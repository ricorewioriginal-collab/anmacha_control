// Sendebus (24/7, headless): ffmpeg dekodiert, AirDeck mischt (Crossfade, Carts, Ducking, Limiter,
// Stilleerkennung), ffmpeg kodiert den Sendestream in EINEM festen Format.
// Neben den Titeln der Automation werden auch alle Live-Quellen (Encoder, Studio-Mikrofon, App, Relay)
// dekodiert und hier gemischt – ein Quellenwechsel ändert das Format der Ausgänge nie (AUDIT 5.2).
// Läuft ohne Browser und startet nach einem Neustart automatisch wieder.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DeckId, MediaItem } from '../core/automation.ts';
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
  /** Überblendzeit beim Wechsel zwischen Automation und Live-Quelle in ms */
  liveFadeMs?: number;
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

/** AirDeckCast-Zusatzprofil: eigenes Format/Bitrate, derselbe Programmbus wie der Hauptencoder. */
export interface StreamProfileOpts {
  format: StreamFormat;
  bitrateKbps: number;
  mp3Mode?: 'cbr' | 'vbr';
  mp3Quality?: number;
}

export interface StreamProfileHooks {
  onStreamStart(contentType: string): void;
  onStreamData(chunk: Buffer): void;
  onStreamStop(): void;
}

interface StreamProfileRuntime {
  opts: StreamProfileOpts;
  hooks: StreamProfileHooks;
  proc: ChildProcess | null;
}

/**
 * AirDeckCast: HLS-Ausgabe (Apple HTTP Live Streaming) - eigener AAC-Encode desselben Programmbusses,
 * den ffmpeg selbst in Segmente + Playlist teilt (kein Byte-Stream über onStreamData, sondern Dateien
 * in einem Verzeichnis, das der HTTP-Server direkt ausliefert).
 */
export interface HlsOpts {
  dir: string;
  bitrateKbps: number;
  /** Segmentlänge in Sekunden (Standard 6) */
  segmentSeconds?: number;
  /** Anzahl Segmente in der Playlist (Standard 6) */
  listSize?: number;
}

interface HlsRuntime {
  opts: HlsOpts;
  proc: ChildProcess | null;
}

export interface PlayoutHooks {
  nextTrack(): MediaItem | null;
  mediaPath(m: MediaItem): string;
  onNowPlaying(m: MediaItem, deck: DeckId): void;
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
/** Live-Quellen: so viel puffern, bevor sie hörbar werden (Netzwerk-Jitter) … */
const LIVE_PREBUFFER_MS = 300;
/** … und höchstens so viel Verzögerung zulassen, danach Älteres verwerfen */
const LIVE_MAX_MS = 1500;

/** Eingangsformat für den Decoder aus dem Content-Type (kürzere Erkennung = weniger Verzögerung) */
function inputFormat(contentType: string): string[] {
  const t = contentType.toLowerCase();
  if (t.includes('mpeg') || t.includes('mp3')) return ['-f', 'mp3'];
  if (t.includes('webm') || t.includes('matroska')) return ['-f', 'matroska'];
  if (t.includes('ogg') || t.includes('opus')) return ['-f', 'ogg'];
  if (t.includes('aac')) return ['-f', 'aac'];
  return [];
}

/** Eine Live-Quelle im Mixer: eigener Decoder, eigener Puffer, eigene Überblendung. */
class LiveChannel {
  readonly id: string;
  readonly contentType: string;
  readonly fifo = new PcmFifo();
  proc: ChildProcess | null = null;
  gain = 0;
  primed = false;
  closing = false;
  bytesIn = 0;
  error: string | null = null;

  constructor(id: string, contentType: string) {
    this.id = id;
    this.contentType = contentType;
  }
}
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
  /** Deck, auf dem die Stimme läuft (null = Cart oder vom Deck gelöst, z. B. beim Ausblenden nach Stopp) */
  deck: DeckId | null = null;
  /** von der Automation gestartet (Deck wird danach geleert) */
  auto = false;
  /** Startposition in der Datei (ms) */
  readonly startMs: number;
  lvSum = 0;
  lvN = 0;
  lvPeak = 0;

  constructor(media: MediaItem, kind: 'track' | 'cart', duck: boolean, gainDb = media.gainDb ?? 0, startMs = media.cueInMs ?? 0) {
    this.media = media;
    this.kind = kind;
    this.duck = duck;
    this.gain = dbToGain(gainDb);
    this.startMs = Math.max(0, startMs);
    const end = media.cueOutMs ?? media.durationMs;
    this.totalFrames = end != null ? Math.max(0, msToFrames(end - this.startMs)) : null;
  }

  /** aktuelle Position in der Datei (ms) */
  get positionMs(): number {
    return this.startMs + framesToMs(this.played);
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

export type EngineDeckState = 'empty' | 'cued' | 'playing' | 'paused';

export interface EngineDeckView {
  id: DeckId;
  state: EngineDeckState;
  mediaId: string | null;
  title: string | null;
  artist: string | null;
  positionMs: number;
  durationMs: number | null;
  /** von der Automation belegt */
  auto: boolean;
}

interface EngineDeck {
  id: DeckId;
  media: MediaItem | null;
  state: EngineDeckState;
  /** Position im Stillstand (ms in der Datei) */
  posMs: number;
  voice: Voice | null;
  auto: boolean;
}

export class DeckError extends Error {}

export interface PlayoutStatus {
  running: boolean;
  format: StreamFormat;
  bitrateKbps: number;
  encoder: 'running' | 'restarting' | 'stopped';
  silent: boolean;
  current: { mediaId: string; title: string; artist: string; positionMs: number; durationMs: number | null; deck: DeckId } | null;
  /** Titel, der gerade ausgeblendet wird (Crossfade), falls vorhanden */
  fading: { mediaId: string; title: string; deck: DeckId } | null;
  /** Die vier Decks der Engine (A/B: Automation und Hand, C/D: nur Hand) */
  decks: EngineDeckView[];
  carts: number;
  startedAt: number | null;
  underruns: number;
  micOn: boolean;
  input: 'off' | 'running' | 'error';
  monitor: boolean;
  /** Programm: null = Automation, sonst ID der Live-Quelle */
  program: string | null;
  /** Automation startet selbstständig Titel (AUTO/EMERGENCY) */
  automation: boolean;
  live: { id: string; contentType: string; buffered: number; primed: boolean; bytesIn: number; error: string | null }[];
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
  private readonly decks: Record<DeckId, EngineDeck> = {
    A: { id: 'A', media: null, state: 'empty', posMs: 0, voice: null, auto: false },
    B: { id: 'B', media: null, state: 'empty', posMs: 0, voice: null, auto: false },
    C: { id: 'C', media: null, state: 'empty', posMs: 0, voice: null, auto: false },
    D: { id: 'D', media: null, state: 'empty', posMs: 0, voice: null, auto: false },
  };
  private lastAutoDeck: 'A' | 'B' = 'B';
  private levelPeak = 0;
  private levelSum = 0;
  private levelN = 0;
  private readonly live = new Map<string, LiveChannel>();
  private program: string | null = null;
  private automationOn = true;
  /** AirDeckCast: zusätzliche Encoder-Profile (z. B. "Mobile AAC 64k"), alle aus demselben PCM-Programmbus
   *  gespeist wie der Hauptencoder - ein Programmbus, mehrere Ausgänge, keine zweite Playout-Engine. */
  private readonly profiles = new Map<string, StreamProfileRuntime>();
  /** AirDeckCast: HLS-Ausgaben (Segmente + Playlist in einem Verzeichnis), ebenfalls aus dem PCM-Programmbus */
  private readonly hlsOutputs = new Map<string, HlsRuntime>();

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
    for (const [id, rt] of this.profiles) this.startProfileEncoder(id, rt);
    for (const [id, rt] of this.hlsOutputs) this.startHls(id, rt);
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
    for (const d of Object.values(this.decks)) {
      if (d.voice) d.posMs = d.voice.positionMs;
      d.voice = null;
      if (d.state === 'playing') d.state = d.auto ? 'empty' : 'paused';
      if (d.state === 'empty') d.media = null;
    }
    const enc = this.encoder;
    this.encoder = null;
    this.encoderState = 'stopped';
    enc?.stdin?.end();
    setTimeout(() => enc?.kill('SIGKILL'), 1000).unref();
    for (const rt of this.profiles.values()) {
      const p = rt.proc;
      rt.proc = null;
      p?.stdin?.end();
      setTimeout(() => p?.kill('SIGKILL'), 1000).unref();
      rt.hooks.onStreamStop();
    }
    for (const rt of this.hlsOutputs.values()) {
      const p = rt.proc;
      rt.proc = null;
      p?.stdin?.end();
      setTimeout(() => p?.kill('SIGKILL'), 1000).unref();
    }
    this.monitorProc?.kill('SIGKILL');
    this.monitorProc = null;
    this.stopInput();
    for (const ch of this.live.values()) this.killLive(ch);
    this.live.clear();
    this.program = null;
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
  readLevel(): { rmsDb: number; peakDb: number; decks: Partial<Record<DeckId, number>> } {
    const toDb = (x: number) => (x > 0 ? Math.max(-90, 20 * Math.log10(x)) : -90);
    const decks: Partial<Record<DeckId, number>> = {};
    for (const d of Object.values(this.decks)) {
      const v = d.voice;
      decks[d.id] = v && v.lvN ? toDb(Math.sqrt(v.lvSum / v.lvN)) : -90;
      if (v) v.lvSum = v.lvN = v.lvPeak = 0;
    }
    const r = { rmsDb: this.levelN ? toDb(Math.sqrt(this.levelSum / this.levelN)) : -90, peakDb: toDb(this.levelPeak), decks };
    this.levelPeak = 0;
    this.levelSum = 0;
    this.levelN = 0;
    return r;
  }

  // ---------- Decks (von Hand) ----------

  private deck(id: string): EngineDeck {
    const d = this.decks[id as DeckId];
    if (!d) throw new DeckError('Deck gibt es nicht');
    return d;
  }

  /** Titel ins Deck laden (nicht während es spielt). */
  deckLoad(id: string, media: MediaItem): void {
    const d = this.deck(id);
    if (d.state === 'playing') throw new DeckError(`Deck ${id} spielt gerade – erst stoppen`);
    d.media = media;
    d.state = 'cued';
    d.posMs = media.cueInMs ?? 0;
    d.auto = false;
  }

  /** Deck starten bzw. nach Pause fortsetzen. */
  deckPlay(id: string): void {
    const d = this.deck(id);
    if (!this.running) throw new DeckError('Die Engine läuft nicht');
    if (!d.media) throw new DeckError(`Deck ${id} ist leer`);
    if (d.state === 'playing') return;
    this.startDeckVoice(d, d.posMs, false);
  }

  /** Anhalten, Position bleibt. */
  deckPause(id: string): void {
    const d = this.deck(id);
    if (d.state !== 'playing' || !d.voice) return;
    d.posMs = d.voice.positionMs;
    this.releaseVoice(d, 30);
    d.state = 'paused';
  }

  /** Stoppen (kurz ausblenden) und an den Anfang zurück. */
  deckStop(id: string): void {
    const d = this.deck(id);
    if (d.voice) this.releaseVoice(d, 250);
    if (!d.media) return;
    d.state = 'cued';
    d.posMs = d.media.cueInMs ?? 0;
    d.auto = false;
  }

  deckEject(id: string): void {
    const d = this.deck(id);
    if (d.voice) this.releaseVoice(d, 250);
    d.media = null;
    d.state = 'empty';
    d.posMs = 0;
    d.auto = false;
  }

  /** Springen (ms in der Datei). */
  deckSeek(id: string, ms: number): void {
    const d = this.deck(id);
    if (!d.media) return;
    const end = d.media.cueOutMs ?? d.media.durationMs ?? Infinity;
    const pos = Math.max(d.media.cueInMs ?? 0, Math.min(ms, end - 100));
    if (d.state === 'playing') {
      this.releaseVoice(d, 20);
      this.startDeckVoice(d, pos, d.auto);
    } else {
      d.posMs = pos;
      if (d.state === 'cued' && pos > (d.media.cueInMs ?? 0)) d.state = 'paused';
    }
  }

  private startDeckVoice(d: EngineDeck, fromMs: number, auto: boolean): Voice {
    const m = d.media!;
    const v = new Voice(m, 'track', false, trackGainDb(m, this.opts.loudness, this.opts.dsp.limiter), fromMs);
    v.deck = d.id;
    v.auto = auto;
    d.voice = v;
    d.state = 'playing';
    d.auto = auto;
    this.startVoice(v);
    // Titelanzeige: Musik bzw. alles auf den Hauptdecks
    if (d.id === 'A' || d.id === 'B' || m.category === 'music') this.hooks.onNowPlaying(m, d.id);
    return v;
  }

  /** Stimme vom Deck lösen und ausblenden (sie läuft im Mixer bis zur Stille weiter). */
  private releaseVoice(d: EngineDeck, fadeMs: number): void {
    const v = d.voice;
    d.voice = null;
    if (!v) return;
    v.deck = null;
    v.fade(0, msToFrames(fadeMs));
  }

  /**
   * Hauptdeck (A/B) für den nächsten Titel: bevorzugt ein leeres, dann eins mit fertigem AutoDJ-Titel,
   * erst zuletzt eins, in das von Hand etwas geladen wurde; spielende Decks nur, wenn beide spielen.
   */
  private freeMainDeck(): EngineDeck {
    const order = [this.decks[this.lastAutoDeck === 'A' ? 'B' : 'A'], this.decks[this.lastAutoDeck]];
    const rank = (d: EngineDeck) => (d.state === 'empty' ? 0 : d.state !== 'playing' && d.auto ? 1 : d.state !== 'playing' ? 2 : 3);
    return order.reduce((best, d) => (rank(d) < rank(best) ? d : best));
  }

  /** Mikrofon/Line-In auf Sendung (mit Ducking der Musik) oder stumm. */
  setMic(on: boolean): void {
    if (on && this.inputState !== 'running') throw new Error('Kein Aufnahmegerät aktiv');
    this.micOn = on;
    this.hooks.log(on ? 'mic_on' : 'mic_off');
  }

  // ---------- Live-Quellen im Mixer ----------

  /** Live-Quelle verbunden: Decoder starten (Daten folgen über liveData). */
  liveOpen(id: string, contentType: string, init?: Buffer): void {
    if (!this.running) return;
    const old = this.live.get(id);
    if (old) this.killLive(old);
    const ch = new LiveChannel(id, contentType);
    const p = spawn(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', 'nobuffer', '-probesize', '32768', '-analyzeduration', '0',
      ...inputFormat(contentType), '-i', 'pipe:0', '-vn', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    ch.proc = p;
    p.stdout!.on('data', (d: Buffer) => ch.fifo.push(d));
    let err = '';
    p.stderr!.on('data', (d) => (err = (err + d).slice(-300)));
    p.stdin!.on('error', () => {});
    p.on('error', (e) => (ch.error = e.message));
    p.on('close', (code) => {
      if (ch.proc !== p) return;
      ch.proc = null;
      if (code && !ch.closing) {
        ch.error = err.trim() || `Decoder beendet (${code})`;
        this.hooks.log('live_decode_failed', { sourceId: id, contentType, stderr: ch.error });
      }
    });
    this.live.set(id, ch);
    if (init) this.liveData(id, init);
    this.hooks.log('live_open', { sourceId: id, contentType });
  }

  liveData(id: string, chunk: Buffer): void {
    const ch = this.live.get(id);
    const stdin = ch?.proc?.stdin;
    if (!ch || !stdin || ch.closing) return;
    ch.bytesIn += chunk.length;
    // Echtzeit: staut sich der Decoder, lieber Daten verwerfen als Speicher volllaufen lassen
    if (stdin.writableLength < 1024 * 1024) stdin.write(chunk);
  }

  liveClose(id: string): void {
    const ch = this.live.get(id);
    if (!ch) return;
    ch.closing = true;
    ch.proc?.stdin?.end();
    // ausblenden lassen; entfernt wird der Kanal im Mixer, sobald er stumm ist
    if (this.program === id) this.program = null;
  }

  hasLive(id: string): boolean {
    return this.live.has(id) && !this.live.get(id)!.closing;
  }

  /**
   * Programm wählen: null = Automation, sonst eine Live-Quelle. Beim Wechsel auf Live werden laufende Titel
   * ausgeblendet (die Automation pausiert, siehe setAutomation); Carts laufen weiter.
   */
  setProgram(id: string | null): void {
    if (this.program === id) return;
    this.program = id;
    if (id !== null) for (const v of this.voices) if (v.kind === 'track' && v.fadeTo !== 0) v.fade(0, msToFrames(this.opts.liveFadeMs ?? 400));
    this.hooks.log('program', { program: id ?? 'automation' });
  }

  /** Automation darf selbstständig Titel starten (AUTO/EMERGENCY) oder nicht (MANUAL/LIVE). */
  setAutomation(on: boolean): void {
    this.automationOn = on;
  }

  /** Titel sofort auf Sendung (MANUAL „jetzt senden“): laufender Titel wird kurz ausgeblendet. */
  playNow(media: MediaItem): void {
    if (!this.running) return;
    const target = this.freeMainDeck();
    // laufenden Titel auf dem anderen Hauptdeck kurz ausblenden
    for (const id of ['A', 'B'] as const) {
      const d = this.decks[id];
      if (d === target || !d.voice) continue;
      this.releaseVoice(d, 500);
      d.state = d.auto ? 'empty' : 'cued';
      if (d.auto) d.media = null;
      d.posMs = d.media?.cueInMs ?? 0;
    }
    if (target.voice) this.releaseVoice(target, 500);
    target.media = media;
    this.lastAutoDeck = target.id as 'A' | 'B';
    this.startDeckVoice(target, media.cueInMs ?? 0, false);
  }

  private killLive(ch: LiveChannel): void {
    ch.closing = true;
    const p = ch.proc;
    ch.proc = null;
    p?.stdin?.end();
    p?.kill('SIGKILL');
    ch.fifo.clear();
  }

  /** Live-Kanäle in den Bus mischen (Jitter-Puffer, Überblendung, Entfernen beendeter Kanäle). */
  private mixLive(bus: Float32Array, due: number): void {
    const pre = msToFrames(LIVE_PREBUFFER_MS);
    const max = msToFrames(LIVE_MAX_MS);
    const fadeFrames = msToFrames(this.opts.liveFadeMs ?? 400);
    for (const ch of [...this.live.values()]) {
      const target = this.program === ch.id && !ch.closing ? 1 : 0;
      // nicht auf Sendung: nur aktuell halten, damit ein Wechsel ohne Verzögerung klingt
      if (target === 0 && ch.gain === 0) {
        if (ch.fifo.frames > pre) ch.fifo.drop(ch.fifo.frames - pre);
        if (ch.closing && (!ch.proc || ch.fifo.frames === 0)) this.removeLive(ch);
        continue;
      }
      if (ch.fifo.frames > max) ch.fifo.drop(ch.fifo.frames - pre);
      if (!ch.primed) {
        if (ch.fifo.frames < pre && !ch.closing) continue;
        ch.primed = true;
      }
      const { samples, got } = ch.fifo.read(due);
      if (got < due) {
        this.underruns++;
        // leergelaufen: neu puffern statt stotternd weiterzuspielen
        if (!ch.closing) ch.primed = false;
      }
      const from = ch.gain;
      const to = from + Math.sign(target - from) * Math.min(Math.abs(target - from), due / fadeFrames);
      ch.gain = to;
      mixInto(bus, samples, from, to);
      if (ch.closing && ch.gain === 0) this.removeLive(ch);
    }
  }

  private removeLive(ch: LiveChannel): void {
    if (this.live.get(ch.id) !== ch) return;
    this.killLive(ch);
    this.live.delete(ch.id);
    this.hooks.log('live_closed', { sourceId: ch.id });
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
            positionMs: cur.positionMs,
            durationMs: cur.totalFrames == null ? null : framesToMs(cur.totalFrames) + cur.startMs - (cur.media.cueInMs ?? 0),
            deck: cur.deck ?? 'A',
          }
        : null,
      fading: (() => {
        const f = this.voices.find((v) => v.kind === 'track' && v.fadeTo === 0 && !v.finished && v.deck);
        return f ? { mediaId: f.media.id, title: f.media.title, deck: f.deck! } : null;
      })(),
      decks: Object.values(this.decks).map((d) => ({
        id: d.id, state: d.state, mediaId: d.media?.id ?? null, title: d.media?.title ?? null, artist: d.media?.artist ?? null,
        positionMs: d.voice ? d.voice.positionMs : d.posMs,
        durationMs: d.media ? (d.media.cueOutMs ?? d.media.durationMs ?? null) : null,
        auto: d.auto,
      })),
      carts: this.voices.filter((v) => v.kind === 'cart').length,
      startedAt: this.startedAt,
      underruns: this.underruns,
      micOn: this.micOn,
      input: this.inputState,
      monitor: !!this.monitorProc,
      program: this.program,
      automation: this.automationOn,
      live: [...this.live.values()].filter((c) => !c.closing).map((c) => ({ id: c.id, contentType: c.contentType, buffered: framesToMs(c.fifo.frames), primed: c.primed, bytesIn: c.bytesIn, error: c.error })),
    };
  }

  // ---------- intern ----------

  private currentTrack(): Voice | undefined {
    // jüngster nicht ausblendender Track
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i]!;
      if (v.kind === 'track' && v.fadeTo !== 0 && (v.deck === 'A' || v.deck === 'B')) return v;
    }
    return undefined;
  }

  /** Codec-Argumente für ein Encoder-Profil (Hauptencoder oder AirDeckCast-Zusatzprofil) - eine Umsetzung. */
  private codecArgs(opts: StreamProfileOpts): string[] {
    const br = `${opts.bitrateKbps}k`;
    return opts.format === 'opus' ? ['-c:a', 'libopus', '-b:a', br, '-f', 'ogg', '-page_duration', '200000']
      : opts.format === 'aac' ? ['-c:a', 'aac', '-b:a', br, '-f', 'adts']
      : opts.mp3Mode === 'vbr'
        ? ['-c:a', 'libmp3lame', '-q:a', String(Math.max(0, Math.min(9, opts.mp3Quality ?? 2))), '-f', 'mp3']
        : ['-c:a', 'libmp3lame', '-b:a', br, '-compression_level', String(Math.max(0, Math.min(9, opts.mp3Quality ?? 2))), '-f', 'mp3'];
  }

  private startEncoder(): void {
    const codec = this.codecArgs(this.opts);
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

  /**
   * AirDeckCast: ein zusätzliches Encoder-Profil starten (z. B. "Mobile AAC 64k"), gespeist aus
   * demselben Programmbus wie der Hauptencoder - ein Mix, mehrere Ausgänge. Läuft neben dem
   * Hauptencoder, unabhängig davon, ob dieser gerade neu startet.
   */
  addProfile(id: string, opts: StreamProfileOpts, hooks: StreamProfileHooks): void {
    this.removeProfile(id);
    const rt: StreamProfileRuntime = { opts, hooks, proc: null };
    this.profiles.set(id, rt);
    if (this.running) this.startProfileEncoder(id, rt);
  }

  removeProfile(id: string): void {
    const rt = this.profiles.get(id);
    if (!rt) return;
    this.profiles.delete(id);
    rt.proc?.kill('SIGKILL');
  }

  listProfiles(): string[] {
    return [...this.profiles.keys()];
  }

  private startProfileEncoder(id: string, rt: StreamProfileRuntime): void {
    const codec = this.codecArgs(rt.opts);
    const proc = spawn(
      this.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', ...RAW_IN, '-i', 'pipe:0', ...codec, '-flush_packets', '1', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    rt.proc = proc;
    rt.hooks.onStreamStart(CONTENT_TYPE[rt.opts.format]);
    proc.stdout!.on('data', (d: Buffer) => rt.hooks.onStreamData(d));
    proc.stderr!.on('data', () => {});
    proc.stdin!.on('error', () => {});
    proc.on('error', (e) => this.hooks.log('profile_encoder_error', { profile: id, message: e.message }));
    proc.on('close', () => {
      if (rt.proc !== proc) return;
      rt.proc = null;
      if (!this.running || !this.profiles.has(id)) return;
      rt.hooks.onStreamStop();
      setTimeout(() => this.running && this.profiles.has(id) && !rt.proc && this.startProfileEncoder(id, rt), 1000).unref();
    });
  }

  /**
   * AirDeckCast: HLS-Ausgabe starten/aktualisieren (z. B. für einen anderen Sender-Player). Ersetzt eine
   * gleichnamige Ausgabe - dieselbe id mit neuen Optionen startet den Segmentierer neu.
   */
  addHls(id: string, opts: HlsOpts): void {
    this.removeHls(id);
    const rt: HlsRuntime = { opts, proc: null };
    this.hlsOutputs.set(id, rt);
    if (this.running) this.startHls(id, rt);
  }

  removeHls(id: string): void {
    const rt = this.hlsOutputs.get(id);
    if (!rt) return;
    this.hlsOutputs.delete(id);
    rt.proc?.kill('SIGKILL');
  }

  listHls(): string[] {
    return [...this.hlsOutputs.keys()];
  }

  private startHls(id: string, rt: HlsRuntime): void {
    const { dir, bitrateKbps, segmentSeconds = 6, listSize = 6 } = rt.opts;
    mkdirSync(dir, { recursive: true });
    const proc = spawn(
      this.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin', ...RAW_IN, '-i', 'pipe:0',
        '-c:a', 'aac', '-b:a', `${bitrateKbps}k`,
        '-f', 'hls', '-hls_time', String(segmentSeconds), '-hls_list_size', String(listSize),
        '-hls_flags', 'delete_segments+append_list',
        '-hls_segment_filename', join(dir, 'seg_%05d.ts'),
        join(dir, 'index.m3u8'),
      ],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
    );
    rt.proc = proc;
    proc.stderr!.on('data', () => {});
    proc.stdin!.on('error', () => {});
    proc.on('error', (e) => this.hooks.log('hls_error', { id, message: e.message }));
    proc.on('close', () => {
      if (rt.proc !== proc) return;
      rt.proc = null;
      if (!this.running || !this.hlsOutputs.has(id)) return;
      setTimeout(() => this.running && this.hlsOutputs.has(id) && !rt.proc && this.startHls(id, rt), 1000).unref();
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
    if (v.startMs > 0) args.push('-ss', (v.startMs / 1000).toFixed(3));
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
    const d = this.freeMainDeck();
    if (d.voice) this.releaseVoice(d, 300);
    d.media = m;
    this.lastAutoDeck = d.id as 'A' | 'B';
    const v = this.startDeckVoice(d, m.cueInMs ?? 0, true);
    if (this.opts.fadeInMs > 0) {
      const target = v.gain;
      v.gain = 0;
      v.fade(target, msToFrames(this.opts.fadeInMs));
    }
    return true;
  }

  private mixFrames(m: MediaItem, total: number | null): number {
    // Musik, externe Stream-URLs (category 'stream') und Moderationslinks (category 'voice_track')
    // sollen sauber ein-/ausgeblendet werden, nicht hart geschnitten. Jingles/Sweeper/Station-IDs/News/
    // Werbung bleiben bewusst beim harten Schnitt (knackige Kennung), außer per Titel (segueMs) gesetzt.
    const base = m.segueMs ?? (m.category === 'music' || m.category === 'stream' || m.category === 'voice_track' ? this.opts.crossfadeMs : 0);
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
      if (v.deck) {
        // Pegel je Deck (nach Gain), für die Deck-Anzeigen
        const g = (to * (k ? duckTo : 1)) / 32768;
        for (let i = 0; i < samples.length; i++) v.lvSum += samples[i]! * samples[i]! * g * g;
        v.lvN += samples.length;
      }
      v.played += got;
      if (v.proc && v.fifo.bytes < RESUME_BYTES) v.proc.stdout?.resume();
    }
    this.mixLive(bus, due);

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
      const d = v.deck ? this.decks[v.deck] : null;
      if (d && d.voice === v) {
        // Titel zu Ende: Automation räumt das Deck, von Hand gestartete Titel stehen wieder am Anfang
        d.voice = null;
        if (d.auto) {
          d.media = null;
          d.state = 'empty';
          d.auto = false;
        } else {
          d.state = 'cued';
          d.posMs = d.media?.cueInMs ?? 0;
        }
      }
      return false;
    });

    this.framesOut += due;
    const enc = this.encoder;
    const pcm = busToS16(bus);
    if (enc?.stdin && enc.stdin.writableLength < 2 * 1024 * 1024) enc.stdin.write(pcm);
    for (const rt of this.profiles.values()) {
      const p = rt.proc;
      if (p?.stdin && p.stdin.writableLength < 2 * 1024 * 1024) p.stdin.write(pcm);
    }
    for (const rt of this.hlsOutputs.values()) {
      const p = rt.proc;
      if (p?.stdin && p.stdin.writableLength < 2 * 1024 * 1024) p.stdin.write(pcm);
    }
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
      if (cur?.deck) {
        const d = this.decks[cur.deck];
        this.releaseVoice(d, 500);
        d.state = d.auto ? 'empty' : 'cued';
        if (d.auto) d.media = null;
        d.posMs = d.media?.cueInMs ?? 0;
      }
      // MANUAL/LIVE: nur ausblenden, die Automation verbraucht keinen Titel
      if (this.automationOn && this.program === null) this.startNextTrack();
      return;
    }
    // Pausiert (MANUAL/LIVE): kein selbstständiger nächster Titel, Queue bleibt unangetastet
    if (!this.automationOn || this.program !== null) return;
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
