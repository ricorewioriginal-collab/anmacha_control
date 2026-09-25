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
export interface TrackAnalysis {
  lufs: number | null;
  truePeakDb: number;
  durationMs: number | null;
  /** Ende der digitalen Stille am Anfang (ms), null = keine */
  leadSilenceMs: number | null;
  /** Beginn der digitalen Stille am Ende (ms), null = keine */
  tailSilenceMs: number | null;
  /** Vollausgesteuerte Samples (Hinweis auf Übersteuerung) */
  clippedSamples: number;
  bitrateKbps: number | null;
  /** Die ganze Datei ist digital still */
  silent: boolean;
}

/** Stille-Schwelle: nur echte digitale Stille, leise Ein-/Ausblendungen bleiben unangetastet */
export const SILENCE_DB = -60;

/**
 * Track-Check in EINEM Durchlauf: Lautheit (EBU R128), True Peak, Stille am Anfang/Ende, Übersteuerung, Bitrate.
 * Liefert null, wenn die Datei nicht dekodierbar ist.
 */
export function analyzeTrack(ffmpeg: string, file: string, timeoutMs = 180_000): Promise<TrackAnalysis | null> {
  return new Promise((resolve) => {
    const af = `ebur128=peak=true:framelog=quiet,silencedetect=n=${SILENCE_DB}dB:d=0.25,astats=measure_perchannel=none:measure_overall=Peak_level+Peak_count`;
    const p = spawn(ffmpeg, ['-hide_banner', '-nostats', '-nostdin', '-i', file, '-vn', '-af', af, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    // Kopf (Dauer, Bitrate) und Stille-Meldungen merken, vom Rest nur das Ende (Zusammenfassungen)
    let head = '';
    let tail = '';
    const silences: { start: number; end: number | null }[] = [];
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stderr!.on('data', (d: Buffer) => {
      const t = d.toString();
      if (head.length < 4000) head += t;
      tail = (tail + t).slice(-8000);
      for (const m of t.matchAll(/silence_start: (-?\d+(?:\.\d+)?)/g)) silences.push({ start: Math.max(0, Number(m[1])), end: null });
      for (const m of t.matchAll(/silence_end: (\d+(?:\.\d+)?)/g)) {
        const open = silences.findLast((x) => x.end === null);
        if (open) open.end = Number(m[1]);
      }
    });
    p.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const summary = tail.slice(tail.lastIndexOf('Summary:'));
      const i = /I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/.exec(summary);
      const tp = /True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?|-inf)\s+dBFS/.exec(summary);
      const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(head);
      const durationMs = dur ? Math.round((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 1000) : null;
      const br = /bitrate: (\d+) kb\/s/.exec(head);
      const peakLevel = /Peak level dB:\s*(-?\d+(?:\.\d+)?|-inf)/.exec(tail);
      const peakCount = /Peak count:\s*(\d+(?:\.\d+)?)/.exec(tail);
      const lufsRaw = i ? Number(i[1]) : NaN;
      // Stille am Anfang: beginnt bei 0; am Ende: bis zum Dateiende (ohne silence_end oder end ≈ Dauer)
      const first = silences[0];
      const leadEnd = first && first.start < 0.05 && first.end !== null ? Math.round(first.end * 1000) : null;
      // Stille bis (fast) zum Dateiende: die ganze Datei ist still – keine Cue-Punkte, sondern ein Hinweis
      const silent = leadEnd !== null && durationMs !== null && leadEnd >= durationMs - 100;
      const leadSilenceMs = silent ? null : leadEnd;
      const last = silences[silences.length - 1];
      const tailOpen = !!last && (last.end === null || (durationMs !== null && last.end * 1000 >= durationMs - 50));
      // eine einzige Stille vom Anfang bis zum Ende (ganz stille Datei) ist weder Anfang noch Ende eines Titels
      const tailSilenceMs = tailOpen && !(last === first && first.start < 0.05) ? Math.round(last!.start * 1000) : null;
      resolve({
        // Stille/zu kurz: ebur128 meldet −70 LUFS – dann keine Anpassung
        lufs: Number.isFinite(lufsRaw) && lufsRaw > -69 ? lufsRaw : null,
        truePeakDb: tp && tp[1] !== '-inf' ? Number(tp[1]) : -90,
        durationMs,
        leadSilenceMs,
        tailSilenceMs,
        clippedSamples: peakLevel && peakLevel[1] !== '-inf' && Number(peakLevel[1]) >= -0.05 && peakCount ? Math.round(Number(peakCount[1])) : 0,
        bitrateKbps: br ? Number(br[1]) : null,
        silent: silent || (!!first && first.start < 0.05 && first.end === null),
      });
    });
  });
}

/** Nur Lautheit (für bestehende Aufrufer) */
export async function analyzeLoudness(ffmpeg: string, file: string, timeoutMs = 180_000): Promise<{ lufs: number; truePeakDb: number } | null> {
  const r = await analyzeTrack(ffmpeg, file, timeoutMs);
  return r && r.lufs !== null ? { lufs: r.lufs, truePeakDb: r.truePeakDb } : null;
}
