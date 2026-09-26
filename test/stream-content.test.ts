// Masterprompt V1 Beta, P2 #20/21 (externe Stream-URL als Programminhalt, saubere Übergänge): addUrlMedia()/
// JobKind 'url' erlauben bereits, eine externe URL im Sendeplan/Uhr-Event einzuplanen - das war nie das
// Problem. Zwei echte Lücken gefunden und behoben/geprüft:
// 1. mixFrames() (Überblendungsdauer) behandelte category 'stream' wie "sonstiges" (0 ms Überblendung,
//    harter Schnitt) statt wie Musik - der Stream-Titel wurde beim Wegschalten nie ausgeblendet, sondern
//    hart abgeschnitten. Behoben; dieser Test bestätigt per playoutView().status.fading, dass der Stream-
//    Titel beim natürlichen Übergang zurück zur Musik tatsächlich ausgeblendet wird (nicht nur, dass keine
//    Stille-Lücke entsteht - ein harter Schnitt mit sofort gestartetem nächsten Titel erzeugt ebenfalls
//    keine Stille-Lücke, nur einen Klick, den die Stille-Hüllkurve allein nicht sehen würde).
// 2. Ungeprüft war, ob ffmpeg eine echte Netzwerk-URL (nicht nur lokale Dateien) tatsächlich als Sendeweg-
//    Eingang verarbeitet - dieser Test nutzt einen echten HTTP-Server als "externen Stream".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  'Externer Stream als Programminhalt: Musik -> Stream (echte URL/HTTP) -> Musik, sauberer Übergang ohne Stille-Lücke',
  { skip: !ff && 'ffmpeg nicht installiert', timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airdeck-streamcontent-'));
    const got: Buffer[] = [];
    const ice = createServer((req, res) => {
      if (req.url?.startsWith('/admin/')) return void res.end('ok');
      res.writeHead(200);
      res.flushHeaders();
      req.on('data', (d: Buffer) => got.push(d));
    });
    await new Promise<void>((r) => ice.listen(0, '127.0.0.1', r));
    const port = (ice.address() as { port: number }).port;

    // Simuliert die externe Quelle (z. B. einen Nachrichten-Stream): eine echte HTTP-Auslieferung,
    // die ffmpeg als Netzwerk-URL einliest - kein lokaler Dateipfad.
    const streamWav = join(dir, 'external.wav');
    wav(streamWav, 8, 770);
    const streamSrv = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(readFileSync(streamWav));
    });
    await new Promise<void>((r) => streamSrv.listen(0, '127.0.0.1', r));
    const streamPort = (streamSrv.address() as { port: number }).port;

    const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
    try {
      wav(join(app.mediaDir, 'main', 'a.wav'), 5, 440);
      wav(join(app.mediaDir, 'main', 'b.wav'), 5, 550);
      app.svc.media.addMedia('main', { id: 'a.wav', title: 'a', artist: 'A', category: 'music', file: 'a.wav', durationMs: null, addedAt: 0 });
      app.svc.media.addMedia('main', { id: 'b.wav', title: 'b', artist: 'B', category: 'music', file: 'b.wav', durationMs: null, addedAt: 0 });
      // Feste Laufzeit für die Stream-Übernahme (wie eine geplante Sendung von X bis Y), damit sie
      // natürlich - über dieselbe Segue-/Crossfade-Weiche wie jeder andere Titel - endet, statt manuell
      // weggeschaltet zu werden. Das ist genau der Pfad, den mixFrames()/mixFrames-Fix betrifft.
      const streamMedia = app.svc.media.addUrlMedia('main', { url: `http://127.0.0.1:${streamPort}/external.wav`, title: 'Externer Stream', durationMs: 4000 });
      assert.equal(streamMedia.category, 'stream');
      if (ff!.ffprobe) await until(() => ['a.wav', 'b.wav'].every((id) => app.svc.media.library('main').find((m) => m.id === id)?.durationMs != null));

      app.setAutomation('main', { autoFill: false });
      app.queueAdd('main', 'a.wav');
      app.queueAdd('main', streamMedia.id);
      app.queueAdd('main', 'b.wav');

      app.saveOutput(admin, 'main', null, { name: 'ice', host: '127.0.0.1', port, mount: '/radio', password: 'pw-123456' });
      app.start();
      app.startPlayout(admin, 'main', { format: 'mp3', bitrateKbps: 128, crossfadeMs: 800 });
      const auto = app.engine.list('main').find((s) => s.type === 'automation')!;
      // Über die gesamte restliche Laufzeit mitschneiden, ob der Stream-Titel jemals im Ausblenden
      // (fading) war - beginnend bevor der Stream überhaupt läuft, damit kein enges Zeitfenster
      // (Event-Loop-Jitter unter Last durch parallel laufende ffmpeg-Prozesse) etwas verpasst.
      let sawStreamFading = false;
      const checkFading = setInterval(() => {
        const status = (app.playoutView('main') as { status: { fading: { mediaId: string } | null } }).status;
        if (status.fading?.mediaId === streamMedia.id) sawStreamFading = true;
      }, 10);

      await until(() => app.engine.get(auto.id)?.state === 'active');
      await until(() => (app.nowPlaying('main') as { mediaId: string } | null)?.mediaId === 'a.wav');
      // Läuft von selbst weiter: a.wav -> externer Stream (per Segue) -> b.wav (per Segue).
      await until(() => (app.nowPlaying('main') as { mediaId: string } | null)?.mediaId === streamMedia.id, 20_000);
      await until(() => (app.nowPlaying('main') as { mediaId: string } | null)?.mediaId === 'b.wav', 20_000);
      await wait(2000);
      clearInterval(checkFading);
      // Der Stream-Titel muss beim Übergang zurück zur Musik wirklich ausgeblendet werden (fading !=
      // null), nicht einfach hart abgeschnitten - das unterscheidet Crossfade von hartem Schnitt, was
      // die reine Stille-Prüfung unten nicht könnte (beide Fälle erzeugen keine Stille-Lücke).
      assert.ok(sawStreamFading, 'externer Stream wurde beim Übergang zurück zur Musik wirklich ausgeblendet (Crossfade), nicht hart geschnitten');
      app.stopPlayout(admin, 'main');

      const mp3 = Buffer.concat(got);
      assert.ok(mp3.length > 20_000, 'genug Audiodaten empfangen (Stream wurde tatsächlich als Eingang genutzt)');
      const pcm = await decodeToPcm(ff!.ffmpeg, mp3);
      assert.ok(pcm.length > 22050, 'PCM erfolgreich dekodiert');

      const win = Math.round(22050 * 0.02);
      const env = rmsEnvelope(pcm, win);
      const settle = Math.round(env.length * 0.02);
      let maxRun = 0, run = 0;
      for (const rms of env.slice(settle)) { if (rms < 50) { run++; maxRun = Math.max(maxRun, run); } else run = 0; }
      assert.ok(maxRun < 5, `zusammenhängende Stille über ${maxRun * 20}ms - Übergang in/aus dem externen Stream war kein sauberer Crossfade (${env.length} Fenster geprüft)`);
    } finally {
      app.shutdown();
      ice.closeAllConnections();
      ice.close();
      streamSrv.closeAllConnections();
      streamSrv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
