// AirDeck Server-Zustand: Sender, Quellen, Relay, Ausgänge, Medien, Queue, Cardwall.
// Keine Abhängigkeit zu AnMaCha oder anderen externen Diensten.

import { createHash, randomBytes } from 'node:crypto';
import { cpus, freemem, totalmem, uptime as osUptime } from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createWriteStream, mkdirSync, rmSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
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
} from '../core/automation.ts';
import { AuditLog, DebouncedJson, readJson, writeFileAtomic } from './store.ts';
import { SecretStore } from './secrets.ts';
import { IcecastOutput, type BroadcastOutput, type OutputConfig, type OutputState } from './icecast.ts';
import { ShoutcastOutput } from './shoutcast.ts';
import { fetchListeners } from './stats.ts';
import { RelayTarget } from './relay.ts';
import { detectFfmpeg, inputDeviceArgs, listInputDevices, probeMedia, type FfmpegInfo } from './ffmpeg.ts';
import { DEFAULT_PLAYOUT, EQ_BANDS, Playout, type PlayoutOptions } from './playout.ts';
import {
  activeWindow, clockDue, dueJobs, nextOccurrence, parseM3U, toM3U, validateClock, validateWindow,
  type ClockEvent, type JobTarget, type ProgramPlan, type RecordingPlan, type Repeat, type ScheduledJob,
} from '../core/scheduler.ts';
import { pickNext as pickFromPool } from '../core/automation.ts';
import type { RelayTap } from './relay.ts';
import { RADIOADMIN, type LautfmConfig } from './lautfm.ts';
import { NOTIFY_EVENTS, Notifier, validateExportPath, validateWebhookUrl, type IntegrationsConfig, type NotifyEvent } from './notify.ts';

export interface Station {
  id: string;
  name: string;
  slogan: string;
  primaryColor: string;
  accentColor: string;
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
  'lautfm:read', 'lautfm:write',
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
  readonly ffmpeg: FfmpegInfo | null;
  private tickCount = 0;
  private lastSchedAt = Date.now();
  private readonly activePlanId = new Map<string, string | null>();
  private readonly recorders = new Map<string, ActiveRecording>();
  private readonly notifier: Notifier;
  private readonly lastOutStatus = new Map<string, string>();
  private readonly subscribers = new Set<(e: HubEvent) => void>();
  private readonly persist: DebouncedJson<PersistedState>;
  private tokens: ApiToken[];
  private readonly tokensFile: string;
  private tickTimer: NodeJS.Timeout | null = null;
  private levelTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string, opts: { stableMs?: number; cooldownMs?: number; appRoot?: string; ffmpeg?: FfmpegInfo | null } = {}) {
    this.dataDir = dataDir;
    this.ffmpeg = opts.ffmpeg !== undefined ? opts.ffmpeg : detectFfmpeg(opts.appRoot ?? process.cwd());
    this.mediaDir = join(dataDir, 'media');
    mkdirSync(this.mediaDir, { recursive: true });
    this.secrets = new SecretStore(dataDir);
    this.audit = new AuditLog(join(dataDir, 'audit.log'));
    this.tokensFile = join(dataDir, 'tokens.json');
    this.tokens = readJson<ApiToken[]>(this.tokensFile, []);
    this.notifier = new Notifier((ref) => this.secrets.get(ref), (event, data) => this.audit.write({ kind: 'notify', event, ...data }));

    const file = join(dataDir, 'airdeck.json');
    const state = readJson<PersistedState | null>(file, null);
    // Neustart: Quellen starten getrennt und müssen sich neu verbinden (keine konkurrierenden Aktiven).
    this.engine = SourcePriorityEngine.restore(state?.sources ?? [], {
      stableMs: opts.stableMs ?? 2000,
      cooldownMs: opts.cooldownMs ?? 0,
    });
    this.engine.on((e) => this.onEngineEvent(e));
    this.persist = new DebouncedJson(file, () => this.snapshot());

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
    // 24/7: Playouts, die vor dem Neustart liefen, automatisch wieder starten
    for (const [id, rt] of this.stations) {
      if (!rt.data.playout?.autostart) continue;
      try {
        this.startPlayout(SYSTEM_PRINCIPAL, id, {});
      } catch (err) {
        this.audit.write({ kind: 'playout', event: 'autostart_failed', stationId: id, message: (err as Error).message });
      }
    }
  }

  shutdown(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.levelTimer) clearInterval(this.levelTimer);
    for (const { playout } of this.playouts.values()) playout.stop();
    this.playouts.clear();
    for (const id of [...this.recorders.keys()]) this.stopRecording(id);
    for (const o of this.outputs.values()) o.stop();
    this.persist.flush();
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
    writeFileAtomic(this.tokensFile, JSON.stringify(this.tokens, null, 1), 0o600);
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
    writeFileAtomic(this.tokensFile, JSON.stringify(this.tokens, null, 1), 0o600);
  }

  authenticate(token: string | undefined): Principal | null {
    if (!token) return null;
    const h = hashToken(token);
    const t = this.tokens.find((x) => x.hash === h);
    if (!t) return null;
    return { id: t.id, tokenId: t.id, roles: t.roles, stationIds: t.stationIds, scopes: t.scopes };
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
    this.publish('station.changed', id, s);
    this.changed();
    return s;
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
    return item;
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

  // ---------- laut.fm ----------

  lautfmConfig(stationId: string): LautfmConfig & { hasToken: boolean } {
    const cfg = this.rt(stationId).data.lautfm ?? {};
    return { ...cfg, hasToken: this.secrets.has(`lautfm:${stationId}`) };
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
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
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

  private changed(): void {
    this.persist.schedule();
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
