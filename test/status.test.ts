import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';
import { lautfmStatus, listenUrlOf, toIcecastXml, toM3u, toXspf } from '../src/server/status.ts';

test('laut.fm-Status wird als Icecast-Mount nachgebaut', async () => {
  const srv = createServer((req, res) => {
    const u = req.url ?? '';
    const j = (d: unknown) => res.end(JSON.stringify(d));
    if (u === '/station/meinradio') return j({ name: 'meinradio', display_name: 'Mein Radio', description: 'Nur Hits', genres: ['Pop', 'Dance'], stream_url: 'https://stream.laut.fm/meinradio', page_url: 'https://laut.fm/meinradio' });
    if (u === '/station/meinradio/current_song') return j({ title: 'Levels', artist: { name: 'Avicii' }, album: 'True', started_at: '2026-09-24T20:00:00+02:00', ends_at: '2026-09-24T20:03:20+02:00' });
    if (u === '/station/meinradio/listeners') return j(42);
    if (u === '/station/meinradio/last_songs') return j([{ title: 'Firestone', artist: { name: 'Kygo' }, started_at: '2026-09-24T19:56:00+02:00' }]);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const s = await lautfmStatus('meinradio', `http://127.0.0.1:${(srv.address() as { port: number }).port}`);
    const src = s.icestats.source[0]!;
    assert.equal(src.listenurl, 'https://stream.laut.fm/meinradio');
    assert.equal(src.listeners, 42);
    assert.equal(src.title, 'Avicii - Levels');
    assert.equal(src.genre, 'Pop, Dance');
    assert.equal(s.now?.ends_at, '2026-09-24T20:03:20+02:00');
    assert.equal(s.last_songs[0]!.artist, 'Kygo');
    const xml = toIcecastXml(s);
    assert.match(xml, /<icestats>[\s\S]*<source mount="\/meinradio">[\s\S]*<listeners>42<\/listeners>[\s\S]*<title>Avicii - Levels<\/title>/);
    assert.match(toM3u(s), /^#EXTM3U\n#EXTINF:-1,Mein Radio\nhttps:\/\/stream\.laut\.fm\/meinradio\n$/);
    assert.match(toXspf(s), /<location>https:\/\/stream\.laut\.fm\/meinradio<\/location>/);
    await assert.rejects(lautfmStatus('../x', 'http://x'), /Ungültig/);
  } finally {
    srv.close();
  }
});

test('Hör-Adressen der Ausgänge', () => {
  assert.equal(listenUrlOf({ type: 'icecast', host: 'a.b', port: 8000, mount: '/live', tls: false }), 'http://a.b:8000/live');
  assert.equal(listenUrlOf({ type: 'icecast', host: 'a.b', port: 443, mount: 'x', tls: true }), 'https://a.b/x');
  assert.equal(listenUrlOf({ type: 'shoutcast', host: 'a.b', port: 8010, mount: '', tls: false, streamId: 2 }), 'http://a.b:8010/stream/2/');
});

test('Öffentlicher Status eines AirDeck-Senders (JSON/XML), abschaltbar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-status-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const m = app.svc.media.addMedia('main', { id: 'm1', title: 'Believer', artist: 'Imagine Dragons', category: 'music', file: 'b.mp3', durationMs: 200_000, addedAt: 0 });
    app.setNowPlaying('main', m.id, 'A');
    const list = (await (await fetch(`${base}/status.json`)).json()) as { stations: { id: string }[] };
    assert.deepEqual(list.stations.map((s) => s.id), ['main']);
    const r = await fetch(`${base}/status/main.json`);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const s = (await r.json()) as { now: { title: string; ends_at: string }; last_songs: { title: string }[]; icestats: { source: unknown[] } };
    assert.equal(s.now.title, 'Believer');
    assert.ok(s.now.ends_at);
    assert.equal(s.last_songs[0]!.title, 'Believer');
    assert.deepEqual(s.icestats.source, [], 'ohne verbundenen Ausgang kein Mount (wie Icecast)');
    const xml = await (await fetch(`${base}/status/main.xml`)).text();
    assert.match(xml, /^<\?xml[\s\S]*<sources>0<\/sources>/);
    app.svc.stations.updateStation('main', { publicStatus: false });
    assert.equal((await fetch(`${base}/status/main.json`)).status, 404);
    assert.deepEqual(((await (await fetch(`${base}/status.json`)).json()) as { stations: unknown[] }).stations, []);
  } finally {
    app.shutdown();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
