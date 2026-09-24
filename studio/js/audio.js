// @ts-check
// AirDeck Audio Engine (Web Audio API): 4 Decks, Cart-Player, Master-Bus mit Limiter,
// Pegelmessung, Ducking und Studio-Stream (MediaRecorder → Relay).

export const DECKS = /** @type {const} */ (['A', 'B', 'C', 'D']);

/** @param {AnalyserNode} an @param {Float32Array<ArrayBuffer>} buf */
function measureDb(an, buf) {
  an.getFloatTimeDomainData(buf);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / buf.length);
  const toDb = (/** @type {number} */ x) => (x > 0 ? Math.max(-90, 20 * Math.log10(x)) : -90);
  return { rmsDb: toDb(rms), peakDb: toDb(peak) };
}

export class Deck {
  /** @param {AudioEngine} engine @param {string} id */
  constructor(engine, id) {
    this.engine = engine;
    this.id = id;
    this.el = new Audio();
    this.el.preload = 'auto';
    /** @type {any} */
    this.media = null;
    this.src = engine.ctx.createMediaElementSource(this.el);
    this.gain = engine.ctx.createGain();
    this.analyser = engine.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.src.connect(this.gain).connect(this.analyser).connect(engine.musicBus);
    this.volume = 1;
    this.segueFired = false;
    /** @type {(d: Deck) => void} */
    this.onEnded = () => {};
    this.el.addEventListener('ended', () => this.onEnded(this));
  }

  /** @param {any} media @param {string} url */
  load(media, url) {
    this.media = media;
    this.segueFired = false;
    this.el.src = url;
    this.el.currentTime = (media.cueInMs ?? 0) / 1000;
    this.gain.gain.cancelScheduledValues(0);
    this.gain.gain.value = this.volume * dbToGain(media.gainDb ?? 0);
  }

  async play() {
    if (!this.media) return;
    await this.engine.resume();
    await this.el.play();
  }

  pause() {
    this.el.pause();
  }

  stop() {
    this.el.pause();
    if (this.media) this.el.currentTime = (this.media.cueInMs ?? 0) / 1000;
  }

  eject() {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.media = null;
  }

  /** @param {number} seconds */
  fadeOut(seconds) {
    const g = this.gain.gain;
    const t = this.engine.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.0001, t + seconds);
    setTimeout(() => {
      this.stop();
      g.cancelScheduledValues(0);
      g.value = this.volume * dbToGain(this.media?.gainDb ?? 0);
    }, seconds * 1000 + 50);
  }

  /** @param {number} v 0..1 */
  setVolume(v) {
    this.volume = v;
    this.gain.gain.value = v * dbToGain(this.media?.gainDb ?? 0);
  }

  get playing() {
    return !this.el.paused && !this.el.ended && !!this.media;
  }

  get positionMs() {
    return this.el.currentTime * 1000;
  }

  get durationMs() {
    const d = this.el.duration;
    const end = this.media?.cueOutMs;
    const total = Number.isFinite(d) ? d * 1000 : this.media?.durationMs ?? 0;
    return end ? Math.min(end, total) : total;
  }

  get remainingMs() {
    return Math.max(0, this.durationMs - this.positionMs);
  }

  level() {
    return measureDb(this.analyser, this.buf);
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    // Musik-Bus (wird beim Ducking abgesenkt) → Master → Limiter → Ausgang
    this.musicBus = this.ctx.createGain();
    this.master = this.ctx.createGain();
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.15;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.streamDest = this.ctx.createMediaStreamDestination();
    this.musicBus.connect(this.master);
    this.master.connect(this.limiter).connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.analyser.connect(this.streamDest);
    /** @type {Record<string, Deck>} */
    this.decks = {};
    for (const id of DECKS) this.decks[id] = new Deck(this, id);
    this.duckDb = -10;
    this.activeCarts = 0;
    /** @type {MediaRecorder|null} */
    this.recorder = null;
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Cart abspielen (überlagert Musik, optional mit Ducking). @param {string} url @param {boolean} duck */
  async playCart(url, duck) {
    await this.resume();
    const el = new Audio(url);
    const node = this.ctx.createMediaElementSource(el);
    node.connect(this.master);
    if (duck) this.setDuck(+1);
    const done = () => {
      node.disconnect();
      if (duck) this.setDuck(-1);
    };
    el.addEventListener('ended', done, { once: true });
    el.addEventListener('error', done, { once: true });
    await el.play();
    return el;
  }

  /** @param {number} delta */
  setDuck(delta) {
    this.activeCarts = Math.max(0, this.activeCarts + delta);
    const target = this.activeCarts > 0 ? dbToGain(this.duckDb) : 1;
    const t = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setTargetAtTime(target, t, 0.08);
  }

  masterLevel() {
    return measureDb(this.analyser, this.buf);
  }

  /** Limiter-Gain-Reduktion in dB (negativ). */
  get reductionDb() {
    return this.limiter.reduction;
  }

  /**
   * Studio-Stream starten: Master-Summe als WebM/Opus in 1-s-Chunks.
   * @param {(chunk: Blob, first: boolean, type: string) => Promise<void>} send
   */
  startStream(send) {
    if (this.recorder) return;
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    if (!type) throw new Error('Browser unterstützt keine Stream-Kodierung (MediaRecorder)');
    const rec = new MediaRecorder(this.streamDest.stream, { mimeType: type, audioBitsPerSecond: 128_000 });
    let first = true;
    let chain = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      const isFirst = first;
      first = false;
      // Reihenfolge sichern: Chunks strikt nacheinander senden.
      chain = chain.then(() => send(e.data, isFirst, type.split(';')[0])).catch(() => {});
    };
    rec.start(1000);
    this.recorder = rec;
  }

  stopStream() {
    this.recorder?.stop();
    this.recorder = null;
  }
}

/** @param {number} db */
export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/** Stilleerkennung (Spiegel von src/core/automation.ts SilenceDetector). */
export class SilenceDetector {
  constructor(thresholdDb = -50, durationMs = 10_000) {
    this.thresholdDb = thresholdDb;
    this.durationMs = durationMs;
    /** @type {number|null} */
    this.since = null;
    this.alarmed = false;
  }

  /** @param {number} db @param {number} at @returns {'silence'|'recovered'|null} */
  feed(db, at) {
    if (db < this.thresholdDb) {
      if (this.since === null) this.since = at;
      if (!this.alarmed && at - this.since >= this.durationMs) {
        this.alarmed = true;
        return 'silence';
      }
      return null;
    }
    this.since = null;
    if (this.alarmed) {
      this.alarmed = false;
      return 'recovered';
    }
    return null;
  }
}
