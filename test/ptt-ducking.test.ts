// Masterprompt V1 Beta, Abschnitt 26 (P2 #25 Voice Tracking/PTT): Live-Voice/PTT existiert bereits real im
// Code (echtes Mikrofon/Line-In im Audiopfad, Ducking, Gain, PFL/Monitoring, Push-to-Talk im Client) - aber
// nur der reine An/Aus-Status war getestet (po.status().micOn), nie die tatsächliche akustische Wirkung.
// "Ein UI-Button gilt nicht als Funktion" - dieser Test misst den echten Pegel im gesendeten Signal:
// 1. Ducking senkt die Musik wirklich ab, sobald das Mikrofon an ist (nicht nur ein Statusflag).
// 2. Das Mikrofonsignal selbst landet wirklich hörbar im gesendeten Signal (kein stummer Kanal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Playout, DEFAULT_PLAYOUT } from '../src/server/playout.ts';
import { detectFfmpeg } from '../src/server/ffmpeg.ts';
import type { MediaItem } from '../src/core/automation.ts';

const ff = detectFfmpeg(process.cwd());
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timeout');
    await wait(20);
  }
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

function rms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (const s of pcm) sum += s * s;
  return Math.sqrt(sum / pcm.length);
}

/** Sendebus mit fester Musik und einer simulierten Mikrofon-Quelle für eine Weile aufzeichnen. */
async function captureWithMic(ffmpeg: string, media: MediaItem, file: string, micArgs: string[], micOnAfterMs: number | null): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const po = new Playout(ffmpeg, {
    nextTrack: () => media, mediaPath: () => file, onNowPlaying: () => {}, onStreamStart: () => {},
    onStreamData: (d) => chunks.push(d), onStreamStop: () => {}, onSilence: () => {}, log: () => {},
  }, { format: 'mp3', bitrateKbps: 128, inputDevice: 'test', duckDb: -10 }, { inputArgs: () => micArgs });
  po.start();
  await until(() => po.status().input === 'running');
  if (micOnAfterMs !== null) {
    await wait(micOnAfterMs);
    po.setMic(true);
  }
  await until(() => Buffer.concat(chunks).length > 60_000, 15_000);
  po.stop();
  return Buffer.concat(chunks);
}

test(
  'Push-to-Talk: Ducking senkt die Musik real ab, und das Mikrofonsignal landet wirklich im gesendeten Signal',
  { skip: !ff && 'ffmpeg nicht installiert', timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airdeck-ptt-'));
    try {
      const file = join(dir, 'music.mp3');
      execFileSync(ff!.ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=6', file]);
      const media: MediaItem = { id: 'm', title: 'm', artist: '', category: 'music', file: 'music.mp3', durationMs: 6000, addedAt: 0 };

      // A) Mikrofon nie an - reine Musik als Referenzpegel
      const off = await decodeToPcm(ff!.ffmpeg, await captureWithMic(ff!.ffmpeg, media, file, ['-f', 'lavfi', '-i', 'anullsrc'], null));
      // B) Mikrofon an, aber die "Mikrofon"-Quelle selbst ist stumm (anullsrc) - zeigt reinen Ducking-Effekt
      //    auf die Musik, ohne durch echte Mikrofon-Energie verfälscht zu werden.
      const duckedSilentMic = await decodeToPcm(ff!.ffmpeg, await captureWithMic(ff!.ffmpeg, media, file, ['-f', 'lavfi', '-i', 'anullsrc'], 200));
      // C) Mikrofon an, mit echtem (simuliertem) Mikrofonsignal.
      const duckedRealMic = await decodeToPcm(ff!.ffmpeg, await captureWithMic(ff!.ffmpeg, media, file, ['-f', 'lavfi', '-i', 'sine=f=2000'], 200));

      const rmsOff = rms(off.subarray(Math.floor(off.length / 2)));
      const rmsDuckedSilent = rms(duckedSilentMic.subarray(Math.floor(duckedSilentMic.length / 2)));
      const rmsDuckedReal = rms(duckedRealMic.subarray(Math.floor(duckedRealMic.length / 2)));

      assert.ok(rmsOff > 500, `Referenzmusik sollte deutlich hörbar sein (RMS=${rmsOff})`);
      const duckDb = 20 * Math.log10(rmsDuckedSilent / rmsOff);
      assert.ok(duckDb < -5, `Ducking senkt die Musik messbar ab, erwartet spürbar unter 0 dB, gemessen ${duckDb.toFixed(1)} dB`);

      assert.ok(rmsDuckedReal > rmsDuckedSilent * 1.5, `Mikrofonsignal muss im gesendeten Signal ankommen (mit Ton lauter als mit stummer Quelle): ${rmsDuckedReal} vs. ${rmsDuckedSilent}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
