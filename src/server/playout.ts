// Server-Playout (24/7, headless): ffmpeg dekodiert, AirDeck mischt (Crossfade, Carts,
// Ducking, Limiter, Stilleerkennung), ffmpeg kodiert den Sendestream.
// Läuft ohne Browser und startet nach einem Neustart automatisch wieder.

import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { MediaItem } from '../core/automation.ts';
import { SilenceDetector } from '../core/automation.ts';
import {
  BYTES_PER_FRAME, CHANNELS, PcmFifo, SAMPLE_RATE, busRmsDb, busToS16, dbToGain, framesToMs, mixInto, msToFrames,
} from '../core/pcm.ts';

export type StreamFormat = 'mp3' | 'opus' | 'aac';

/** 10-Band-EQ (Hz) für die Master-Kette */
export const EQ_BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000] as const;

export interface DspOptions {
  /** Verstärkung je Band in dB (−12 … +12), Reihenfolge wie EQ_BANDS */
  eq: number[];
  compressor: boolean;
  limiter: boolean;
  /** Trittschall-/Rumpelfilter unter 60 Hz */
  highpass?: boolean;
  /** 5-Band-Multiband-Kompressor (dichter „Radio-Sound“) */
  multiband?: boolean;
  /** Automatische Lautheitsregelung des Summensignals (EBU R128, loudnorm) */
  agc?: boolean;
  /** Ziel-Lautheit der AGC in LUFS */
  targetLufs?: number;
  /** Gewähltes Profil (nur Anzeige) */
  preset?: string;
}

/** Klangprofile für die Master-Kette (Startpunkte, danach frei anpassbar). */
export const DSP_PRESETS: Record<string, { label: string; dsp: Omit<DspOptions, 'preset'> }> = {
  neutral: { label: 'Neutral (nur Limiter)', dsp: { eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], compressor: false, limiter: true, highpass: false, multiband: false, agc: false } },
  music: { label: 'Musik ausgewogen', dsp: { eq: [1, 0, 0, 0, 0, 0, 1, 1, 0, 0], compressor: true, limiter: true, highpass: true, multiband: false, agc: true, targetLufs: -16 } },
  pop: { label: 'Pop/Dance – laut & dicht', dsp: { eq: [2, 1, 0, 0, 0, 1, 1, 2, 1, 0], compressor: false, limiter: true, highpass: true, multiband: true, agc: true, targetLufs: -14 } },
  talk: { label: 'Wort & Moderation', dsp: { eq: [-2, -1, 0, 0, 1, 2, 1, 0, 0, 0], compressor: true, limiter: true, highpass: true, multiband: false, agc: true, targetLufs: -16 } },
  classic: { label: 'Klassik/Jazz – dynamisch', dsp: { eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], compressor: false, limiter: true, highpass: false, multiband: false, agc: false } },
};

export interface PlayoutOptions {
  format: StreamFormat;
  bitrateKbps: number;
  /** MP3 (LAME): konstante oder variable Bitrate */
  mp3Mode?: 'cbr' | 'vbr';
  /** LAME-VBR-Qualität 0 (beste) … 9 */
  mp3Quality?: number;
  /** Lautheitsangleich pro Titel anhand der Analyse (wie ReplayGain) */
  loudness?: { auto: boolean; targetLufs: number };
  /** Einblendzeit neuer Titel in ms (0 = sofort voll) */
  fadeInMs: number;
  dsp: DspOptions;
  /** Programm über die Lautsprecher dieses PCs mithören (ffplay) */
  monitor: boolean;
  /** Aufnahmegerät für Mikrofon/Line-In (leer = keins) */
  inputDevice: string;
  micGainDb: number;
  /** Standard-Überblendung für Musik in ms */
  crossfadeMs: number;
  /** Absenkung der Musik, während Carts mit Ducking laufen */
  duckDb: number;
  silenceThresholdDb: number;
  silenceMs: number;
}

export const DEFAULT_PLAYOUT: PlayoutOptions = {
  format: 'mp3', bitrateKbps: 128, crossfadeMs: 3000, duckDb: -10, silenceThresholdDb: -50, silenceMs: 10_000,
  fadeInMs: 0, dsp: { eq: EQ_BANDS.map(() => 0), compressor: false, limiter: true }, monitor: false, inputDevice: '', micGainDb: 0,
  mp3Mode: 'cbr', mp3Quality: 2, loudness: { auto: true, targetLufs: -16 },
};

/**
 * Verstärkung eines Titels in dB: manueller Gain hat Vorrang; sonst Lautheitsangleich auf das Ziel,
 * begrenzt auf ±12 dB und so, dass der Spitzenpegel nicht über −1 dBTP steigt (mit Limiter +3 dB Reserve).
 */
export function trackGainDb(m: MediaItem, loud: PlayoutOptions['loudness'], limiter: boolean): number {
  if (m.gainDb != null) return m.gainDb;
  if (!loud?.auto || m.lufs == null || m.category !== 'music' && m.category !== 'jingle' && m.category !== 'station_id' && m.category !== 'sweeper' && m.category !== 'ad') return 0;
  let g = Math.max(-12, Math.min(12, loud.targetLufs - m.lufs));
  if (m.truePeakDb != null) g = Math.min(g, -1 - m.truePeakDb + (limiter ? 3 : 0));
  return Math.round(g * 10) / 10;
}

/** ffmpeg-Filterkette für die Master-DSP. */
export function dspFilter(d: DspOptions): string | null {
  const parts: string[] = [];
  EQ_BANDS.forEach((f, i) => {
    const g = Math.max(-12, Math.min(12, Number(d.eq?.[i]) || 0));
    if (g !== 0) parts.push(`equalizer=f=${f}:t=o:w=1:g=${g}`);
  });
  if (d.highpass) parts.unshift('highpass=f=60:p=2');
  // 5 Bänder (Beispiel aus der ffmpeg-Doku, angepasst): Bass bis 100 Hz … Höhen bis 22 kHz
  if (d.multiband) parts.push("mcompand=args='0.005,0.1 6 -47/-40,-34/-34,-17/-33 100 | 0.003,0.05 6 -47/-40,-34/-34,-17/-33 400 | 0.000625,0.0125 6 -47/-40,-34/-34,-15/-33 1600 | 0.0001,0.025 6 -47/-40,-34/-34,-31/-31,-0/-30 6400 | 0,0.025 6 -38/-31,-28/-28,-0/-25 22000'");
  if (d.compressor) parts.push('acompressor=threshold=0.125:ratio=3:attack=20:release=250:makeup=2');
  // loudnorm arbeitet intern mit 192 kHz – danach zurück auf die Sendefrequenz
  if (d.agc) parts.push(`loudnorm=I=${Math.max(-30, Math.min(-8, Number(d.targetLufs) || -16))}:TP=-1.5:LRA=11,aresample=${SAMPLE_RATE}`);
  if (d.limiter) parts.push('alimiter=limit=0.95:level=disabled');
  return parts.length ? parts.join(',') : null;
}

const RAW_IN = ['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ch_layout', 'stereo'];

export interface PlayoutHooks {
  nextTrack(): MediaItem | null;
  mediaPath(m: MediaItem): string;
  onNowPlaying(m: MediaItem): void;
  onStreamStart(contentType: string): void;
  onStreamData(chunk: Buffer): void;
  onStreamStop(): void;
  onSilence(silent: boolean): void;
  log(event: string, data?: Record<string, unknown>): void;
}

export const CONTENT_TYPE: Record<StreamFormat, string> = { mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac' };

export interface PlayoutExtras {
  ffplay?: string | null;
  inputArgs?: (device: string) => string[];
}

const BLOCK_MS = 20;
const MAX_BUFFER_BYTES = 10 * SAMPLE_RATE * BYTES_PER_FRAME; // 10 s Vorlauf pro Stimme
const RESUME_BYTES = 5 * SAMPLE_RATE * BYTES_PER_FRAME;

class Voice {
  readonly media: MediaItem;
  readonly kind: 'track' | 'cart';
  readonly duck: boolean;
  readonly fifo = new PcmFifo();
  readonly totalFrames: number | null;
  proc: ChildProcess | null = null;
  decoderDone = false;
  played = 0;
  gain: number;
  fadeTo: number | null = null;
  fadeFramesLeft = 0;
  segueFired = false;

  constructor(media: MediaItem, kind: 'track' | 'cart', duck: boolean, gainDb = media.gainDb ?? 0) {
    this.media = media;
    this.kind = kind;
    this.duck = duck;
    this.gain = dbToGain(gainDb);
    const end = media.cueOutMs ?? media.durationMs;
    this.totalFrames = end != null ? Math.max(0, msToFrames(end - (media.cueInMs ?? 0))) : null;
  }

  get remainingFrames(): number | null {
    return this.totalFrames == null ? null : Math.max(0, this.totalFrames - this.played);
  }

  /** Fertig, wenn Cue-Out erreicht oder Decoder leer, oder Ausblendung abgeschlossen. */
  get finished(): boolean {
    if (this.totalFrames != null && this.played >= this.totalFrames) return true;
    if (this.decoderDone && this.fifo.frames === 0) return true;
    return this.fadeTo === 0 && this.fadeFramesLeft === 0;
  }

  fade(to: number, frames: number): void {
    this.fadeTo = to;
    this.fadeFramesLeft = Math.max(1, frames);
  }

  stop(): void {
    this.proc?.kill('SIGKILL');
    this.proc = null;
    this.fifo.clear();
  }
}

export interface PlayoutStatus {
  running: boolean;
  format: StreamFormat;
  bitrateKbps: number;
  encoder: 'running' | 'restarting' | 'stopped';
  silent: boolean;
  current: { mediaId: string; title: string; artist: string; positionMs: number; durationMs: number | null; deck: 'A' | 'B' } | null;
  /** Titel, der gerade ausgeblendet wird (Crossfade), falls vorhanden */
  fading: { mediaId: string; title: string; deck: 'A' | 'B' } | null;
  carts: number;
  startedAt: number | null;
  underruns: number;
  micOn: boolean;
  input: 'off' | 'running' | 'error';
  monitor: boolean;
}

export class Playout {
  private readonly ffmpeg: string;
  private readonly hooks: PlayoutHooks;
  opts: PlayoutOptions;
  private voices: Voice[] = [];
  private encoder: ChildProcess | null = null;
  private encoderState: PlayoutStatus['encoder'] = 'stopped';
  private timer: NodeJS.Timeout | null = null;
  private t0 = 0;
  private framesOut = 0;
  private running = false;
  private startedAt: number | null = null;
  private duckGain = 1;
  private silence: SilenceDetector;
  private silent = false;
  private lastNextAttempt = -Infinity;
  private underruns = 0;
  private skipRequested = false;
  private readonly extras: PlayoutExtras;
  private monitorProc: ChildProcess | null = null;
  private inputProc: ChildProcess | null = null;
  private readonly inputFifo = new PcmFifo();
  private inputState: PlayoutStatus['input'] = 'off';
  private micOn = false;
  private micGain = 0;
  private trackCounter = 0;
  private readonly deckOf = new WeakMap<object, 'A' | 'B'>();
  private levelPeak = 0;
  private levelSum = 0;
  private levelN = 0;

  constructor(ffmpeg: string, hooks: PlayoutHooks, opts: Partial<PlayoutOptions> = {}, extras: PlayoutExtras = {}) {
    this.ffmpeg = ffmpeg;
    this.hooks = hooks;
    this.extras = extras;
    this.opts = { ...DEFAULT_PLAYOUT, ...opts, dsp: { ...DEFAULT_PLAYOUT.dsp, ...opts.dsp } };
    this.silence = new SilenceDetector({ thresholdDb: this.opts.silenceThresholdDb, durationMs: this.opts.silenceMs });
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.silence = new SilenceDetector({ thresholdDb: this.opts.silenceThresholdDb, durationMs: this.opts.silenceMs });
    this.startEncoder();
    if (this.opts.monitor) this.startMonitor();
    if (this.opts.inputDevice) this.startInput();
    this.t0 = performance.now();
    this.framesOut = 0;
    this.timer = setInterval(() => this.pump(), BLOCK_MS);
    this.hooks.log('playout_started', { format: this.opts.format, bitrateKbps: this.opts.bitrateKbps });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const v of this.voices) v.stop();
    this.voices = [];
    const enc = this.encoder;
    this.encoder = null;
    this.encoderState = 'stopped';
    enc?.stdin?.end();
    setTimeout(() => enc?.kill('SIGKILL'), 1000).unref();
    this.monitorProc?.kill('SIGKILL');
    this.monitorProc = null;
    this.stopInput();
    this.hooks.onStreamStop();
    if (this.silent) this.hooks.onSilence(false);
    this.silent = false;
    this.startedAt = null;
    this.hooks.log('playout_stopped');
  }

  /** Aktuellen Titel kurz ausblenden und nächsten starten. */
  skip(): void {
    this.skipRequested = true;
  }

  /** Pegel seit dem letzten Abruf (RMS/Peak in dBFS) – für die VU-Anzeige im Studio. */
  readLevel(): { rmsDb: number; peakDb: number } {
    const toDb = (x: number) => (x > 0 ? Math.max(-90, 20 * Math.log10(x)) : -90);
    const r = { rmsDb: this.levelN ? toDb(Math.sqrt(this.levelSum / this.levelN)) : -90, peakDb: toDb(this.levelPeak) };
    this.levelPeak = 0;
    this.levelSum = 0;
    this.levelN = 0;
    return r;
  }

  /** Mikrofon/Line-In auf Sendung (mit Ducking der Musik) oder stumm. */
  setMic(on: boolean): void {
    if (on && this.inputState !== 'running') throw new Error('Kein Aufnahmegerät aktiv');
    this.micOn = on;
    this.hooks.log(on ? 'mic_on' : 'mic_off');
  }

  playCart(media: MediaItem, duck: boolean): void {
    if (!this.running) return;
    this.startVoice(new Voice(media, 'cart', duck, trackGainDb(media, this.opts.loudness, this.opts.dsp.limiter)));
  }

  status(): PlayoutStatus {
    const cur = this.currentTrack();
    return {
      running: this.running,
      format: this.opts.format,
      bitrateKbps: this.opts.bitrateKbps,
      encoder: this.encoderState,
      silent: this.silent,
      current: cur
        ? {
            mediaId: cur.media.id, title: cur.media.title, artist: cur.media.artist,
            positionMs: framesToMs(cur.played) + (cur.media.cueInMs ?? 0),
            durationMs: cur.totalFrames == null ? null : framesToMs(cur.totalFrames),
            deck: this.deckOf.get(cur) ?? 'A',
          }
        : null,
      fading: (() => {
        const f = this.voices.find((v) => v.kind === 'track' && v.fadeTo === 0 && !v.finished);
        return f ? { mediaId: f.media.id, title: f.media.title, deck: this.deckOf.get(f) ?? 'A' } : null;
      })(),
      carts: this.voices.filter((v) => v.kind === 'cart').length,
      startedAt: this.startedAt,
      underruns: this.underruns,
      micOn: this.micOn,
      input: this.inputState,
      monitor: !!this.monitorProc,
    };
  }

  // ---------- intern ----------

  private currentTrack(): Voice | undefined {
    // jüngster nicht ausblendender Track
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i]!;
      if (v.kind === 'track' && v.fadeTo !== 0) return v;
    }
    return undefined;
  }

  private startEncoder(): void {
    const br = `${this.opts.bitrateKbps}k`;
    const codec =
      this.opts.format === 'opus' ? ['-c:a', 'libopus', '-b:a', br, '-f', 'ogg', '-page_duration', '200000']
      : this.opts.format === 'aac' ? ['-c:a', 'aac', '-b:a', br, '-f', 'adts']
      : this.opts.mp3Mode === 'vbr'
        ? ['-c:a', 'libmp3lame', '-q:a', String(Math.max(0, Math.min(9, this.opts.mp3Quality ?? 2))), '-f', 'mp3']
        : ['-c:a', 'libmp3lame', '-b:a', br, '-compression_level', String(Math.max(0, Math.min(9, this.opts.mp3Quality ?? 2))), '-f', 'mp3'];
    const af = dspFilter(this.opts.dsp);
    const enc = spawn(
      this.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', ...RAW_IN, '-i', 'pipe:0', ...(af ? ['-af', af] : []), ...codec, '-flush_packets', '1', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.encoder = enc;
    this.encoderState = 'running';
    this.hooks.onStreamStart(CONTENT_TYPE[this.opts.format]);
    enc.stdout!.on('data', (d: Buffer) => this.hooks.onStreamData(d));
    let err = '';
    enc.stderr!.on('data', (d) => (err = (err + d).slice(-500)));
    enc.stdin!.on('error', () => {});
    enc.on('error', (e) => this.hooks.log('encoder_error', { message: e.message }));
    enc.on('close', (code) => {
      if (this.encoder !== enc) return;
      this.encoder = null;
      if (!this.running) return;
      // Encoder-Absturz: nach 1 s neu starten, Automation läuft weiter
      this.encoderState = 'restarting';
      this.hooks.log('encoder_crashed', { code, stderr: err.trim() });
      this.hooks.onStreamStop();
      setTimeout(() => this.running && !this.encoder && this.startEncoder(), 1000).unref();
    });
  }

  private startMonitor(): void {
    const ffplay = this.extras.ffplay;
    if (!ffplay) return this.hooks.log('monitor_unavailable', { reason: 'ffplay fehlt' });
    const p = spawn(ffplay, ['-hide_banner', '-loglevel', 'error', '-nodisp', '-fflags', 'nobuffer', '-probesize', '32', ...RAW_IN, '-i', 'pipe:0'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    this.monitorProc = p;
    p.stdin!.on('error', () => {});
    p.on('error', () => (this.monitorProc = null));
    p.on('close', () => {
      if (this.monitorProc === p) this.monitorProc = null;
    });
  }

  private startInput(): void {
    const args = this.extras.inputArgs?.(this.opts.inputDevice);
    if (!args) return;
    const p = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args, '-vn', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.inputProc = p;
    this.inputState = 'running';
    p.stdout!.on('data', (d: Buffer) => this.inputFifo.push(d));
    let err = '';
    p.stderr!.on('data', (d) => (err = (err + d).slice(-300)));
    p.on('error', () => (this.inputState = 'error'));
    p.on('close', () => {
      if (this.inputProc !== p) return;
      this.inputProc = null;
      this.inputState = 'error';
      this.micOn = false;
      this.hooks.log('input_failed', { device: this.opts.inputDevice, stderr: err.trim() });
    });
  }

  private stopInput(): void {
    const p = this.inputProc;
    this.inputProc = null;
    p?.kill('SIGKILL');
    this.inputFifo.clear();
    this.inputState = 'off';
    this.micOn = false;
  }

  private startVoice(v: Voice): void {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (v.media.cueInMs) args.push('-ss', (v.media.cueInMs / 1000).toFixed(3));
    args.push('-i', this.hooks.mediaPath(v.media), '-vn', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1');
    const p = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    v.proc = p;
    p.stdout!.on('data', (d: Buffer) => {
      v.fifo.push(d);
      if (v.fifo.bytes > MAX_BUFFER_BYTES) p.stdout!.pause();
    });
    let err = '';
    p.stderr!.on('data', (d) => (err = (err + d).slice(-300)));
    p.on('error', () => (v.decoderDone = true));
    p.on('close', (code) => {
      v.decoderDone = true;
      if (code && v.played === 0 && v.fifo.frames === 0) this.hooks.log('decode_failed', { mediaId: v.media.id, stderr: err.trim() });
    });
    this.voices.push(v);
  }

  private startNextTrack(): boolean {
    const m = this.hooks.nextTrack();
    if (!m) return false;
    const v = new Voice(m, 'track', false, trackGainDb(m, this.opts.loudness, this.opts.dsp.limiter));
    this.deckOf.set(v, this.trackCounter++ % 2 === 0 ? 'A' : 'B');
    if (this.opts.fadeInMs > 0) {
      const target = v.gain;
      v.gain = 0;
      v.fade(target, msToFrames(this.opts.fadeInMs));
    }
    this.startVoice(v);
    this.hooks.onNowPlaying(m);
    return true;
  }

  private mixFrames(m: MediaItem, total: number | null): number {
    const base = m.segueMs ?? (m.category === 'music' ? this.opts.crossfadeMs : 0);
    return msToFrames(total ? Math.min(base, framesToMs(total) / 2) : base);
  }

  private pump(): void {
    if (!this.running) return;
    const now = performance.now();
    let due = Math.floor(((now - this.t0) / 1000) * SAMPLE_RATE) - this.framesOut;
    if (due <= 0) return;
    if (due > SAMPLE_RATE * 2) {
      // Event-Loop hing (z. B. Standby): nicht nachholen, sondern neu takten
      due = msToFrames(BLOCK_MS);
      this.t0 = now - ((this.framesOut + due) / SAMPLE_RATE) * 1000;
    }

    this.automation(now);

    const bus = new Float32Array(due * CHANNELS);
    const ducking = this.micOn || this.voices.some((v) => v.kind === 'cart' && v.duck);
    const duckTarget = ducking ? dbToGain(this.opts.duckDb) : 1;
    const duckFrom = this.duckGain;
    // Ducking weich über ca. 150 ms
    const duckTo = duckFrom + Math.sign(duckTarget - duckFrom) * Math.min(Math.abs(duckTarget - duckFrom), due / msToFrames(150));
    this.duckGain = duckTo;

    for (const v of this.voices) {
      let want = due;
      if (v.remainingFrames != null) want = Math.min(want, v.remainingFrames);
      const { samples, got } = v.fifo.read(want);
      if (got < want && !v.decoderDone) this.underruns++;
      const from = v.gain;
      let to = v.gain;
      if (v.fadeTo != null && v.fadeFramesLeft > 0) {
        const step = Math.min(due, v.fadeFramesLeft);
        to = from + ((v.fadeTo - from) * step) / v.fadeFramesLeft;
        v.fadeFramesLeft -= step;
        v.gain = to;
      }
      const k = v.kind === 'track' ? 1 : 0;
      mixInto(bus, samples, from * (k ? duckFrom : 1), to * (k ? duckTo : 1));
      v.played += got;
      if (v.proc && v.fifo.bytes < RESUME_BYTES) v.proc.stdout?.resume();
    }
    // Mikrofon/Line-In: Latenz klein halten (max. ~200 ms Vorlauf), Ein-/Ausblenden weich
    if (this.inputProc) {
      const maxFrames = msToFrames(200) + due;
      if (this.inputFifo.frames > maxFrames) this.inputFifo.read(this.inputFifo.frames - maxFrames);
      const { samples } = this.inputFifo.read(due);
      const target = this.micOn ? dbToGain(this.opts.micGainDb) : 0;
      const from = this.micGain;
      const to = from + Math.sign(target - from) * Math.min(Math.abs(target - from), due / msToFrames(80));
      this.micGain = to;
      if (from > 0 || to > 0) mixInto(bus, samples, from, to);
    }

    this.voices = this.voices.filter((v) => {
      if (!v.finished) return true;
      v.stop();
      return false;
    });

    this.framesOut += due;
    const enc = this.encoder;
    const pcm = busToS16(bus);
    if (enc?.stdin && enc.stdin.writableLength < 2 * 1024 * 1024) enc.stdin.write(pcm);
    const mon = this.monitorProc;
    if (mon?.stdin && mon.stdin.writableLength < 512 * 1024) mon.stdin.write(pcm);

    for (let i = 0; i < bus.length; i++) {
      const a = Math.abs(bus[i]!);
      if (a > this.levelPeak) this.levelPeak = a;
      this.levelSum += bus[i]! * bus[i]!;
    }
    this.levelN += bus.length;
    const ev = this.silence.feed(busRmsDb(bus), Date.now());
    if (ev === 'silence') {
      this.silent = true;
      this.hooks.log('silence_detected');
      this.hooks.onSilence(true);
      // Notfall: nächsten Titel erzwingen
      this.currentTrack()?.fade(0, msToFrames(200));
      this.lastNextAttempt = -Infinity;
    } else if (ev === 'recovered') {
      this.silent = false;
      this.hooks.onSilence(false);
    }
  }

  private automation(now: number): void {
    const cur = this.currentTrack();
    if (this.skipRequested) {
      this.skipRequested = false;
      cur?.fade(0, msToFrames(500));
      this.startNextTrack();
      return;
    }
    if (!cur || cur.finished) {
      // Leerlauf: höchstens alle 2 s neu versuchen (z. B. Queue/Archiv leer)
      if (now - this.lastNextAttempt < 2000) return;
      this.lastNextAttempt = now;
      this.startNextTrack();
      return;
    }
    const rem = cur.remainingFrames;
    if (rem == null || cur.segueFired) return;
    const mix = this.mixFrames(cur.media, cur.totalFrames);
    if (rem <= mix) {
      cur.segueFired = true;
      if (this.startNextTrack() && mix > 0) cur.fade(0, rem);
    }
  }
}
