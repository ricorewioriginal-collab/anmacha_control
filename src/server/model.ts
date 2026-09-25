// Gemeinsame Typen und Hilfsfunktionen des Servers (Sender, Laufzeitzustand, Fehler, Rechte).
// Kein Zustand, keine Seiteneffekte – von app.ts und den Diensten unter services/ genutzt.

import { createHash, randomBytes } from 'node:crypto';
import type { WriteStream } from 'node:fs';
import { PriorityError, type Actor, type SourceConfig } from '../core/source-priority.ts';
import type { CartSlot, ClockTemplate, DeckId, DeckState, MediaItem, PlayQueue, QueueEntry, RotationRules } from '../core/automation.ts';
import type { ClockEvent, ProgramPlan, RecordingPlan, ScheduledJob } from '../core/scheduler.ts';
import type { PlayoutOptions } from './playout.ts';
import type { LautfmConfig } from './lautfm.ts';
import type { IntegrationsConfig } from './notify.ts';
import type { AiStationConfig } from './ai/director.ts';
import type { RelayTap } from './relay.ts';
import type { BroadcastOutput, OutputConfig } from './icecast.ts';
import type { SecretStore } from './secrets.ts';
import type { BaseMode } from '../core/mode.ts';

export const AUDIO_FILE_RE = /\.(mp3|ogg|opus|wav|flac|m4a|aac|webm)$/i;

/** Anbindung eines bestehenden Systems (AzuraCast, Icecast, beliebiger Stream) an einen AirDeck-Sender. */
export interface BridgeConfig {
  id: string;
  name: string;
  kind: 'azuracast' | 'icecast' | 'stream';
  /** Basis-URL (AzuraCast/Icecast) bzw. Stream-URL (stream) */
  url: string;
  /** AzuraCast: Kurzname oder ID des Senders; Icecast: Mount */
  station?: string;
  /** Status spiegeln (Now Playing, Hörer, Verlauf) */
  mirror: boolean;
  /** Stream als Quelle übernehmen (Pull-Relay) */
  pull: boolean;
  /** Explizite Stream-URL für das Relay (sonst aus dem Status) */
  pullUrl?: string;
  /** Quelle, die das Relay speist (wird automatisch angelegt) */
  sourceId?: string;
  priority: number;
}

export interface Station {
  id: string;
  name: string;
  slogan: string;
  primaryColor: string;
  accentColor: string;
  /** Eigenes Logo: Dateiendung + Version (z. B. "png:lq3x"), Datei liegt in data/logos */
  logo?: string;
  /** Öffentliche Statusseite/Widget (Standard: an) */
  publicStatus?: boolean;
  genre?: string;
}

export interface StationData {
  library: MediaItem[];
  queue: QueueEntry[];
  cardwall: CartSlot[];
  clock: ClockTemplate;
  rotation: RotationRules;
  history: string[];
  clockCursor: number;
  autoFill: boolean;
  minQueue: number;
  playout?: PlayoutConfig;
  playlists?: Playlist[];
  jobs?: ScheduledJob[];
  clockEvents?: ClockEvent[];
  plans?: ProgramPlan[];
  recPlans?: RecordingPlan[];
  recordings?: Recording[];
  playLog?: PlayLogEntry[];
  planCursor?: Record<string, number>;
  lautfm?: LautfmConfig;
  integrations?: IntegrationsConfig;
  ai?: AiStationConfig;
  bridges?: BridgeConfig[];
  /** Eingebundene Musikordner (werden indiziert und überwacht, nicht kopiert) */
  linkedFolders?: LinkedFolder[];
  /** Grundbetriebsart des Mode-Managers (AUTO/MANUAL); LIVE/EMERGENCY ergeben sich aus dem Sendezustand */
  mode?: BaseMode;
}

export interface LinkedFolder {
  /** absoluter Pfad auf dem Server/PC */
  path: string;
  category: import('../core/automation.ts').MediaCategory;
  /** Zeitpunkt der letzten vollständigen Durchsicht */
  scannedAt?: number;
  files?: number;
  error?: string;
}

export interface Playlist {
  id: string;
  name: string;
  color: string;
  items: string[];
}

export interface Recording {
  id: string;
  label: string;
  startedAt: number;
  endedAt?: number;
  bytes: number;
  contentType: string;
  file: string;
  planId?: string;
}

export interface PlayLogEntry {
  at: number;
  mediaId: string;
  title: string;
  artist: string;
  category: string;
}

export interface ActiveRecording {
  rec: Recording;
  stream: WriteStream | null;
  tap: RelayTap;
  target: string;
}

export interface PlayoutConfig extends PlayoutOptions {
  /** Nach Serverstart automatisch wieder senden (24/7) */
  autostart: boolean;
  /** Quelle, als die das Playout sendet (Standard: Automation-Quelle des Senders) */
  sourceId?: string;
  /** Notfall-Ordner: spielt, wenn Queue, Sendeuhr und Sendeplan nichts liefern */
  emergencyFolder?: string;
}

export interface PersistedState {
  version: 1;
  stations: Station[];
  sources: SourceConfig[];
  outputs: OutputConfig[];
  data: Record<string, StationData>;
}

export interface ApiToken {
  id: string;
  name: string;
  hash: string;
  scopes: string[];
  roles: string[];
  stationIds: string[];
  createdAt: string;
  /** Gekoppeltes Gerät (Handy, weiterer PC) statt frei erzeugtem API-Token */
  device?: { platform: string; pairedAt: string; lastSeenAt?: string; ip?: string };
}

export interface Principal extends Actor {
  scopes: string[];
  tokenId: string;
  /** Angemeldeter Benutzer (Sitzung), sonst API-Token */
  user?: { id: string; username: string; name: string; mustChangePassword?: boolean };
}

export interface NowPlaying {
  mediaId: string | null;
  deck: DeckId | null;
  startedAt: number | null;
}

export interface StationRuntime {
  station: Station;
  data: StationData;
  queue: PlayQueue;
  decks: Record<DeckId, DeckState>;
  nowPlaying: NowPlaying;
  /** Sendebus spielt Notfall-Material (Queue, Sendeuhr und Sendeplan lieferten nichts) */
  emergencyPlaying?: boolean;
}

export type HubEvent = { type: string; stationId?: string; payload: unknown };

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const ALL_SCOPES = [
  'now_playing:read', 'schedule:read', 'stream:read', 'branding:read', 'queue:read', 'queue:write',
  'cardwall:read', 'cardwall:trigger', 'sources:read', 'sources:write', 'automation:read', 'automation:write',
  'media:read', 'media:write', 'stations:write', 'outputs:read', 'outputs:write', 'audit:read', 'tokens:write',
  'lautfm:read', 'lautfm:write', 'ai:read', 'ai:write', 'bridge:write',
] as const;

export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

// ---------- Hilfsfunktionen ----------

export const SYSTEM_PRINCIPAL: Principal = { id: 'system', tokenId: 'system', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };

export function canSee(p: Principal, stationId: string): boolean {
  return p.stationIds.includes('*') || p.stationIds.includes(stationId);
}

export function relayKey(stationId: string, target: string): string {
  return `${stationId}${target}`;
}

export function normalizeMount(m: unknown): string {
  const s = String(m ?? '').trim();
  const withSlash = s.startsWith('/') ? s : `/${s}`;
  if (!/^\/[a-zA-Z0-9._\-/]{1,100}$/.test(withSlash) || withSlash.includes('..')) {
    throw new AppError(400, 'invalid_mount', 'Ungültiger Mountpoint/Target');
  }
  return withSlash;
}

export function posInt(v: unknown): number | undefined {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function safeColor(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!;
  return diff === 0;
}

export function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof PriorityError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : err.code.startsWith('invalid') ? 400 : 409;
      throw new AppError(status, err.code, err.message);
    }
    throw err;
  }
}

export function publicSource<T extends SourceConfig>(s: T, secrets: SecretStore): Omit<T, 'credentialRef'> & { hasPassword: boolean } {
  const { credentialRef, ...rest } = s;
  return { ...rest, hasPassword: !!credentialRef && secrets.has(credentialRef) };
}

export function publicOutput(o: BroadcastOutput, secrets: SecretStore): Record<string, unknown> {
  const { passwordRef, ...cfg } = o.cfg;
  return { ...cfg, hasPassword: secrets.has(passwordRef), state: { ...o.state } };
}
