// Masterprompt V1 Beta, P3 #26/28 (AirDeckCast: ein Programmbus, mehrere Encoder-Ausgänge): bisher lief
// pro Sender genau EIN Encoder-Prozess (ein Format/eine Bitrate) - für "alternative Stream-Profile"
// (z. B. Standard MP3 128k + Mobile AAC 64k gleichzeitig) hätte es eine zweite komplette Playout-Instanz
// gebraucht. Audit ergab: Der interne Mixer (Playout) schreibt bereits rohe PCM-Daten in einen separaten
// Encoder-Prozess (RAW_IN -> ffmpeg -c:a ...) - ein zweiter Encoder-Prozess kann denselben PCM-Bus einfach
// zusätzlich abonnieren, ohne die Mix-Engine zu duplizieren. Playout.addProfile() macht genau das.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Playout } from '../src/server/playout.ts';
import { detectFfmpeg } from '../src/server/ffmpeg.ts';
import type { MediaItem } from '../src/core/automation.ts';

const ff = detectFfmpeg(process.cwd());
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timeout');
    await wait(20);
  }
}

/** Beliebiges Format zu PCM dekodieren (mit explizitem Eingangsformat, wichtig für ADTS/OGG aus pipe:0). */
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
  'AirDeckCast: ein Programmbus speist gleichzeitig zwei unabhängige Encoder-Profile (Standard MP3 + Mobile AAC)',
  { skip: !ff && 'ffmpeg nicht installiert', timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airdeck-multiprofile-'));
    try {
      const file = join(dir, 'song.mp3');
      execFileSync(ff!.ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=6', file]);
      const media: MediaItem = { id: 'm', title: 'm', artist: '', category: 'music', file: 'song.mp3', durationMs: 6000, addedAt: 0 };

      const mainChunks: Buffer[] = [];
      let mainStarted = '';
      const mobileChunks: Buffer[] = [];
      let mobileStarted = '';
      let mobileStopped = 0;

      const po = new Playout(ff!.ffmpeg, {
        nextTrack: () => media, mediaPath: () => file, onNowPlaying: () => {},
        onStreamStart: (t) => (mainStarted = t), onStreamData: (d) => mainChunks.push(d), onStreamStop: () => {},
        onSilence: () => {}, log: () => {},
      }, { format: 'mp3', bitrateKbps: 128 });

      po.addProfile('mobile', { format: 'aac', bitrateKbps: 64 }, {
        onStreamStart: (t) => (mobileStarted = t),
        onStreamData: (d) => mobileChunks.push(d),
        onStreamStop: () => mobileStopped++,
      });
      assert.deepEqual(po.listProfiles(), ['mobile']);

      po.start();
      await until(() => Buffer.concat(mainChunks).length > 20_000 && Buffer.concat(mobileChunks).length > 10_000);
      const stoppedBeforeStop = mobileStopped;
      po.stop();
      await wait(200);

      assert.equal(mainStarted, 'audio/mpeg');
      assert.equal(mobileStarted, 'audio/aac');

      const mainPcm = await decodeToPcm(ff!.ffmpeg, Buffer.concat(mainChunks), 'mp3');
      const mobilePcm = await decodeToPcm(ff!.ffmpeg, Buffer.concat(mobileChunks), 'aac');
      assert.ok(mainPcm.length > 5000, 'Hauptprofil liefert echtes, dekodierbares Audio');
      assert.ok(mobilePcm.length > 5000, 'Zusatzprofil liefert echtes, dekodierbares Audio - unabhängig vom Hauptencoder');

      const rmsMain = rms(mainPcm);
      const rmsMobile = rms(mobilePcm);
      assert.ok(rmsMain > 500, `Hauptprofil enthält hörbares Signal (RMS=${rmsMain})`);
      assert.ok(rmsMobile > 500, `Zusatzprofil enthält hörbares Signal (RMS=${rmsMobile}) - derselbe Programmbus, nicht Stille`);

      // Sauberes Beenden: po.stop() muss den Zusatzencoder wirklich mitbeenden (onStreamStop), nicht nur den
      // Prozess killen und den Hook vergessen - unabhängig davon, ob unter Systemlast zwischendurch ein
      // (vom Playout selbst abgefangener) Neustart des Zusatzencoders stattfand.
      assert.ok(mobileStopped > stoppedBeforeStop, 'po.stop() beendet auch das Zusatzprofil sauber (onStreamStop wird aufgerufen)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
