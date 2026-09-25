// Verbindungstest des Clients (studio/js/connect.js) gegen einen echten Server und Attrappen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';
// @ts-expect-error – Browser-Modul ohne Typdeklaration
import { normalizeServer, testConnection } from '../studio/js/connect.js';

async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

test('Adresse: http:// und Port 8750 werden ergänzt, Domains bleiben ohne Port', () => {
  assert.equal(normalizeServer('192.168.1.20').url, 'http://192.168.1.20:8750');
  assert.equal(normalizeServer('http://192.168.1.20:9000/').url, 'http://192.168.1.20:9000');
  assert.equal(normalizeServer('https://radio.example.org').url, 'https://radio.example.org');
  assert.ok(normalizeServer('http://[kaputt').error);
});

test('Stufen: Handy-localhost, nicht erreichbar, kein AirDeck, Version, Anmeldung, Rechte', async () => {
  const native = { native: true, deviceName: 'Test' };
  // „localhost“ auf dem Handy ist das Handy selbst
  let r = await testConnection('localhost', {}, native);
  assert.equal(r.steps.at(-1).id, 'address');
  assert.match(r.steps.at(-1).hint, /Adresse des PCs/);

  // nichts erreichbar
  r = await testConnection('127.0.0.1:1', { code: '123456' }, { native: false });
  assert.equal(r.steps.at(-1).id, 'reach');
  assert.equal(r.ok, false);

  // fremder Webserver / zu neue API
  let health: unknown = { hello: 'world' };
  const fake = createServer((_req, res) => res.end(JSON.stringify(health)));
  const fakeBase = await listen(fake);
  try {
    r = await testConnection(fakeBase, { code: '1' }, { native: false });
    assert.equal(r.steps.at(-1).id, 'airdeck');
    health = { name: 'AirDeck', version: '9.0.0', api: '2.0' };
    r = await testConnection(fakeBase, { code: '1' }, { native: false });
    assert.equal(r.steps.at(-1).detail, 'Diese App benötigt ein Update');
    health = { name: 'AirDeck', version: '0.3.0' };
    r = await testConnection(fakeBase, { code: '1' }, { native: false });
    assert.equal(r.steps.at(-1).detail, 'AirDeck Server benötigt ein Update');
  } finally {
    fake.close();
  }

  // echter Server ohne Benutzerkonten (Desktop): Passwort-Anmeldung → Hinweis auf Kopplung; Code → verbunden
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-con-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  const base = await listen(server);
  try {
    r = await testConnection(base, { username: 'admin', password: 'irgendwas1' }, { native: false });
    assert.equal(r.steps.at(-1).id, 'login');
    assert.match(r.steps.at(-1).hint, /Kopplungscode/);
    const op = { id: 'a', tokenId: 'a', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };
    const { code } = app.svc.devices.createPairing(op, {});
    const steps: string[] = [];
    // (als App wäre 127.0.0.1 zu Recht abgelehnt – siehe oben)
    r = await testConnection(base, { code }, { native: false, deviceName: 'Browser', onStep: (s: { id: string }) => steps.push(s.id) });
    assert.equal(r.ok, true);
    assert.deepEqual(steps, ['address', 'reach', 'airdeck', 'version', 'login', 'rights']);
    assert.match(r.token, /^ad_/);
    assert.equal(app.svc.devices.list()[0]!.device.platform, 'web');
  } finally {
    app.shutdown();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
