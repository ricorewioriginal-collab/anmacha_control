import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { allowedPublicPath, allowedRadioadminPath, forward } from '../src/server/lautfm.ts';

const admin = { id: 'admin', tokenId: 't', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-f-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  for (const [id, cat, folder] of [['a', 'music', 'Rock'], ['b', 'music', 'Rock'], ['c', 'music', 'Pop'], ['j', 'jingle', 'Jingles']] as const) {
    app.addMedia('main', { id, title: `Titel ${id}`, artist: `Artist ${id}`, category: cat, file: `${id}.mp3`, durationMs: 60_000, addedAt: 0, folder, originalName: `Artist ${id} - Titel ${id}.mp3` });
  }
  return { dir, app, done: () => { app.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('Ordner, Queue aus Ordner füllen, Playlists, Playlist abspielen', () => {
  const { app, done } = setup();
  try {
    assert.deepEqual(app.folders('main'), ['Jingles', 'Pop', 'Rock']);
    assert.equal(app.queueFillFrom('main', { folder: 'Rock', count: 2 }), 2);
    const q = (app.queueView('main') as { items: { mediaId: string }[] }).items.map((x) => x.mediaId);
    assert.deepEqual(new Set(q), new Set(['a', 'b']));
    const pl = app.saveQueueAsPlaylist('main', 'Rockblock');
    assert.equal(pl.items.length, 2);
    app.queueClear('main');
    app.playPlaylist('main', pl.id);
    assert.equal((app.queueView('main') as { items: unknown[] }).items.length, 2);
    app.removeMedia('main', 'a');
    assert.deepEqual(app.playlists('main')[0]!.items, ['b']);
  } finally {
    done();
  }
});

test('Zeitplan-Job feuert, Wiederholung wird weitergeschoben', async () => {
  const { app, done } = setup();
  try {
    app.start();
    const job = app.saveJob('main', { at: Date.now() + 300, repeat: 'daily', kind: 'media', mediaId: 'j', mode: 'track' });
    await wait(1100);
    const q = (app.queueView('main') as { items: { mediaId: string; origin: string }[] }).items;
    assert.equal(q[0]?.mediaId, 'j');
    assert.equal(q[0]?.origin, 'schedule');
    const again = (app.planning('main') as { jobs: { id: string; at: number }[] }).jobs.find((x) => x.id === job.id)!;
    assert.ok(again.at > Date.now() + 23 * 3600e3, 'täglich → morgen wieder');
  } finally {
    done();
  }
});

test('Stunden-Uhr: Validierung und manuelles Auslösen über der Musik', () => {
  const { app, done } = setup();
  try {
    assert.throws(() => app.saveClockEvent('main', null, { kind: 'folder', folder: 'Jingles', minutes: [], mode: 'fx' }), /Minute/);
    const events: unknown[] = [];
    app.subscribe((e) => e.type === 'automation.command' && events.push(e.payload));
    const ev = app.saveClockEvent('main', null, { kind: 'folder', folder: 'Jingles', minutes: [0], hours: [], days: [], mode: 'fx', label: 'Stundenjingle' });
    app.fireClockEvent('main', ev.id);
    assert.deepEqual(events, [{ action: 'fx', mediaId: 'j' }]);
  } finally {
    done();
  }
});

test('Sendeplan: im Zeitfenster kommt die Musik aus der Playlist', () => {
  const { app, done } = setup();
  try {
    const pl = app.savePlaylist('main', null, { name: 'Pop', items: ['c'] });
    assert.throws(() => app.savePlan('main', null, { label: 'x', days: [], from: '25:00', to: '10:00', playlistId: pl.id }), /Uhrzeit/);
    app.savePlan('main', null, { label: 'Ganztags Pop', days: [], from: '00:00', to: '00:00', playlistId: pl.id });
    app.queueFill('main');
    const items = (app.queueView('main') as { items: { mediaId: string; origin: string }[] }).items;
    assert.ok(items.length > 0 && items.every((x) => x.mediaId === 'c' && x.origin === 'plan'));
    assert.throws(() => app.deletePlaylist('main', pl.id), /Sendeplan/);
  } finally {
    done();
  }
});

test('M3U Export und Import (Abgleich über Dateiname/Titel, URLs)', () => {
  const { app, done } = setup();
  try {
    app.queueAdd('main', 'a');
    const m3u = app.exportQueueM3U('main');
    assert.ok(m3u.includes('#EXTINF:60,Artist a - Titel a'));
    const r = app.importM3U('main', '#EXTM3U\nC:\\\\Musik\\\\Artist b - Titel b.mp3\n#EXTINF:10,Artist c - Titel c\nirgendwo.mp3\nhttps://stream.example/live\nfehlt.mp3\n', { playlistName: 'Import' });
    assert.equal(r.matched, 3);
    assert.deepEqual(r.missing, ['fehlt.mp3']);
    assert.equal(app.playlists('main').find((p) => p.id === r.playlistId)!.items.length, 3);
    assert.ok(app.library('main').some((m) => m.url === 'https://stream.example/live' && m.category === 'stream'));
    assert.throws(() => app.addUrlMedia('main', { url: 'file:///etc/passwd' }), /http/);
  } finally {
    done();
  }
});

test('Recorder schneidet das Sendesignal mit und trennt bei Formatwechsel', async () => {
  const { app, dir, done } = setup();
  try {
    const auto = app.engine.list('main').find((s) => s.type === 'automation')!;
    app.studioChunk(admin, 'main', auto.id, 'audio/mpeg', Buffer.from('AAAA'), true);
    const rec = app.startRecording('main', 'Test');
    app.studioChunk(admin, 'main', auto.id, 'audio/mpeg', Buffer.from('BBBB'), false);
    app.stopRecording('main');
    await wait(50);
    const list = (app.recordings('main') as { recordings: { id: string; bytes: number; file: string }[] }).recordings;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.bytes, 4);
    const { path } = app.recordingFile('main', list[0]!.id);
    assert.ok(existsSync(path) && statSync(path).size === 4);
    assert.ok(rec);
    app.deleteRecording('main', list[0]!.id);
    assert.ok(!existsSync(path));
    assert.throws(() => app.saveRecPlan('main', null, { label: 'x', days: [9], from: '10:00', to: '11:00' }), /Wochentage/);
    void dir;
  } finally {
    done();
  }
});

test('Verlauf und Titelanzeige', () => {
  const { app, done } = setup();
  try {
    app.setNowPlaying('main', 'b', 'A');
    assert.equal(app.history('main')[0]!.title, 'Titel b');
    assert.throws(() => app.sendMetadata('main', '', ' '), /Titel/);
  } finally {
    done();
  }
});

test('laut.fm: nur erlaubte Pfade, Token bleibt serverseitig', async () => {
  assert.equal(allowedRadioadminPath('/stations', undefined), true);
  assert.equal(allowedRadioadminPath('/stations/42/playlists/7', 42), true);
  assert.equal(allowedRadioadminPath('/stations/42/tracks;queued', 42), true);
  assert.equal(allowedRadioadminPath('/stations/43/playlists', 42), false);
  assert.equal(allowedRadioadminPath('/stations/42/../43', 42), false);
  assert.equal(allowedRadioadminPath('/stations/42', undefined), false);
  assert.equal(allowedPublicPath('/station/80er-radio/current_song'), true);
  assert.equal(allowedPublicPath('/station/x/../../etc'), false);
  // alle GET-Endpunkte der öffentlichen laut.fm-API (api-spec)
  for (const ok of ['/server_status', '/time', '/letters', '/genres', '/station_names', '/listeners', '/stations', '/stations/live', '/stations/numbers',
    '/stations/letter/a', '/stations/genre/Hip%20Hop', '/stations/eins,zwei', '/station/eins', '/station/eins/listeners', '/station/eins/images/logo',
    '/station/eins/schedule', '/station/eins/playlists', '/station/eins/last_songs', '/station/eins/next_artists']) assert.equal(allowedPublicPath(ok), true, ok);
  for (const bad of ['/song_change.stream.json', '/stations/names/../x', '/station/eins/tracks', '/admin']) assert.equal(allowedPublicPath(bad), false, bad);

  // forward() gegen einen lokalen Upstream: Authorization wird ergänzt, Upload-Body gestreamt
  const seen: { auth?: string; origin?: string; body: string; method?: string }[] = [];
  const upstream = createServer((req, res) => {
    const e = { auth: req.headers.authorization, origin: req.headers.origin, body: '', method: req.method };
    seen.push(e);
    req.on('data', (d) => (e.body += d));
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'x=1' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const up = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const proxy = createServer((req, res) => void forward(req, res, up + req.url, 'geheim', 60_000, 'airdeck'));
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const port = (proxy.address() as { port: number }).port;
  const result = await new Promise<{ status: number; body: string; cookie?: string[] }>((ok) => {
    const r = request({ host: '127.0.0.1', port, method: 'POST', path: '/x', headers: { 'Content-Type': 'text/plain', 'Content-Length': 5 } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body: b, cookie: res.headers['set-cookie'] }));
    });
    r.end('hallo');
  });
  assert.equal(result.status, 201);
  assert.equal(seen[0]!.origin, 'airdeck', 'Radioadmin verlangt den Origin der callback_url');
  assert.equal(result.body, '{"ok":true}');
  assert.equal(result.cookie, undefined);
  assert.equal(seen[0]!.auth, 'Bearer geheim');
  assert.equal(seen[0]!.body, 'hallo');
  upstream.close();
  proxy.close();
});

test('Schnelltrigger nach Kategorie, Systemwerte', () => {
  const { app, done } = setup();
  try {
    const events: unknown[] = [];
    app.subscribe((e) => e.type === 'automation.command' && events.push(e.payload));
    const m = app.quickTrigger('main', 'jingle');
    assert.equal(m.id, 'j');
    assert.deepEqual(events, [{ action: 'fx', mediaId: 'j' }]); // Jingle läuft über der Musik
    app.quickTrigger('main', 'music', 'track');
    assert.equal((app.queueView('main') as { items: { origin: string }[] }).items[0]!.origin, 'schedule');
    assert.throws(() => app.quickTrigger('main', 'news'), /Keine Titel/);
    assert.throws(() => app.quickTrigger('main', 'x'), /Kategorie/);
    const s = app.system() as { cpu: number; ram: number };
    assert.ok(s.ram > 0 && s.ram <= 100 && s.cpu >= 0 && s.cpu <= 100);
  } finally {
    done();
  }
});
