// Integrationstest Server-Playout mit echtem ffmpeg (wird übersprungen, wenn ffmpeg fehlt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { detectFfmpeg } from '../src/server/ffmpeg.ts';

const ff = detectFfmpeg(process.cwd());
const admin = { id: 'admin', tokenId: 't', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timeout');
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

test('Server-Playout sendet 24/7 ohne Browser, mit Skip, Neustart und Stille-Fallback', { skip: !ff && 'ffmpeg nicht installiert', timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-po-'));
  const got: Buffer[] = [];
  const ice = createServer((req, res) => {
    if (req.url?.startsWith('/admin/')) return void res.end('ok');
    res.writeHead(200);
    res.flushHeaders();
    req.on('data', (d: Buffer) => got.push(d));
  });
  await new Promise<void>((r) => ice.listen(0, '127.0.0.1', r));
  const port = (ice.address() as { port: number }).port;

  let app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
  try {
    for (const [name, secs, freq, cat] of [
      ['a.wav', 3, 440, 'music'], ['b.wav', 3, 550, 'music'], ['id.wav', 1, 880, 'station_id'],
    ] as const) {
      wav(join(app.mediaDir, 'main', name), secs, freq);
      app.addMedia('main', { id: name, title: name, artist: name, category: cat, file: name, durationMs: null, addedAt: 0 });
    }
    // ffprobe ermittelt Laufzeiten serverseitig
    if (ff!.ffprobe) await until(() => app.library('main').every((m) => m.durationMs != null));

    app.saveOutput(admin, 'main', null, { name: 'ice', host: '127.0.0.1', port, mount: '/radio', password: 'pw-123456' });
    app.start();
    app.startPlayout(admin, 'main', { format: 'mp3', bitrateKbps: 64, crossfadeMs: 1000 });
    const auto = app.engine.list('main').find((s) => s.type === 'automation')!;
    await until(() => app.engine.get(auto.id)?.state === 'active');
    await until(() => Buffer.concat(got).length > 4000);
    const data = Buffer.concat(got);
    assert.ok(data.includes(Buffer.from([0xff])) , 'MP3-Frames erwartet');

    const first = (app.nowPlaying('main') as { mediaId: string }).mediaId;
    assert.equal(first, 'id.wav', 'Sendeuhr beginnt mit Station ID');
    await until(() => (app.nowPlaying('main') as { mediaId: string }).mediaId !== first);
    const second = (app.nowPlaying('main') as { mediaId: string }).mediaId;
    app.skipPlayout('main');
    await until(() => (app.nowPlaying('main') as { mediaId: string }).mediaId !== second);

    // Browser-Stream auf dieselbe Quelle wird abgewiesen
    assert.throws(() => app.studioChunk(admin, 'main', auto.id, 'audio/webm', Buffer.from('x'), true), /Server-Playout/);

    // Neustart: Playout läuft automatisch wieder an (autostart)
    app.shutdown();
    app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
    app.start();
    await until(() => app.engine.get(auto.id)?.state === 'active');
    assert.equal((app.playoutView('main') as { status: { running: boolean } }).status.running, true);

    // Stille: nur stille Titel → Quelle fällt aus, Fallback auf Backup
    for (const m of [...app.library('main')]) app.removeMedia('main', m.id);
    wav(join(app.mediaDir, 'main', 'quiet.wav'), 20, 0);
    app.addMedia('main', { id: 'quiet.wav', title: 'quiet', artist: '', category: 'music', file: 'quiet.wav', durationMs: 20000, addedAt: 0 });
    app.stopPlayout(admin, 'main');
    const backup = app.engine.addSource({ id: 'backup', stationId: 'main', name: 'Backup', type: 'backup_automation', target: '/live', priority: 20, takeoverPolicy: 'auto', allowedRoles: [] });
    app.engine.connect(backup.id);
    app.startPlayout(admin, 'main', { silenceMs: 2000 });
    await until(() => app.engine.get(auto.id)?.state === 'active');
    await until(() => app.engine.get(auto.id)?.state === 'failed', 10_000);
    assert.equal(app.engine.activeFor('main', '/live')?.id, 'backup');

    // Bewusst gestoppt → kein Autostart
    app.stopPlayout(admin, 'main');
    assert.equal((app.playoutView('main') as { config: { autostart: boolean } }).config.autostart, false);
  } finally {
    app.shutdown();
    ice.closeAllConnections();
    ice.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
