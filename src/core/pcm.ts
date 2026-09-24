// PCM-Hilfen für das Server-Playout: s16le, 44,1 kHz, Stereo.

export const SAMPLE_RATE = 44100;
export const CHANNELS = 2;
export const BYTES_PER_FRAME = 4;

export const msToFrames = (ms: number): number => Math.round((ms / 1000) * SAMPLE_RATE);
export const framesToMs = (frames: number): number => Math.round((frames / SAMPLE_RATE) * 1000);
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/** FIFO für PCM-Bytes aus einem Decoder; liest immer ganze Frames und füllt Lücken mit Stille. */
export class PcmFifo {
  private chunks: Buffer[] = [];
  private head = 0;
  /** Rest unvollständiger Frames (Decoder-Chunks sind nicht frame-ausgerichtet) */
  private rem: Buffer = Buffer.alloc(0);
  bytes = 0;

  push(buf: Buffer): void {
    if (this.rem.length) buf = Buffer.concat([this.rem, buf]);
    const usable = buf.length - (buf.length % BYTES_PER_FRAME);
    this.rem = Buffer.from(buf.subarray(usable));
    if (usable === 0) return;
    this.chunks.push(buf.subarray(0, usable));
    this.bytes += usable;
  }

  get frames(): number {
    return Math.floor(this.bytes / BYTES_PER_FRAME);
  }

  /** Liest bis zu n Frames; liefert Samples (Int16, interleaved) und Anzahl echter Frames. */
  read(n: number): { samples: Int16Array; got: number } {
    const samples = new Int16Array(n * CHANNELS);
    const got = Math.min(n, this.frames);
    const need = got * BYTES_PER_FRAME;
    let copied = 0;
    while (copied < need) {
      const c = this.chunks[0]!;
      const avail = c.length - this.head;
      const take = Math.min(avail, need - copied);
      for (let i = 0; i < take; i += 2) {
        samples[(copied + i) >> 1] = c.readInt16LE(this.head + i);
      }
      copied += take;
      this.head += take;
      if (this.head >= c.length) {
        this.chunks.shift();
        this.head = 0;
      }
    }
    this.bytes -= need;
    return { samples, got };
  }

  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.rem = Buffer.alloc(0);
    this.bytes = 0;
  }
}

/**
 * Addiert Samples mit linearer Gain-Rampe in den Float-Mixbus.
 * gainFrom → gainTo über die Länge des Blocks.
 */
export function mixInto(bus: Float32Array, src: Int16Array, gainFrom: number, gainTo: number): void {
  const frames = src.length / CHANNELS;
  const step = frames > 1 ? (gainTo - gainFrom) / frames : 0;
  let g = gainFrom;
  for (let f = 0; f < frames; f++) {
    const i = f * 2;
    bus[i]! += (src[i]! / 32768) * g;
    bus[i + 1]! += (src[i + 1]! / 32768) * g;
    g += step;
  }
}

/** Float-Bus → s16le mit weichem Limiter (kein hartes Clipping ab −2 dBFS). */
export function busToS16(bus: Float32Array): Buffer {
  const out = Buffer.alloc(bus.length * 2);
  const knee = 0.8;
  for (let i = 0; i < bus.length; i++) {
    let x = bus[i]!;
    const a = Math.abs(x);
    if (a > knee) x = Math.sign(x) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x * 32767))), i * 2);
  }
  return out;
}

/** RMS-Pegel eines Float-Busses in dBFS. */
export function busRmsDb(bus: Float32Array): number {
  if (bus.length === 0) return -90;
  let sum = 0;
  for (let i = 0; i < bus.length; i++) sum += bus[i]! * bus[i]!;
  const rms = Math.sqrt(sum / bus.length);
  return rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90;
}
