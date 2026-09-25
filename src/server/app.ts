// AirDeck Server-Zustand: Sender, Quellen, Relay, Ausgänge, Medien, Queue, Cardwall.
// Keine Abhängigkeit zu AnMaCha oder anderen externen Diensten.

import { createHash, randomBytes } from 'node:crypto';
import { cpus, freemem, networkInterfaces, totalmem, uptime as osUptime } from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createWriteStream, mkdirSync, rmSync, type WriteStream } from 'node:fs';
import { extname, join } from 'node:path';
import {
  SourcePriorityEngine,
  PriorityError,
  type Actor,
  type EngineEvent,
  type SourceConfig,
} from '../core/source-priority.ts';
import {
  DEFAULT_CLOCK,
  DEFAULT_ROTATION,
  PlayQueue,
  backtime,
  defaultCardwall,
  fillFromClock,
  playLength,
  type CartSlot,
  type ClockTemplate,
  type DeckId,
  type DeckState,
  type MediaItem,
  type QueueEntry,
  type RotationRules,
  DECK_IDS,
  MEDIA_CATEGORIES,
  parseFileName,
} from '../core/automation.ts';

const AUDIO_FILE_RE = /\.(mp3|ogg|opus|wav|flac|m4a|aac|webm)$/i;
import { AuditLog, readJson, writeFileAtomic } from './store.ts';
import { DbDocStore, importJsonFilesSync, type DocStore } from './repo/docs.ts';
import { openSqliteSync } from './db/index.ts';
import { SCHEMA_VERSION } from './db/schema.ts';
import { SecretStore } from './secrets.ts';
import { IcecastOutput, type BroadcastOutput, type OutputConfig, type OutputState } from './icecast.ts';
import { ShoutcastOutput } from './shoutcast.ts';
import { fetchListeners } from './stats.ts';
import { RelayTarget } from './relay.ts';
import { analyzeLoudness, detectFfmpeg, detectFfmpegAsync, inputDeviceArgs, listInputDevices, probeMedia, type FfmpegInfo } from './ffmpeg.ts';
import { DEFAULT_PLAYOUT, DSP_PRESETS, EQ_BANDS, Playout, type PlayoutOptions } from './playout.ts';
import {
  activeWindow, clockDue, dueJobs, nextOccurrence, parseM3U, toM3U, validateClock, validateWindow,
  type ClockEvent, type JobTarget, type ProgramPlan, type RecordingPlan, type Repeat, type ScheduledJob,
} from '../core/scheduler.ts';
import { pickNext as pickFromPool } from '../core/automation.ts';
import type { RelayTap } from './relay.ts';
import { DEFAULT_ORIGIN, ORIGIN_RE, PUBLIC_API, RADIOADMIN, loginUrl, type LautfmConfig } from './lautfm.ts';
import { SyncManager } from './sync.ts';
import { appVersion, type AirDeckConfig, type Mode } from './config.ts';
import { HealthManager } from './health.ts';
import { DEFAULT_SOURCE, Updater, type UpdateSource } from './update.ts';
import { AiService } from './ai/service.ts';
import { AiDirector, DEFAULT_AI, type AiStationConfig, type AiSource } from './ai/director.ts';
import { AiError } from './ai/providers.ts';
import { Nextcloud, NextcloudError, cleanPath, type NextcloudConfig } from './nextcloud.ts';
import { liquidsoapScript } from './liquidsoap.ts';
import { UserStore } from './users.ts';
import { lautfmStatus, listenUrlOf, type StreamStatus } from './status.ts';
import { PullRelay, fetchAzuracast, fetchIcecastMount, type ExternalNow } from './bridge.ts';

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
import { readFileSync, writeFileSync } from 'node:fs';
import { NOTIFY_EVENTS, Notifier, validateExportPath, validateWebhookUrl, type IntegrationsConfig, type NotifyEvent } from './notify.ts';

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

interface StationData {
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

interface ActiveRecording {
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

interface PersistedState {
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

interface StationRuntime {
  station: Station;
  data: StationData;
  queue: PlayQueue;
  decks: Record<DeckId, DeckState>;
  nowPlaying: NowPlaying;
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

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export class AirDeckApp {
  readonly dataDir: string;
  readonly mediaDir: string;
  readonly engine: SourcePriorityEngine;
  readonly secrets: SecretStore;
  readonly audit: AuditLog;
  private readonly stations = new Map<string, StationRuntime>();
  private readonly outputs = new Map<string, BroadcastOutput>();
  private readonly relays = new Map<string, RelayTarget>();
  private readonly playouts = new Map<string, { playout: Playout; source: SourceConfig }>();
  /** kann sich im Betrieb ändern: fehlgeschlagene Erkennung wird im Hintergrund wiederholt */
  ffmpeg: FfmpegInfo | null;
  readonly health: HealthManager;
  readonly mode: Mode;
  readonly version: string;
  readonly paths: AirDeckConfig['paths'];
  private ffmpegRetry: NodeJS.Timeout | null = null;
  private tickCount = 0;
  private lastSchedAt = Date.now();
  private readonly activePlanId = new Map<string, string | null>();
  private readonly recorders = new Map<string, ActiveRecording>();
  private readonly notifier: Notifier;
  private readonly lastOutStatus = new Map<string, string>();
  private readonly subscribers = new Set<(e: HubEvent) => void>();
  /** Datenhaltung: Datenbank (Standard SQLite im Datenordner) */
  readonly docs: DocStore;
  /** von der App selbst geöffnete Datenbank (wird beim Beenden geschlossen) */
  private readonly ownDb: { close(): Promise<void> } | null;
  private tokens: ApiToken[];
  private tickTimer: NodeJS.Timeout | null = null;
  private levelTimer: NodeJS.Timeout | null = null;

  readonly sync: SyncManager;

  readonly updater: Updater;
  readonly users: UserStore;
  readonly ai: AiService;
  readonly director: AiDirector;
  readonly packaged: boolean;
  readonly headless: boolean;
  readonly appRoot: string;
  listenHost = '127.0.0.1';
  /** Vom Einstiegspunkt gesetzt: sauber beenden (Studio-Knopf „AirDeck beenden“, Tray, --stop) */
  requestShutdown: (() => void) | null = null;
  listenPort = 8750;

  constructor(dataDir: string, opts: { stableMs?: number; cooldownMs?: number; appRoot?: string; ffmpeg?: FfmpegInfo | null; secrets?: SecretStore; sync?: SyncManager; build?: string; packaged?: boolean; headless?: boolean; config?: AirDeckConfig; ffmpegRetryS?: number[]; docs?: DocStore } = {}) {
    this.dataDir = dataDir;
    if (opts.docs) {
      this.docs = opts.docs;
      this.ownDb = null;
    } else {
      // ohne Vorgabe (Tests, Hilfsinstanzen): SQLite im Datenordner, bisherige JSON-Dateien werden übernommen
      const db = openSqliteSync(join(dataDir, 'airdeck.db'));
      const store = DbDocStore.openSync(db);
      importJsonFilesSync(dataDir, store);
      this.docs = store;
      this.ownDb = db;
    }
    this.ffmpeg = opts.ffmpeg !== undefined ? opts.ffmpeg : detectFfmpeg(opts.appRoot ?? process.cwd());
    this.ffmpegDisabled = opts.ffmpeg === null;
    if (opts.ffmpegRetryS) this.ffmpegRetryS = opts.ffmpegRetryS;
    this.mediaDir = opts.config?.paths.media ?? join(dataDir, 'media');
    mkdirSync(this.mediaDir, { recursive: true });
    this.paths = opts.config?.paths ?? { config: join(dataDir, 'config'), data: dataDir, media: this.mediaDir, logs: join(dataDir, 'logs'), backups: join(dataDir, 'backups') };
    this.mode = opts.config?.mode ?? (opts.headless ? 'server' : 'local');
    this.version = appVersion(opts.appRoot ?? process.cwd());
    this.secrets = opts.secrets ?? new SecretStore(dataDir);
    this.updater = new Updater(opts.build ?? 'dev');
    this.packaged = opts.packaged ?? false;
    this.appRoot = opts.appRoot ?? process.cwd();
    this.headless = opts.headless ?? false;
    this.audit = new AuditLog(join(dataDir, 'audit.log'));
    this.users = new UserStore(dataDir, this.docs);
    this.ai = new AiService(dataDir, {
      get: (ref) => this.secrets.get(ref),
      set: (ref, v) => (v === null ? this.secrets.delete(ref) : this.secrets.set(ref, v)),
    }, (event, data) => this.audit.write({ kind: 'ai', event, ...data }), fetch, this.docs);
    this.director = new AiDirector({
      station: (id) => this.rt(id).station,
      library: (id) => this.rt(id).data.library,
      queue: (id) => this.rt(id).queue.list(),
      history: (id) => (this.rt(id).data.playLog ?? []).map((e) => e.mediaId),
      insert: (id, mediaId, index) => {
        this.rt(id).queue.add(mediaId, 'ai', index);
        this.publishQueue(id);
      },
      addGenerated: (id, audio, ext, title, category) => this.addGeneratedMedia(id, audio, ext, title, category),
      remove: (id, mediaId) => {
        if (this.rt(id).data.library.some((m) => m.id === mediaId)) this.removeMedia(id, mediaId);
      },
      nowPlayingId: (id) => this.rt(id).nowPlaying.mediaId,
      pickJingle: (id) => {
        const rt = this.rt(id);
        return pickFromPool(rt.data.library, 'station_id', rt.data.history, rt.data.rotation) ?? pickFromPool(rt.data.library, 'jingle', rt.data.history, rt.data.rotation);
      },
      event: (id, type, payload) => {
        this.audit.write({ kind: 'ai', event: type, stationId: id, ok: payload.ok, detail: typeof payload.detail === 'string' ? payload.detail.slice(0, 300) : undefined, cost: payload.cost });
        if (id !== '*') this.publish(type, id, payload);
      },
    }, this.ai, (id) => this.aiConfig(id));
    this.tokens = this.docs.get<ApiToken[]>('tokens', []);
    this.notifier = new Notifier((ref) => this.secrets.get(ref), (event, data) => this.audit.write({ kind: 'notify', event, ...data }));

    const state = this.docs.get<PersistedState | null>('airdeck', null);
    // Neustart: Quellen starten getrennt und müssen sich neu verbinden (keine konkurrierenden Aktiven).
    this.engine = SourcePriorityEngine.restore(state?.sources ?? [], {
      stableMs: opts.stableMs ?? 2000,
      cooldownMs: opts.cooldownMs ?? 0,
    });
    this.engine.on((e) => this.onEngineEvent(e));
    this.docs.bind('airdeck', () => this.snapshot());
    this.sync = opts.sync ?? new SyncManager(dataDir, this.secrets, (event, data) => this.audit.write({ kind: 'sync', event, ...data }));
    this.health = new HealthManager({
      name: 'AirDeck',
      version: this.version,
      build: opts.build ?? 'dev',
      mode: this.mode,
      packaged: this.packaged,
      paths: this.paths,
      ffmpeg: () => this.ffmpeg,
      database: () => {
        const st = this.docs.status();
        const backend = this.sync.config.backend;
        return {
          provider: this.docs instanceof DbDocStore ? this.docs.db.dialect : 'json',
          state: st.state === 'error' ? 'BROKEN' : 'READY',
          detail: st.lastError ?? (backend === 'local' ? undefined : `zusätzlicher Abgleich ${backend}${this.sync.status.lastError ? `: ${this.sync.status.lastError}` : ''}`),
          pending: st.pending,
          lastWriteAt: st.lastWriteAt,
          sync: { backend, lastDecision: this.sync.status.lastDecision, lastPushAt: this.sync.status.lastPushAt, error: this.sync.status.lastError },
        };
      },
      aiProviders: () => ((this.ai.view() as { providers: { id: string; name: string; kind: string; enabled: boolean; hasKey: boolean; binPath?: string }[] }).providers),
      outputs: () => [...this.outputs.values()].map((o) => ({ id: o.cfg.id, stationId: o.cfg.stationId, name: o.cfg.name, status: o.state.status, error: o.state.error })),
      encoders: () => [...this.playouts].map(([stationId, { playout }]) => {
        const st = playout.status();
        return { stationId, running: st.running, encoder: st.encoder, format: st.format, bitrateKbps: st.bitrateKbps };
      }),
    });
    this.docs.onWrite = (name) => {
      if (name === 'airdeck') this.sync.schedulePush(() => this.stateJson());
    };
    if (this.docs instanceof DbDocStore) this.docs.onStatus = (st) => this.publish('DATABASE_STATUS_CHANGED', undefined, { state: st.state, error: st.lastError });

    for (const st of state?.stations ?? []) this.mountStation(st, state?.data[st.id]);
    for (const o of state?.outputs ?? []) this.mountOutput(o);
    if (this.stations.size === 0) this.createStation({ id: 'main', name: 'AirDeck Radio' }, true);
  }

  start(): void {
    this.tickTimer = setInterval(() => this.tick(), 500);
    this.tickTimer.unref();
    // Pegel des Kerns für die VU-Anzeige (nur wenn jemand zuhört)
    this.levelTimer = setInterval(() => {
      if (this.subscribers.size === 0) return;
      for (const [id, { playout }] of this.playouts) this.publish('playout.level', id, playout.readLevel());
    }, 200);
    this.levelTimer.unref();
    // Brücken: Relays zu bestehenden Systemen wieder aufnehmen
    this.startBridges();
    this.autostartPlayouts();
    if (!this.ffmpeg && !this.ffmpegDisabled) this.scheduleFfmpegRetry(0);
  }

  /** false, wenn Tests bzw. Hilfsinstanzen ffmpeg ausdrücklich abgeschaltet haben */
  private ffmpegDisabled = false;
  private ffmpegRetryS = [10, 30, 60, 120, 300];

  /** ffmpeg-Erkennung ist beim Start fehlgeschlagen (z. B. Zeitüberschreitung unter Last): im Hintergrund erneut suchen. */
  private scheduleFfmpegRetry(attempt: number): void {
    const delay = this.ffmpegRetryS[attempt];
    if (delay === undefined) {
      this.audit.write({ kind: 'system', event: 'ffmpeg_missing', attempts: attempt });
      return;
    }
    this.ffmpegRetry = setTimeout(() => {
      void detectFfmpegAsync(this.appRoot).then((info) => {
        this.ffmpegRetry = null;
        if (!info) return this.scheduleFfmpegRetry(attempt + 1);
        this.ffmpeg = info;
        console.log(`ffmpeg gefunden (Versuch ${attempt + 2}): ${info.version}`);
        this.audit.write({ kind: 'system', event: 'ffmpeg_ready', source: info.source, attempt: attempt + 2 });
        this.publish('system.dependency', undefined, { id: 'ffmpeg', state: 'READY' });
        this.autostartPlayouts();
      });
    }, delay * 1000);
    this.ffmpegRetry.unref();
  }

  // 24/7: Playouts, die vor dem Neustart liefen, automatisch wieder starten
  private autostartPlayouts(): void {
    if (!this.ffmpeg) return;
    for (const [id, rt] of this.stations) {
      if (!rt.data.playout?.autostart || this.playouts.get(id)?.playout.status().running) continue;
      try {
        this.startPlayout(SYSTEM_PRINCIPAL, id, {});
      } catch (err) {
        this.audit.write({ kind: 'playout', event: 'autostart_failed', stationId: id, message: (err as Error).message });
      }
    }
  }

  shutdown(): void {
    if (this.ffmpegRetry) clearTimeout(this.ffmpegRetry);
    this.ai.flush();
    this.users.flush();
    for (const r of this.pulls.values()) r.stop();
    this.pulls.clear();
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.levelTimer) clearInterval(this.levelTimer);
    for (const { playout } of this.playouts.values()) playout.stop();
    this.playouts.clear();
    for (const id of [...this.recorders.keys()]) this.stopRecording(id);
    for (const o of this.outputs.values()) o.stop();
    this.persistNow();
    void this.ownDb?.close();
  }

  // ---------- Tokens / Auth ----------

  hasTokens(): boolean {
    return this.tokens.length > 0;
  }

  createToken(input: { name: string; scopes: string[]; roles: string[]; stationIds: string[] }): { token: string; info: Omit<ApiToken, 'hash'> } {
    const scopes = input.scopes.includes('*') ? ['*'] : input.scopes.filter((s) => (ALL_SCOPES as readonly string[]).includes(s));
    const token = `ad_${randomBytes(24).toString('base64url')}`;
    const rec: ApiToken = {
      id: newId('tok'),
      name: input.name.slice(0, 80) || 'token',
      hash: hashToken(token),
      scopes,
      roles: input.roles.slice(0, 10),
      stationIds: input.stationIds.length ? input.stationIds : ['*'],
      createdAt: new Date().toISOString(),
    };
    this.tokens.push(rec);
    this.docs.set('tokens', this.tokens);
    const { hash: _hash, ...info } = rec;
    return { token, info };
  }

  /**
   * Token für das lokale Desktop-Programm (Windows): verschlüsselt im Secret Store,
   * damit das Studio-Fenster ohne Eingabe startet. Wird bei Widerruf neu erzeugt.
   */
  desktopToken(): string {
    const saved = this.secrets.get('desktop:token');
    if (saved && this.authenticate(saved)) return saved;
    const { token } = this.createToken({ name: 'desktop', scopes: ['*'], roles: ['admin'], stationIds: ['*'] });
    this.secrets.set('desktop:token', token);
    return token;
  }

  listTokens(): Omit<ApiToken, 'hash'>[] {
    return this.tokens.map(({ hash: _hash, ...t }) => t);
  }

  revokeToken(id: string): void {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.id !== id);
    if (this.tokens.length === before) throw new AppError(404, 'not_found', 'Token nicht gefunden');
    this.docs.set('tokens', this.tokens);
  }

  authenticate(token: string | undefined): Principal | null {
    if (!token) return null;
    const h = hashToken(token);
    const t = this.tokens.find((x) => x.hash === h);
    if (t) return { id: t.id, tokenId: t.id, roles: t.roles, stationIds: t.stationIds, scopes: t.scopes };
    const u = this.users.session(token);
    if (!u) return null;
    return {
      id: u.id, tokenId: `session:${u.id}`, roles: u.roles, stationIds: u.stationIds, scopes: UserStore.scopesFor(u.roles),
      user: { id: u.id, username: u.username, name: u.name, ...(u.mustChangePassword ? { mustChangePassword: true } : {}) },
    };
  }

  static hasScope(p: Principal, scope: string): boolean {
    return p.scopes.includes('*') || p.scopes.includes(scope);
  }

  // ---------- Events ----------

  subscribe(fn: (e: HubEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private publish(type: string, stationId: string | undefined, payload: unknown): void {
    if (stationId) this.notifyFrom(type, stationId, payload);
    const e = { type, stationId, payload };
    for (const s of this.subscribers) {
      try {
        s(e);
      } catch {
        // defekte Subscriber ignorieren
      }
    }
  }

  private onEngineEvent(e: EngineEvent): void {
    if (e.type !== 'SOURCE_HEALTH_CHANGED' || e.data?.healthy === false) {
      this.audit.write({ kind: 'source', ...e });
    }
    if (e.type === 'TAKEOVER_COMPLETED') this.relayFor(e.stationId, e.target).setActive(e.sourceId ?? null);
    if (e.type === 'OFF_AIR') this.relayFor(e.stationId, e.target).setActive(null);
    this.publish('source.' + e.type.toLowerCase(), e.stationId, e);
    this.publish('sources.changed', e.stationId, this.engine.list(e.stationId));
  }

  private tick(): void {
    this.engine.tick();
    try {
      this.processSchedules();
    } catch (err) {
      this.audit.write({ kind: 'schedule', event: 'error', message: (err as Error).message });
    }
    // Hörerzahlen alle 30 s von den verbundenen Ausgängen
    if (this.tickCount % 60 === 0) {
      for (const o of this.outputs.values()) {
        if (o.state.status !== 'connected') continue;
        fetchListeners(o.cfg).then((n) => {
          if (o.state.listeners === n) return;
          o.state.listeners = n;
          this.publish('stream.state_changed', o.cfg.stationId, { id: o.cfg.id, ...o.state });
        });
      }
    }
    // KI-Musikplanung alle 10 s prüfen (nur wenn aktiviert, sonst kostenlos)
    if (this.tickCount % 20 === 0) for (const id of this.stations.keys()) this.director.tick(id);
    // Status-Spiegel der Brücken (je Anbindung höchstens alle 15 s)
    if (this.tickCount % 30 === 0) this.tickBridges();
    if (++this.tickCount % 2 === 0) {
      for (const [id, { playout }] of this.playouts) this.publish('playout.state', id, playout.status());
    }
    // Transportebene: Quelle ohne Daten > 5 s gilt als getrennt (Netzwerkabbruch).
    for (const [key, relay] of this.relays) {
      for (const id of relay.staleSessions(5000)) {
        relay.close(id);
        const src = this.engine.get(id);
        if (src) this.engine.disconnect(id);
        this.audit.write({ kind: 'relay', event: 'stale_source_closed', target: key, sourceId: id });
      }
    }
  }

  // ---------- Sender ----------

  private mountStation(station: Station, data?: StationData): StationRuntime {
    const d: StationData = {
      // unbekannte/optionale Felder (laut.fm, Integrationen, KI …) bleiben beim Neustart erhalten
      ...data,
      library: data?.library ?? [],
      queue: data?.queue ?? [],
      cardwall: data?.cardwall ?? defaultCardwall(),
      clock: data?.clock ?? DEFAULT_CLOCK,
      rotation: data?.rotation ?? DEFAULT_ROTATION,
      history: data?.history ?? [],
      playlists: data?.playlists ?? [],
      jobs: data?.jobs ?? [],
      clockEvents: data?.clockEvents ?? [],
      plans: data?.plans ?? [],
      recPlans: data?.recPlans ?? [],
      recordings: data?.recordings ?? [],
      playLog: data?.playLog ?? [],
      planCursor: data?.planCursor ?? {},
      clockCursor: data?.clockCursor ?? 0,
      autoFill: data?.autoFill ?? true,
      minQueue: data?.minQueue ?? 8,
      playout: data?.playout,
    };
    const decks = Object.fromEntries(DECK_IDS.map((id) => [id, { id, mediaId: null, status: 'empty' }])) as Record<DeckId, DeckState>;
    const rt: StationRuntime = { station, data: d, queue: new PlayQueue(d.queue), decks, nowPlaying: { mediaId: null, deck: null, startedAt: null } };
    this.stations.set(station.id, rt);
    mkdirSync(join(this.mediaDir, station.id), { recursive: true });
    return rt;
  }

  createStation(input: Partial<Station> & { id: string; name: string }, withDefaults = false): Station {
    if (!SLUG.test(input.id)) throw new AppError(400, 'invalid_id', 'Sender-ID: a-z, 0-9, Bindestrich, max. 40 Zeichen');
    if (this.stations.has(input.id)) throw new AppError(409, 'exists', 'Sender existiert bereits');
    const station: Station = {
      id: input.id,
      name: input.name.slice(0, 80),
      slogan: (input.slogan ?? '').slice(0, 120),
      primaryColor: safeColor(input.primaryColor, '#19c3e6'),
      accentColor: safeColor(input.accentColor, '#8b5cf6'),
    };
    this.mountStation(station);
    if (withDefaults) {
      // Sinnvolle Grundausstattung laut Spezifikation.
      const defaults: Array<[string, SourceConfig['type'], number, SourceConfig['takeoverPolicy']]> = [
        ['Live Studio', 'live_studio', 1, 'auto'],
        ['Remote Studio', 'remote_studio', 2, 'auto'],
        ['Android Live', 'mobile', 3, 'auto'],
        ['AirDeck Automation', 'automation', 10, 'auto'],
      ];
      for (const [name, type, priority, takeoverPolicy] of defaults) {
        this.engine.addSource({
          id: newId('src'), stationId: station.id, name, type, target: '/live', priority, takeoverPolicy,
          allowedRoles: ['operator', 'dj'],
        });
      }
    }
    this.audit.write({ kind: 'station', event: 'created', stationId: station.id });
    this.changed();
    return station;
  }

  updateStation(id: string, patch: Partial<Station>): Station {
    const rt = this.rt(id);
    const s = rt.station;
    if (patch.name !== undefined) s.name = String(patch.name).slice(0, 80);
    if (patch.slogan !== undefined) s.slogan = String(patch.slogan).slice(0, 120);
    if (patch.primaryColor !== undefined) s.primaryColor = safeColor(patch.primaryColor, s.primaryColor);
    if (patch.accentColor !== undefined) s.accentColor = safeColor(patch.accentColor, s.accentColor);
    if (typeof patch.publicStatus === 'boolean') s.publicStatus = patch.publicStatus;
    if (typeof patch.genre === 'string') s.genre = patch.genre.slice(0, 80) || undefined;
    this.publish('station.changed', id, s);
    this.changed();
    return s;
  }

  private static readonly LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

  /** Eigenes Senderlogo speichern (PNG/JPG/WebP/GIF, max. 2 MB; SVG bewusst nicht wegen Skripten). */
  setStationLogo(id: string, contentType: string, data: Buffer): Station {
    const s = this.rt(id).station;
    const ext = AirDeckApp.LOGO_TYPES[contentType.split(';')[0]!.trim().toLowerCase()];
    if (!ext) throw new AppError(415, 'unsupported_media', 'Logo als PNG, JPG, WebP oder GIF hochladen');
    if (data.length > 2 * 1024 * 1024) throw new AppError(413, 'too_large', 'Logo höchstens 2 MB');
    // Signatur prüfen statt dem angegebenen Typ blind zu vertrauen
    const sig = data.subarray(0, 12);
    const ok = { png: sig[0] === 0x89 && sig[1] === 0x50, jpg: sig[0] === 0xff && sig[1] === 0xd8, gif: sig.toString('latin1', 0, 3) === 'GIF', webp: sig.toString('latin1', 8, 12) === 'WEBP' }[ext];
    if (!ok) throw new AppError(415, 'unsupported_media', 'Datei ist kein gültiges Bild');
    const dir = join(this.dataDir, 'logos');
    mkdirSync(dir, { recursive: true });
    this.removeLogoFile(id);
    writeFileSync(join(dir, `${id}.${ext}`), data);
    s.logo = `${ext}:${Date.now().toString(36)}`;
    this.publish('station.changed', id, s);
    this.changed();
    return s;
  }

  removeStationLogo(id: string): Station {
    const s = this.rt(id).station;
    this.removeLogoFile(id);
    delete s.logo;
    this.publish('station.changed', id, s);
    this.changed();
    return s;
  }

  private removeLogoFile(id: string): void {
    for (const ext of Object.values(AirDeckApp.LOGO_TYPES)) rmSync(join(this.dataDir, 'logos', `${id}.${ext}`), { force: true });
  }

  stationLogo(id: string): { path: string; type: string } | null {
    const s = this.stations.get(id)?.station;
    if (!s?.logo) return null;
    const ext = s.logo.split(':')[0]!;
    const type = Object.entries(AirDeckApp.LOGO_TYPES).find(([, e]) => e === ext)?.[0];
    const path = join(this.dataDir, 'logos', `${id}.${ext}`);
    return type && existsSync(path) ? { path, type } : null;
  }

  /** Sender vollständig entfernen (Playout, Aufnahmen, Quellen, Ausgänge, Medien). Der letzte Sender bleibt. */
  deleteStation(p: Principal, id: string): void {
    this.rt(id);
    if (this.stations.size <= 1) throw new AppError(409, 'last_station', 'Der letzte Sender kann nicht gelöscht werden');
    const pl = this.playouts.get(id);
    if (pl) {
      pl.playout.stop();
      this.playouts.delete(id);
    }
    if (this.recorders.has(id)) this.stopRecording(id);
    for (const s of this.engine.list(id)) this.removeSource(p, id, s.id);
    for (const o of [...this.outputs.values()]) if (o.cfg.stationId === id) this.removeOutput(p, id, o.cfg.id);
    for (const key of [...this.relays.keys()]) if (key.startsWith(`${id}/`)) this.relays.delete(key);
    this.secrets.delete(`lautfm:${id}`);
    this.removeLogoFile(id);
    rmSync(join(this.mediaDir, id), { recursive: true, force: true });
    this.stations.delete(id);
    this.audit.write({ kind: 'station', event: 'deleted', actor: p.id, stationId: id });
    this.changed();
  }

  listStations(p: Principal): Station[] {
    return [...this.stations.values()].map((r) => r.station).filter((s) => canSee(p, s.id));
  }

  station(id: string): Station {
    return this.rt(id).station;
  }

  // ---------- Quellen ----------

  addSource(p: Principal, stationId: string, input: Omit<SourceConfig, 'id' | 'stationId'>): unknown {
    this.rt(stationId);
    const src = wrap(() =>
      this.engine.addSource({
        id: newId('src'),
        stationId,
        name: String(input.name ?? 'Quelle').slice(0, 80),
        type: input.type,
        target: normalizeMount(input.target),
        priority: input.priority,
        takeoverPolicy: input.takeoverPolicy ?? 'auto',
        allowedRoles: Array.isArray(input.allowedRoles) ? input.allowedRoles.map(String) : ['operator', 'dj'],
        fallbackSourceId: input.fallbackSourceId,
      }),
    );
    this.audit.write({ kind: 'source', event: 'created', actor: p.id, sourceId: src.id, priority: src.priority });
    this.changed();
    this.publish('sources.changed', stationId, this.engine.list(stationId));
    return publicSource(src, this.secrets);
  }

  updateSource(p: Principal, stationId: string, id: string, patch: Record<string, unknown>): unknown {
    this.sourceOf(stationId, id);
    const allowed: Record<string, unknown> = {};
    for (const k of ['name', 'type', 'priority', 'takeoverPolicy', 'allowedRoles', 'fallbackSourceId', 'blocked', 'target']) {
      if (k in patch) allowed[k] = k === 'target' ? normalizeMount(String(patch[k])) : patch[k];
    }
    const src = wrap(() => this.engine.updateSource(id, allowed, p));
    this.audit.write({ kind: 'source', event: 'updated', actor: p.id, sourceId: id, fields: Object.keys(allowed) });
    this.changed();
    this.publish('sources.changed', stationId, this.engine.list(stationId));
    return publicSource(src, this.secrets);
  }

  removeSource(p: Principal, stationId: string, id: string): void {
    const src = this.sourceOf(stationId, id);
    wrap(() => this.engine.removeSource(id, p));
    this.relays.get(relayKey(stationId, src.target))?.close(id);
    if (src.credentialRef) this.secrets.delete(src.credentialRef);
    this.audit.write({ kind: 'source', event: 'removed', actor: p.id, sourceId: id });
    this.changed();
    this.publish('sources.changed', stationId, this.engine.list(stationId));
  }

  setSourcePassword(p: Principal, stationId: string, id: string, password: string): void {
    const src = this.sourceOf(stationId, id);
    if (password.length < 8) throw new AppError(400, 'weak_password', 'Passwort muss mindestens 8 Zeichen haben');
    const ref = src.credentialRef ?? `source:${id}`;
    this.secrets.set(ref, password);
    if (!src.credentialRef) wrap(() => this.engine.updateSource(id, { credentialRef: ref }, p));
    this.audit.write({ kind: 'source', event: 'password_set', actor: p.id, sourceId: id });
    this.changed();
  }

  listSources(stationId: string): unknown[] {
    this.rt(stationId);
    return this.engine.list(stationId).map((s) => ({ ...publicSource(s, this.secrets), relay: this.relays.get(relayKey(stationId, s.target))?.status() }));
  }

  takeover(p: Principal, stationId: string, id: string, force: boolean): unknown {
    this.sourceOf(stationId, id);
    return publicSource(wrap(() => this.engine.requestTakeover(id, p, { force, stationId })), this.secrets);
  }

  release(p: Principal, stationId: string, id: string): void {
    this.sourceOf(stationId, id);
    wrap(() => this.engine.release(id, p));
    this.relays.get(relayKey(stationId, this.engine.get(id)!.target))?.close(id);
  }

  reportHealth(stationId: string, id: string, healthy: boolean, reason?: string): void {
    this.sourceOf(stationId, id);
    this.engine.setHealth(id, healthy, reason);
  }

  // ---------- Relay-Eingang ----------

  /** Authentifiziert eine Encoder-Verbindung (Icecast-Source-Client) über Source-ID/Passwort. */
  authenticateIngest(stationId: string, mount: string, user: string, pass: string): SourceConfig | null {
    const target = normalizeMount(mount);
    const candidates = this.engine.list(stationId).filter((s) => s.target === target && s.credentialRef);
    const ordered = [...candidates.filter((s) => s.id === user), ...candidates.filter((s) => s.id !== user)];
    for (const s of ordered) {
      const secret = this.secrets.get(s.credentialRef!);
      if (secret && timingSafeEqualStr(secret, pass)) return s;
    }
    return null;
  }

  ingestOpen(src: SourceConfig, contentType: string): void {
    const relay = this.relayFor(src.stationId, src.target);
    relay.open(src.id, contentType);
    try {
      this.engine.connect(src.id, { id: `ingest:${src.id}`, roles: ['admin'], stationIds: [src.stationId] });
    } catch (err) {
      relay.close(src.id);
      throw err;
    }
  }

  ingestData(src: SourceConfig, chunk: Buffer): void {
    this.relayFor(src.stationId, src.target).data(src.id, chunk);
  }

  ingestClose(src: SourceConfig): void {
    this.relayFor(src.stationId, src.target).close(src.id);
    if (this.engine.get(src.id)) this.engine.disconnect(src.id);
  }

  /** Chunk-Upload der Studio-Automation (Browser-MediaRecorder). */
  studioChunk(p: Principal, stationId: string, id: string, contentType: string, chunk: Buffer, start: boolean): void {
    const src = this.sourceOf(stationId, id);
    if (!p.roles.includes('admin') && !src.allowedRoles.some((r) => p.roles.includes(r))) {
      throw new AppError(403, 'forbidden', 'Nicht autorisiert für diese Quelle');
    }
    if ([...this.playouts.values()].some((x) => x.source.id === id)) {
      throw new AppError(409, 'source_busy', 'Diese Quelle wird bereits vom Server-Playout (24/7) verwendet');
    }
    const relay = this.relayFor(stationId, src.target);
    if (start || !relay.hasSession(id)) {
      // Neuer Stream (neuer Container-Header): Sitzung komplett neu aufbauen.
      relay.close(id);
      this.engine.disconnect(id);
      relay.open(id, contentType);
      wrap(() => this.engine.connect(id, p));
    } else if (['disconnected', 'failed'].includes(this.engine.get(id)!.state) && this.engine.get(id)!.healthy) {
      // Nach Erholung (z. B. Stille vorbei) wieder anmelden, Header der Sitzung bleibt erhalten.
      wrap(() => this.engine.connect(id, p));
    }
    relay.data(id, chunk);
  }

  addListener(stationId: string, mount: string, res: import('node:http').ServerResponse): boolean {
    return this.relayFor(stationId, normalizeMount(mount)).addListener(res);
  }

  private relayFor(stationId: string, target: string): RelayTarget {
    const key = relayKey(stationId, target);
    let r = this.relays.get(key);
    if (!r) {
      r = new RelayTarget(() => [...this.outputs.values()].filter((o) => o.cfg.stationId === stationId && o.cfg.sourceTarget === target && o.cfg.enabled));
      this.relays.set(key, r);
    }
    return r;
  }

  // ---------- Ausgänge ----------

  private mountOutput(cfg: OutputConfig): BroadcastOutput {
    this.outputs.get(cfg.id)?.stop();
    const Cls = cfg.type === 'shoutcast' ? ShoutcastOutput : IcecastOutput;
    const o = new Cls(cfg, () => this.secrets.get(cfg.passwordRef), (s: OutputState) => this.publish('stream.state_changed', cfg.stationId, { id: cfg.id, ...s }));
    this.outputs.set(cfg.id, o);
    return o;
  }

  listOutputs(stationId: string): unknown[] {
    this.rt(stationId);
    return [...this.outputs.values()].filter((o) => o.cfg.stationId === stationId).map((o) => publicOutput(o, this.secrets));
  }

  saveOutput(p: Principal, stationId: string, id: string | null, input: Record<string, unknown>): unknown {
    this.rt(stationId);
    const prev = id ? this.outputOf(stationId, id).cfg : undefined;
    const outId = prev?.id ?? newId('out');
    const priority = input.priority === null || input.priority === '' ? undefined : (input.priority ?? prev?.priority);
    if (priority !== undefined && (typeof priority !== 'number' || !Number.isSafeInteger(priority) || priority < 1)) {
      throw new AppError(400, 'invalid_priority', 'Priority muss eine positive Ganzzahl sein');
    }
    const port = Number(input.port ?? prev?.port ?? 8000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError(400, 'invalid_port', 'Ungültiger Port');
    const host = String(input.host ?? prev?.host ?? '').trim();
    if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new AppError(400, 'invalid_host', 'Ungültiger Host');
    const type = (input.type ?? prev?.type ?? 'icecast') as OutputConfig['type'];
    if (type !== 'icecast' && type !== 'shoutcast') throw new AppError(400, 'invalid_type', 'Unbekannter Ausgangstyp');
    const cfg: OutputConfig = {
      id: outId,
      stationId,
      name: String(input.name ?? prev?.name ?? 'Stream').slice(0, 80),
      type,
      host,
      port,
      mount: normalizeMount(String(input.mount ?? prev?.mount ?? '/stream')),
      username: String(input.username ?? prev?.username ?? 'source').slice(0, 80),
      passwordRef: prev?.passwordRef ?? `output:${outId}`,
      tls: Boolean(input.tls ?? prev?.tls ?? false),
      sourceTarget: normalizeMount(String(input.sourceTarget ?? prev?.sourceTarget ?? '/live')),
      priority: priority as number | undefined,
      streamId: type === 'shoutcast' ? posInt('streamId' in input ? input.streamId : prev?.streamId) : undefined,
      bitrateKbps: posInt('bitrateKbps' in input ? input.bitrateKbps : prev?.bitrateKbps),
      enabled: Boolean(input.enabled ?? prev?.enabled ?? true),
    };
    if (typeof input.password === 'string' && input.password) this.secrets.set(cfg.passwordRef, input.password);
    const o = this.mountOutput(cfg);
    if (cfg.enabled) this.relayFor(stationId, cfg.sourceTarget).startOutput(o);
    this.audit.write({ kind: 'output', event: prev ? 'updated' : 'created', actor: p.id, outputId: outId });
    this.changed();
    return publicOutput(o, this.secrets);
  }

  removeOutput(p: Principal, stationId: string, id: string): void {
    const o = this.outputOf(stationId, id);
    o.stop();
    this.outputs.delete(id);
    this.secrets.delete(o.cfg.passwordRef);
    this.audit.write({ kind: 'output', event: 'removed', actor: p.id, outputId: id });
    this.changed();
  }

  // ---------- Medien ----------

  library(stationId: string): MediaItem[] {
    return this.rt(stationId).data.library;
  }

  media(stationId: string, id: string): MediaItem {
    const m = this.rt(stationId).data.library.find((x) => x.id === id);
    if (!m) throw new AppError(404, 'not_found', 'Medium nicht gefunden');
    return m;
  }

  mediaPath(stationId: string, m: MediaItem): string {
    if (m.url) return m.url;
    return join(this.mediaDir, stationId, m.file);
  }

  addMedia(stationId: string, item: MediaItem): MediaItem {
    const rt = this.rt(stationId);
    rt.data.library.push(item);
    this.publish('library.changed', stationId, { added: item });
    this.changed();
    // Laufzeit und ID3-Tags serverseitig lesen (wichtig für Crossfade/Backtiming im Headless-Betrieb)
    const ffprobe = this.ffmpeg?.ffprobe;
    if (ffprobe && !item.url) {
      probeMedia(ffprobe, this.mediaPath(stationId, item)).then(({ durationMs, tags }) => {
        if (!rt.data.library.includes(item)) return;
        const patch: Record<string, unknown> = {};
        if (durationMs && item.durationMs == null) patch.durationMs = durationMs;
        if (tags.title) patch.title = tags.title;
        if (tags.artist) patch.artist = tags.artist;
        if (tags.bpm && item.bpm == null) patch.bpm = tags.bpm;
        if (tags.album) item.album = tags.album;
        if (tags.genre) item.genre = tags.genre;
        if (tags.year) item.year = tags.year;
        if (Object.keys(patch).length || tags.album || tags.genre || tags.year) this.updateMedia(stationId, item.id, patch);
      });
    }
    if (!item.url && item.lufs == null) this.queueLoudness(stationId, item.id);
    return item;
  }

  // ---------- Lautheitsanalyse (EBU R128) – nacheinander, damit der Sendebetrieb nicht leidet ----------

  private readonly loudQueue: { stationId: string; id: string }[] = [];
  private loudBusy = false;

  queueLoudness(stationId: string, id: string): void {
    if (!this.ffmpeg || this.loudQueue.some((x) => x.stationId === stationId && x.id === id)) return;
    this.loudQueue.push({ stationId, id });
    void this.runLoudness();
  }

  /** Alle noch nicht gemessenen Titel eines Senders einreihen. */
  analyzeLibrary(stationId: string, force = false): { queued: number } {
    if (!this.ffmpeg) throw new AppError(501, 'unsupported', 'Lautheitsanalyse benötigt ffmpeg');
    let queued = 0;
    for (const m of this.rt(stationId).data.library) {
      if (m.url || (!force && m.lufs != null)) continue;
      this.queueLoudness(stationId, m.id);
      queued++;
    }
    return { queued };
  }

  loudnessStatus(stationId: string): unknown {
    const lib = this.rt(stationId).data.library.filter((m) => !m.url);
    return { total: lib.length, measured: lib.filter((m) => m.lufs != null).length, pending: this.loudQueue.filter((x) => x.stationId === stationId).length, running: this.loudBusy };
  }

  private async runLoudness(): Promise<void> {
    if (this.loudBusy || !this.ffmpeg) return;
    this.loudBusy = true;
    try {
      for (let job = this.loudQueue.shift(); job; job = this.loudQueue.shift()) {
        const rt = this.stations.get(job.stationId);
        const m = rt?.data.library.find((x) => x.id === job!.id);
        if (!m || m.url) continue;
        const r = await analyzeLoudness(this.ffmpeg.ffmpeg, this.mediaPath(job.stationId, m));
        if (!r || !rt!.data.library.includes(m)) continue;
        m.lufs = r.lufs;
        m.truePeakDb = r.truePeakDb;
        this.publish('library.changed', job.stationId, { updated: m });
        this.changed();
      }
    } finally {
      this.loudBusy = false;
    }
  }

  updateMedia(stationId: string, id: string, patch: Record<string, unknown>): MediaItem {
    const m = this.media(stationId, id);
    if (typeof patch.title === 'string') m.title = patch.title.slice(0, 200);
    if (typeof patch.artist === 'string') m.artist = patch.artist.slice(0, 200);
    if (typeof patch.category === 'string' && (MEDIA_CATEGORIES as readonly string[]).includes(patch.category)) m.category = patch.category as MediaItem['category'];
    if (typeof patch.folder === 'string') m.folder = patch.folder.trim().slice(0, 80) || undefined;
    for (const k of ['durationMs', 'cueInMs', 'cueOutMs', 'segueMs', 'introMs', 'bpm', 'gainDb'] as const) {
      const v = patch[k];
      if (v === null && k !== 'durationMs') delete m[k];
      else if (typeof v === 'number' && Number.isFinite(v) && (k === 'gainDb' || v >= 0)) m[k] = v;
    }
    this.publish('library.changed', stationId, { updated: m });
    this.changed();
    return m;
  }

  removeMedia(stationId: string, id: string): void {
    const rt = this.rt(stationId);
    const m = this.media(stationId, id);
    rt.data.library = rt.data.library.filter((x) => x.id !== id);
    rt.queue.prune((mid) => mid !== id);
    for (const c of rt.data.cardwall) if (c.mediaId === id) c.mediaId = null;
    for (const pl of rt.data.playlists ?? []) pl.items = pl.items.filter((x) => x !== id);
    if (!m.url) rmSync(this.mediaPath(stationId, m), { force: true });
    this.publish('library.changed', stationId, { removed: id });
    this.publishQueue(stationId);
    this.changed();
  }

  // ---------- Queue / Automation ----------

  queueView(stationId: string, remainingCurrentMs = 0): unknown {
    const rt = this.rt(stationId);
    const lib = new Map(rt.data.library.map((m) => [m.id, m]));
    const bt = backtime(rt.queue.list(), lib, Date.now(), remainingCurrentMs);
    return {
      items: rt.queue.list().map((q, i) => ({ ...q, media: lib.get(q.mediaId) ?? null, startsAt: bt.rows[i]?.startsAt, known: bt.rows[i]?.known })),
      autoFill: rt.data.autoFill,
      totalMs: rt.queue.list().reduce((a, q) => a + (playLength(lib.get(q.mediaId) ?? ({ durationMs: 0 } as MediaItem)) ?? 0), 0),
    };
  }

  queueAdd(stationId: string, mediaId: string, index?: number): void {
    this.media(stationId, mediaId);
    this.rt(stationId).queue.add(mediaId, 'manual', index);
    this.publishQueue(stationId);
  }

  queueRemove(stationId: string, uid: string): void {
    if (!this.rt(stationId).queue.remove(uid)) throw new AppError(404, 'not_found', 'Eintrag nicht gefunden');
    this.publishQueue(stationId);
  }

  queueMove(stationId: string, uid: string, index: number): void {
    if (!this.rt(stationId).queue.move(uid, index)) throw new AppError(404, 'not_found', 'Eintrag nicht gefunden');
    this.publishQueue(stationId);
  }

  queueClear(stationId: string): void {
    this.rt(stationId).queue.clear();
    this.publishQueue(stationId);
  }

  /** Nächsten Titel entnehmen (Deck lädt ihn). Füllt bei Bedarf nach Sendeuhr nach. */
  queueNext(stationId: string): MediaItem | null {
    const rt = this.rt(stationId);
    this.autoFill(rt);
    let e = rt.queue.shift();
    // Einträge mit gelöschten Medien überspringen
    while (e && !rt.data.library.some((m) => m.id === e!.mediaId)) e = rt.queue.shift();
    this.autoFill(rt);
    this.publishQueue(stationId);
    return e ? rt.data.library.find((m) => m.id === e!.mediaId)! : null;
  }

  queueFill(stationId: string): void {
    const rt = this.rt(stationId);
    this.autoFill(rt, true);
    this.publishQueue(stationId);
  }

  setAutomation(stationId: string, patch: { autoFill?: boolean; minQueue?: number; clock?: ClockTemplate }): unknown {
    const rt = this.rt(stationId);
    if (typeof patch.autoFill === 'boolean') rt.data.autoFill = patch.autoFill;
    if (typeof patch.minQueue === 'number' && patch.minQueue >= 1 && patch.minQueue <= 100) rt.data.minQueue = Math.floor(patch.minQueue);
    if (patch.clock && Array.isArray(patch.clock.slots)) {
      rt.data.clock = { id: String(patch.clock.id ?? 'custom'), name: String(patch.clock.name ?? 'Sendeuhr').slice(0, 80), slots: patch.clock.slots.slice(0, 200) };
      rt.data.clockCursor = 0;
    }
    this.publish('automation.state_changed', stationId, this.automationView(stationId));
    this.changed();
    return this.automationView(stationId);
  }

  automationView(stationId: string): unknown {
    const d = this.rt(stationId).data;
    return { autoFill: d.autoFill, minQueue: d.minQueue, clock: d.clock, rotation: d.rotation };
  }

  setNowPlaying(stationId: string, mediaId: string, deck: DeckId): NowPlaying {
    const rt = this.rt(stationId);
    const m = this.media(stationId, mediaId);
    rt.nowPlaying = { mediaId, deck, startedAt: Date.now() };
    if (m.category === 'music') {
      rt.data.history.unshift(mediaId);
      rt.data.history.length = Math.min(rt.data.history.length, 200);
    }
    const log = (rt.data.playLog ??= []);
    log.unshift({ at: Date.now(), mediaId, title: m.title, artist: m.artist, category: m.category });
    if (log.length > 1000) log.length = 1000;
    const song = m.artist ? `${m.artist} - ${m.title}` : m.title;
    for (const o of this.outputs.values()) if (o.cfg.stationId === stationId) o.updateMetadata(song);
    this.publish('now_playing.changed', stationId, { ...rt.nowPlaying, media: m });
    this.changed();
    this.director.onTrack(stationId, m);
    return rt.nowPlaying;
  }

  nowPlaying(stationId: string): unknown {
    const rt = this.rt(stationId);
    const lib = rt.data.library;
    const next = rt.queue.list()[0];
    return {
      ...rt.nowPlaying,
      media: rt.nowPlaying.mediaId ? lib.find((m) => m.id === rt.nowPlaying.mediaId) ?? null : null,
      next: next ? lib.find((m) => m.id === next.mediaId) ?? null : null,
    };
  }

  setDeck(stationId: string, deckId: string, patch: Partial<DeckState>): DeckState {
    const rt = this.rt(stationId);
    if (!(DECK_IDS as readonly string[]).includes(deckId)) throw new AppError(404, 'not_found', 'Deck nicht gefunden');
    const d = rt.decks[deckId as DeckId];
    if (patch.mediaId !== undefined) {
      if (patch.mediaId !== null) this.media(stationId, patch.mediaId);
      d.mediaId = patch.mediaId;
    }
    if (patch.status && ['empty', 'cued', 'playing', 'paused'].includes(patch.status)) d.status = patch.status;
    d.startedAt = d.status === 'playing' ? Date.now() : undefined;
    this.publish('deck.state_changed', stationId, d);
    return d;
  }

  decks(stationId: string): DeckState[] {
    return Object.values(this.rt(stationId).decks);
  }

  // ---------- Server-Playout (24/7) ----------

  playoutView(stationId: string): unknown {
    const rt = this.rt(stationId);
    const cfg = { ...DEFAULT_PLAYOUT, autostart: false, ...rt.data.playout };
    return {
      supported: !!this.ffmpeg,
      ffmpeg: this.ffmpeg ? { version: this.ffmpeg.version, encoders: this.ffmpeg.encoders, probe: !!this.ffmpeg.ffprobe } : null,
      config: cfg,
      status: this.playouts.get(stationId)?.playout.status() ?? null,
    };
  }

  startPlayout(p: Principal, stationId: string, input: Partial<PlayoutConfig>): unknown {
    const rt = this.rt(stationId);
    if (!this.ffmpeg) throw new AppError(501, 'unsupported', 'Server-Playout benötigt ffmpeg (AIRDECK_FFMPEG, ./ffmpeg/ oder PATH)');
    const cfg = this.savePlayoutConfig(stationId, input);
    if (cfg.format === 'opus' && !this.ffmpeg.encoders.opus) throw new AppError(501, 'unsupported', 'ffmpeg ohne libopus');
    if (cfg.format === 'mp3' && !this.ffmpeg.encoders.mp3) throw new AppError(501, 'unsupported', 'ffmpeg ohne libmp3lame');
    if (this.playouts.has(stationId)) return this.playoutView(stationId);
    const sources = this.engine.list(stationId);
    const source = (cfg.sourceId && sources.find((s) => s.id === cfg.sourceId)) || sources.find((s) => s.type === 'automation');
    if (!source) throw new AppError(409, 'no_source', 'Keine Automation-Quelle für das Playout vorhanden');
    // Browser-Stream derselben Quelle beenden, bevor das Server-Playout übernimmt
    this.relayFor(stationId, source.target).close(source.id);
    if (this.engine.get(source.id)?.state !== 'disconnected') this.engine.disconnect(source.id);

    const playout = new Playout(this.ffmpeg.ffmpeg, {
      nextTrack: () => this.queueNext(stationId) ?? this.emergencyPick(stationId),
      mediaPath: (m) => this.mediaPath(stationId, m),
      onNowPlaying: (m) => this.setNowPlaying(stationId, m.id, 'A'),
      onStreamStart: (type) => {
        try {
          this.relayFor(stationId, source.target).close(source.id);
          this.ingestOpen(source, type);
        } catch (err) {
          this.audit.write({ kind: 'playout', event: 'source_rejected', stationId, message: (err as Error).message });
        }
      },
      onStreamData: (chunk) => this.ingestData(source, chunk),
      onStreamStop: () => this.ingestClose(source),
      onSilence: (silent) => {
        if (!silent) this.publish('playout.log', stationId, { event: 'silence_recovered' });
        // Stille → Quelle ungesund → Fallback nach Priorität; bei Erholung wieder anmelden
        this.engine.setHealth(source.id, !silent, silent ? 'silence' : undefined);
        if (!silent && this.engine.get(source.id)?.state === 'disconnected' && this.relayFor(stationId, source.target).hasSession(source.id)) {
          try {
            this.engine.connect(source.id);
          } catch {
            // gesperrt o. ä. – bleibt getrennt
          }
        }
      },
      log: (event, data) => {
        this.audit.write({ kind: 'playout', event, stationId, ...data });
        this.publish('playout.log', stationId, { event, ...data });
      },
    }, cfg, { ffplay: this.ffmpeg.ffplay, inputArgs: inputDeviceArgs });
    this.playouts.set(stationId, { playout, source });
    playout.start();
    rt.data.playout = { ...cfg, autostart: input.autostart ?? true };
    this.audit.write({ kind: 'playout', event: 'start', actor: p.id, stationId, sourceId: source.id });
    this.changed();
    return this.playoutView(stationId);
  }

  stopPlayout(p: Principal, stationId: string): unknown {
    const rt = this.rt(stationId);
    const po = this.playouts.get(stationId);
    if (po) {
      this.playouts.delete(stationId);
      po.playout.stop();
      this.engine.setHealth(po.source.id, true);
    }
    // Bewusst gestoppt → nach Neustart nicht automatisch wieder senden
    if (rt.data.playout) rt.data.playout.autostart = false;
    this.audit.write({ kind: 'playout', event: 'stop', actor: p.id, stationId });
    this.changed();
    return this.playoutView(stationId);
  }

  setMic(stationId: string, on: boolean): void {
    const po = this.playouts.get(stationId);
    if (!po) throw new AppError(409, 'not_running', 'Server-Playout läuft nicht');
    try {
      po.playout.setMic(on);
    } catch (err) {
      throw new AppError(409, 'no_input', (err as Error).message);
    }
    this.publish('playout.state', stationId, po.playout.status());
  }

  inputDevices(): unknown {
    if (!this.ffmpeg) return { supported: false, devices: [] };
    return { supported: true, devices: listInputDevices(this.ffmpeg.ffmpeg), monitor: !!this.ffmpeg.ffplay, eqBands: EQ_BANDS };
  }

  private cpuPrev = cpus().map((c) => c.times);

  /** Systemwerte für das Monitoring (CPU, RAM, Stream-Durchsatz). */
  system(): unknown {
    const now = cpus().map((c) => c.times);
    let idle = 0;
    let total = 0;
    now.forEach((t, i) => {
      const p = this.cpuPrev[i] ?? t;
      const d = (k: keyof typeof t) => t[k] - p[k];
      const sum = d('user') + d('nice') + d('sys') + d('idle') + d('irq');
      total += sum;
      idle += d('idle');
    });
    this.cpuPrev = now;
    const outBytes = [...this.outputs.values()].reduce((a, o) => a + o.state.bytesSent, 0);
    const t = Date.now();
    const rate = this.lastOut ? ((outBytes - this.lastOut.bytes) / Math.max(1, t - this.lastOut.at)) * 1000 : 0;
    this.lastOut = { bytes: outBytes, at: t };
    return {
      cpu: total > 0 ? Math.round((1 - idle / total) * 100) : 0,
      ram: Math.round((1 - freemem() / totalmem()) * 100),
      uptimeS: Math.round(osUptime()),
      processMb: Math.round(process.memoryUsage().rss / 1048576),
      streamBytesPerSec: Math.max(0, Math.round(rate)),
      outputsConnected: [...this.outputs.values()].filter((o) => o.state.status === 'connected').length,
    };
  }
  private lastOut: { bytes: number; at: number } | null = null;

  /** Cover-Bild aus der Audiodatei (eingebettetes Bild), zwischengespeichert. */
  async cover(stationId: string, mediaId: string): Promise<string | null> {
    const m = this.media(stationId, mediaId);
    if (m.url || !this.ffmpeg) return null;
    const dir = join(this.dataDir, 'covers', stationId);
    const file = join(dir, `${m.id}.jpg`);
    const none = `${file}.none`;
    if (existsSync(file)) return file;
    if (existsSync(none)) return null;
    mkdirSync(dir, { recursive: true });
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn(this.ffmpeg!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', this.mediaPath(stationId, m), '-an', '-frames:v', '1', '-vf', 'scale=300:300:force_original_aspect_ratio=increase,crop=300:300', file], { windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0 && existsSync(file)));
      setTimeout(() => p.kill(), 15_000).unref();
    });
    if (!ok) {
      rmSync(file, { force: true });
      writeFileAtomic(none, '');
      return null;
    }
    return file;
  }

  /** Schnelltrigger: Titel einer Kategorie (Rotation) über der Musik oder als Nächstes. */
  quickTrigger(stationId: string, category: string, mode?: string): MediaItem {
    const rt = this.rt(stationId);
    if (!(MEDIA_CATEGORIES as readonly string[]).includes(category)) throw new AppError(400, 'invalid_category', 'Unbekannte Kategorie');
    const pool = rt.data.library.filter((m) => m.category === category);
    const picked = pickFromPool(pool.map((x) => ({ ...x, category: 'music' as const })), 'music', rt.data.history, rt.data.rotation);
    if (!picked) throw new AppError(404, 'empty', 'Keine Titel in dieser Kategorie');
    const m = rt.data.library.find((x) => x.id === picked.id)!;
    const fx = ['jingle', 'sweeper', 'station_id', 'drop', 'tts', 'bed'].includes(category);
    const md = mode === 'fx' || mode === 'now' || mode === 'track' ? mode : fx ? 'fx' : 'now';
    this.executeTarget(stationId, { kind: 'media', mediaId: m.id, mode: md, label: m.title }, 'quick');
    return m;
  }

  shuffleQueue(stationId: string): void {
    this.rt(stationId).queue.shuffle();
    this.publishQueue(stationId);
  }

  skipPlayout(stationId: string): void {
    const po = this.playouts.get(stationId);
    if (!po) throw new AppError(409, 'not_running', 'Server-Playout läuft nicht');
    po.playout.skip();
  }

  savePlayoutConfig(stationId: string, input: Partial<PlayoutConfig>): PlayoutConfig {
    const rt = this.rt(stationId);
    const cur: PlayoutConfig = { ...DEFAULT_PLAYOUT, autostart: false, ...rt.data.playout };
    if (input.format === 'mp3' || input.format === 'opus' || input.format === 'aac') cur.format = input.format;
    cur.dsp = { ...DEFAULT_PLAYOUT.dsp, ...cur.dsp };
    if (input.dsp && typeof input.dsp === 'object') {
      if (Array.isArray(input.dsp.eq)) cur.dsp.eq = EQ_BANDS.map((_, i) => Math.max(-12, Math.min(12, Number(input.dsp!.eq[i]) || 0)));
      if (typeof input.dsp.compressor === 'boolean') cur.dsp.compressor = input.dsp.compressor;
      if (typeof input.dsp.limiter === 'boolean') cur.dsp.limiter = input.dsp.limiter;
      for (const k of ['highpass', 'multiband', 'agc'] as const) if (typeof input.dsp[k] === 'boolean') cur.dsp[k] = input.dsp[k];
      if (typeof input.dsp.targetLufs === 'number' && Number.isFinite(input.dsp.targetLufs)) cur.dsp.targetLufs = Math.max(-30, Math.min(-8, input.dsp.targetLufs));
      if (typeof input.dsp.preset === 'string') cur.dsp.preset = input.dsp.preset in DSP_PRESETS ? input.dsp.preset : undefined;
    }
    if (input.mp3Mode === 'cbr' || input.mp3Mode === 'vbr') cur.mp3Mode = input.mp3Mode;
    if (typeof input.mp3Quality === 'number' && input.mp3Quality >= 0 && input.mp3Quality <= 9) cur.mp3Quality = Math.round(input.mp3Quality);
    if (input.loudness && typeof input.loudness === 'object') {
      const t = Number(input.loudness.targetLufs);
      cur.loudness = { auto: input.loudness.auto !== false, targetLufs: Number.isFinite(t) ? Math.max(-30, Math.min(-8, t)) : cur.loudness?.targetLufs ?? -16 };
    }
    if (typeof input.monitor === 'boolean') cur.monitor = input.monitor;
    if (typeof input.inputDevice === 'string') cur.inputDevice = input.inputDevice.slice(0, 200);
    if (typeof input.emergencyFolder === 'string') cur.emergencyFolder = input.emergencyFolder.slice(0, 80) || undefined;
    const num = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined);
    cur.bitrateKbps = num(input.bitrateKbps, 32, 320) ?? cur.bitrateKbps;
    cur.crossfadeMs = num(input.crossfadeMs, 0, 15000) ?? cur.crossfadeMs;
    cur.fadeInMs = num(input.fadeInMs, 0, 10000) ?? cur.fadeInMs ?? 0;
    cur.micGainDb = num(input.micGainDb, -20, 20) ?? cur.micGainDb ?? 0;
    cur.duckDb = num(input.duckDb, -40, 0) ?? cur.duckDb;
    cur.silenceThresholdDb = num(input.silenceThresholdDb, -90, -10) ?? cur.silenceThresholdDb;
    cur.silenceMs = num(input.silenceMs, 2000, 120000) ?? cur.silenceMs;
    if (typeof input.sourceId === 'string') cur.sourceId = input.sourceId || undefined;
    if (typeof input.autostart === 'boolean') cur.autostart = input.autostart;
    rt.data.playout = cur;
    this.changed();
    return cur;
  }

  /** Notfall-Auswahl, wenn Queue und Sendeuhr nichts liefern: beliebiger Musiktitel, sonst irgendein Titel. */
  private emergencyPick(stationId: string): MediaItem | null {
    const rt = this.rt(stationId);
    const lib = rt.data.library;
    const folder = rt.data.playout?.emergencyFolder;
    const emergency = folder ? lib.filter((m) => (m.folder ?? '') === folder && !m.url) : [];
    if (emergency.length) {
      this.audit.write({ kind: 'playout', event: 'emergency_folder', stationId, folder });
      return pickFromPool(emergency.map((x) => ({ ...x, category: 'music' as const })), 'music', rt.data.history, rt.data.rotation) ?? emergency[0]!;
    }
    const pool = lib.filter((m) => m.category === 'music');
    const list = pool.length ? pool : lib;
    return list.length ? list[Math.floor(Math.random() * list.length)]! : null;
  }

  // ---------- Ordner, URL-Streams, M3U, Titelanzeige, Verlauf ----------

  folders(stationId: string): string[] {
    return [...new Set(this.rt(stationId).data.library.map((m) => m.folder ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  }

  addUrlMedia(stationId: string, input: { url: string; title?: string; artist?: string; durationMs?: number; folder?: string }): MediaItem {
    const url = String(input.url ?? '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new AppError(400, 'invalid_url', 'Nur http(s)-URLs sind erlaubt');
    const existing = this.rt(stationId).data.library.find((m) => m.url === url);
    if (existing) return existing;
    const dur = typeof input.durationMs === 'number' && input.durationMs > 0 ? Math.round(input.durationMs) : null;
    return this.addMedia(stationId, {
      id: newId('m'), title: String(input.title || url).slice(0, 200), artist: String(input.artist ?? '').slice(0, 200),
      category: 'stream', file: '', url, durationMs: dur, cueOutMs: dur ?? undefined, addedAt: Date.now(), folder: input.folder,
    });
  }

  /** Füllt die Queue mit n Titeln aus Ordner oder Kategorie (mit Rotationsregeln). */
  queueFillFrom(stationId: string, input: { folder?: string; category?: string; count?: number }): number {
    const rt = this.rt(stationId);
    const count = Math.max(1, Math.min(100, Number(input.count) || 10));
    const pool = rt.data.library.filter((m) => (input.folder !== undefined ? (m.folder ?? '') === input.folder : m.category === input.category));
    if (!pool.length) throw new AppError(404, 'empty', 'Keine Titel in dieser Auswahl');
    const recent = [...rt.queue.list().map((q) => q.mediaId).reverse(), ...rt.data.history];
    let added = 0;
    for (let i = 0; i < count; i++) {
      const m = pickFromPool(pool.map((x) => ({ ...x, category: 'music' as const })), 'music', recent, rt.data.rotation);
      if (!m) break;
      rt.queue.add(m.id, 'manual');
      recent.unshift(m.id);
      added++;
    }
    this.publishQueue(stationId);
    return added;
  }

  exportQueueM3U(stationId: string): string {
    const rt = this.rt(stationId);
    const lib = new Map(rt.data.library.map((m) => [m.id, m]));
    return toM3U(rt.queue.list().map((q) => lib.get(q.mediaId)).filter((m): m is MediaItem => !!m).map((m) => ({
      title: m.title, artist: m.artist, durationMs: m.durationMs, path: m.url ?? m.originalName ?? m.file,
    })));
  }

  /** M3U importieren: Einträge werden über Dateiname, "Interpret - Titel" oder URL der Bibliothek zugeordnet. */
  importM3U(stationId: string, text: string, target: { playlistName?: string }): { matched: number; missing: string[]; playlistId?: string } {
    const rt = this.rt(stationId);
    const norm = (x: string) => x.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/\s+/g, ' ').trim();
    const byName = new Map<string, MediaItem>();
    for (const m of rt.data.library) {
      if (m.originalName) byName.set(norm(m.originalName), m);
      byName.set(norm(m.artist ? `${m.artist} - ${m.title}` : m.title), m);
      if (m.url) byName.set(m.url.toLowerCase(), m);
    }
    const ids: string[] = [];
    const missing: string[] = [];
    for (const e of parseM3U(text).slice(0, 5000)) {
      const base = e.path.replace(/^.*[\\/]/, '');
      let m = byName.get(e.path.toLowerCase()) ?? byName.get(norm(base)) ?? (e.title ? byName.get(norm(e.title)) : undefined);
      if (!m && /^https?:\/\//i.test(e.path)) m = this.addUrlMedia(stationId, { url: e.path, title: e.title, durationMs: e.durationMs });
      if (m) ids.push(m.id);
      else missing.push(e.title ?? base);
    }
    if (target.playlistName) {
      const pl = this.savePlaylist(stationId, null, { name: target.playlistName, items: ids });
      return { matched: ids.length, missing, playlistId: pl.id };
    }
    for (const id of ids) rt.queue.add(id, 'manual');
    this.publishQueue(stationId);
    return { matched: ids.length, missing };
  }

  /** Titelanzeige manuell senden (z. B. bei Live-Moderation). */
  sendMetadata(stationId: string, artist: string, title: string): void {
    const song = (artist ? `${artist} - ${title}` : title).slice(0, 250);
    if (!song.trim()) throw new AppError(400, 'empty', 'Titel angeben');
    for (const o of this.outputs.values()) if (o.cfg.stationId === stationId) o.updateMetadata(song);
    this.publish('metadata.sent', stationId, { artist, title });
  }

  history(stationId: string, limit = 200): PlayLogEntry[] {
    return (this.rt(stationId).data.playLog ?? []).slice(0, Math.min(1000, Math.max(1, limit)));
  }

  // ---------- Playlists ----------

  playlists(stationId: string): Playlist[] {
    return this.rt(stationId).data.playlists ?? [];
  }

  savePlaylist(stationId: string, id: string | null, input: { name?: string; color?: string; items?: unknown }): Playlist {
    const rt = this.rt(stationId);
    const list = (rt.data.playlists ??= []);
    let pl = id ? list.find((p) => p.id === id) : undefined;
    if (id && !pl) throw new AppError(404, 'not_found', 'Playlist nicht gefunden');
    if (!pl) {
      pl = { id: newId('pl'), name: 'Neue Playlist', color: '#19c3e6', items: [] };
      list.push(pl);
    }
    if (typeof input.name === 'string' && input.name.trim()) pl.name = input.name.trim().slice(0, 80);
    if (input.color !== undefined) pl.color = safeColor(input.color, pl.color);
    if (Array.isArray(input.items)) {
      const valid = new Set(rt.data.library.map((m) => m.id));
      pl.items = input.items.map(String).filter((x) => valid.has(x)).slice(0, 5000);
    }
    this.publish('playlists.changed', stationId, list);
    this.changed();
    return pl;
  }

  deletePlaylist(stationId: string, id: string): void {
    const rt = this.rt(stationId);
    if (rt.data.plans?.some((p) => p.playlistId === id)) throw new AppError(409, 'in_use', 'Playlist wird im Sendeplan verwendet');
    rt.data.playlists = (rt.data.playlists ?? []).filter((p) => p.id !== id);
    this.publish('playlists.changed', stationId, rt.data.playlists);
    this.changed();
  }

  saveQueueAsPlaylist(stationId: string, name: string): Playlist {
    return this.savePlaylist(stationId, null, { name, items: this.rt(stationId).queue.list().map((q) => q.mediaId) });
  }

  /** Playlist abspielen: ersetzt die Queue und schaltet per Crossfade weiter. */
  playPlaylist(stationId: string, id: string): void {
    const rt = this.rt(stationId);
    const pl = rt.data.playlists?.find((p) => p.id === id);
    if (!pl || !pl.items.length) throw new AppError(404, 'empty', 'Playlist ist leer oder existiert nicht');
    rt.queue.clear();
    for (const mid of pl.items) rt.queue.add(mid, 'manual');
    this.publishQueue(stationId);
    this.advance(stationId);
  }

  // ---------- Zeitplan, Stunden-Uhr, Sendeplan ----------

  planning(stationId: string): unknown {
    const d = this.rt(stationId).data;
    const now = new Date();
    return {
      jobs: [...(d.jobs ?? [])].sort((a, b) => a.at - b.at), clockEvents: d.clockEvents ?? [], plans: d.plans ?? [],
      recPlans: d.recPlans ?? [], activePlanId: activeWindow(d.plans ?? [], now)?.id ?? null,
    };
  }

  saveJob(stationId: string, input: Record<string, unknown>): ScheduledJob {
    const rt = this.rt(stationId);
    const at = typeof input.at === 'string' || typeof input.at === 'number' ? new Date(input.at).getTime() : NaN;
    if (!Number.isFinite(at)) throw new AppError(400, 'invalid_time', 'Ungültiger Zeitpunkt');
    const repeat = (['none', 'hourly', 'daily', 'weekdays', 'weekly'] as Repeat[]).includes(input.repeat as Repeat) ? (input.repeat as Repeat) : 'none';
    const job: ScheduledJob = { id: newId('job'), at, repeat, ...this.jobTarget(stationId, input) };
    (rt.data.jobs ??= []).push(job);
    this.planningChanged(stationId);
    return job;
  }

  deleteJob(stationId: string, id: string): void {
    const rt = this.rt(stationId);
    rt.data.jobs = (rt.data.jobs ?? []).filter((j) => j.id !== id);
    this.planningChanged(stationId);
  }

  saveClockEvent(stationId: string, id: string | null, input: Record<string, unknown>): ClockEvent {
    const rt = this.rt(stationId);
    const list = (rt.data.clockEvents ??= []);
    const ints = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(Number))].sort((a, b) => a - b) : []);
    const ev: ClockEvent = {
      id: id ?? newId('clk'), enabled: input.enabled !== false, minutes: ints(input.minutes), hours: ints(input.hours), days: ints(input.days),
      ...this.jobTarget(stationId, input),
    };
    try {
      validateClock(ev);
    } catch (err) {
      throw new AppError(400, 'invalid_clock', (err as Error).message);
    }
    const i = list.findIndex((e) => e.id === ev.id);
    if (id && i === -1) throw new AppError(404, 'not_found', 'Uhr-Event nicht gefunden');
    if (i === -1) list.push(ev);
    else list[i] = ev;
    this.planningChanged(stationId);
    return ev;
  }

  deleteClockEvent(stationId: string, id: string): void {
    const rt = this.rt(stationId);
    rt.data.clockEvents = (rt.data.clockEvents ?? []).filter((e) => e.id !== id);
    this.planningChanged(stationId);
  }

  /** Uhr-Event sofort auslösen (Test). */
  fireClockEvent(stationId: string, id: string): void {
    const ev = this.rt(stationId).data.clockEvents?.find((e) => e.id === id);
    if (!ev) throw new AppError(404, 'not_found', 'Uhr-Event nicht gefunden');
    this.executeTarget(stationId, ev, 'manual');
  }

  savePlan(stationId: string, id: string | null, input: Record<string, unknown>): ProgramPlan {
    const rt = this.rt(stationId);
    const list = (rt.data.plans ??= []);
    const plan: ProgramPlan = {
      id: id ?? newId('plan'), label: String(input.label ?? 'Sendung').slice(0, 80), days: Array.isArray(input.days) ? input.days.map(Number) : [],
      from: String(input.from ?? ''), to: String(input.to ?? ''), playlistId: String(input.playlistId ?? ''), shuffle: input.shuffle === true,
    };
    try {
      validateWindow(plan);
    } catch (err) {
      throw new AppError(400, 'invalid_window', (err as Error).message);
    }
    if (!rt.data.playlists?.some((p) => p.id === plan.playlistId)) throw new AppError(400, 'invalid_playlist', 'Playlist wählen');
    const i = list.findIndex((p) => p.id === plan.id);
    if (id && i === -1) throw new AppError(404, 'not_found', 'Sendeplan-Eintrag nicht gefunden');
    if (i === -1) list.push(plan);
    else list[i] = plan;
    this.planningChanged(stationId);
    return plan;
  }

  deletePlan(stationId: string, id: string): void {
    const rt = this.rt(stationId);
    rt.data.plans = (rt.data.plans ?? []).filter((p) => p.id !== id);
    this.planningChanged(stationId);
  }

  private jobTarget(stationId: string, input: Record<string, unknown>): JobTarget {
    const kind = input.kind as JobTarget['kind'];
    const mode = (['now', 'track', 'fx'] as const).includes(input.mode as never) ? (input.mode as JobTarget['mode']) : 'track';
    const label = typeof input.label === 'string' ? input.label.slice(0, 80) : undefined;
    const rt = this.rt(stationId);
    switch (kind) {
      case 'media':
        this.media(stationId, String(input.mediaId ?? ''));
        return { kind, mediaId: String(input.mediaId), mode, label };
      case 'folder':
        if (!rt.data.library.some((m) => (m.folder ?? '') === String(input.folder ?? ''))) throw new AppError(400, 'empty_folder', 'Ordner ist leer');
        return { kind, folder: String(input.folder ?? ''), mode, label };
      case 'url': {
        const m = this.addUrlMedia(stationId, { url: String(input.url ?? ''), title: label, durationMs: Number(input.durationMs) || undefined });
        return { kind: 'media', mediaId: m.id, mode, label: label ?? m.title };
      }
      case 'playlist':
        if (!rt.data.playlists?.some((p) => p.id === input.playlistId)) throw new AppError(400, 'invalid_playlist', 'Playlist wählen');
        return { kind, playlistId: String(input.playlistId), mode: 'now', label };
      default:
        throw new AppError(400, 'invalid_kind', 'Art: media, folder, url oder playlist');
    }
  }

  private planningChanged(stationId: string): void {
    this.publish('planning.changed', stationId, this.planning(stationId));
    this.changed();
  }

  /** Nächsten Titel starten – im Server-Playout direkt, sonst übernimmt das Studio (Event). */
  private advance(stationId: string): void {
    const po = this.playouts.get(stationId);
    if (po) po.playout.skip();
    else this.publish('automation.command', stationId, { action: 'next' });
  }

  private executeTarget(stationId: string, t: JobTarget, origin: string): void {
    const rt = this.rt(stationId);
    if (t.kind === 'playlist') {
      this.playPlaylist(stationId, t.playlistId!);
    } else {
      let m: MediaItem | undefined;
      if (t.kind === 'media') m = rt.data.library.find((x) => x.id === t.mediaId);
      else {
        const pool = rt.data.library.filter((x) => (x.folder ?? '') === t.folder);
        const picked = pickFromPool(pool.map((x) => ({ ...x, category: 'music' as const })), 'music', rt.data.history, rt.data.rotation);
        m = picked ? rt.data.library.find((x) => x.id === picked.id) : undefined;
      }
      if (!m) {
        this.audit.write({ kind: 'schedule', event: 'target_missing', stationId, label: t.label });
        return;
      }
      if (t.mode === 'fx') {
        const po = this.playouts.get(stationId);
        if (po) po.playout.playCart(m, true);
        else this.publish('automation.command', stationId, { action: 'fx', mediaId: m.id });
      } else {
        rt.queue.add(m.id, 'schedule', 0);
        this.publishQueue(stationId);
        if (t.mode === 'now') this.advance(stationId);
      }
    }
    this.audit.write({ kind: 'schedule', event: 'fired', stationId, origin, label: t.label, mode: t.mode });
    this.publish('schedule.fired', stationId, { label: t.label, kind: t.kind, mode: t.mode, origin });
  }

  private processSchedules(): void {
    const now = Date.now();
    const from = this.lastSchedAt;
    this.lastSchedAt = now;
    const minuteChanged = Math.floor(from / 60000) !== Math.floor(now / 60000);
    for (const [stationId, rt] of this.stations) {
      // Zeitplan-Jobs
      const jobs = rt.data.jobs ?? [];
      const due = dueJobs(jobs, from, now);
      for (const j of due) {
        this.executeTarget(stationId, j, 'job');
        const next = nextOccurrence(j, now);
        if (next === null) rt.data.jobs = (rt.data.jobs ?? []).filter((x) => x.id !== j.id);
        else j.at = next;
      }
      // Verpasste einmalige Jobs (PC war aus) nicht nachholen, sondern aufräumen/weiterschieben
      for (const j of rt.data.jobs ?? []) {
        if (j.at < now - 60_000) {
          const next = nextOccurrence(j, now);
          if (next === null) rt.data.jobs = (rt.data.jobs ?? []).filter((x) => x.id !== j.id);
          else j.at = next;
        }
      }
      if (due.length) this.planningChanged(stationId);
      if (!minuteChanged) continue;
      const d = new Date(now);
      for (const ev of clockDue(rt.data.clockEvents ?? [], d)) this.executeTarget(stationId, ev, 'clock');
      // Sendeplan-Wechsel: automatisch gefüllte Einträge verwerfen, damit das neue Programm sofort greift
      const planId = activeWindow(rt.data.plans ?? [], d)?.id ?? null;
      if (this.activePlanId.has(stationId) && this.activePlanId.get(stationId) !== planId) {
        rt.queue.pruneOrigins(['clock', 'plan']);
        this.autoFill(rt);
        this.publishQueue(stationId);
        this.publish('planning.changed', stationId, this.planning(stationId));
      }
      this.activePlanId.set(stationId, planId);
      // Aufnahme-Zeitfenster
      const recPlan = activeWindow(rt.data.recPlans ?? [], d);
      const active = this.recorders.get(stationId);
      if (recPlan && !active) this.startRecording(stationId, recPlan.label, recPlan.id);
      if (!recPlan && active?.rec.planId) this.stopRecording(stationId);
    }
  }

  // ---------- Recorder / Replays ----------

  recordings(stationId: string): unknown {
    const rt = this.rt(stationId);
    const active = this.recorders.get(stationId);
    return { recordings: [...(rt.data.recordings ?? [])].reverse(), recording: active ? active.rec : null, recPlans: rt.data.recPlans ?? [] };
  }

  startRecording(stationId: string, label?: string, planId?: string, target = '/live'): Recording {
    const rt = this.rt(stationId);
    if (this.recorders.has(stationId)) throw new AppError(409, 'busy', 'Es läuft bereits eine Aufnahme');
    const dir = join(this.dataDir, 'recordings', stationId);
    mkdirSync(dir, { recursive: true });
    const baseLabel = (label?.trim() || `Mitschnitt ${new Date().toLocaleString('de-DE')}`).slice(0, 80);
    let part = 0;
    const active: ActiveRecording = {
      rec: { id: '', label: baseLabel, startedAt: Date.now(), bytes: 0, contentType: '', file: '', planId },
      stream: null,
      target,
      tap: {
        onStart: (type, init) => {
          part++;
          const ext = type.includes('mpeg') ? 'mp3' : type.includes('ogg') ? 'ogg' : type.includes('webm') ? 'webm' : type.includes('aac') ? 'aac' : 'bin';
          const rec: Recording = { id: newId('rec'), label: part > 1 ? `${baseLabel} (Teil ${part})` : baseLabel, startedAt: Date.now(), bytes: 0, contentType: type, file: '', planId };
          rec.file = `${rec.id}.${ext}`;
          active.rec = rec;
          active.stream = createWriteStream(join(dir, rec.file));
          (rt.data.recordings ??= []).push(rec);
          if (init) this.recWrite(active, init);
          this.publish('recorder.changed', stationId, this.recordings(stationId));
          this.changed();
        },
        onData: (chunk) => this.recWrite(active, chunk),
        onStop: () => {
          active.stream?.end();
          active.stream = null;
          active.rec.endedAt = Date.now();
          this.changed();
        },
      },
    };
    this.recorders.set(stationId, active);
    this.relayFor(stationId, target).addTap(active.tap);
    this.audit.write({ kind: 'recorder', event: 'start', stationId, planId });
    this.publish('recorder.changed', stationId, this.recordings(stationId));
    return active.rec;
  }

  stopRecording(stationId: string): void {
    const active = this.recorders.get(stationId);
    if (!active) return;
    this.recorders.delete(stationId);
    this.relayFor(stationId, active.target).removeTap(active.tap);
    this.audit.write({ kind: 'recorder', event: 'stop', stationId });
    this.publish('recorder.changed', stationId, this.recordings(stationId));
    this.changed();
  }

  private recWrite(active: ActiveRecording, chunk: Buffer): void {
    if (!active.stream) return;
    // Platte zu langsam: lieber Lücke als Speicher volllaufen lassen
    if (active.stream.writableLength > 8 * 1024 * 1024) return;
    active.stream.write(chunk);
    active.rec.bytes += chunk.length;
  }

  recordingFile(stationId: string, id: string): { path: string; rec: Recording } {
    const rec = this.rt(stationId).data.recordings?.find((r) => r.id === id);
    if (!rec) throw new AppError(404, 'not_found', 'Aufnahme nicht gefunden');
    return { path: join(this.dataDir, 'recordings', stationId, rec.file), rec };
  }

  deleteRecording(stationId: string, id: string): void {
    const rt = this.rt(stationId);
    const { path, rec } = this.recordingFile(stationId, id);
    if (this.recorders.get(stationId)?.rec.id === rec.id) throw new AppError(409, 'busy', 'Aufnahme läuft noch');
    rmSync(path, { force: true });
    rt.data.recordings = (rt.data.recordings ?? []).filter((r) => r.id !== id);
    this.publish('recorder.changed', stationId, this.recordings(stationId));
    this.changed();
  }

  saveRecPlan(stationId: string, id: string | null, input: Record<string, unknown>): RecordingPlan {
    const rt = this.rt(stationId);
    const list = (rt.data.recPlans ??= []);
    const plan: RecordingPlan = {
      id: id ?? newId('rp'), label: String(input.label ?? 'Aufnahme').slice(0, 80), days: Array.isArray(input.days) ? input.days.map(Number) : [],
      from: String(input.from ?? ''), to: String(input.to ?? ''),
    };
    try {
      validateWindow(plan);
    } catch (err) {
      throw new AppError(400, 'invalid_window', (err as Error).message);
    }
    const i = list.findIndex((p) => p.id === plan.id);
    if (i === -1) list.push(plan);
    else list[i] = plan;
    this.publish('recorder.changed', stationId, this.recordings(stationId));
    this.changed();
    return plan;
  }

  deleteRecPlan(stationId: string, id: string): void {
    const rt = this.rt(stationId);
    rt.data.recPlans = (rt.data.recPlans ?? []).filter((p) => p.id !== id);
    this.publish('recorder.changed', stationId, this.recordings(stationId));
    this.changed();
  }

  // ---------- Benachrichtigungen, Webhooks, Now-Playing-Export ----------

  /** Übersetzt interne Ereignisse in externe Meldungen (Webhook/Telegram/Datei). */
  private notifyFrom(type: string, stationId: string, payload: unknown): void {
    const cfg = this.stations.get(stationId)?.data.integrations;
    if (!cfg) return;
    const p = (payload ?? {}) as Record<string, any>;
    let event: NotifyEvent | null = null;
    let data: Record<string, unknown> = {};
    switch (type) {
      case 'now_playing.changed':
        event = 'now_playing';
        data = { mediaId: p.mediaId, title: p.media?.title, artist: p.media?.artist, album: p.media?.album, category: p.media?.category, durationMs: p.media?.durationMs };
        break;
      case 'source.takeover_completed':
        event = 'on_air_changed';
        data = { source: this.engine.get(p.sourceId)?.name ?? p.sourceId, priority: p.data?.priority, target: p.target };
        break;
      case 'source.off_air':
        event = 'off_air';
        data = { target: p.target };
        break;
      case 'source.source_failed':
        event = 'source_failed';
        data = { source: this.engine.get(p.sourceId)?.name ?? p.sourceId, reason: p.data?.reason };
        break;
      case 'playout.log':
        if (p.event === 'silence_detected') event = 'silence';
        else if (p.event === 'silence_recovered') event = 'silence_recovered';
        else if (p.event === 'encoder_crashed') event = 'encoder_crashed';
        data = { detail: p.stderr };
        break;
      case 'stream.state_changed': {
        const prev = this.lastOutStatus.get(p.id);
        this.lastOutStatus.set(p.id, p.status);
        if (prev === p.status) break;
        const name = this.outputs.get(p.id)?.cfg.name ?? p.id;
        if (p.status === 'error') event = 'stream_error';
        else if (p.status === 'connected') event = 'stream_connected';
        data = { output: name, error: p.error };
        break;
      }
      case 'schedule.fired':
        event = 'schedule_fired';
        data = { label: p.label, kind: p.kind, mode: p.mode };
        break;
    }
    if (event) this.notifier.emit(cfg, { event, station: stationId, at: new Date().toISOString(), data });
  }

  integrations(stationId: string): unknown {
    const cfg = this.rt(stationId).data.integrations ?? { webhooks: [] };
    return {
      events: NOTIFY_EVENTS,
      webhooks: cfg.webhooks.map(({ secretRef, ...w }) => ({ ...w, hasSecret: !!secretRef && this.secrets.has(secretRef) })),
      telegram: cfg.telegram ? { chatId: cfg.telegram.chatId, enabled: cfg.telegram.enabled, hasToken: this.secrets.has(cfg.telegram.botTokenRef) } : null,
      nowPlayingFile: cfg.nowPlayingFile ?? null,
    };
  }

  setIntegrations(p: Principal, stationId: string, input: Record<string, any>): unknown {
    const rt = this.rt(stationId);
    const cur: IntegrationsConfig = rt.data.integrations ?? { webhooks: [] };
    try {
      if (Array.isArray(input.webhooks)) {
        cur.webhooks = input.webhooks.slice(0, 10).map((w: Record<string, any>) => {
          const prev = cur.webhooks.find((x) => x.id === w.id);
          const id = prev?.id ?? newId('wh');
          const secretRef = prev?.secretRef ?? `webhook:${stationId}:${id}`;
          if (typeof w.secret === 'string' && w.secret) this.secrets.set(secretRef, w.secret);
          const events = (Array.isArray(w.events) ? w.events : []).filter((e: string) => (NOTIFY_EVENTS as readonly string[]).includes(e));
          return { id, url: validateWebhookUrl(String(w.url ?? '')), events, secretRef, enabled: w.enabled !== false };
        });
      }
      if (input.telegram === null) cur.telegram = undefined;
      else if (input.telegram && typeof input.telegram === 'object') {
        const botTokenRef = cur.telegram?.botTokenRef ?? `telegram:${stationId}`;
        if (typeof input.telegram.botToken === 'string' && input.telegram.botToken) this.secrets.set(botTokenRef, input.telegram.botToken.trim());
        cur.telegram = { chatId: String(input.telegram.chatId ?? '').slice(0, 64), botTokenRef, enabled: input.telegram.enabled !== false };
      }
      if (input.nowPlayingFile === null || input.nowPlayingFile === '') cur.nowPlayingFile = undefined;
      else if (typeof input.nowPlayingFile === 'string') cur.nowPlayingFile = validateExportPath(input.nowPlayingFile);
    } catch (err) {
      throw new AppError(400, 'invalid_integration', (err as Error).message);
    }
    rt.data.integrations = cur;
    this.audit.write({ kind: 'notify', event: 'config', actor: p.id, stationId });
    this.changed();
    return this.integrations(stationId);
  }

  /** Testmeldung an alle Webhooks/Telegram senden und Ergebnisse zurückgeben. */
  async testIntegrations(stationId: string): Promise<unknown> {
    const cfg = this.rt(stationId).data.integrations;
    if (!cfg) return { webhooks: [], telegram: null };
    const payload = { event: 'schedule_fired' as const, station: stationId, at: new Date().toISOString(), data: { test: true, label: 'AirDeck Testmeldung' } };
    const webhooks = await Promise.all(cfg.webhooks.map(async (w) => ({ id: w.id, ok: await this.notifier.deliverWebhook(w, payload) })));
    const telegram = cfg.telegram ? await this.notifier.deliverTelegram(cfg.telegram.chatId, cfg.telegram.botTokenRef, `✅ AirDeck ${stationId}: Testmeldung`) : null;
    return { webhooks, telegram };
  }

  // ---------- Updates ----------

  updateConfig(): UpdateSource & { autoCheck: boolean } {
    const s = this.docs.get<Partial<UpdateSource> & { autoCheck?: boolean }>('update', {});
    return { ...DEFAULT_SOURCE, ...s, tokenRef: 'update:token', autoCheck: s.autoCheck ?? true };
  }

  updateSettingsView(): unknown {
    const s = this.updateConfig();
    return {
      repo: s.repo, tag: s.tag, manifestUrl: s.manifestUrl ?? '', autoCheck: s.autoCheck, hasToken: this.secrets.has('update:token'),
      build: this.updater.current, canInstall: process.platform === 'win32' && this.packaged,
    };
  }

  setUpdateSettings(input: Record<string, unknown>): unknown {
    const cur = this.updateConfig();
    const repo = typeof input.repo === 'string' && input.repo ? input.repo.trim() : cur.repo;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new AppError(400, 'invalid_repo', 'Repository im Format besitzer/name angeben');
    const manifestUrl = typeof input.manifestUrl === 'string' ? input.manifestUrl.trim() : cur.manifestUrl ?? '';
    if (manifestUrl && !/^https:\/\//.test(manifestUrl)) throw new AppError(400, 'invalid_url', 'Update-Adresse muss https:// sein');
    if (typeof input.token === 'string') {
      if (input.token) this.secrets.set('update:token', input.token.trim());
      else this.secrets.delete('update:token');
    }
    this.docs.set('update', {
      repo, tag: typeof input.tag === 'string' && input.tag ? input.tag : cur.tag, manifestUrl: manifestUrl || undefined,
      autoCheck: typeof input.autoCheck === 'boolean' ? input.autoCheck : cur.autoCheck,
    });
    return this.updateSettingsView();
  }

  checkUpdate(force = false): Promise<unknown> {
    return this.updater.check(this.updateConfig(), this.secrets.get('update:token'), force);
  }

  /** Windows (installiertes Programm): Setup laden, prüfen, still installieren, AirDeck beenden. */
  async installUpdate(exit: () => void): Promise<unknown> {
    if (process.platform !== 'win32' || !this.packaged) throw new AppError(409, 'not_supported', 'Automatische Installation nur im installierten Windows-Programm – sonst bitte manuell herunterladen');
    const info = await this.updater.check(this.updateConfig(), this.secrets.get('update:token'), true);
    if (info.error) throw new AppError(502, 'update_check_failed', info.error);
    if (!info.available || !info.assets.setup) throw new AppError(409, 'no_update', 'Kein neueres Update verfügbar');
    const file = await this.updater.download(info.assets.setup, this.secrets.get('update:token'));
    this.audit.write({ kind: 'update', event: 'install', from: this.updater.current, to: info.latest });
    this.updater.runWindowsSetup(file, this.headless);
    setTimeout(exit, 1500).unref();
    return { installing: true, to: info.latest };
  }

  // ---------- Brücke zu bestehenden Systemen ----------

  private readonly bridgeStatus = new Map<string, { at: number; data?: ExternalNow; error?: string; busy?: boolean }>();
  private readonly pulls = new Map<string, PullRelay>();
  /** Von außen gemeldetes Now Playing (Bridge-API), pro Sender */
  private readonly externalNow = new Map<string, ExternalNow & { at: number }>();

  bridges(stationId: string): unknown[] {
    return (this.rt(stationId).data.bridges ?? []).map((b) => ({
      ...b, hasKey: this.secrets.has(`bridge:${b.id}`),
      status: this.bridgeStatus.get(b.id) ?? null,
      relay: this.pulls.has(b.id) ? { state: this.pulls.get(b.id)!.state, error: this.pulls.get(b.id)!.lastError, bytes: this.pulls.get(b.id)!.bytes } : null,
    }));
  }

  saveBridge(p: Principal, stationId: string, id: string | null, input: Record<string, any>): unknown {
    const rt = this.rt(stationId);
    const list = (rt.data.bridges ??= []);
    const cur = id ? list.find((b) => b.id === id) : undefined;
    if (id && !cur) throw new AppError(404, 'not_found', 'Anbindung nicht gefunden');
    if (input.remove === true && cur) {
      this.stopPull(cur.id);
      if (cur.sourceId && this.engine.get(cur.sourceId)) this.removeSource(p, stationId, cur.sourceId);
      rt.data.bridges = list.filter((b) => b !== cur);
      this.secrets.delete(`bridge:${cur.id}`);
      this.bridgeStatus.delete(cur.id);
      this.changed();
      return { removed: true };
    }
    const kind = ['azuracast', 'icecast', 'stream'].includes(input.kind) ? input.kind : cur?.kind ?? 'stream';
    const url = String(input.url ?? cur?.url ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw new AppError(400, 'invalid_url', 'Adresse mit http(s):// angeben');
    const pullUrl = typeof input.pullUrl === 'string' ? input.pullUrl.trim() : cur?.pullUrl ?? '';
    if (pullUrl && !/^https?:\/\/[^\s]+$/.test(pullUrl)) throw new AppError(400, 'invalid_url', 'Stream-Adresse mit http(s):// angeben');
    const b: BridgeConfig = {
      id: cur?.id ?? newId('br'),
      name: String(input.name ?? cur?.name ?? kind).trim().slice(0, 60) || kind,
      kind, url,
      station: typeof input.station === 'string' ? input.station.trim().slice(0, 80) || undefined : cur?.station,
      mirror: typeof input.mirror === 'boolean' ? input.mirror : cur?.mirror ?? kind !== 'stream',
      pull: typeof input.pull === 'boolean' ? input.pull : cur?.pull ?? kind === 'stream',
      pullUrl: pullUrl || undefined,
      sourceId: cur?.sourceId,
      priority: Number.isInteger(input.priority) && input.priority > 0 && input.priority < 1000 ? input.priority : cur?.priority ?? 20,
    };
    if (kind === 'azuracast' && !b.station) throw new AppError(400, 'invalid_station', 'AzuraCast: Kurzname oder ID des Senders angeben');
    if (kind === 'icecast' && !b.station) b.station = '/stream';
    if (typeof input.apiKey === 'string') {
      if (input.apiKey) this.secrets.set(`bridge:${b.id}`, input.apiKey.trim());
      else this.secrets.delete(`bridge:${b.id}`);
    }
    // Relay-Quelle anlegen/aktualisieren (Typ url_stream, eigene Priorität)
    if (b.pull) {
      const existing = b.sourceId ? this.engine.get(b.sourceId) : undefined;
      if (!existing) {
        const src = this.addSource(p, stationId, { name: `Relay: ${b.name}`, type: 'url_stream', target: '/live', priority: b.priority, takeoverPolicy: 'auto', allowedRoles: ['operator'] }) as { id: string };
        b.sourceId = src.id;
      } else if (existing.priority !== b.priority || existing.name !== `Relay: ${b.name}`) {
        this.updateSource(p, stationId, existing.id, { priority: b.priority, name: `Relay: ${b.name}` });
      }
    }
    if (cur) Object.assign(cur, b);
    else list.push(b);
    this.audit.write({ kind: 'bridge', event: cur ? 'updated' : 'created', actor: p.id, stationId, bridge: b.id, bridgeKind: b.kind, pull: b.pull, mirror: b.mirror });
    this.changed();
    this.stopPull(b.id);
    if (b.pull) void this.startPull(stationId, b);
    if (b.mirror) void this.pollBridge(stationId, b, true);
    return this.bridges(stationId).find((x) => (x as { id: string }).id === b.id);
  }

  private stopPull(id: string): void {
    this.pulls.get(id)?.stop();
    this.pulls.delete(id);
  }

  /** Relay starten: Stream-URL explizit, sonst aus dem gespiegelten Status (AzuraCast-Mount/Icecast-Mount). */
  private async startPull(stationId: string, b: BridgeConfig): Promise<void> {
    let url = b.kind === 'stream' ? b.url : b.pullUrl;
    if (!url) {
      const s = await this.pollBridge(stationId, b, true);
      url = s?.listenUrls[0];
    }
    const src = b.sourceId ? this.engine.list(stationId).find((x) => x.id === b.sourceId) : undefined;
    if (!url || !src || !(this.rt(stationId).data.bridges ?? []).includes(b)) {
      if (!url) this.audit.write({ kind: 'bridge', event: 'relay_no_url', stationId, bridge: b.id });
      return;
    }
    const relay = new PullRelay(url, {
      open: (type) => {
        try {
          this.ingestOpen(src, type);
        } catch (err) {
          this.audit.write({ kind: 'bridge', event: 'relay_rejected', stationId, bridge: b.id, message: (err as Error).message });
        }
      },
      data: (chunk) => this.ingestData(src, chunk),
      close: () => this.ingestClose(src),
      log: (event, data) => this.audit.write({ kind: 'bridge', event, stationId, bridge: b.id, ...data }),
    });
    this.pulls.set(b.id, relay);
    relay.start();
  }

  /** Status einer Anbindung abfragen (mit Zwischenspeicher, nie parallel). */
  private async pollBridge(stationId: string, b: BridgeConfig, force = false): Promise<ExternalNow | undefined> {
    const st = this.bridgeStatus.get(b.id) ?? { at: 0 };
    if (st.busy || (!force && Date.now() - st.at < 15_000)) return st.data;
    st.busy = true;
    this.bridgeStatus.set(b.id, st);
    try {
      const key = this.secrets.get(`bridge:${b.id}`);
      if (b.kind === 'azuracast') st.data = await fetchAzuracast(b.url, b.station!, key);
      else if (b.kind === 'icecast') st.data = await fetchIcecastMount(b.url, b.station ?? '/stream');
      else return undefined;
      st.error = undefined;
      this.publish('bridge.status', stationId, { id: b.id, ...st.data });
    } catch (err) {
      st.error = (err as Error).message;
    } finally {
      st.at = Date.now();
      st.busy = false;
    }
    return st.data;
  }

  private startBridges(): void {
    for (const [id, rt] of this.stations) for (const b of rt.data.bridges ?? []) if (b.pull) void this.startPull(id, b);
  }

  private tickBridges(): void {
    for (const [id, rt] of this.stations) for (const b of rt.data.bridges ?? []) if (b.mirror && b.kind !== 'stream') void this.pollBridge(id, b);
  }

  // ---------- Bridge-API für Entwickler: externe Schlüssel → AirDeck-Sender (idempotent) ----------

  private bridgeMap(): Record<string, string> {
    return { ...this.docs.get<Record<string, string>>('bridge-keys', {}) };
  }

  /** Sender über einen externen Schlüssel anlegen oder aktualisieren – derselbe Schlüssel ergibt immer denselben Sender. */
  bridgeUpsertStation(key: string, input: Record<string, unknown>): { station: Station; created: boolean } {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/.test(key)) throw new AppError(400, 'invalid_key', 'Schlüssel: Buchstaben, Ziffern und : . _ - (max. 120)');
    const map = this.bridgeMap();
    const known = map[key];
    if (known && this.stations.has(known)) return { station: this.updateStation(known, input as Partial<Station>), created: false };
    const base = (typeof input.id === 'string' && input.id ? input.id : key).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'sender';
    let sid = base;
    for (let i = 2; this.stations.has(sid); i++) sid = `${base}-${i}`;
    const station = this.createStation({ id: sid, name: String(input.name ?? key).slice(0, 80), slogan: typeof input.slogan === 'string' ? input.slogan : undefined, primaryColor: input.primaryColor as string, accentColor: input.accentColor as string }, input.withDefaultSources !== false);
    if (typeof input.genre === 'string') this.updateStation(sid, { genre: input.genre });
    map[key] = sid;
    this.docs.set('bridge-keys', map);
    this.audit.write({ kind: 'bridge', event: 'station_created', key, stationId: sid });
    return { station, created: true };
  }

  bridgeStation(key: string): string {
    const sid = this.bridgeMap()[key];
    if (!sid || !this.stations.has(sid)) throw new AppError(404, 'not_found', 'Kein Sender zu diesem Schlüssel');
    return sid;
  }

  bridgeMappings(): Record<string, string> {
    return this.bridgeMap();
  }

  /** Now Playing von einem fremden System melden (z. B. eigene Automation, SAM, mAirList, RadioDJ per Skript). */
  bridgeNowPlaying(key: string, input: Record<string, unknown>): unknown {
    const sid = this.bridgeStation(key);
    const artist = String(input.artist ?? '').slice(0, 200);
    const title = String(input.title ?? '').slice(0, 200);
    if (!title) throw new AppError(400, 'invalid', 'Titel fehlt');
    const started = typeof input.startedAt === 'string' && !Number.isNaN(Date.parse(input.startedAt)) ? new Date(input.startedAt).toISOString() : new Date().toISOString();
    const dur = typeof input.durationMs === 'number' && input.durationMs > 0 ? input.durationMs : null;
    const prev = this.externalNow.get(sid);
    const history = prev?.now ? [{ started_at: prev.now.started_at ?? undefined, artist: prev.now.artist, title: prev.now.title }, ...prev.history].slice(0, 10) : prev?.history ?? [];
    const ext: ExternalNow & { at: number } = {
      at: Date.now(), name: this.rt(sid).station.name, listeners: typeof input.listeners === 'number' ? input.listeners : prev?.listeners ?? null,
      listenUrls: Array.isArray(input.listenUrls) ? input.listenUrls.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 5) : prev?.listenUrls ?? [],
      now: { artist, title, album: typeof input.album === 'string' ? input.album : undefined, started_at: started, ends_at: dur ? new Date(Date.parse(started) + dur).toISOString() : null },
      history, live: null,
    };
    this.externalNow.set(sid, ext);
    for (const k of [...this.statusCache.keys()]) if (k.startsWith(`a:${sid}:`)) this.statusCache.delete(k);
    // Titelanzeige an die eigenen Ausgänge, Ereignis für Studio/Webhooks
    const song = artist ? `${artist} - ${title}` : title;
    for (const o of this.outputs.values()) if (o.cfg.stationId === sid) o.updateMetadata(song);
    this.publish('now_playing.external', sid, ext);
    return { stationId: sid, now: ext.now };
  }

  // ---------- Stream-Status (öffentlich, wie Icecast) ----------

  private readonly statusCache = new Map<string, { at: number; data: Promise<StreamStatus> }>();
  private readonly startedAt = new Date().toISOString();

  private cached(key: string, ttlMs: number, fn: () => Promise<StreamStatus>): Promise<StreamStatus> {
    const hit = this.statusCache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.data;
    const data = fn();
    this.statusCache.set(key, { at: Date.now(), data });
    data.catch(() => this.statusCache.delete(key));
    if (this.statusCache.size > 200) this.statusCache.delete(this.statusCache.keys().next().value!);
    return data;
  }

  /** Öffentliche Senderliste für die Statusseite. */
  publicStations(): { id: string; name: string; lautfm?: string }[] {
    return [...this.stations.values()].filter((r) => r.station.publicStatus !== false).map((r) => ({ id: r.station.id, name: r.station.name, ...(r.data.lautfm?.stationName ? { lautfm: r.data.lautfm.stationName } : {}) }));
  }

  /** Status eines AirDeck-Senders: aktive Quelle, verbundene Ausgänge, laut.fm (falls verbunden), Now Playing, Verlauf. */
  streamStatus(stationId: string, host: string): Promise<StreamStatus> {
    const rt = this.stations.get(stationId);
    if (!rt || rt.station.publicStatus === false) return Promise.reject(new AppError(404, 'not_found', 'Sender nicht gefunden oder nicht öffentlich'));
    return this.cached(`a:${stationId}:${host}`, 5000, async () => {
      const lib = new Map(rt.data.library.map((m) => [m.id, m]));
      const m = rt.nowPlaying.mediaId ? lib.get(rt.nowPlaying.mediaId) : undefined;
      const active = this.engine.list(stationId).find((s) => s.state === 'active');
      const fmt = rt.data.playout?.format ?? 'mp3';
      const type = fmt === 'opus' ? 'application/ogg' : fmt === 'aac' ? 'audio/aac' : 'audio/mpeg';
      const title = m ? (m.artist ? `${m.artist} - ${m.title}` : m.title) : '';
      const sources: StreamStatus['icestats']['source'] = [];
      for (const o of this.outputs.values()) {
        if (o.cfg.stationId !== stationId || !o.cfg.enabled || o.state.status !== 'connected') continue;
        if (/(^|\.)laut\.fm$/i.test(o.cfg.host) && rt.data.lautfm?.stationName) continue; // kommt unten mit echten laut.fm-Daten
        sources.push({
          kind: o.cfg.type === 'shoutcast' ? 'shoutcast' : 'icecast', listenurl: listenUrlOf(o.cfg), server_name: rt.station.name, server_description: rt.station.slogan,
          server_type: o.state.contentType ?? type, genre: rt.station.genre, bitrate: o.cfg.bitrateKbps ?? rt.data.playout?.bitrateKbps ?? null,
          listeners: o.state.listeners ?? null, title, artist: m?.artist, stream_start_iso8601: o.state.connectedAt ? new Date(o.state.connectedAt).toISOString() : null,
        });
      }
      let laut: StreamStatus | null = null;
      if (rt.data.lautfm?.stationName) laut = await this.lautfmPublicStatus(rt.data.lautfm.stationName).catch(() => null);
      if (laut) sources.push(...laut.icestats.source);
      // Gespiegelte Systeme (AzuraCast/Icecast) und per Bridge-API gemeldete Streams
      let ext: ExternalNow | undefined;
      for (const b of rt.data.bridges ?? []) {
        const d = b.mirror ? this.bridgeStatus.get(b.id)?.data : undefined;
        if (!d) continue;
        ext ??= d;
        for (const u of d.listenUrls.slice(0, 3)) {
          sources.push({ kind: b.kind === 'azuracast' ? 'azuracast' : 'icecast', listenurl: u, server_name: d.name, server_type: d.format ? (d.format.includes('/') ? d.format : `audio/${d.format}`) : 'audio/mpeg',
            bitrate: d.bitrate ?? null, listeners: d.listeners, title: d.now ? (d.now.artist ? `${d.now.artist} - ${d.now.title}` : d.now.title) : '', artist: d.now?.artist, stream_start_iso8601: d.now?.started_at ?? null, genre: rt.station.genre });
        }
      }
      const pushed = this.externalNow.get(stationId);
      if (pushed && Date.now() - pushed.at < 6 * 3600_000) {
        ext = pushed;
        for (const u of pushed.listenUrls) sources.push({ kind: 'extern', listenurl: u, server_name: rt.station.name, server_type: 'audio/mpeg', listeners: pushed.listeners, title: pushed.now ? (pushed.now.artist ? `${pushed.now.artist} - ${pushed.now.title}` : pushed.now.title) : '', artist: pushed.now?.artist, stream_start_iso8601: pushed.now?.started_at ?? null });
      }
      const log = (rt.data.playLog ?? []).filter((e) => e.category === 'music').slice(0, 10);
      return {
        kind: 'airdeck', station: stationId, name: rt.station.name, description: rt.station.slogan,
        icestats: { admin: '', host, location: 'AirDeck', server_id: `AirDeck ${this.updater.current}`, server_start_iso8601: this.startedAt, source: sources },
        now: m ? { artist: m.artist, title: m.title, album: m.album, started_at: rt.nowPlaying.startedAt ? new Date(rt.nowPlaying.startedAt).toISOString() : null,
          ends_at: rt.nowPlaying.startedAt && m.durationMs ? new Date(rt.nowPlaying.startedAt + m.durationMs - (m.cueInMs ?? 0)).toISOString() : null } : ext?.now ?? laut?.now ?? null,
        last_songs: log.length ? log.map((e) => ({ started_at: new Date(e.at).toISOString(), artist: e.artist, title: e.title })) : ext?.history.length ? ext.history : laut?.last_songs ?? [],
        onair: active ? { source: active.name, type: active.type, priority: active.priority } : null,
        links: { ...(laut?.links ?? {}), ...(rt.station.logo ? { logo: `/api/v1/stations/${stationId}/logo` } : {}) },
        updated_at: new Date().toISOString(),
      };
    });
  }

  /** Beliebiger laut.fm-Sender (Name) – Icecast-Status nachgebaut aus der öffentlichen API, 10 s zwischengespeichert. */
  lautfmPublicStatus(name: string): Promise<StreamStatus> {
    return this.cached(`l:${name}`, 10_000, () => lautfmStatus(name, PUBLIC_API));
  }

  // ---------- Liquidsoap ----------

  liquidsoap(stationId: string, opts: { port?: number; mount?: string; processing?: boolean }): { script: string; env: string[] } {
    const rt = this.rt(stationId);
    const outputs = [...this.outputs.values()].filter((o) => o.cfg.stationId === stationId).map((o) => o.cfg);
    const port = Number.isInteger(opts.port) && opts.port! > 1023 && opts.port! < 65536 ? opts.port! : 8005;
    return liquidsoapScript(outputs, {
      stationName: rt.station.name, harborPort: port, harborMount: String(opts.mount ?? 'airdeck').replace(/[^\w/-]/g, '').slice(0, 40) || 'airdeck',
      bitrateKbps: rt.data.playout?.bitrateKbps ?? 128, processing: opts.processing !== false,
    });
  }

  // ---------- Nextcloud-Brücke ----------

  nextcloudConfig(): (NextcloudConfig & { hasPassword: boolean }) | { configured: false } {
    const c = this.docs.get<NextcloudConfig | null>('nextcloud', null);
    return c ? { ...c, hasPassword: this.secrets.has('nextcloud:password') } : { configured: false };
  }

  setNextcloud(input: Record<string, unknown>): unknown {
    if (input.remove === true) {
      rmSync(join(this.dataDir, 'nextcloud.json'), { force: true });
      this.secrets.delete('nextcloud:password');
      return { configured: false };
    }
    const url = String(input.url ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(url)) throw new AppError(400, 'invalid_url', 'Nextcloud-Adresse mit https:// angeben');
    const user = String(input.user ?? '').trim();
    if (!user) throw new AppError(400, 'invalid_user', 'Benutzername fehlt');
    let root: string;
    try {
      root = cleanPath(String(input.root ?? '/'));
    } catch {
      throw new AppError(400, 'invalid_path', 'Ungültiger Startordner');
    }
    if (typeof input.password === 'string' && input.password) this.secrets.set('nextcloud:password', input.password.trim());
    if (!this.secrets.has('nextcloud:password')) throw new AppError(400, 'no_password', 'App-Passwort fehlt (Nextcloud → Einstellungen → Sicherheit → App-Passwort)');
    this.docs.set('nextcloud', { url, user, root });
    this.audit.write({ kind: 'nextcloud', event: 'config', url, user });
    return this.nextcloudConfig();
  }

  private nc(): { client: Nextcloud; root: string } {
    const c = this.docs.get<NextcloudConfig | null>('nextcloud', null);
    const pw = this.secrets.get('nextcloud:password');
    if (!c || !pw) throw new AppError(409, 'not_configured', 'Nextcloud ist noch nicht eingerichtet');
    return { client: new Nextcloud(c, pw), root: c.root };
  }

  private ncCall<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((err) => {
      if (err instanceof NextcloudError) throw new AppError(err.status === 401 ? 502 : err.status, 'nextcloud', err.message);
      throw err;
    });
  }

  /** Ordner in der Nextcloud (relativ zum Startordner). */
  async nextcloudList(path: string): Promise<unknown> {
    const { client, root } = this.nc();
    const rel = cleanPath(path);
    const entries = await this.ncCall(() => client.list(cleanPath(`${root}/${rel}`)));
    return {
      path: rel,
      entries: entries.map((e) => ({ ...e, path: cleanPath(e.path.slice(root === '/' ? 0 : root.length)), audio: !e.dir && AUDIO_FILE_RE.test(e.name) })),
    };
  }

  /** Dateien/Ordner (rekursiv, max. 500 Dateien) in die Bibliothek übernehmen. */
  async nextcloudImport(stationId: string, paths: string[], opts: { category?: string; folder?: string }): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const { client, root } = this.nc();
    const rt = this.rt(stationId);
    const category = (MEDIA_CATEGORIES as readonly string[]).includes(String(opts.category)) ? (opts.category as MediaItem['category']) : 'music';
    const files: { path: string; name: string; folder: string }[] = [];
    const walk = async (rel: string, folder: string, depth: number): Promise<void> => {
      const list = await this.ncCall(() => client.list(cleanPath(`${root}/${rel}`)));
      for (const e of list) {
        if (files.length >= 500) return;
        const r = cleanPath(`${rel}/${e.name}`);
        if (e.dir && depth < 4) await walk(r, folder ? `${folder} / ${e.name}` : e.name, depth + 1);
        else if (!e.dir && AUDIO_FILE_RE.test(e.name)) files.push({ path: r, name: e.name, folder });
      }
    };
    for (const p of paths.slice(0, 200)) {
      const rel = cleanPath(p);
      const name = rel.split('/').pop() ?? '';
      if (AUDIO_FILE_RE.test(name)) files.push({ path: rel, name, folder: opts.folder ?? '' });
      else await walk(rel, opts.folder || name, 0);
    }
    const errors: string[] = [];
    let imported = 0;
    let skipped = 0;
    for (const f of files) {
      // bereits übernommene Datei (gleicher Nextcloud-Pfad) nicht doppelt laden
      if (rt.data.library.some((m) => m.source === `nextcloud:${f.path}`)) {
        skipped++;
        continue;
      }
      const id = newId('m');
      const ext = extname(f.name).toLowerCase();
      const file = `${id}${ext}`;
      try {
        await this.ncCall(() => client.download(cleanPath(`${root}/${f.path}`), join(this.mediaDir, stationId, file), 500 * 1024 * 1024));
        const meta = parseFileName(f.name);
        this.addMedia(stationId, { id, title: meta.title || f.name, artist: meta.artist, category, file, durationMs: null, addedAt: Date.now(), folder: f.folder.slice(0, 80) || undefined, originalName: f.name, source: `nextcloud:${f.path}` });
        imported++;
      } catch (err) {
        errors.push(`${f.name}: ${(err as Error).message}`);
      }
    }
    this.audit.write({ kind: 'nextcloud', event: 'import', stationId, imported, skipped, errors: errors.length });
    return { imported, skipped, errors: errors.slice(0, 20) };
  }

  /** Mitschnitt in die Nextcloud hochladen. */
  async nextcloudUploadRecording(stationId: string, recId: string, targetDir: string): Promise<unknown> {
    const { client, root } = this.nc();
    const { path, rec } = this.recordingFile(stationId, recId);
    const ext = rec.contentType.includes('ogg') ? 'ogg' : rec.contentType.includes('aac') ? 'aac' : rec.contentType.includes('webm') ? 'webm' : 'mp3';
    const name = `${new Date(rec.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')} ${rec.label}`.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
    const target = cleanPath(`${root}/${targetDir || 'AirDeck-Mitschnitte'}/${name}.${ext}`);
    await this.ncCall(() => client.upload(path, target, rec.contentType));
    this.audit.write({ kind: 'nextcloud', event: 'upload', stationId, recId });
    return { uploaded: target };
  }

  // ---------- Android-App / Netzwerk ----------

  /** Mitgelieferte APK (Windows-Paket) oder null. */
  localApk(): string | null {
    const f = join(this.appRoot, 'android', 'AirDeck-Android.apk');
    return existsSync(f) ? f : null;
  }

  appConnect(): unknown {
    const lanSetting = readJson<{ lan?: boolean }>(join(this.dataDir, 'network.json'), {}).lan === true;
    const listening = this.listenHost === '0.0.0.0' || this.listenHost === '::';
    const addresses: string[] = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) addresses.push(`http://${a.address}:${this.listenPort}`);
    }
    return { lan: lanSetting, listening, restartNeeded: lanSetting !== listening && !process.env.AIRDECK_HOST, addresses, apk: this.localApk() ? 'local' : 'release' };
  }

  setNetwork(lan: boolean): unknown {
    writeFileAtomic(join(this.dataDir, 'network.json'), JSON.stringify({ lan }));
    this.audit.write({ kind: 'network', event: 'lan', lan });
    return this.appConnect();
  }

  // ---------- KI-Automation ----------

  aiConfig(stationId: string): AiStationConfig {
    const c = this.rt(stationId).data.ai;
    return { ...DEFAULT_AI, ...c, text: { ...DEFAULT_AI.text, ...c?.text }, voice: { ...DEFAULT_AI.voice, ...c?.voice }, music: { ...DEFAULT_AI.music, ...c?.music } };
  }

  setAiConfig(p: Principal, stationId: string, input: Record<string, any>): AiStationConfig {
    const cur = this.aiConfig(stationId);
    const str = (v: unknown, max: number, d: string) => (typeof v === 'string' ? v.trim().slice(0, max) : d);
    const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
    const target = (t: any, d: any) => (t && typeof t === 'object' ? {
      providerId: str(t.providerId, 40, d?.providerId ?? ''), model: str(t.model, 120, d?.model ?? ''),
      ...(typeof t.temperature === 'number' ? { temperature: Math.max(0, Math.min(2, t.temperature)) } : {}),
      ...(typeof t.maxTokens === 'number' ? { maxTokens: int(t.maxTokens, 50, 8000, 600) } : d?.maxTokens ? { maxTokens: d.maxTokens } : {}),
    } : d);
    const voice = (t: any, d: any) => (t && typeof t === 'object' ? {
      providerId: str(t.providerId, 40, d?.providerId ?? ''), voice: str(t.voice, 300, d?.voice ?? ''), model: str(t.model, 120, d?.model ?? '') || undefined,
      ...(typeof t.speed === 'number' ? { speed: Math.max(0.5, Math.min(2, t.speed)) } : {}),
    } : d);
    const sources: AiSource[] = Array.isArray(input.sources) ? input.sources.slice(0, 12).map((s: any, i: number) => {
      const url = String(s.url ?? '').trim();
      if (!/^https?:\/\//.test(url)) throw new AppError(400, 'invalid_url', `Quelle ${i + 1}: URL muss mit http(s):// beginnen`);
      return { id: str(s.id, 40, '') || newId('ais'), name: str(s.name, 60, `Quelle ${i + 1}`), url, kind: ['rss', 'json', 'text'].includes(s.kind) ? s.kind : 'rss', use: ['news', 'weather', 'info'].includes(s.use) ? s.use : 'info' };
    }) : cur.sources;
    const next: AiStationConfig = {
      enabled: bool(input.enabled, cur.enabled),
      approval: bool(input.approval, cur.approval),
      everySongs: int(input.everySongs, 0, 20, cur.everySongs),
      topOfHourNews: bool(input.topOfHourNews, cur.topOfHourNews),
      language: str(input.language, 40, cur.language) || 'Deutsch',
      persona: str(input.persona, 400, cur.persona),
      style: str(input.style, 600, cur.style),
      maxWords: int(input.maxWords, 10, 300, cur.maxWords),
      sources,
      text: { ...target(input.text, cur.text), fallback: input.text && 'fallback' in input.text ? (input.text.fallback?.providerId ? target(input.text.fallback, undefined) : undefined) : cur.text.fallback },
      voice: { ...voice(input.voice, cur.voice), fallback: input.voice && 'fallback' in input.voice ? (input.voice.fallback?.providerId ? voice(input.voice.fallback, undefined) : undefined) : cur.voice.fallback },
      music: input.music && typeof input.music === 'object' ? {
        enabled: bool(input.music.enabled, cur.music.enabled), lookahead: int(input.music.lookahead, 1, 10, cur.music.lookahead),
        instructions: str(input.music.instructions, 600, cur.music.instructions), jingleEvery: int(input.music.jingleEvery, 0, 20, cur.music.jingleEvery),
      } : cur.music,
      keepGenerated: int(input.keepGenerated, 5, 500, cur.keepGenerated),
    };
    if (next.enabled && !next.text.providerId) throw new AppError(400, 'no_provider', 'Für die KI-Automation zuerst einen Text-Provider und ein Modell wählen');
    if (next.enabled && next.everySongs > 0 && !next.voice.providerId) throw new AppError(400, 'no_voice', 'Für Moderationen einen Sprach-Provider und eine Stimme wählen');
    this.rt(stationId).data.ai = next;
    this.audit.write({ kind: 'ai', event: 'config', actor: p.id, stationId, enabled: next.enabled, music: next.music.enabled, approval: next.approval });
    this.changed();
    return next;
  }

  /** KI-Sprachdatei als Medium ablegen (wird automatisch aufgeräumt). */
  addGeneratedMedia(stationId: string, audio: Buffer, ext: string, title: string, category: MediaItem['category'], generated = true): MediaItem {
    const id = newId('m');
    const file = `${id}.${ext === 'wav' ? 'wav' : 'mp3'}`;
    writeFileSync(join(this.mediaDir, stationId, file), audio);
    return this.addMedia(stationId, {
      id, title: title.slice(0, 200), artist: this.rt(stationId).station.name, category, file, durationMs: null, addedAt: Date.now(),
      folder: generated ? 'KI' : 'KI-Studio', ...(generated ? { generatedBy: 'ai' as const } : {}),
    });
  }

  /** KI-Werkzeug: Text erzeugen (Assistent, Spot-Texte, Sendungsplanung). */
  async aiText(stationId: string, prompt: string, system?: string): Promise<unknown> {
    const c = this.aiConfig(stationId);
    if (!prompt.trim()) throw new AppError(400, 'empty', 'Bitte eine Anweisung eingeben');
    try {
      const r = await this.ai.text(stationId, 'assistant', [c.text, c.text.fallback], system?.trim() || `Du bist der Redaktionsassistent des Radiosenders „${this.rt(stationId).station.name}“. Antworte auf ${c.language}.`, prompt.slice(0, 20_000), 90_000);
      return { text: r.text, providerId: r.providerId, model: r.model, cost: r.cost };
    } catch (err) {
      throw new AppError(502, 'ai_failed', (err as Error).message);
    }
  }

  /** KI-Werkzeug: Text vertonen und in die Bibliothek legen (Voice Studio, Spots, Jingles). */
  async aiSpeech(stationId: string, input: { text?: string; title?: string; category?: string; voice?: string; providerId?: string; model?: string }): Promise<MediaItem> {
    const c = this.aiConfig(stationId);
    const text = String(input.text ?? '').trim();
    if (!text) throw new AppError(400, 'empty', 'Kein Text');
    if (text.length > 5000) throw new AppError(413, 'too_long', 'Höchstens 5000 Zeichen');
    const target = input.providerId ? { providerId: input.providerId, voice: input.voice ?? '', model: input.model } : { ...c.voice, ...(input.voice ? { voice: input.voice } : {}) };
    try {
      const r = await this.ai.voice(stationId, 'voice_studio', [target, input.providerId ? undefined : c.voice.fallback], text, 120_000);
      const category = (MEDIA_CATEGORIES as readonly string[]).includes(String(input.category)) ? (input.category as MediaItem['category']) : 'tts';
      return this.addGeneratedMedia(stationId, r.audio, r.ext, input.title?.trim() || text.slice(0, 60), category, false);
    } catch (err) {
      throw new AppError(err instanceof AiError && err.code === 'no_voice' ? 400 : 502, 'ai_failed', (err as Error).message);
    }
  }

  // ---------- laut.fm ----------

  lautfmConfig(stationId: string): LautfmConfig & { origin: string; hasToken: boolean; loginUrl: string } {
    const cfg = this.rt(stationId).data.lautfm ?? {};
    const origin = cfg.origin ?? DEFAULT_ORIGIN;
    return { ...cfg, origin, hasToken: this.secrets.has(`lautfm:${stationId}`), loginUrl: loginUrl(origin) };
  }

  lautfmToken(stationId: string): string | undefined {
    return this.secrets.get(`lautfm:${stationId}`);
  }

  setLautfmConfig(p: Principal, stationId: string, input: Record<string, unknown>): unknown {
    const rt = this.rt(stationId);
    const cfg: LautfmConfig = { ...rt.data.lautfm };
    if (input.stationId !== undefined) {
      const n = Number(input.stationId);
      cfg.stationId = input.stationId === null || input.stationId === '' ? undefined : Number.isSafeInteger(n) && n > 0 ? n : cfg.stationId;
    }
    if (typeof input.origin === 'string') {
      const o = input.origin.trim();
      if (o && !ORIGIN_RE.test(o)) throw new AppError(400, 'invalid_origin', 'Callback/Origin: nur Buchstaben, Ziffern und . _ : / -');
      cfg.origin = o && o !== DEFAULT_ORIGIN ? o : undefined;
    }
    if (typeof input.stationName === 'string') cfg.stationName = input.stationName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || undefined;
    if (typeof input.token === 'string') {
      if (input.token) this.secrets.set(`lautfm:${stationId}`, input.token.trim());
      else this.secrets.delete(`lautfm:${stationId}`);
    }
    rt.data.lautfm = cfg;
    this.audit.write({ kind: 'lautfm', event: 'config', actor: p.id, stationId, token: typeof input.token === 'string' ? (input.token ? 'set' : 'removed') : 'unchanged' });
    this.changed();
    return this.lautfmConfig(stationId);
  }

  /** Radioadmin-Anfrage mit gespeichertem Token (serverseitig). */
  async radioadmin(stationId: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const token = this.lautfmToken(stationId);
    if (!token) throw new AppError(409, 'no_token', 'Kein laut.fm-Radioadmin-Token hinterlegt');
    const r = await fetch(RADIOADMIN + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, Origin: this.lautfmConfig(stationId).origin, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {
      throw new AppError(502, 'upstream_unreachable', 'laut.fm nicht erreichbar');
    });
    const text = await r.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Text-Antwort (z. B. Passwort)
    }
    return { status: r.status, data };
  }

  /**
   * Live-Zugang der laut.fm-Station als AirDeck-Ausgang übernehmen (Icecast-Source mit optionalem ?prio=).
   * Nutzt GET /stations/{id}/live und ggf. /live/password aus der Radioadmin-API.
   */
  async lautfmCreateOutput(p: Principal, stationId: string, priority?: number): Promise<unknown> {
    const cfg = this.lautfmConfig(stationId);
    if (!cfg.stationId) throw new AppError(409, 'no_station', 'Zuerst die laut.fm-Station wählen');
    const live = await this.radioadmin(stationId, 'GET', `/stations/${cfg.stationId}/live`);
    if (live.status !== 200 || typeof live.data !== 'object' || !live.data) throw new AppError(live.status === 403 ? 403 : 502, 'lautfm_error', `laut.fm antwortete ${live.status}`);
    const d = live.data as { protocol?: string; server?: string; port?: number; mountpoint?: string; user?: string; password?: string; bitrate?: number };
    let password = d.password;
    if (!password) {
      const pw = await this.radioadmin(stationId, 'GET', `/stations/${cfg.stationId}/live/password`);
      if (pw.status === 200 && typeof pw.data === 'string') password = pw.data;
    }
    if (!d.server || !d.mountpoint || !password) throw new AppError(502, 'lautfm_incomplete', 'laut.fm lieferte keine vollständigen Live-Zugangsdaten');
    return this.saveOutput(p, stationId, null, {
      name: `laut.fm ${cfg.stationName ?? cfg.stationId}`, type: 'icecast', host: d.server, port: d.port ?? (d.protocol === 'https' ? 443 : 80),
      tls: d.protocol === 'https', mount: d.mountpoint, username: d.user ?? 'source', password, priority, sourceTarget: '/live',
    });
  }

  // ---------- Cardwall ----------

  cardwall(stationId: string): CartSlot[] {
    return this.rt(stationId).data.cardwall;
  }

  updateCart(stationId: string, slotId: string, patch: Partial<CartSlot>): CartSlot {
    const slot = this.rt(stationId).data.cardwall.find((c) => c.id === slotId);
    if (!slot) throw new AppError(404, 'not_found', 'Cart nicht gefunden');
    if (typeof patch.label === 'string') slot.label = patch.label.slice(0, 40);
    if (typeof patch.group === 'string') slot.group = patch.group.slice(0, 40);
    if (patch.color !== undefined) slot.color = safeColor(patch.color, slot.color);
    if (patch.mediaId !== undefined) {
      if (patch.mediaId !== null) this.media(stationId, patch.mediaId);
      slot.mediaId = patch.mediaId;
    }
    this.publish('cardwall.changed', stationId, this.cardwall(stationId));
    this.changed();
    return slot;
  }

  triggerCart(stationId: string, slotId: string): CartSlot {
    const slot = this.rt(stationId).data.cardwall.find((c) => c.id === slotId);
    if (!slot) throw new AppError(404, 'not_found', 'Cart nicht gefunden');
    if (!slot.mediaId) throw new AppError(409, 'empty_cart', 'Cart ist leer');
    const po = this.playouts.get(stationId);
    if (po) {
      const m = this.media(stationId, slot.mediaId);
      po.playout.playCart(m, ['voice_track', 'tts', 'news', 'ad'].includes(m.category));
    }
    this.publish('cardwall.triggered', stationId, { ...slot, server: !!po });
    return slot;
  }

  // ---------- intern ----------

  private autoFill(rt: StationRuntime, force = false): void {
    if (!rt.data.autoFill && !force) return;
    // KI plant die Musik: Sendeuhr springt nur ein, wenn die Queue leer ist (Rückfall)
    const ai = rt.data.ai;
    if (!force && ai?.enabled && ai.music.enabled && rt.queue.length > 0) return;
    // Sendeplan: im aktiven Zeitfenster kommt die Musik aus der zugeordneten Playlist
    const plan = activeWindow(rt.data.plans ?? [], new Date());
    const pl = plan ? rt.data.playlists?.find((x) => x.id === plan.playlistId) : undefined;
    const items = pl?.items.filter((id) => rt.data.library.some((m) => m.id === id)) ?? [];
    if (plan && items.length) {
      const cursors = (rt.data.planCursor ??= {});
      let guard = rt.data.minQueue * 2;
      while (rt.queue.length < rt.data.minQueue && guard-- > 0) {
        let next: string;
        if (plan.shuffle) {
          const lib = rt.data.library.filter((m) => items.includes(m.id));
          next = (pickFromPool(lib.map((m) => ({ ...m, category: 'music' as const })), 'music', [...rt.queue.list().map((q) => q.mediaId).reverse(), ...rt.data.history], rt.data.rotation) ?? lib[0]!).id;
        } else {
          const c = (cursors[plan.id] ?? 0) % items.length;
          next = items[c]!;
          cursors[plan.id] = c + 1;
        }
        rt.queue.add(next, 'plan');
      }
      return;
    }
    rt.data.clockCursor = fillFromClock(rt.queue, rt.data.library, rt.data.clock, rt.data.history, rt.data.clockCursor, rt.data.minQueue, rt.data.rotation);
  }

  private publishQueue(stationId: string): void {
    this.publish('queue.changed', stationId, this.queueView(stationId));
    this.changed();
  }

  /** Datenbankbericht mit Live-Prüfung (Version, Antwortzeit, Schema) */
  async databaseReport(): Promise<unknown> {
    const base = this.health.database() as Record<string, unknown>;
    if (!(this.docs instanceof DbDocStore)) return base;
    const h = await this.docs.db.health();
    return { ...base, engine: h.engine, version: h.version, latencyMs: h.latencyMs, schema: SCHEMA_VERSION, ok: h.ok && base.state === 'READY', error: h.error ?? base.detail };
  }

  /** Zustand sofort speichern (z. B. vor manuellem Sync). */
  persistNow(): void {
    this.docs.touch('airdeck');
    this.docs.flushSync();
  }

  stateJson(): string {
    return JSON.stringify(this.snapshot(), null, 1);
  }

  private changed(): void {
    this.docs.touch('airdeck');
  }

  private snapshot(): PersistedState {
    const data: Record<string, StationData> = {};
    for (const [id, rt] of this.stations) data[id] = { ...rt.data, queue: rt.queue.list() };
    return {
      version: 1,
      stations: [...this.stations.values()].map((r) => r.station),
      sources: this.engine.exportConfig(),
      outputs: [...this.outputs.values()].map((o) => o.cfg),
      data,
    };
  }

  private rt(id: string): StationRuntime {
    const rt = this.stations.get(id);
    if (!rt) throw new AppError(404, 'not_found', 'Sender nicht gefunden');
    return rt;
  }

  private sourceOf(stationId: string, id: string): SourceConfig {
    const s = this.engine.get(id);
    if (!s || s.stationId !== stationId) throw new AppError(404, 'not_found', 'Quelle nicht gefunden');
    return s;
  }

  private outputOf(stationId: string, id: string): BroadcastOutput {
    const o = this.outputs.get(id);
    if (!o || o.cfg.stationId !== stationId) throw new AppError(404, 'not_found', 'Ausgang nicht gefunden');
    return o;
  }
}

// ---------- Hilfsfunktionen ----------

const SYSTEM_PRINCIPAL: Principal = { id: 'system', tokenId: 'system', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };

export function canSee(p: Principal, stationId: string): boolean {
  return p.stationIds.includes('*') || p.stationIds.includes(stationId);
}

function relayKey(stationId: string, target: string): string {
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

function posInt(v: unknown): number | undefined {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function safeColor(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!;
  return diff === 0;
}

function wrap<T>(fn: () => T): T {
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

function publicSource<T extends SourceConfig>(s: T, secrets: SecretStore): Omit<T, 'credentialRef'> & { hasPassword: boolean } {
  const { credentialRef, ...rest } = s;
  return { ...rest, hasPassword: !!credentialRef && secrets.has(credentialRef) };
}

function publicOutput(o: BroadcastOutput, secrets: SecretStore): Record<string, unknown> {
  const { passwordRef, ...cfg } = o.cfg;
  return { ...cfg, hasPassword: secrets.has(passwordRef), state: { ...o.state } };
}
