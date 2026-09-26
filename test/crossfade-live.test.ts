// Masterprompt V1 Beta, Abschnitt 27 (Crossfade "NOCH NICHT FERTIG"): #14 deckte Musik<->Musik/Jingle,
// #20/21 externer Stream<->Musik und ein früherer Schritt Voice Track->Musik ab. Der letzte in der
// README offen gelassene Fall war Live->Automation (und zurück): eine echte Live-Quelle (Mikrofon/App/
// Encoder) übernimmt das Programm und gibt es wieder ab - genau wie bei den anderen Fällen mit echtem
// Audio/echtem ffmpeg/echtem Sendebus geprüft, nicht nur "Modus wechselt".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
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
async function until(fn: () => boolean, ms = 15_000, what = 'Bedingung') {
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
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  writeFileSync(file, b);
}

/** Live-Encoder wie BUTT/Studio-Mikrofon: Opus in Ogg in Echtzeit, direkt in den Ingest der App */
function liveEncoder(app: AirDeckApp, src: SourceConfig, input: string): ChildProcess {
  const p = spawn(ff!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', input, '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  app.ingestOpen(src, 'audio/ogg');
  p.stdout!.on('data', (d: Buffer) => app.ingestData(src, d));
  return p;
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
  'Crossfade mit echtem Audio: Live-Quelle übernimmt das Programm und gibt es zurück, ohne Stille-Lücke am Übergang',
  { skip, timeout: 90_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airdeck-xfade-live-'));
    const got: Buffer[] = [];
    const ice = createServer((req, res) => {
      if (req.url?.startsWith('/admin/') || req.method === 'GET') return void res.end('ok');
      res.writeHead(200);
      res.flushHeaders();
      req.on('data', (d: Buffer) => got.push(d));
    });
    await new Promise<void>((r) => ice.listen(0, '127.0.0.1', r));
    const port = (ice.address() as { port: number }).port;

    const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
    let enc: ChildProcess | null = null;
    try {
      // Ein langer, durchgehender Titel, damit die Automation vor UND nach der Live-Sendung im
      // Mitschnitt ist (kein Titelende überlagert den Übergang).
      wav(join(app.mediaDir, 'main', 'a.wav'), 30, 440);
      app.svc.media.addMedia('main', { id: 'a.wav', title: 'a', artist: 'A', category: 'music', file: 'a.wav', durationMs: null, addedAt: 0 });
      app.setAutomation('main', { autoFill: false });
      app.queueAdd('main', 'a.wav');

      app.saveOutput(admin, 'main', null, { name: 'ice', host: '127.0.0.1', port, mount: '/radio', password: 'pw-123456' });
      const live = app.engine.list('main').find((s) => s.type === 'live_studio')!;
      app.start();
      app.startPlayout(admin, 'main', { format: 'mp3', bitrateKbps: 128, crossfadeMs: 800 });
      const auto = app.engine.list('main').find((s) => s.type === 'automation')!;
      await until(() => app.engine.get(auto.id)?.state === 'active');
      await until(() => (app.nowPlaying('main') as { mediaId: string } | null)?.mediaId === 'a.wav');
      await wait(1500); // etwas Automation im Mitschnitt vor der Live-Übernahme

      enc = liveEncoder(app, live, 'sine=f=1400:sample_rate=48000');
      await until(() => app.modeView('main').mode === 'LIVE', 10_000, 'Modus LIVE');
      await wait(4000); // Live-Ton im Mitschnitt (lang genug für den Fade-In und stabiles Signal danach)

      enc.kill('SIGKILL');
      enc = null;
      app.ingestClose(live);
      await until(() => app.modeView('main').mode === 'AUTO', 10_000, 'zurück in AUTO');
      await wait(2500); // Automation nach der Übergabe im Mitschnitt
      app.stopPlayout(admin, 'main');

      const mp3 = Buffer.concat(got);
      assert.ok(mp3.length > 20_000, 'genug Audiodaten empfangen');
      const pcm = await decodeToPcm(ff!.ffmpeg, mp3);
      assert.ok(pcm.length > 22050, 'PCM erfolgreich dekodiert (kein korruptes MP3 durch den Quellenwechsel)');

      const win = Math.round(22050 * 0.02);
      const env = rmsEnvelope(pcm, win);
      const settle = Math.round(env.length * 0.02);
      let maxRun = 0, run = 0;
      for (const rms of env.slice(settle)) { if (rms < 50) { run++; maxRun = Math.max(maxRun, run); } else run = 0; }
      assert.ok(maxRun < 5, `zusammenhängende Stille über ${maxRun * 20}ms gefunden - deutet auf Stopp-dann-Start statt Crossfade beim Live-Wechsel hin (${env.length} Fenster geprüft)`);
    } finally {
      enc?.kill('SIGKILL');
      app.shutdown();
      ice.closeAllConnections();
      ice.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
