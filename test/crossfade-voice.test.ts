// Masterprompt V1 Beta, Abschnitt 27 (Crossfade "NOCH NICHT FERTIG"): #14 deckte Musik<->Musik/Jingle ab,
// #20/21 Musik<->externer Stream. Noch offen war Voice->Musik: ein aufgenommener Moderationslink
// (Voice Tracking, category 'voice_track'), der in die Queue eingefügt wird und in den nächsten Titel
// übergeht - genau wie die anderen Kategorien real mit echtem Audio/echtem ffmpeg/echtem Sendebus geprüft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { detectFfmpeg } from '../src/server/ffmpeg.ts';

const ff = detectFfmpeg(process.cwd());
const admin = { id: 'admin', tokenId: 't', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 20_000) {
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
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  writeFileSync(file, b);
}

function decodeToPcm(ffmpeg: string, mp3: Buffer): Promise<Int16Array> {
  return new Promise((resolveP, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0', '-f', 's16le', '-ar', '22050', '-ac', '1', 'pipe:1'], { windowsHide: true });
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', reject);
    p.on('close', () => {
      const buf = Buffer.concat(chunks);
      resolveP(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
    });
    p.stdin.write(mp3);
    p.stdin.end();
  });
}

function rmsEnvelope(pcm: Int16Array, window: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + window <= pcm.length; i += window) {
    let sum = 0;
    for (let j = i; j < i + window; j++) sum += pcm[j]! * pcm[j]!;
    out.push(Math.sqrt(sum / window));
  }
  return out;
}

test(
  'Crossfade mit echtem Audio: Voice Track (Moderationslink) -> Musik ohne Stille-Lücke, mit echter Ausblendung',
  { skip: !ff && 'ffmpeg nicht installiert', timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airdeck-xfade-voice-'));
    const got: Buffer[] = [];
    const ice = createServer((req, res) => {
      if (req.url?.startsWith('/admin/')) return void res.end('ok');
      res.writeHead(200);
      res.flushHeaders();
      req.on('data', (d: Buffer) => got.push(d));
    });
    await new Promise<void>((r) => ice.listen(0, '127.0.0.1', r));
    const port = (ice.address() as { port: number }).port;

    const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
    try {
      wav(join(app.mediaDir, 'main', 'a.wav'), 4, 440);
      wav(join(app.mediaDir, 'main', 'voice.wav'), 3, 300);
      wav(join(app.mediaDir, 'main', 'b.wav'), 4, 550);
      app.svc.media.addMedia('main', { id: 'a.wav', title: 'a', artist: 'A', category: 'music', file: 'a.wav', durationMs: null, addedAt: 0 });
      const voice = app.svc.media.addMedia('main', { id: 'voice.wav', title: 'Moderationslink', artist: '', category: 'voice_track', file: 'voice.wav', durationMs: null, addedAt: 0 });
      app.svc.media.addMedia('main', { id: 'b.wav', title: 'b', artist: 'B', category: 'music', file: 'b.wav', durationMs: null, addedAt: 0 });
      if (ff!.ffprobe) await until(() => app.svc.media.library('main').every((m) => m.durationMs != null));

      app.setAutomation('main', { autoFill: false });
      for (const id of ['a.wav', 'voice.wav', 'b.wav']) app.queueAdd('main', id);

      app.saveOutput(admin, 'main', null, { name: 'ice', host: '127.0.0.1', port, mount: '/radio', password: 'pw-123456' });
      app.start();
      app.startPlayout(admin, 'main', { format: 'mp3', bitrateKbps: 128, crossfadeMs: 800 });
      const auto = app.engine.list('main').find((s) => s.type === 'automation')!;
      await until(() => app.engine.get(auto.id)?.state === 'active');

      await until(() => (app.nowPlaying('main') as { mediaId: string } | null)?.mediaId === voice.id, 30_000);
      let sawVoiceFading = false;
      const checkFading = setInterval(() => {
        const status = (app.playoutView('main') as { status: { fading: { mediaId: string } | null } }).status;
        if (status.fading?.mediaId === voice.id) sawVoiceFading = true;
      }, 10);
      await until(() => (app.nowPlaying('main') as { mediaId: string } | null)?.mediaId === 'b.wav', 30_000);
      await wait(2000);
      clearInterval(checkFading);
      app.stopPlayout(admin, 'main');

      const mp3 = Buffer.concat(got);
      assert.ok(mp3.length > 20_000, 'genug Audiodaten empfangen');
      const pcm = await decodeToPcm(ff!.ffmpeg, mp3);
      assert.ok(pcm.length > 22050, 'PCM erfolgreich dekodiert');

      const win = Math.round(22050 * 0.02);
      const env = rmsEnvelope(pcm, win);
      const settle = Math.round(env.length * 0.02);
      let maxRun = 0, run = 0;
      for (const rms of env.slice(settle)) { if (rms < 50) { run++; maxRun = Math.max(maxRun, run); } else run = 0; }
      assert.ok(maxRun < 5, `zusammenhängende Stille über ${maxRun * 20}ms beim Übergang Voice Track -> Musik gefunden (${env.length} Fenster geprüft)`);
      assert.ok(sawVoiceFading, 'Voice Track wurde beim Übergang zur Musik wirklich ausgeblendet (Crossfade), nicht hart geschnitten');
    } finally {
      app.shutdown();
      ice.closeAllConnections();
      ice.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
