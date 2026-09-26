// Masterprompt V1 Beta, P3 #29 (HLS): AirDeckCast konnte bisher nur Icecast/SHOUTcast-Ziele bedienen
// (Push per HTTP PUT an einen externen Server). HLS (Apple HTTP Live Streaming) ist ein Pull-Format:
// der AirDeck-Server selbst liefert eine Playlist (.m3u8) und Segmente (.ts) über HTTP aus - kein externer
// Icecast nötig. Audit: derselbe PCM-Programmbus, den auch die Zusatzprofile (#26/#28) nutzen, kann einen
// weiteren ffmpeg-Prozess speisen, der ihn per "-f hls" selbst in Segmente + Playlist teilt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';
import { detectFfmpeg } from '../src/server/ffmpeg.ts';

const ff = detectFfmpeg(process.cwd());
const admin = { id: 'admin', tokenId: 't', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timeout');
    await wait(50);
  }
}

function wav(file: string, seconds: number, freq: number): void {
  const rate = 22050;
  const n = Math.floor(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  writeFileSync(file, b);
}

function decodeToPcm(ffmpeg: string, data: Buffer, inputFormat: string): Promise<Int16Array> {
  return new Promise((resolveP, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', inputFormat, '-i', 'pipe:0', '-f', 's16le', '-ar', '22050', '-ac', '1', 'pipe:1'], { windowsHide: true });
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', reject);
    p.on('close', () => {
      const buf = Buffer.concat(chunks);
      resolveP(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
    });
    p.stdin.write(data);
    p.stdin.end();
  });
}

function rms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (const s of pcm) sum += s * s;
  return Math.sqrt(sum / pcm.length);
}

test(
  'AirDeckCast HLS: Sendebus liefert eine echte Playlist mit Segmenten, direkt über den AirDeck-HTTP-Server abrufbar',
  { skip: !ff && 'ffmpeg nicht installiert', timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airdeck-hls-'));
    const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
    const server: Server = createHttpServer(app, join(import.meta.dirname, '../studio'));
    try {
      wav(join(app.mediaDir, 'main', 'a.wav'), 8, 440);
      app.svc.media.addMedia('main', { id: 'a.wav', title: 'a', artist: 'A', category: 'music', file: 'a.wav', durationMs: null, addedAt: 0 });
      app.setAutomation('main', { autoFill: false });
      app.queueAdd('main', 'a.wav');

      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const token = app.svc.auth.desktopToken();

      app.start();
      app.startPlayout(admin, 'main', { format: 'mp3', bitrateKbps: 128, hls: { enabled: true, bitrateKbps: 96, segmentSeconds: 2 } });
      const auto = app.engine.list('main').find((s) => s.type === 'automation')!;
      await until(() => app.engine.get(auto.id)?.state === 'active');

      const playlistPath = join(app.hlsDir, 'main', 'index.m3u8');
      await until(() => existsSync(playlistPath) && /\.ts\b/.test(readFileSync(playlistPath, 'utf8')), 20_000);

      const res = await fetch(`${base}/hls/main/index.m3u8`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/vnd.apple.mpegurl');
      const playlist = await res.text();
      assert.match(playlist, /^#EXTM3U/, 'echte HLS-Playlist');
      const segName = playlist.split('\n').find((l) => l.endsWith('.ts'));
      assert.ok(segName, 'Playlist referenziert mindestens ein Segment');

      const segRes = await fetch(`${base}/hls/main/${segName}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(segRes.status, 200);
      assert.equal(segRes.headers.get('content-type'), 'video/mp2t');
      const segBuf = Buffer.from(await segRes.arrayBuffer());
      assert.ok(segBuf.length > 500, 'Segment enthält echte Daten, kein leerer Platzhalter');

      const pcm = await decodeToPcm(ff!.ffmpeg, segBuf, 'mpegts');
      assert.ok(pcm.length > 1000, 'Segment ist echtes, dekodierbares Audio (MPEG-TS/AAC)');
      const level = rms(pcm);
      assert.ok(level > 500, `Segment enthält hörbares Signal (RMS=${level}) - derselbe Programmbus, nicht Stille`);

      // Pfadausbruch wird abgelehnt (kein Zugriff außerhalb des Sender-HLS-Ordners)
      const escape = await fetch(`${base}/hls/main/..%2f..%2fapp.js`, { headers: { Authorization: `Bearer ${token}` } });
      assert.ok(escape.status === 403 || escape.status === 404);

      app.stopPlayout(admin, 'main');
    } finally {
      app.shutdown();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
