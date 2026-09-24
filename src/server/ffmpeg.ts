// ffmpeg-Capability-Erkennung. Reihenfolge: AIRDECK_FFMPEG → mitgeliefertes ./ffmpeg/ → PATH.
// Ohne ffmpeg bleibt AirDeck lauffähig; nur das Server-Playout meldet dann "unsupported".

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface FfmpegInfo {
  ffmpeg: string;
  ffprobe: string | null;
  version: string;
  encoders: { mp3: boolean; opus: boolean };
}

const exe = process.platform === 'win32' ? '.exe' : '';

function works(bin: string): string | null {
  try {
    const r = spawnSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.status === 0 ? (r.stdout.split('\n')[0] ?? '').trim() : null;
  } catch {
    return null;
  }
}

export function detectFfmpeg(appRoot: string): FfmpegInfo | null {
  const candidates = [process.env.AIRDECK_FFMPEG, join(appRoot, 'ffmpeg', `ffmpeg${exe}`), `ffmpeg${exe}`].filter(
    (c): c is string => !!c && (!c.includes('/') && !c.includes('\\') ? true : existsSync(c)),
  );
  for (const bin of candidates) {
    const version = works(bin);
    if (!version) continue;
    const probeCandidate = bin.includes('/') || bin.includes('\\') ? join(dirname(bin), `ffprobe${exe}`) : `ffprobe${exe}`;
    const ffprobe = works(probeCandidate) ? probeCandidate : null;
    const enc = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).stdout ?? '';
    return { ffmpeg: bin, ffprobe, version, encoders: { mp3: /libmp3lame/.test(enc), opus: /libopus/.test(enc) } };
  }
  return null;
}

/** Laufzeit einer Audiodatei in ms (oder null). */
export function probeDurationMs(ffprobe: string, file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const s = Number.parseFloat(out.trim());
      resolve(Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : null);
    });
    setTimeout(() => p.kill(), 15_000).unref();
  });
}
