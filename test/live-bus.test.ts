// Sendebus + Mode-Manager mit echtem ffmpeg (ARCHITECTURE §3/§4, behebt AUDIT 5.2 und 5.3).
// Live-Quellen werden dekodiert und gemischt: Die Ausgänge behalten Format und Verbindung.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { detectFfmpeg } from '../src/server/ffmpeg.ts';
import type { SourceConfig } from '../src/core/source-priority.ts';

const ff = detectFfmpeg(process.cwd());
const skip = (!ff || !ff.encoders.opus || !ff.encoders.mp3) && 'ffmpeg mit libopus/libmp3lame nicht installiert';
const admin = { id: 'admin', tokenId: 't', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 10_000, what = 'Bedingung') {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`Timeout: ${what}`);
    await wait(25);
  }
}

function wav(file: string, seconds: number, freq: number): void {
  const rate = 22050;
  const n = Math.floor(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(freq ? Math.round(9000 * Math.sin((2 * Math.PI * freq * i) / rate)) : 0, 44 + i * 2);
  writeFileSync(file, b);
}

/** Icecast-Attrappe: zählt Verbindungen und merkt sich deren Content-Type */
async function iceMock(): Promise<{ server: Server; port: number; conns: string[]; bytes: () => number }> {
  const conns: string[] = [];
  let bytes = 0;
  const server = createServer((req, res) => {
    // Status-/Hörerabfragen (GET) und Metadaten sind keine Sendeverbindungen
    if (req.url?.startsWith('/admin/') || req.method === 'GET') return void res.end('{}');
    conns.push(`${req.method} ${String(req.headers['content-type'])}`);
    res.writeHead(200);
    res.flushHeaders();
    req.on('data', (d: Buffer) => (bytes += d.length));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as { port: number }).port, conns, bytes: () => bytes };
}

/** Live-Encoder wie BUTT/Studio-Mikrofon: Opus in Ogg in Echtzeit, direkt in den Ingest der App */
function liveEncoder(app: AirDeckApp, src: SourceConfig, input: string, container: 'ogg' | 'webm' = 'ogg'): ChildProcess {
  const p = spawn(ff!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', input, '-c:a', 'libopus', '-b:a', '64k', '-f', container, 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  // Browser-MediaRecorder (Studio-Mikrofon, Android-App) sendet WebM/Opus
  app.ingestOpen(src, container === 'webm' ? 'audio/webm;codecs=opus' : 'audio/ogg');
  p.stdout!.on('data', (d: Buffer) => app.ingestData(src, d));
  return p;
}

async function setup(dir: string, port: number) {
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
  for (const [name, freq] of [['a.wav', 440], ['b.wav', 550], ['c.wav', 660]] as const) {
    wav(join(app.mediaDir, 'main', name), 4, freq);
    app.svc.media.addMedia('main', { id: name, title: name, artist: 'Test', category: 'music', file: name, durationMs: 4000, addedAt: 0 });
  }
  app.saveOutput(admin, 'main', null, { name: 'ice', host: '127.0.0.1', port, mount: '/radio', password: 'pw-123456' });
  const live = app.engine.list('main').find((s) => s.type === 'live_studio')!;
  const events: string[] = [];
  // Pegel wie im Studio über die Ereignisse lesen (readLevel() setzt zurück und wird vom Pegel-Takt mitgelesen)
  const levels: { at: number; rmsDb: number }[] = [];
  app.subscribe((e) => {
    if (e.type === 'MODE_CHANGED') events.push((e.payload as { mode: string }).mode);
    if (e.type === 'playout.level') levels.push({ at: Date.now(), rmsDb: (e.payload as { rmsDb: number }).rmsDb });
  });
  const loudSince = (t: number) => Math.max(-90, ...levels.filter((l) => l.at >= t).map((l) => l.rmsDb));
  app.start();
  return { app, live, events, loudSince };
}

test('Sendebus: Live-Quelle wird gemischt – Format und Verbindung bleiben, Automation pausiert, MANUAL', { skip, timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-bus-'));
  const ice = await iceMock();
  const { app, live, events, loudSince } = await setup(dir, ice.port);
  let enc: ChildProcess | null = null;
  try {
    app.startPlayout(admin, 'main', { format: 'mp3', bitrateKbps: 64, crossfadeMs: 0 });
    await until(() => ice.conns.length === 1 && ice.bytes() > 2000, 10_000, 'Ausgang verbunden');
    assert.match(ice.conns[0]!, /audio\/mpeg$/);
    assert.equal(app.modeView('main').mode, 'AUTO');

    // LIVE: Ogg/Opus-Encoder verbindet (höhere Priorität)
    enc = liveEncoder(app, live, 'sine=f=1000:sample_rate=48000');
    await until(() => app.modeView('main').mode === 'LIVE', 10_000, 'Modus LIVE');
    await until(() => (app.playoutView('main') as { status: { live: { primed: boolean }[] } }).status.live[0]?.primed === true, 10_000, 'Live-Kanal gepuffert');
    const played = app.history('main').length;
    const queued = (app.queueView('main') as { items: unknown[] }).items.length;
    const liveFrom = Date.now() + 500; // nach der Überblendung
    await wait(5000); // länger als ein Titel
    assert.equal(app.history('main').length, played, 'während LIVE werden keine Titel verbraucht');
    assert.equal((app.queueView('main') as { items: unknown[] }).items.length, queued);
    assert.equal(app.modeView('main').program, live.id);
    const level = loudSince(liveFrom);
    assert.ok(level > -30, `Live-Ton ist im Programm (${level} dB)`);
    // die Kernaussage: kein Formatwechsel, keine neue Verbindung der Ausgänge
    assert.equal(ice.conns.length, 1, `Ausgang wird nicht neu verbunden (${ice.conns.join(', ')})`);

    // Live endet → zurück in AUTO, die Automation setzt fort
    enc.kill('SIGKILL');
    enc = null;
    app.ingestClose(live);
    await until(() => app.modeView('main').mode === 'AUTO', 10_000, 'zurück in AUTO');
    await until(() => app.history('main').length > played, 10_000, 'Automation spielt weiter');
    assert.equal(ice.conns.length, 1, ice.conns.join(', '));

    // MANUAL: Automation startet keinen Titel mehr selbst; „jetzt senden“ geht
    app.setBaseMode(admin, 'main', 'MANUAL');
    assert.equal(app.modeView('main').mode, 'MANUAL');
    const before = app.history('main').length;
    await wait(5500); // laufender Titel (4 s) endet, danach kommt nichts von selbst
    assert.equal(app.history('main').length, before, 'MANUAL: kein automatischer nächster Titel');
    app.playNow(admin, 'main', 'c.wav');
    await until(() => (app.nowPlaying('main') as { mediaId: string }).mediaId === 'c.wav', 5000, 'jetzt senden');
    app.setBaseMode(admin, 'main', 'AUTO');
    assert.deepEqual(events.slice(0, 4), ['LIVE', 'AUTO', 'MANUAL', 'AUTO']);
  } finally {
    enc?.kill('SIGKILL');
    app.shutdown();
    ice.server.closeAllConnections();
    ice.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Live ohne laufenden Bus (WebM wie Studio-Mikrofon/App): Bus startet automatisch in MP3 und endet mit der Sendung', { skip, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-bus-'));
  const ice = await iceMock();
  const { app, live, loudSince } = await setup(dir, ice.port);
  let enc: ChildProcess | null = null;
  try {
    const t0 = Date.now();
    enc = liveEncoder(app, live, 'sine=f=800:sample_rate=48000', 'webm');
    await until(() => app.playouts.has('main'), 10_000, 'Bus gestartet');
    await until(() => ice.conns.length >= 1 && ice.bytes() > 2000, 10_000, 'Ausgang verbunden');
    assert.ok(ice.conns.every((c) => c.endsWith('audio/mpeg')), `Ausgänge nur MP3 (${ice.conns.join(', ')})`);
    assert.equal(app.modeView('main').mode, 'LIVE');
    await until(() => loudSince(t0) > -30, 10_000, 'WebM-Live-Ton im Programm');
    // die Automation-Quelle konkurriert nicht mit der Live-Sendung
    const auto = app.engine.list('main').find((s) => s.type === 'automation')!;
    assert.equal(app.engine.get(auto.id)!.state, 'disconnected');

    enc.kill('SIGKILL');
    enc = null;
    app.ingestClose(live);
    await until(() => !app.playouts.has('main'), 10_000, 'Bus nach Live beendet');
    assert.equal((app.playoutView('main') as { config: { autostart: boolean } }).config.autostart, false, 'Autostart unverändert');
  } finally {
    enc?.kill('SIGKILL');
    app.shutdown();
    ice.server.closeAllConnections();
    ice.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Stille auf der Live-Quelle: Rückfall auf die Automation', { skip, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-bus-'));
  const ice = await iceMock();
  const { app, live } = await setup(dir, ice.port);
  let enc: ChildProcess | null = null;
  try {
    app.startPlayout(admin, 'main', { format: 'mp3', bitrateKbps: 64, crossfadeMs: 0, silenceMs: 2000 });
    await until(() => ice.bytes() > 2000, 10_000, 'Ausgang verbunden');
    enc = liveEncoder(app, live, 'anullsrc=r=48000:cl=stereo');
    await until(() => app.modeView('main').mode === 'LIVE', 10_000, 'Modus LIVE');
    await until(() => app.modeView('main').mode === 'AUTO', 15_000, 'Stille → zurück in AUTO');
    assert.equal(app.engine.get(live.id)!.healthy, false, 'stille Live-Quelle bleibt abgeschaltet, bis sie neu verbindet');
    assert.equal(ice.conns.length, 1, ice.conns.join(', '));
  } finally {
    enc?.kill('SIGKILL');
    app.shutdown();
    ice.server.closeAllConnections();
    ice.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
