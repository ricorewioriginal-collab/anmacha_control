// AirDeck Server-Zustand: Sender, Quellen, Relay, Ausgänge, Medien, Queue, Cardwall.
// Keine Abhängigkeit zu AnMaCha oder anderen externen Diensten.

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
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
} from '../core/automation.ts';
import { AuditLog, DebouncedJson, readJson, writeFileAtomic } from './store.ts';
import { SecretStore } from './secrets.ts';
import { IcecastOutput, type OutputConfig, type OutputState } from './icecast.ts';
import { RelayTarget } from './relay.ts';

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
  private readonly outputs = new Map<string, IcecastOutput>();
  private readonly relays = new Map<string, RelayTarget>();
  private readonly subscribers = new Set<(e: HubEvent) => void>();
  private readonly persist: DebouncedJson<PersistedState>;
  private tokens: ApiToken[];
  private readonly tokensFile: string;
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string, opts: { stableMs?: number; cooldownMs?: number } = {}) {
    this.dataDir = dataDir;
    this.mediaDir = join(dataDir, 'media');
    mkdirSync(this.mediaDir, { recursive: true });
    this.secrets = new SecretStore(dataDir);
    this.audit = new AuditLog(join(dataDir, 'audit.log'));
    this.tokensFile = join(dataDir, 'tokens.json');
    this.tokens = readJson<ApiToken[]>(this.tokensFile, []);

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
  }

  shutdown(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
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
      clockCursor: data?.clockCursor ?? 0,
      autoFill: data?.autoFill ?? true,
      minQueue: data?.minQueue ?? 8,
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

  private mountOutput(cfg: OutputConfig): IcecastOutput {
    this.outputs.get(cfg.id)?.stop();
    const o = new IcecastOutput(cfg, () => this.secrets.get(cfg.passwordRef), (s: OutputState) => this.publish('stream.state_changed', cfg.stationId, { id: cfg.id, ...s }));
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
    return join(this.mediaDir, stationId, m.file);
  }

  addMedia(stationId: string, item: MediaItem): MediaItem {
    const rt = this.rt(stationId);
    rt.data.library.push(item);
    this.publish('library.changed', stationId, { added: item });
    this.changed();
    return item;
  }

  updateMedia(stationId: string, id: string, patch: Record<string, unknown>): MediaItem {
    const m = this.media(stationId, id);
    if (typeof patch.title === 'string') m.title = patch.title.slice(0, 200);
    if (typeof patch.artist === 'string') m.artist = patch.artist.slice(0, 200);
    if (typeof patch.category === 'string') m.category = patch.category as MediaItem['category'];
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
    rmSync(this.mediaPath(stationId, m), { force: true });
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
    this.publish('cardwall.triggered', stationId, slot);
    return slot;
  }

  // ---------- intern ----------

  private autoFill(rt: StationRuntime, force = false): void {
    if (!rt.data.autoFill && !force) return;
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

  private outputOf(stationId: string, id: string): IcecastOutput {
    const o = this.outputs.get(id);
    if (!o || o.cfg.stationId !== stationId) throw new AppError(404, 'not_found', 'Ausgang nicht gefunden');
    return o;
  }
}

// ---------- Hilfsfunktionen ----------

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

function publicOutput(o: IcecastOutput, secrets: SecretStore): Record<string, unknown> {
  const { passwordRef, ...cfg } = o.cfg;
  return { ...cfg, hasPassword: secrets.has(passwordRef), state: { ...o.state } };
}
