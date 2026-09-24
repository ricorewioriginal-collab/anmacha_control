import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';

let dir: string;
let app: AirDeckApp;
let server: Server;
let base: string;
let token: string;
let icecast: Server;
let icePort: number;
const received: { path: string; auth: string; type: string; data: string }[] = [];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timeout');
    await wait(20);
  }
}

async function api(method: string, path: string, body?: unknown, tok = token) {
  const r = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

function ingest(mount: string, user: string, pass: string, method = 'PUT') {
  const port = Number(new URL(base).port);
  const req = request({
    host: '127.0.0.1',
    port,
    method,
    path: `/ingest/main${mount}`,
    headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'), 'Content-Type': 'audio/mpeg' },
  });
  const status = new Promise<number>((ok) => req.on('response', (res) => ok(res.statusCode ?? 0)));
  req.on('error', () => {});
  req.flushHeaders();
  return { req, status };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'airdeck-'));
  icecast = createServer((req, res) => {
    const entry = { path: req.url ?? '', auth: String(req.headers.authorization), type: String(req.headers['content-type']), data: '' };
    received.push(entry);
    if (req.url?.startsWith('/admin/')) return void res.end('ok');
    res.writeHead(200);
    res.flushHeaders();
    req.on('data', (d) => (entry.data += d.toString()));
  });
  await new Promise<void>((r) => icecast.listen(0, '127.0.0.1', r));
  icePort = (icecast.address() as { port: number }).port;

  app = new AirDeckApp(dir, { stableMs: 0 });
  token = app.createToken({ name: 't', scopes: ['*'], roles: ['admin'], stationIds: ['*'] }).token;
  server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  app.shutdown();
  server.closeAllConnections();
  server.close();
  icecast.closeAllConnections();
  icecast.close();
  rmSync(dir, { recursive: true, force: true });
});

test('ohne Token kein Zugriff, Health öffentlich', async () => {
  assert.equal((await api('GET', '/api/v1/stations', undefined, 'falsch')).status, 401);
  const h = await fetch(base + '/api/v1/health');
  assert.equal(h.status, 200);
});

test('Scopes werden durchgesetzt', async () => {
  const ro = app.createToken({ name: 'ro', scopes: ['now_playing:read'], roles: [], stationIds: ['main'] }).token;
  assert.equal((await api('GET', '/api/v1/stations/main/now-playing', undefined, ro)).status, 200);
  assert.equal((await api('GET', '/api/v1/stations/main/sources', undefined, ro)).status, 403);
  const other = app.createToken({ name: 'o', scopes: ['*'], roles: ['dj'], stationIds: ['other'] }).token;
  assert.equal((await api('GET', '/api/v1/stations/main/sources', undefined, other)).status, 403);
});

test('Standardsender mit Quellen nach Spezifikation', async () => {
  const r = await api('GET', '/api/v1/stations/main/sources');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((s: { priority: number }) => s.priority), [1, 2, 3, 10]);
  assert.ok(r.body.every((s: Record<string, unknown>) => !('credentialRef' in s)));
});

test('ungültige Priority wird per API abgelehnt', async () => {
  for (const priority of [0, -3, 1.5, '2']) {
    const r = await api('POST', '/api/v1/stations/main/sources', { name: 'x', type: 'relay', target: '/live', priority });
    assert.equal(r.status, 400, `priority ${priority}`);
  }
});

test('Relay: Priority-Übernahme, Weiterleitung an Icecast, Fallback', async () => {
  const sources = (await api('GET', '/api/v1/stations/main/sources')).body as { id: string; type: string }[];
  const live = sources.find((s) => s.type === 'live_studio')!;
  const auto = sources.find((s) => s.type === 'automation')!;
  assert.equal((await api('POST', `/api/v1/stations/main/sources/${live.id}/password`, { password: 'kurz' })).status, 400);
  assert.equal((await api('POST', `/api/v1/stations/main/sources/${live.id}/password`, { password: 'live-geheim-1' })).status, 204);
  assert.equal((await api('POST', `/api/v1/stations/main/sources/${auto.id}/password`, { password: 'auto-geheim-1' })).status, 204);

  const out = await api('POST', '/api/v1/stations/main/outputs', {
    name: 'Test', type: 'icecast', host: '127.0.0.1', port: icePort, mount: '/radio', username: 'source', password: 'ice-pass', priority: 5, sourceTarget: '/live',
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.hasPassword, true);
  assert.equal(JSON.stringify(out.body).includes('ice-pass'), false);

  // falsches Passwort
  const bad = ingest('/live', 'source', 'falsch');
  assert.equal(await bad.status, 401);

  // Automation verbindet und sendet
  const a = ingest('/live', 'source', 'auto-geheim-1');
  assert.equal(await a.status, 200);
  await until(() => received.some((r) => r.path === '/radio?prio=5'));
  const stream1 = received.find((r) => r.path === '/radio?prio=5')!;
  assert.equal(stream1.auth, 'Basic ' + Buffer.from('source:ice-pass').toString('base64'));
  a.req.write('AUTO1');
  await until(() => stream1.data.includes('AUTO1'));

  // Live Studio (Priority 1) übernimmt
  const l = ingest('/live', live.id, 'live-geheim-1', 'SOURCE');
  assert.equal(await l.status, 200);
  await until(() => app.engine.get(live.id)?.state === 'active');
  assert.equal(app.engine.get(auto.id)?.state, 'standby');
  await wait(50);
  const stream2 = received.filter((r) => r.path === '/radio?prio=5').at(-1)!;
  l.req.write('LIVE1');
  a.req.write('AUTO2');
  await until(() => stream2.data.includes('LIVE1'));
  await wait(50);
  assert.equal(stream2.data.includes('AUTO2'), false, 'Standby-Quelle darf nicht senden');

  // Live trennt → Fallback auf Automation
  l.req.end();
  await until(() => app.engine.get(auto.id)?.state === 'active');
  await wait(50);
  const stream3 = received.filter((r) => r.path === '/radio?prio=5').at(-1)!;
  a.req.write('AUTO3');
  await until(() => stream3.data.includes('AUTO3'));

  // Audit-Log enthält Übernahmen, aber keine Passwörter
  const audit = readFileSync(join(dir, 'audit.log'), 'utf8');
  assert.ok(audit.includes('TAKEOVER_COMPLETED'));
  assert.ok(!/geheim|ice-pass/.test(audit));
  a.req.end();
  await until(() => app.engine.get(auto.id)?.state === 'disconnected');
});

test('Medien-Upload, Queue nach Sendeuhr, Now Playing', async () => {
  const up = async (name: string, category: string) => {
    const r = await fetch(`${base}/api/v1/stations/main/media?name=${encodeURIComponent(name)}&category=${category}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: Buffer.from('ID3fake-audio'),
    });
    return r.json() as Promise<{ id: string; artist: string; title: string }>;
  };
  const bad = await fetch(`${base}/api/v1/stations/main/media?name=virus.exe`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: 'x' });
  assert.equal(bad.status, 415);
  const s1 = await up('Station ID.mp3', 'station_id');
  const m1 = await up('Avicii - Wake Me Up.mp3', 'music');
  await up('Kygo - Firestone.mp3', 'music');
  assert.equal(m1.artist, 'Avicii');
  assert.equal(m1.title, 'Wake Me Up');
  await api('PATCH', `/api/v1/stations/main/media/${m1.id}`, { durationMs: 247_000 });

  const file = await fetch(`${base}/api/v1/stations/main/media/${m1.id}/file?token=${token}`, { headers: { Range: 'bytes=0-2' } });
  assert.equal(file.status, 206);
  assert.equal(await file.text(), 'ID3');

  const next = await api('POST', '/api/v1/stations/main/queue/next');
  assert.equal(next.body.media.id, s1.id); // Sendeuhr beginnt mit Station ID
  const q = await api('GET', '/api/v1/stations/main/queue');
  assert.ok(q.body.items.length >= 2);

  const np = await api('POST', '/api/v1/stations/main/now-playing', { mediaId: m1.id, deck: 'A' });
  assert.equal(np.status, 200);
  const view = await api('GET', '/api/v1/stations/main/now-playing');
  assert.equal(view.body.media.title, 'Wake Me Up');

  const cart = await api('PATCH', '/api/v1/stations/main/cardwall/cart1', { mediaId: s1.id, label: 'Station ID' });
  assert.equal(cart.body.mediaId, s1.id);
  assert.equal((await api('POST', '/api/v1/stations/main/cardwall/cart2/trigger')).status, 409);
});

test('Studio wird ausgeliefert, Pfad-Traversal blockiert', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('content-security-policy'));
  const t = await fetch(base + '/..%2f..%2fpackage.json');
  assert.notEqual(t.status, 200);
});

test('Mehrere Sender: anlegen, Logo setzen (öffentlich), löschen', async () => {
  const st = await api('POST', '/api/v1/stations', { id: 'zweit', name: 'Zweitsender' });
  assert.equal(st.status, 200);
  assert.equal((await api('GET', '/api/v1/stations')).body.length, 2);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  const put = (type: string, body: Buffer) => fetch(`${base}/api/v1/stations/zweit/logo`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body });
  assert.equal((await put('image/svg+xml', Buffer.from('<svg/>'))).status, 415, 'SVG abgelehnt');
  assert.equal((await put('image/png', Buffer.from('keinbild-keinbild'))).status, 415, 'Signatur geprüft');
  const ok = await put('image/png', png);
  assert.equal(ok.status, 200);
  assert.match(((await ok.json()) as { logo: string }).logo, /^png:/);
  const img = await fetch(`${base}/api/v1/stations/zweit/logo`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
  assert.equal((await api('DELETE', '/api/v1/stations/zweit')).status, 204);
  assert.equal((await fetch(`${base}/api/v1/stations/zweit/logo`)).status, 404);
  assert.equal((await api('GET', '/api/v1/stations')).body.length, 1);
  assert.equal((await api('DELETE', '/api/v1/stations/main')).status, 409, 'letzter Sender bleibt');
});

test('Persistenz: Neustart stellt Konfiguration ohne aktive Quellen wieder her', async () => {
  await api('PUT', '/api/v1/stations/main/lautfm', { stationName: 'meinradio' });
  app.shutdown();
  const again = new AirDeckApp(dir, { stableMs: 0 });
  assert.equal(again.lautfmConfig('main').stationName, 'meinradio', 'laut.fm-Einstellungen überleben den Neustart');
  const list = again.engine.list('main');
  assert.equal(list.length, 4);
  assert.ok(list.every((s) => s.state === 'disconnected'));
  assert.equal(again.listOutputs('main').length, 1);
  assert.equal(again.library('main').length, 3);
  assert.ok(again.authenticate(token));
  again.shutdown();
});

test('Pfadprüfung funktioniert mit Windows- und Linux-Pfaden', async () => {
  const { isInside } = await import('../src/server/http.ts');
  const path = await import('node:path');
  assert.equal(isInside('C:\\Program Files\\AirDeck\\studio', 'C:\\Program Files\\AirDeck\\studio\\index.html', path.win32), true);
  assert.equal(isInside('C:\\Program Files\\AirDeck\\studio', 'C:\\Program Files\\AirDeck\\studio\\js\\app.js', path.win32), true);
  assert.equal(isInside('C:\\Program Files\\AirDeck\\studio', 'C:\\Program Files\\AirDeck\\secret.txt', path.win32), false);
  assert.equal(isInside('C:\\Program Files\\AirDeck\\studio', 'D:\\x.html', path.win32), false);
  assert.equal(isInside('/opt/airdeck/studio', '/opt/airdeck/studio/index.html', path.posix), true);
  assert.equal(isInside('/opt/airdeck/studio', '/opt/airdeck/studio-evil/x', path.posix), false);
  assert.equal(isInside('/opt/airdeck/studio', '/opt/airdeck/studio', path.posix), false);
});
