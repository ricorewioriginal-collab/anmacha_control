import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { SecretStore } from '../src/server/secrets.ts';
import { FirestoreStore, SyncManager, decide, type RemoteDoc } from '../src/server/sync.ts';

// MySQL-Tests nur mit Datenbank: AIRDECK_TEST_MYSQL="host:port:user:passwort:datenbank"
const MYSQL = process.env.AIRDECK_TEST_MYSQL?.split(':');

test('Konfliktregel', () => {
  const r = (updatedAt: number): RemoteDoc => ({ updatedAt, instance: 'x', state: {} });
  assert.equal(decide(null, null, {}), 'nothing');
  assert.equal(decide('h', null, {}), 'push_local');
  assert.equal(decide(null, r(1), {}), 'take_remote');
  assert.equal(decide('h', r(1), {}), 'take_remote', 'neuer Standort holt den gemeinsamen Stand');
  assert.equal(decide('h', r(1), {}, 'push'), 'push_local');
  assert.equal(decide('h', r(2), { localHash: 'h', remoteAt: 1 }), 'take_remote');
  assert.equal(decide('h2', r(1), { localHash: 'h', remoteAt: 1 }), 'push_local');
  assert.equal(decide('h2', r(2), { localHash: 'h', remoteAt: 1 }), 'conflict');
  assert.equal(decide('h', r(1), { localHash: 'h', remoteAt: 1 }), 'nothing');
});

test('Installer-Einrichtungsdatei wird importiert und gelöscht, Fehler blockieren den Start nicht', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-setup-'));
  try {
    writeFileSync(join(dir, 'storage-setup.json'), JSON.stringify({ backend: 'mysql', mysql: { host: '127.0.0.1', port: 1, user: 'u', password: 'geheim', database: 'airdeck' } }));
    const secrets = new SecretStore(dir);
    const sync = new SyncManager(dir, secrets);
    const decision = await sync.startup(); // Port 1: nicht erreichbar → lokal weiter
    assert.equal(decision, null);
    assert.ok(sync.status.lastError);
    assert.equal(existsSync(join(dir, 'storage-setup.json')), false, 'Klartext-Datei muss gelöscht sein');
    assert.equal(secrets.get('storage:mysql'), 'geheim');
    assert.ok(!JSON.stringify(sync.view()).includes('geheim'));
    await sync.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MySQL: zwei Standorte teilen den Senderzustand, Konflikte werden gesichert', { skip: !MYSQL && 'AIRDECK_TEST_MYSQL nicht gesetzt' }, async () => {
  const [host, port, user, password, database] = MYSQL!;
  const mysqlCfg = { host, port: Number(port), user, password, database };
  const dirA = mkdtempSync(join(tmpdir(), 'airdeck-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'airdeck-b-'));
  try {
    // Standort A legt den gemeinsamen Stand an
    const secA = new SecretStore(dirA);
    const syncA = new SyncManager(dirA, secA);
    await syncA.configure({ backend: 'mysql', mysql: mysqlCfg, firstSync: 'push' }, true);
    const appA = new AirDeckApp(dirA, { ffmpeg: null, secrets: secA, sync: syncA });
    appA.svc.stations.updateStation('main', { name: 'Studio Hannover' });
    appA.svc.media.addMedia('main', { id: 'm1', title: 'Song', artist: 'X', category: 'music', file: 'm1.mp3', durationMs: 1000, addedAt: 0 });
    appA.persistNow();
    await syncA.pushNow(appA.stateJson());
    appA.shutdown();

    // Standort B (frisch installiert) holt den Stand
    const secB = new SecretStore(dirB);
    const syncB = new SyncManager(dirB, secB);
    await syncB.configure({ backend: 'mysql', mysql: mysqlCfg }, true);
    assert.equal(await syncB.startup(), 'take_remote');
    const appB = new AirDeckApp(dirB, { ffmpeg: null, secrets: secB, sync: syncB });
    assert.equal(appB.svc.stations.station('main').name, 'Studio Hannover');
    assert.equal(appB.svc.media.library('main')[0]?.title, 'Song');
    appB.shutdown();

    // Beide ändern offline → Konflikt: lokal gewinnt, Remote-Stand wird gesichert
    const b2 = new AirDeckApp(dirB, { ffmpeg: null, secrets: secB, sync: syncB });
    b2.svc.stations.updateStation('main', { name: 'Studio Berlin' });
    b2.persistNow();
    b2.shutdown();
    await syncA.pushNow(JSON.stringify({ ...JSON.parse(appA.stateJson()), marker: 1 }));
    assert.equal(await syncB.startup(), 'conflict');
    assert.ok(readdirSync(dirB).some((f) => f.startsWith('airdeck.remote-conflict-')));
    await syncA.close();
    await syncB.close();
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('Firebase/Firestore: Service-Account-Anmeldung (RS256) und Dokument lesen/schreiben', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let stored: unknown = null;
  let tokenOk = false;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/token') {
        const jwt = new URLSearchParams(body).get('assertion') ?? '';
        const [h, c, sig] = jwt.split('.');
        const v = createVerify('RSA-SHA256');
        v.update(`${h}.${c}`);
        tokenOk = v.verify(publicKey, Buffer.from(sig!, 'base64url')) && JSON.parse(Buffer.from(c!, 'base64url').toString()).iss === 'svc@test.iam';
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(tokenOk ? { access_token: 'ya29.test', expires_in: 3600 } : { error_description: 'bad jwt' }));
      }
      if (req.headers.authorization !== 'Bearer ya29.test') return res.writeHead(401).end();
      assert.ok(req.url!.includes('/projects/demo-proj/databases/(default)/documents/airdeck/state'));
      if (req.method === 'PATCH') {
        stored = JSON.parse(body);
        return res.end('{}');
      }
      if (!stored) return res.writeHead(404).end('{}');
      res.end(JSON.stringify(stored));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const sa = JSON.stringify({ client_email: 'svc@test.iam', private_key: privateKey, project_id: 'demo-proj', token_uri: `${base}/token` });
  try {
    const fs = new FirestoreStore({ projectId: 'demo-proj', credentialsRef: 'x', collection: 'airdeck' }, sa, base);
    await fs.test();
    assert.equal(await fs.pull(), null);
    await fs.push({ updatedAt: 42, instance: 'pc1', state: { stations: [{ id: 'main', name: 'PROMPT FM' }] } });
    assert.ok(tokenOk, 'JWT muss gültig signiert sein');
    const doc = await fs.pull();
    assert.equal(doc?.updatedAt, 42);
    assert.deepEqual(doc?.state, { stations: [{ id: 'main', name: 'PROMPT FM' }] });
  } finally {
    srv.close();
  }
});
