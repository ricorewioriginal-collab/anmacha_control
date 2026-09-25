import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';
import { fetchAzuracast, fetchIcecastMount } from '../src/server/bridge.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timeout');
    await wait(20);
  }
}

const AZ = {
  station: { name: 'Azura Test', listen_url: 'https://radio.example/listen/azt/radio.mp3', mounts: [{ url: 'https://radio.example/listen/azt/radio.mp3', bitrate: 128, format: 'mp3', is_default: true }] },
  listeners: { current: 17, total: 20 },
  live: { is_live: true, streamer_name: 'DJ Rico' },
  now_playing: { played_at: 1758744000, duration: 200, song: { artist: 'Kygo', title: 'Firestone', album: 'Cloud Nine' } },
  song_history: [{ played_at: 1758743800, song: { artist: 'Avicii', title: 'Levels' } }],
};

test('AzuraCast- und Icecast-Status werden einheitlich gelesen', async () => {
  const keys: string[] = [];
  const srv = createServer((req, res) => {
    keys.push(String(req.headers['x-api-key'] ?? ''));
    if (req.url === '/api/nowplaying/azt') return void res.end(JSON.stringify(AZ));
    if (req.url === '/status-json.xsl') return void res.end(JSON.stringify({ icestats: { source: [{ listenurl: 'http://ice.example:8000/live', server_name: 'Mein Ice', title: 'Imagine Dragons - Believer', listeners: 4, bitrate: 192, server_type: 'audio/mpeg' }] } }));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const a = await fetchAzuracast(base + '/', 'azt', 'k-123');
    assert.equal(keys[0], 'k-123');
    assert.equal(a.listeners, 17);
    assert.deepEqual(a.listenUrls, ['https://radio.example/listen/azt/radio.mp3']);
    assert.equal(a.now?.title, 'Firestone');
    assert.equal(a.now?.ends_at, new Date((1758744000 + 200) * 1000).toISOString());
    assert.deepEqual(a.live, { active: true, streamer: 'DJ Rico' });
    assert.equal(a.history[0]!.title, 'Levels');
    const i = await fetchIcecastMount(base, '/live');
    assert.deepEqual([i.now?.artist, i.now?.title, i.listeners, i.bitrate], ['Imagine Dragons', 'Believer', 4, 192]);
    assert.equal(i.listenUrls[0], `${base}/live`);
    await assert.rejects(fetchIcecastMount(base, '/fehlt'), /nicht aktiv/);
    await assert.rejects(fetchAzuracast(base, 'unbekannt'), /nicht gefunden/);
  } finally {
    srv.close();
  }
});

test('Pull-Relay: bestehender Stream wird AirDeck-Quelle mit Priorität, geht an die Ausgänge, verbindet neu', async () => {
  let connections = 0;
  let current: ServerResponse | null = null;
  const stream = createServer((req, res) => {
    connections++;
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    current = res;
    const t = setInterval(() => res.write(Buffer.from(`EXTERN${connections}|`)), 40);
    res.on('close', () => clearInterval(t));
  });
  const received: string[] = [];
  const ice = createServer((req, res) => {
    if (req.url?.startsWith('/admin/')) return void res.end('ok');
    res.writeHead(200);
    res.flushHeaders();
    req.on('data', (d) => received.push(d.toString()));
  });
  await new Promise<void>((r) => stream.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => ice.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-bridge-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const admin = { id: 't', tokenId: 't', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };
  try {
    app.saveOutput(admin, 'main', null, { name: 'Ice', type: 'icecast', host: '127.0.0.1', port: (ice.address() as { port: number }).port, mount: '/radio', username: 'source', password: 'ice-geheim-1', sourceTarget: '/live' });
    const b = app.svc.bridges.saveBridge(admin, 'main', null, { kind: 'stream', name: 'Alte Automation', url: `http://127.0.0.1:${(stream.address() as { port: number }).port}/live`, pull: true, priority: 5 }) as { id: string; sourceId: string };
    const src = () => app.engine.get(b.sourceId)!;
    assert.equal(src().type, 'url_stream');
    assert.equal(src().priority, 5);
    await until(() => src().state === 'active');
    await until(() => received.join('').includes('EXTERN1|'));
    // Fremdstream bricht ab → Relay verbindet selbst neu
    (current as ServerResponse | null)?.destroy();
    await until(() => connections >= 2, 8000);
    await until(() => received.join('').includes('EXTERN2|'), 8000);
    // Nochmal speichern (z. B. Priorität ändern) legt keine zweite Quelle an
    app.svc.bridges.saveBridge(admin, 'main', b.id, { priority: 7 });
    assert.equal(app.engine.list('main').filter((s) => s.type === 'url_stream').length, 1);
    assert.equal(src().priority, 7);
    app.svc.bridges.saveBridge(admin, 'main', b.id, { remove: true });
    assert.equal(app.engine.get(b.sourceId), undefined);
  } finally {
    app.shutdown();
    stream.closeAllConnections();
    stream.close();
    ice.closeAllConnections();
    ice.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Bridge-API: gleicher Schlüssel = gleicher Sender, Now Playing erscheint im Status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-bapi-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const token = app.svc.auth.createToken({ name: 'bridge', scopes: ['bridge:write'], roles: [], stationIds: ['*'] }).token;
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    const a = await call('PUT', '/bridge/stations/azuracast:radio.example:azt', { name: 'Azura Test', genre: 'Pop' });
    assert.equal(a.status, 200);
    assert.equal(a.body.created, true);
    const b = await call('PUT', '/bridge/stations/azuracast:radio.example:azt', { name: 'Azura Test (neu)' });
    assert.equal(b.body.created, false);
    assert.equal(b.body.station.id, a.body.station.id, 'kein zweiter Sender');
    assert.equal(b.body.station.name, 'Azura Test (neu)');
    assert.equal((await call('GET', '/bridge/mappings')).body['azuracast:radio.example:azt'], a.body.station.id);
    assert.equal((await call('PUT', '/bridge/stations/ungültig schlüssel', {})).status, 400);

    const np = await call('POST', '/bridge/stations/azuracast:radio.example:azt/now-playing', { artist: 'Kygo', title: 'Firestone', durationMs: 180000, listeners: 9, listenUrls: ['https://radio.example/listen/azt/radio.mp3'] });
    assert.equal(np.status, 200);
    await call('POST', '/bridge/stations/azuracast:radio.example:azt/now-playing', { artist: 'Avicii', title: 'Levels' });
    const st = (await (await fetch(`${base.replace('/api/v1', '')}/status/${a.body.station.id}.json`)).json()) as any;
    assert.equal(st.now.title, 'Levels');
    assert.equal(st.last_songs[0].title, 'Firestone');
    assert.equal(st.icestats.source[0].listenurl, 'https://radio.example/listen/azt/radio.mp3');
    assert.equal(st.icestats.source[0].listeners, 9);
    assert.equal((await call('POST', '/bridge/stations/unbekannt/now-playing', { title: 'x' })).status, 404);
    // GET-Variante für einfache Sendesoftware
    const g = await fetch(`${base}/bridge/stations/${encodeURIComponent('azuracast:radio.example:azt')}/now-playing?token=${token}&artist=RadioDJ&title=Testtitel&duration=200`);
    assert.equal(g.status, 200);
    const st2 = (await (await fetch(`${base.replace('/api/v1', '')}/status/${a.body.station.id}.json`)).json()) as any;
    assert.equal(st2.now.title, 'Testtitel');
    assert.ok(st2.now.ends_at, 'Dauer in Sekunden übernommen');
  } finally {
    app.shutdown();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
