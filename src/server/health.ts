// Health- und Dependency-Manager (docs/architecture/DEPLOYMENT.md, NETWORK.md).
// Öffentlich gibt es nur die Zusammenfassung ohne Details; die Einzelberichte sind angemeldet abrufbar.

import { accessSync, constants, existsSync, statfsSync } from 'node:fs';
import { API_VERSION, type AirDeckConfig, type Mode } from './config.ts';
import type { FfmpegInfo } from './ffmpeg.ts';

export type DepState = 'READY' | 'MISSING' | 'OUTDATED' | 'BROKEN';

export interface Dependency {
  id: 'runtime' | 'ffmpeg' | 'ffprobe' | 'database' | 'storage' | 'ai';
  name: string;
  state: DepState;
  version?: string;
  source?: 'bundled' | 'system' | 'custom' | 'builtin';
  detail?: string;
}

export interface AiProviderInfo {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  hasKey: boolean;
  binPath?: string;
}

export interface OutputInfo {
  id: string;
  stationId: string;
  name: string;
  status: string;
  error?: string;
}

export interface EncoderInfo {
  stationId: string;
  running: boolean;
  encoder: string;
  format: string;
  bitrateKbps: number;
}

/** Was der Health-Manager vom Rest des Programms braucht – bewusst schmal gehalten. */
export interface HealthSource {
  name: string;
  version: string;
  build: string;
  mode: Mode;
  packaged: boolean;
  paths: AirDeckConfig['paths'];
  ffmpeg(): FfmpegInfo | null;
  database(): { provider: string; state: DepState; detail?: string; [k: string]: unknown };
  aiProviders(): AiProviderInfo[];
  outputs(): OutputInfo[];
  encoders(): EncoderInfo[];
}

export const MIN_NODE = [22, 18] as const;
/** Unter dieser Grenze meldet der Speicher „wenig Platz“ (kein Fehler, nur Warnung) */
export const LOW_SPACE_BYTES = 1024 ** 3;
const KEY_KINDS = new Set(['openai', 'anthropic', 'google', 'elevenlabs']);

export function nodeState(version = process.versions.node): DepState {
  const [maj = 0, min = 0] = version.split('.').map(Number);
  return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]) ? 'READY' : 'OUTDATED';
}

export interface StorageReport {
  state: 'ok' | 'low' | 'error';
  dirs: { id: keyof AirDeckConfig['paths']; path: string; writable: boolean; freeBytes: number | null }[];
}

function writable(p: string): boolean {
  try {
    accessSync(p, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function freeBytes(p: string): number | null {
  try {
    const s = statfsSync(p);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export function storageReport(paths: AirDeckConfig['paths']): StorageReport {
  // Sicherungsordner wird erst bei der ersten Sicherung angelegt – fehlt er, zählt der Datenordner
  const ids = ['data', 'media', 'logs', 'backups'] as const;
  const dirs = ids.map((id) => {
    const path = paths[id];
    const present = existsSync(path);
    return { id, path, writable: present ? writable(path) : id === 'backups' || id === 'logs', freeBytes: present ? freeBytes(path) : null };
  });
  const broken = dirs.some((d) => !d.writable && (d.id === 'data' || d.id === 'media'));
  const low = dirs.some((d) => d.freeBytes !== null && d.freeBytes < LOW_SPACE_BYTES);
  return { state: broken ? 'error' : low ? 'low' : 'ok', dirs };
}

export function aiState(providers: AiProviderInfo[]): { state: 'off' | 'ready' | 'error'; problems: string[] } {
  const on = providers.filter((p) => p.enabled);
  if (!on.length) return { state: 'off', problems: [] };
  const problems: string[] = [];
  for (const p of on) {
    if (KEY_KINDS.has(p.kind) && !p.hasKey) problems.push(`${p.name}: kein API-Key`);
    if (p.kind === 'piper' && (!p.binPath || !existsSync(p.binPath))) problems.push(`${p.name}: Piper nicht gefunden`);
  }
  return { state: problems.length === on.length ? 'error' : 'ready', problems };
}

export class HealthManager {
  private storageCache: { at: number; report: StorageReport } | null = null;

  private readonly src: HealthSource;

  constructor(src: HealthSource) {
    this.src = src;
  }

  /** Speicherprüfung kostet Systemaufrufe – höchstens alle 30 s */
  storage(): StorageReport {
    const now = Date.now();
    if (!this.storageCache || now - this.storageCache.at > 30_000) this.storageCache = { at: now, report: storageReport(this.src.paths) };
    return this.storageCache.report;
  }

  dependencies(): Dependency[] {
    const f = this.src.ffmpeg();
    const db = this.src.database();
    const st = this.storage();
    const ai = aiState(this.src.aiProviders());
    const missingEnc = f ? [!f.encoders.mp3 && 'MP3 (LAME)', !f.encoders.opus && 'Opus'].filter(Boolean) : [];
    return [
      { id: 'runtime', name: 'Node.js-Laufzeit', state: nodeState(), version: process.versions.node, source: this.src.packaged ? 'bundled' : 'system' },
      f
        ? { id: 'ffmpeg', name: 'ffmpeg', state: missingEnc.length ? 'BROKEN' : 'READY', version: f.version.replace(/^ffmpeg version\s+/i, '').split(' ')[0], source: f.source, detail: missingEnc.length ? `ohne ${missingEnc.join(', ')}` : undefined }
        : { id: 'ffmpeg', name: 'ffmpeg', state: 'MISSING', detail: 'Server-Playout, Analyse und Aufnahme nicht verfügbar' },
      { id: 'ffprobe', name: 'ffprobe', state: f?.ffprobe ? 'READY' : 'MISSING', source: f?.ffprobe ? f.source : undefined },
      { id: 'database', name: 'Datenbank', state: db.state, version: db.provider, source: 'builtin', detail: db.detail },
      { id: 'storage', name: 'Speicher', state: st.state === 'error' ? 'BROKEN' : 'READY', detail: st.state === 'low' ? 'wenig freier Speicher' : st.state === 'error' ? 'Daten- oder Medienordner nicht beschreibbar' : undefined },
      { id: 'ai', name: 'KI', state: ai.state === 'error' ? 'BROKEN' : 'READY', detail: ai.state === 'off' ? 'nicht eingerichtet' : ai.problems.join('; ') || undefined },
    ];
  }

  streamState(stationIds: (id: string) => boolean = () => true): 'connected' | 'connecting' | 'error' | 'idle' {
    const outs = this.src.outputs().filter((o) => stationIds(o.stationId));
    if (outs.some((o) => o.status === 'connected')) return 'connected';
    if (outs.some((o) => o.status === 'error' || o.status === 'unsupported')) return 'error';
    if (outs.some((o) => o.status === 'connecting')) return 'connecting';
    return 'idle';
  }

  /** Öffentliche Zusammenfassung – keine Pfade, Namen oder Fehlermeldungen */
  summary(): Record<string, string> {
    const f = this.src.ffmpeg();
    const st = this.storage();
    const db = this.src.database();
    const enc = this.src.encoders();
    const stream = this.streamState();
    const ai = aiState(this.src.aiProviders()).state;
    const database = db.state === 'READY' ? 'ok' : 'error';
    const audio = f ? 'ok' : 'unavailable';
    const encoder = !f || !f.encoders.mp3 ? 'unavailable' : enc.some((e) => e.running && e.encoder !== 'running') ? 'restarting' : enc.some((e) => e.running) ? 'running' : 'idle';
    const status = database === 'error' || st.state === 'error' ? 'error' : audio !== 'ok' || encoder === 'restarting' || stream === 'error' || st.state === 'low' || ai === 'error' ? 'degraded' : 'ok';
    return { status, name: this.src.name, version: this.src.version, api: API_VERSION, mode: this.src.mode, server: 'ok', database, storage: st.state, audio, encoder, stream, ai };
  }

  system(): Record<string, unknown> {
    return {
      name: this.src.name, version: this.src.version, api: API_VERSION, build: this.src.build, mode: this.src.mode,
      node: process.versions.node, platform: `${process.platform}-${process.arch}`, packaged: this.src.packaged,
      dependencies: this.dependencies(),
    };
  }

  database(): unknown {
    return this.src.database();
  }

  audio(): unknown {
    const f = this.src.ffmpeg();
    return {
      ffmpeg: f ? { version: f.version, source: f.source, encoders: f.encoders, ffprobe: !!f.ffprobe, ffplay: !!f.ffplay } : null,
      // Mithören/CUE/Mikrofon laufen am Client (MULTI_PLATFORM.md) – hier nur, was der Server selbst kann
      serverPlayout: !!f,
    };
  }

  encoder(stationIds: (id: string) => boolean): unknown {
    return { encoders: this.src.encoders().filter((e) => stationIds(e.stationId)) };
  }

  stream(stationIds: (id: string) => boolean): unknown {
    return { state: this.streamState(stationIds), outputs: this.src.outputs().filter((o) => stationIds(o.stationId)) };
  }

  ai(): unknown {
    const providers = this.src.aiProviders();
    const a = aiState(providers);
    return { state: a.state, problems: a.problems, providers: providers.map(({ binPath: _b, ...p }) => p) };
  }
}
