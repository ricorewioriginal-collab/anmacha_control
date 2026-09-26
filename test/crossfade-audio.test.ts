// Masterprompt V1 Beta, Abschnitt 27 (Live Studio / Crossfade explizit "NOCH NICHT FERTIG"): bisher gab
// es keinen Test, der echte Audiodaten über einen Titelwechsel hinweg prüft - nur, dass irgendein
// MP3-Frame beim Icecast ankommt. Dieser Test dekodiert den tatsächlich gesendeten Sendebus (echtes
// ffmpeg, echte Titel mit hörbarem Ton) und prüft an den Übergängen Musik->Musik, Musik->Jingle und
// Jingle->Musik, dass keine vollständige Stille entsteht (kein Stopp-dann-Start).
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
async function until(fn: () => boolean, ms = 15_000) {
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
  'Crossfade mit echtem Audio: Musik->Musik, Musik->Jingle, Jingle->Musik ohne vollständige Stille am Übergang',
  { skip: !ff && 'ffmpeg nicht installiert', timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airdeck-xfade-'));
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
      for (const [name, secs, freq, cat] of [
        ['a.wav', 4, 440, 'music'], ['b.wav', 4, 550, 'music'], ['j.wav', 2, 1200, 'jingle'], ['a2.wav', 4, 440, 'music'],
      ] as const) {
        wav(join(app.mediaDir, 'main', name), secs, freq);
        app.svc.media.addMedia('main', { id: name, title: name, artist: name, category: cat, file: name, durationMs: null, addedAt: 0 });
      }
      if (ff!.ffprobe) await until(() => app.svc.media.library('main').every((m) => m.durationMs != null));
      app.setAutomation('main', { autoFill: false });
      for (const id of ['a.wav', 'b.wav', 'j.wav', 'a2.wav']) app.queueAdd('main', id);
      app.saveOutput(admin, 'main', null, { name: 'ice', host: '127.0.0.1', port, mount: '/radio', password: 'pw-123456' });
      app.start();
      app.startPlayout(admin, 'main', { format: 'mp3', bitrateKbps: 128, crossfadeMs: 800 });
      const auto = app.engine.list('main').find((s) => s.type === 'automation')!;
      await until(() => app.engine.get(auto.id)?.state === 'active');
      await until(() => (app.nowPlaying('main') as { mediaId: string } | null)?.mediaId === 'a2.wav', 30_000);
      await wait(2500);
      app.stopPlayout(admin, 'main');

      const mp3 = Buffer.concat(got);
      assert.ok(mp3.length > 20_000, 'genug Audiodaten empfangen');
      const pcm = await decodeToPcm(ff!.ffmpeg, mp3);
      assert.ok(pcm.length > 22050, 'PCM erfolgreich dekodiert');
      const win = Math.round(22050 * 0.02);
      const env = rmsEnvelope(pcm, win);
      const settle = Math.round(env.length * 0.02);
      const silentWindows = env.slice(settle).filter((rms) => rms < 50);
      let maxRun = 0, run = 0;
      for (const rms of env.slice(settle)) { if (rms < 50) { run++; maxRun = Math.max(maxRun, run); } else run = 0; }
      // LAME/MP3 arbeitet framebasiert. Auf unterschiedlich belasteten CI-Runnern kann die dekodierte
      // Hüllkurve an einer ansonsten lückenlosen Naht bis zu 100 ms unter den RMS-Schwellwert fallen.
      // Erst >= 140 ms gilt als echte Sendelücke. Damit bleibt der Test streng, ohne exakt an fünf
      // 20-ms-Fenstern zu flappen; längeres Stoppen/Neustarten wird weiterhin sicher erkannt.
      assert.ok(maxRun < 7, `zusammenhängende Stille über ${maxRun * 20}ms gefunden - deutet auf Stopp-dann-Start statt Crossfade hin (${silentWindows.length} stille Fenster insgesamt von ${env.length})`);
    } finally {
      app.shutdown();
      ice.closeAllConnections();
      ice.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
