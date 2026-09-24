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

export type StreamFormat = 'mp3' | 'opus';

export interface PlayoutOptions {
  format: StreamFormat;
  bitrateKbps: number;
  /** Standard-Überblendung für Musik in ms */
  crossfadeMs: number;
  /** Absenkung der Musik, während Carts mit Ducking laufen */
  duckDb: number;
  silenceThresholdDb: number;
  silenceMs: number;
}

export const DEFAULT_PLAYOUT: PlayoutOptions = {
  format: 'mp3', bitrateKbps: 128, crossfadeMs: 3000, duckDb: -10, silenceThresholdDb: -50, silenceMs: 10_000,
};

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

export const CONTENT_TYPE: Record<StreamFormat, string> = { mp3: 'audio/mpeg', opus: 'audio/ogg' };

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

  constructor(media: MediaItem, kind: 'track' | 'cart', duck: boolean) {
    this.media = media;
    this.kind = kind;
    this.duck = duck;
    this.gain = dbToGain(media.gainDb ?? 0);
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
  current: { mediaId: string; title: string; artist: string; positionMs: number; durationMs: number | null } | null;
  carts: number;
  startedAt: number | null;
  underruns: number;
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

  constructor(ffmpeg: string, hooks: PlayoutHooks, opts: Partial<PlayoutOptions> = {}) {
    this.ffmpeg = ffmpeg;
    this.hooks = hooks;
    this.opts = { ...DEFAULT_PLAYOUT, ...opts };
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

  playCart(media: MediaItem, duck: boolean): void {
    if (!this.running) return;
    this.startVoice(new Voice(media, 'cart', duck));
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
          }
        : null,
      carts: this.voices.filter((v) => v.kind === 'cart').length,
      startedAt: this.startedAt,
      underruns: this.underruns,
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
    const codec =
      this.opts.format === 'opus'
        ? ['-c:a', 'libopus', '-b:a', `${this.opts.bitrateKbps}k`, '-f', 'ogg', '-page_duration', '200000']
        : ['-c:a', 'libmp3lame', '-b:a', `${this.opts.bitrateKbps}k`, '-f', 'mp3'];
    const enc = spawn(
      this.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-i', 'pipe:0', ...codec, '-flush_packets', '1', 'pipe:1'],
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
    this.startVoice(new Voice(m, 'track', false));
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
    const ducking = this.voices.some((v) => v.kind === 'cart' && v.duck);
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
    this.voices = this.voices.filter((v) => {
      if (!v.finished) return true;
      v.stop();
      return false;
    });

    this.framesOut += due;
    const enc = this.encoder;
    if (enc?.stdin && enc.stdin.writableLength < 2 * 1024 * 1024) enc.stdin.write(busToS16(bus));

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
