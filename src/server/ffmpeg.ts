// ffmpeg-Capability-Erkennung. Reihenfolge: AIRDECK_FFMPEG → mitgeliefertes ./ffmpeg/ → PATH.
// Ohne ffmpeg bleibt AirDeck lauffähig; nur das Server-Playout meldet dann "unsupported".

import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface FfmpegInfo {
  ffmpeg: string;
  ffprobe: string | null;
  /** ffplay für lokales Abhören über die PC-Lautsprecher */
  ffplay: string | null;
  version: string;
  encoders: { mp3: boolean; opus: boolean };
  /** custom = AIRDECK_FFMPEG, bundled = mitgeliefert (./ffmpeg/), system = PATH */
  source: 'custom' | 'bundled' | 'system';
}

const exe = process.platform === 'win32' ? '.exe' : '';
const TIMEOUT_MS = 15_000;
const OPTS = { encoding: 'utf8' as const, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };

function runSync(bin: string, args: string[]): string | null {
  try {
    const r = spawnSync(bin, args, OPTS);
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

function runAsync(bin: string, args: string[]): Promise<string | null> {
  return new Promise((ok) => execFile(bin, args, OPTS, (err, stdout) => ok(err ? null : stdout)));
}

const isPath = (bin: string) => bin.includes('/') || bin.includes('\\');

// Reihenfolge: eigener Pfad → mitgeliefert → PATH. Schlägt ein Kandidat fehl, folgt der nächste.
function candidates(appRoot: string): { bin: string; source: FfmpegInfo['source'] }[] {
  const list: { bin: string; source: FfmpegInfo['source'] }[] = [];
  if (process.env.AIRDECK_FFMPEG) list.push({ bin: process.env.AIRDECK_FFMPEG, source: 'custom' });
  list.push({ bin: join(appRoot, 'ffmpeg', `ffmpeg${exe}`), source: 'bundled' }, { bin: `ffmpeg${exe}`, source: 'system' });
  return list.filter((c) => !isPath(c.bin) || existsSync(c.bin));
}

/** Prüfschritte als Generator: dieselbe Logik für den blockierenden Start und die Suche im Betrieb. */
function* probe(appRoot: string): Generator<[string, string[]], FfmpegInfo | null, string | null> {
  const firstLine = (out: string | null) => (out ?? '').split('\n')[0]!.trim() || null;
  for (const { bin, source } of candidates(appRoot)) {
    const version = firstLine(yield [bin, ['-hide_banner', '-version']]);
    if (!version) continue;
    const probeBin = isPath(bin) ? join(dirname(bin), `ffprobe${exe}`) : `ffprobe${exe}`;
    const ffprobe = firstLine(yield [probeBin, ['-hide_banner', '-version']]) ? probeBin : null;
    const playBin = probeBin.replace(/ffprobe(\.exe)?$/, `ffplay${exe}`);
    const ffplay = firstLine(yield [playBin, ['-hide_banner', '-version']]) ? playBin : null;
    const enc = (yield [bin, ['-hide_banner', '-encoders']]) ?? '';
    return { ffmpeg: bin, ffprobe, ffplay, version, encoders: { mp3: /libmp3lame/.test(enc), opus: /libopus/.test(enc) }, source };
  }
  return null;
}

/** Beim Start (blockierend, es läuft noch nichts). */
export function detectFfmpeg(appRoot: string): FfmpegInfo | null {
  const g = probe(appRoot);
  let step = g.next(null);
  while (!step.done) step = g.next(runSync(...step.value));
  return step.value;
}

/** Erneute Suche im laufenden Betrieb, ohne den Prozess zu blockieren. */
export async function detectFfmpegAsync(appRoot: string): Promise<FfmpegInfo | null> {
  const g = probe(appRoot);
  let step = g.next(null);
  while (!step.done) step = g.next(await runAsync(...step.value));
  return step.value;
}

export interface MediaProbe {
  durationMs: number | null;
  tags: { title?: string; artist?: string; album?: string; genre?: string; year?: number; bpm?: number };
}

/** Laufzeit und ID3-/Vorbis-Tags einer Audiodatei. */
export function probeMedia(ffprobe: string, file: string): Promise<MediaProbe> {
  return new Promise((resolve) => {
    const p = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:format_tags', '-of', 'json', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve({ durationMs: null, tags: {} }));
    p.on('close', () => {
      try {
        const f = (JSON.parse(out) as { format?: { duration?: string; tags?: Record<string, string> } }).format ?? {};
        const t: Record<string, string> = {};
        for (const [k, v] of Object.entries(f.tags ?? {})) t[k.toLowerCase()] = String(v).trim().slice(0, 200);
        const s = Number.parseFloat(f.duration ?? '');
        const year = Number.parseInt(t.date ?? t.year ?? '', 10);
        const bpm = Number.parseInt(t.tbpm ?? t.bpm ?? '', 10);
        resolve({
          durationMs: Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : null,
          tags: {
            title: t.title || undefined, artist: t.artist || t.album_artist || undefined, album: t.album || undefined, genre: t.genre || undefined,
            year: year > 1000 && year < 3000 ? year : undefined, bpm: bpm > 0 && bpm < 400 ? bpm : undefined,
          },
        });
      } catch {
        resolve({ durationMs: null, tags: {} });
      }
    });
    setTimeout(() => p.kill(), 15_000).unref();
  });
}

/** Laufzeit einer Audiodatei in ms (oder null). */
export async function probeDurationMs(ffprobe: string, file: string): Promise<number | null> {
  return (await probeMedia(ffprobe, file)).durationMs;
}

export interface AudioDevice {
  id: string;
  name: string;
}

/** Aufnahmegeräte (Mikrofon/Line-In) für die Server-Automation. */
export function listInputDevices(ffmpeg: string): AudioDevice[] {
  if (process.platform === 'win32') {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const out: AudioDevice[] = [];
    for (const line of (r.stderr ?? '').split(/\r?\n/)) {
      const m = /"([^"]+)"\s*\(audio\)/.exec(line);
      if (m) out.push({ id: m[1]!, name: m[1]! });
    }
    return out;
  }
  if (process.platform === 'darwin') {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8', timeout: 8000 });
    const text = r.stderr ?? '';
    const audio = text.split(/AVFoundation audio devices:/)[1] ?? '';
    return [...audio.matchAll(/\[(\d+)\]\s+(.+)/g)].map((m) => ({ id: m[1]!, name: m[2]!.trim() }));
  }
  return [{ id: 'default', name: 'Standard-Eingang (PulseAudio/PipeWire)' }];
}

/** ffmpeg-Eingabeargumente für ein Aufnahmegerät. */
export function inputDeviceArgs(id: string): string[] {
  if (process.platform === 'win32') return ['-f', 'dshow', '-audio_buffer_size', '50', '-i', `audio=${id}`];
  if (process.platform === 'darwin') return ['-f', 'avfoundation', '-i', `:${id}`];
  return ['-f', 'pulse', '-i', id || 'default'];
}

/** Lautheit eines Titels messen (EBU R128): integrierte Lautheit (LUFS) und True-Peak (dBTP). */
export function analyzeLoudness(ffmpeg: string, file: string, timeoutMs = 180_000): Promise<{ lufs: number; truePeakDb: number } | null> {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-nostats', '-nostdin', '-i', file, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stderr!.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    p.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const summary = err.slice(err.lastIndexOf('Summary:'));
      const i = /I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/.exec(summary);
      const tp = /True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?|-inf)\s+dBFS/.exec(summary);
      if (code !== 0 || !i) return resolve(null);
      const lufs = Number(i[1]);
      // Stille/zu kurz: ebur128 meldet −70 LUFS – dann keine Anpassung
      if (!Number.isFinite(lufs) || lufs <= -69) return resolve(null);
      resolve({ lufs, truePeakDb: tp && tp[1] !== '-inf' ? Number(tp[1]) : -90 });
    });
  });
}
