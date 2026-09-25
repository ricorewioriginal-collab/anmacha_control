// AirDeck-Kern: Sender-Laufzeit, Quellen (Source Priority), Relay/Ingest, Ausgänge, Queue, Decks, Server-Playout,
// Cardwall sowie Takt, Ereignisse und Datenhaltung. Alle übrigen Fachgebiete liegen als Dienste unter services/
// und werden über `app.svc.<dienst>` angesprochen. Keine Abhängigkeit zu AnMaCha oder anderen externen Diensten.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SourcePriorityEngine, type EngineEvent, type SourceConfig } from '../core/source-priority.ts';
import {
  DECK_IDS, DEFAULT_CLOCK, DEFAULT_ROTATION, MEDIA_CATEGORIES, PlayQueue, backtime, defaultCardwall, fillFromClock, pickNext as pickFromPool, playLength,
  type CartSlot, type ClockTemplate, type DeckId, type DeckState, type MediaItem,
} from '../core/automation.ts';
import { activeWindow } from '../core/scheduler.ts';
import { ModeState, automationRuns, type BaseMode, type Mode as BroadcastMode } from '../core/mode.ts';
import {
  AppError, SYSTEM_PRINCIPAL, newId, normalizeMount, posInt, publicOutput, publicSource, relayKey, safeColor, timingSafeEqualStr, wrap,
  type HubEvent, type NowPlaying, type PersistedState, type PlayLogEntry, type PlayoutConfig, type Principal, type Station, type StationData, type StationRuntime,
} from './model.ts';
import { AuditLog } from './store.ts';
import { DbDocStore, importJsonFilesSync, type DocStore } from './repo/docs.ts';
import { openSqliteSync } from './db/index.ts';
import { SCHEMA_VERSION } from './db/schema.ts';
import { SecretStore } from './secrets.ts';
import { IcecastOutput, type BroadcastOutput, type OutputConfig, type OutputState } from './icecast.ts';
import { ShoutcastOutput } from './shoutcast.ts';
import { fetchListeners } from './stats.ts';
import { RelayTarget } from './relay.ts';
import { detectFfmpeg, detectFfmpegAsync, inputDeviceArgs, listInputDevices, type FfmpegInfo } from './ffmpeg.ts';
import { DEFAULT_PLAYOUT, DSP_PRESETS, DeckError, EQ_BANDS, Playout } from './playout.ts';
import { SyncManager } from './sync.ts';
import { appVersion, type AirDeckConfig, type Mode } from './config.ts';
import { HealthManager } from './health.ts';
import { Updater } from './update.ts';
import { AiService } from './ai/service.ts';
import { AiDirector } from './ai/director.ts';
import { UserStore } from './users.ts';
import { Notifier } from './notify.ts';
import { createServices, type Services } from './services/index.ts';

// Bisherige Importe aus app.ts bleiben gültig
export * from './model.ts';

export class AirDeckApp {
  /** Dienstmodule (services/) */
  readonly svc: Services;
  readonly dataDir: string;
  readonly mediaDir: string;
  readonly engine: SourcePriorityEngine;
  readonly secrets: SecretStore;
  readonly audit: AuditLog;
  readonly stations = new Map<string, StationRuntime>();
  readonly outputs = new Map<string, BroadcastOutput>();
  readonly relays = new Map<string, RelayTarget>();
  /** Sendebus je Sender; forLive = nur für eine Live-Sendung gestartet (endet mit ihr) */
  readonly playouts = new Map<string, { playout: Playout; source: SourceConfig; forLive?: boolean }>();
  /** Mode-Manager je Sender */
  readonly modes = new Map<string, ModeState>();
  /** Quelle, die wegen Stille als ungesund markiert wurde (je Sender) */
  readonly silenced = new Map<string, string>();
  /** kann sich im Betrieb ändern: fehlgeschlagene Erkennung wird im Hintergrund wiederholt */
  ffmpeg: FfmpegInfo | null;
  readonly health: HealthManager;
  readonly mode: Mode;
  readonly version: string;
  readonly paths: AirDeckConfig['paths'];
  /** Vollständige Konfiguration (airdeck.conf), null in Tests/Hilfsinstanzen ohne Datei */
  readonly config: AirDeckConfig | null;
  ffmpegRetry: NodeJS.Timeout | null = null;
  tickCount = 0;
  readonly notifier: Notifier;
  readonly subscribers = new Set<(e: HubEvent) => void>();
  /** Datenhaltung: Datenbank (Standard SQLite im Datenordner) */
  readonly docs: DocStore;
  /** von der App selbst geöffnete Datenbank (wird beim Beenden geschlossen) */
  readonly ownDb: { close(): Promise<void> } | null;
  tickTimer: NodeJS.Timeout | null = null;
  levelTimer: NodeJS.Timeout | null = null;

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
  /** Vom Einstiegspunkt gesetzt: neu starten (nach Änderungen an Betriebsart, Datenbank, Netzwerk, Pfaden) */
  requestRestart: (() => void) | null = null;
  listenPort = 8750;

  constructor(dataDir: string, opts: { stableMs?: number; cooldownMs?: number; appRoot?: string; ffmpeg?: FfmpegInfo | null; secrets?: SecretStore; sync?: SyncManager; build?: string; packaged?: boolean; headless?: boolean; config?: AirDeckConfig; ffmpegRetryS?: number[]; docs?: DocStore } = {}) {
    this.dataDir = dataDir;
    this.svc = createServices(this);
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
    this.config = opts.config ?? null;
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
      addGenerated: (id, audio, ext, title, category) => this.svc.ai.addGeneratedMedia(id, audio, ext, title, category),
      remove: (id, mediaId) => {
        if (this.rt(id).data.library.some((m) => m.id === mediaId)) this.svc.media.removeMedia(id, mediaId);
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
    }, this.ai, (id) => this.svc.ai.aiConfig(id));
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
    if (this.stations.size === 0) this.svc.stations.createStation({ id: 'main', name: 'AirDeck Radio' }, true);
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
    this.svc.bridges.startBridges();
    this.autostartPlayouts();
    if (!this.ffmpeg && !this.ffmpegDisabled) this.scheduleFfmpegRetry(0);
  }

  /** false, wenn Tests bzw. Hilfsinstanzen ffmpeg ausdrücklich abgeschaltet haben */
  ffmpegDisabled = false;
  ffmpegRetryS = [10, 30, 60, 120, 300];

  /** ffmpeg-Erkennung ist beim Start fehlgeschlagen (z. B. Zeitüberschreitung unter Last): im Hintergrund erneut suchen. */
  scheduleFfmpegRetry(attempt: number): void {
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
  autostartPlayouts(): void {
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
    this.stopping = true;
    if (this.ffmpegRetry) clearTimeout(this.ffmpegRetry);
    this.ai.flush();
    this.users.flush();
    for (const r of this.svc.bridges.pulls.values()) r.stop();
    this.svc.bridges.pulls.clear();
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.levelTimer) clearInterval(this.levelTimer);
    for (const { playout } of this.playouts.values()) playout.stop();
    this.playouts.clear();
    for (const id of [...this.svc.recorder.recorders.keys()]) this.svc.recorder.stopRecording(id);
    for (const o of this.outputs.values()) o.stop();
    this.persistNow();
    void this.ownDb?.close();
  }

  // ---------- Rechte ----------

  static hasScope(p: Principal, scope: string): boolean {
    return p.scopes.includes('*') || p.scopes.includes(scope);
  }

  // ---------- Events ----------

  subscribe(fn: (e: HubEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  publish(type: string, stationId: string | undefined, payload: unknown): void {
    if (stationId) this.svc.notifications.notifyFrom(type, stationId, payload);
    const e = { type, stationId, payload };
    for (const s of this.subscribers) {
      try {
        s(e);
      } catch {
        // defekte Subscriber ignorieren
      }
    }
  }

  onEngineEvent(e: EngineEvent): void {
    if (e.type !== 'SOURCE_HEALTH_CHANGED' || e.data?.healthy === false) {
      this.audit.write({ kind: 'source', ...e });
    }
    if (e.type === 'TAKEOVER_COMPLETED' || e.type === 'OFF_AIR') this.applyProgram(e.stationId, e.target, e.type.toLowerCase());
    this.publish('source.' + e.type.toLowerCase(), e.stationId, e);
    this.publish('sources.changed', e.stationId, this.engine.list(e.stationId));
  }

  tick(): void {
    this.engine.tick();
    try {
      this.svc.planning.processSchedules();
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
    // Eingebundene Musikordner jede Minute abgleichen (asynchron, nie parallel)
    if (this.tickCount % 120 === 60) void this.svc.media.scanLinked();
    // Status-Spiegel der Brücken (je Anbindung höchstens alle 15 s)
    if (this.tickCount % 30 === 0) this.svc.bridges.tickBridges();
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

  mountStation(station: Station, data?: StationData): StationRuntime {
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
    // Neue Verbindung einer zuvor wegen Stille abgeschalteten Live-Quelle: wieder zulassen
    if (this.silenced.get(src.stationId) === src.id && this.busOf(src)?.source.id !== src.id) {
      this.silenced.delete(src.stationId);
      this.engine.setHealth(src.id, true);
    }
    this.busOf(src)?.playout.liveOpen(src.id, contentType);
    try {
      this.engine.connect(src.id, { id: `ingest:${src.id}`, roles: ['admin'], stationIds: [src.stationId] });
    } catch (err) {
      relay.close(src.id);
      this.busOf(src)?.playout.liveClose(src.id);
      throw err;
    }
  }

  ingestData(src: SourceConfig, chunk: Buffer): void {
    this.relayFor(src.stationId, src.target).data(src.id, chunk);
    this.busOf(src)?.playout.liveData(src.id, chunk);
  }

  ingestClose(src: SourceConfig): void {
    this.busOf(src)?.playout.liveClose(src.id);
    this.relayFor(src.stationId, src.target).close(src.id);
    if (this.engine.get(src.id)) this.engine.disconnect(src.id);
  }

  /** Sendebus, der eine Live-Quelle aufnimmt (gleiches Target, nicht die eigene Automation-Quelle) */
  busOf(src: SourceConfig): { playout: Playout; source: SourceConfig; forLive?: boolean } | undefined {
    const po = this.playouts.get(src.stationId);
    return po && po.source.id !== src.id && po.source.target === src.target ? po : undefined;
  }

  // ---------- Programm und Mode-Manager ----------

  /** Mode-Manager des Senders (angelegt beim ersten Zugriff mit der gespeicherten Grundbetriebsart). */
  modeOf(stationId: string): ModeState {
    let m = this.modes.get(stationId);
    if (!m) {
      m = new ModeState(this.rt(stationId).data.mode ?? 'AUTO', (c) => {
        this.playouts.get(stationId)?.playout.setAutomation(automationRuns(c.to));
        this.audit.write({ kind: 'mode', event: 'changed', stationId, from: c.from, to: c.to, base: c.base, reason: c.reason });
        this.publish('MODE_CHANGED', stationId, { mode: c.to, from: c.from, base: c.base, reason: c.reason });
        if (c.to === 'LIVE') this.sendLiveMetadata(stationId);
      });
      this.modes.set(stationId, m);
    }
    return m;
  }

  modeView(stationId: string): { mode: BroadcastMode; base: BaseMode; program: string | null; bus: boolean; live: string | null } {
    const m = this.modeOf(stationId);
    const po = this.playouts.get(stationId);
    const program = po?.playout.status().program ?? null;
    return { mode: m.mode, base: m.base, program, bus: !!po, live: program ? this.engine.get(program)?.name ?? program : null };
  }

  /** Grundbetriebsart setzen (Operator): AUTO = Automation läuft, MANUAL = Automation pausiert. */
  setBaseMode(p: Principal, stationId: string, base: string): unknown {
    if (base !== 'AUTO' && base !== 'MANUAL') throw new AppError(400, 'invalid_mode', 'Betriebsart AUTO oder MANUAL');
    const rt = this.rt(stationId);
    rt.data.mode = base;
    this.modeOf(stationId).update({ base }, `operator:${p.id}`);
    this.changed();
    return this.modeView(stationId);
  }

  /** MANUAL/AUTO: Titel sofort auf Sendung (über den Sendebus). */
  playNow(p: Principal, stationId: string, mediaId: string): unknown {
    const po = this.playouts.get(stationId);
    if (!po) throw new AppError(409, 'not_running', 'Der Sendebus läuft nicht – zuerst Automation/Senden starten');
    if (this.modeOf(stationId).mode === 'LIVE') throw new AppError(409, 'live_on_air', 'Live-Quelle ist auf Sendung – für Einspieler die Cartwall nutzen');
    const m = this.svc.media.media(stationId, mediaId);
    po.playout.playNow(m);
    this.audit.write({ kind: 'mode', event: 'play_now', actor: p.id, stationId, mediaId });
    return this.modeView(stationId);
  }

  /**
   * Welche Quelle ist hörbar? Läuft der Sendebus, hören die Ausgänge immer den Bus (festes Format) und der Mixer
   * blendet auf die laut Source Priority aktive Quelle über. Ohne Bus (kein ffmpeg) wird wie bisher der Strom der
   * aktiven Quelle unverändert weitergegeben.
   */
  applyProgram(stationId: string, target: string, reason: string): void {
    const relay = this.relayFor(stationId, target);
    const active = this.engine.activeFor(stationId, target);
    const po = this.playouts.get(stationId);
    const mode = this.modes.has(stationId) || this.stations.has(stationId) ? this.modeOf(stationId) : null;
    if (po && po.source.target === target) {
      if (relay.hasSession(po.source.id)) relay.setActive(po.source.id);
      const live = active && active.id !== po.source.id ? active : null;
      // Live-Quelle ohne Kanal (verband sich vor dem Start des Busses): Kanal aus der Relay-Sitzung nachziehen
      if (live && !po.playout.hasLive(live.id)) {
        const sess = relay.sessionInfo(live.id);
        if (sess) po.playout.liveOpen(live.id, sess.contentType, sess.init);
      }
      po.playout.setProgram(live && po.playout.hasLive(live.id) ? live.id : null);
      const autoOk = active?.id === po.source.id || (!!this.engine.get(po.source.id)?.healthy && !active);
      mode?.update({ liveOnAir: !!live, emergency: !live && (!autoOk || this.rt(stationId).emergencyPlaying === true) }, reason);
      // nur für eine Live-Sendung gestartet: endet mit ihr
      if (po.forLive && !live) setImmediate(() => this.stopBusForLive(stationId));
      return;
    }
    // Live-Quelle auf Sendung, aber kein Bus: Bus automatisch starten, damit das Format fest bleibt
    if (active && this.canStartBusForLive(stationId, target)) {
      relay.setActive(null);
      setImmediate(() => this.startBusForLive(stationId, target));
      return;
    }
    relay.setActive(active?.id ?? null);
    mode?.update({ liveOnAir: !!active && active.type !== 'automation', emergency: false }, reason);
  }

  /** Quellentypen, die als Live-Sendung gelten (Automation/Backup/Notfall sind keine) */
  static readonly LIVE_TYPES = new Set<string>(['live_studio', 'remote_studio', 'mobile', 'relay', 'url_stream']);
  private busStoppedAt = new Map<string, number>();
  private stopping = false;

  private canStartBusForLive(stationId: string, target: string): boolean {
    if (this.stopping || !this.ffmpeg || !this.ffmpeg.encoders.mp3 || this.playouts.has(stationId)) return false;
    const active = this.engine.activeFor(stationId, target);
    // nur echte Live-Quellen mit tatsächlichem Audiostrom
    if (!active || !AirDeckApp.LIVE_TYPES.has(active.type) || !this.relayFor(stationId, target).hasSession(active.id)) return false;
    // Schutz vor Start/Stopp-Wechselspiel
    if (Date.now() - (this.busStoppedAt.get(stationId) ?? 0) < 5000) return false;
    const auto = this.engine.list(stationId).find((s) => s.type === 'automation' && s.target === target);
    // Browser-Automation sendet gerade selbst: nicht dazwischengehen (bisheriger Weg)
    return !!auto && auto.state === 'disconnected';
  }

  private startBusForLive(stationId: string, target: string): void {
    if (this.stopping || this.playouts.has(stationId) || !this.stations.has(stationId)) return;
    const active = this.engine.activeFor(stationId, target);
    if (!active || !AirDeckApp.LIVE_TYPES.has(active.type)) return;
    try {
      this.startPlayout(SYSTEM_PRINCIPAL, stationId, {}, { forLive: true });
      this.audit.write({ kind: 'mode', event: 'bus_started_for_live', stationId, sourceId: active.id });
    } catch (err) {
      this.audit.write({ kind: 'mode', event: 'bus_start_failed', stationId, message: (err as Error).message });
      this.relayFor(stationId, target).setActive(active.id);
    }
  }

  private stopBusForLive(stationId: string): void {
    const po = this.playouts.get(stationId);
    if (!po?.forLive) return;
    const active = this.engine.activeFor(stationId, po.source.target);
    if (active && active.id !== po.source.id) return;
    this.playouts.delete(stationId);
    this.busStoppedAt.set(stationId, Date.now());
    po.playout.stop();
    this.audit.write({ kind: 'mode', event: 'bus_stopped_after_live', stationId });
    this.applyProgram(stationId, po.source.target, 'live_ended');
  }

  /** Titelanzeige während LIVE: „Live: <Quelle>“ */
  private sendLiveMetadata(stationId: string): void {
    const po = this.playouts.get(stationId);
    const program = po?.playout.status().program;
    const src = program ? this.engine.get(program) : undefined;
    const song = `Live: ${src?.name ?? this.rt(stationId).station.name}`;
    for (const o of this.outputs.values()) if (o.cfg.stationId === stationId) o.updateMetadata(song);
    this.publish('now_playing.live', stationId, { source: src?.name ?? null, title: song });
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
      this.busOf(src)?.playout.liveClose(id);
      relay.close(id);
      this.engine.disconnect(id);
      relay.open(id, contentType);
      if (this.silenced.get(stationId) === id) {
        this.silenced.delete(stationId);
        this.engine.setHealth(id, true);
      }
      this.busOf(src)?.playout.liveOpen(id, contentType);
      wrap(() => this.engine.connect(id, p));
    } else if (['disconnected', 'failed'].includes(this.engine.get(id)!.state) && this.engine.get(id)!.healthy) {
      // Nach Erholung (z. B. Stille vorbei) wieder anmelden, Header der Sitzung bleibt erhalten.
      wrap(() => this.engine.connect(id, p));
    }
    relay.data(id, chunk);
    this.busOf(src)?.playout.liveData(id, chunk);
  }

  addListener(stationId: string, mount: string, res: import('node:http').ServerResponse): boolean {
    return this.relayFor(stationId, normalizeMount(mount)).addListener(res);
  }

  relayFor(stationId: string, target: string): RelayTarget {
    const key = relayKey(stationId, target);
    let r = this.relays.get(key);
    if (!r) {
      r = new RelayTarget(() => [...this.outputs.values()].filter((o) => o.cfg.stationId === stationId && o.cfg.sourceTarget === target && o.cfg.enabled));
      this.relays.set(key, r);
    }
    return r;
  }

  // ---------- Ausgänge ----------

  mountOutput(cfg: OutputConfig): BroadcastOutput {
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

  // ---------- Queue / Automation / Decks ----------

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
    this.svc.media.media(stationId, mediaId);
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
    const m = this.svc.media.media(stationId, mediaId);
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
      if (patch.mediaId !== null) this.svc.media.media(stationId, patch.mediaId);
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

  /**
   * Deck bedienen (Engine auf dem Server ist maßgeblich, das Studio ist Fernbedienung).
   * Läuft die Engine noch nicht, wird sie gestartet – in MANUAL spielt danach nichts von selbst.
   */
  deckAction(p: Principal, stationId: string, deckId: string, action: string, body: Record<string, unknown>): unknown {
    if (!(DECK_IDS as readonly string[]).includes(deckId)) throw new AppError(404, 'not_found', 'Deck nicht gefunden');
    if (!['load', 'play', 'pause', 'stop', 'eject', 'seek'].includes(action)) throw new AppError(404, 'not_found', 'Unbekannte Deck-Aktion');
    let po = this.playouts.get(stationId);
    if (!po && (action === 'load' || action === 'play')) {
      this.startPlayout(p, stationId, {});
      po = this.playouts.get(stationId);
    }
    if (!po) return this.playoutView(stationId);
    const e = po.playout;
    try {
      if (action === 'load') e.deckLoad(deckId, this.svc.media.media(stationId, String(body.mediaId ?? '')));
      else if (action === 'play') {
        if (this.modeOf(stationId).mode === 'LIVE' && (deckId === 'A' || deckId === 'B')) throw new DeckError('Live-Quelle ist auf Sendung – für Einspieler Deck C/D oder die Cartwall nutzen');
        if (typeof body.mediaId === 'string') e.deckLoad(deckId, this.svc.media.media(stationId, body.mediaId));
        e.deckPlay(deckId);
      } else if (action === 'pause') e.deckPause(deckId);
      else if (action === 'stop') e.deckStop(deckId);
      else if (action === 'eject') e.deckEject(deckId);
      else e.deckSeek(deckId, Number(body.ms) || 0);
    } catch (err) {
      if (err instanceof DeckError) throw new AppError(409, 'deck', err.message);
      throw err;
    }
    this.audit.write({ kind: 'deck', event: action, actor: p.id, stationId, deck: deckId });
    const st = e.status();
    this.publish('playout.state', stationId, st);
    return st;
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

  startPlayout(p: Principal, stationId: string, input: Partial<PlayoutConfig>, opts: { forLive?: boolean } = {}): unknown {
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
      nextTrack: () => {
        const regular = this.queueNext(stationId);
        const rtNow = this.rt(stationId);
        const m = regular ?? this.emergencyPick(stationId);
        const was = rtNow.emergencyPlaying === true;
        rtNow.emergencyPlaying = !regular && !!m;
        if (was !== rtNow.emergencyPlaying) this.applyProgram(stationId, source.target, rtNow.emergencyPlaying ? 'emergency_material' : 'regular_material');
        return m;
      },
      mediaPath: (m) => this.svc.media.mediaPath(stationId, m),
      onNowPlaying: (m, deck) => this.setNowPlaying(stationId, m.id, deck),
      onStreamStart: (type) => {
        try {
          this.relayFor(stationId, source.target).close(source.id);
          // nur für eine Live-Sendung: Bus-Sitzung im Relay, aber keine Anmeldung als Automation-Quelle
          if (opts.forLive) this.relayFor(stationId, source.target).open(source.id, type);
          else this.ingestOpen(source, type);
        } catch (err) {
          this.audit.write({ kind: 'playout', event: 'source_rejected', stationId, message: (err as Error).message });
        }
        // Ausgänge hören ab jetzt den Bus; bereits verbundene Live-Quellen werden übernommen
        this.applyProgram(stationId, source.target, 'bus_started');
      },
      onStreamData: (chunk) => this.ingestData(source, chunk),
      onStreamStop: () => (opts.forLive ? this.relayFor(stationId, source.target).close(source.id) : this.ingestClose(source)),
      onSilence: (silent) => {
        if (!silent) this.publish('playout.log', stationId, { event: 'silence_recovered' });
        // Stille auf dem Programm → die Quelle auf Sendung gilt als ungesund → Fallback nach Priorität
        // (Live-Quelle → Automation; Automation → Backup-Quelle bzw. Notfall). Bei Erholung wieder anmelden.
        if (silent) {
          const program = this.playouts.get(stationId)?.playout.status().program ?? source.id;
          // Manuell: Stille ist Sache der Moderation (Deck gestoppt, Pause) – melden, aber nichts übernehmen
          if (program === source.id && this.modeOf(stationId).base === 'MANUAL') {
            this.publish('playout.log', stationId, { event: 'silence_manual' });
            return;
          }
          this.silenced.set(stationId, program);
          this.engine.setHealth(program, false, 'silence');
          return;
        }
        // Eine stille Live-Quelle bleibt abgeschaltet, bis sie neu verbindet (sonst Wechselspiel alle paar Sekunden)
        const was = this.silenced.get(stationId);
        if (was && was !== source.id) return;
        this.silenced.delete(stationId);
        this.engine.setHealth(source.id, true);
        if (this.engine.get(source.id)?.state === 'disconnected' && this.relayFor(stationId, source.target).hasSession(source.id)) {
          try {
            this.engine.connect(source.id);
          } catch {
            // gesperrt o. ä. – bleibt getrennt
          }
        }
        this.applyProgram(stationId, source.target, 'silence_recovered');
      },
      log: (event, data) => {
        this.audit.write({ kind: 'playout', event, stationId, ...data });
        this.publish('playout.log', stationId, { event, ...data });
      },
    }, cfg, { ffplay: this.ffmpeg.ffplay, inputArgs: inputDeviceArgs });
    this.playouts.set(stationId, { playout, source, forLive: opts.forLive });
    playout.setAutomation(automationRuns(this.modeOf(stationId).mode));
    playout.start();
    // nur für eine Live-Sendung gestartet: Autostart-Einstellung nicht verändern
    if (!opts.forLive) rt.data.playout = { ...cfg, autostart: input.autostart ?? true };
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
      this.silenced.delete(stationId);
      this.applyProgram(stationId, po.source.target, 'bus_stopped');
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
    this.svc.planning.executeTarget(stationId, { kind: 'media', mediaId: m.id, mode: md, label: m.title }, 'quick');
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
  emergencyPick(stationId: string): MediaItem | null {
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

  // ---------- Queue aus Auswahl füllen, Titelanzeige, Sendeverlauf ----------

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

  // ---------- Weiterschalten (Planung, Playlists, Schnelltrigger) ----------

  /** Nächsten Titel starten – im Server-Playout direkt, sonst übernimmt das Studio (Event). */
  advance(stationId: string): void {
    const po = this.playouts.get(stationId);
    if (po) po.playout.skip();
    else this.publish('automation.command', stationId, { action: 'next' });
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
      if (patch.mediaId !== null) this.svc.media.media(stationId, patch.mediaId);
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
      const m = this.svc.media.media(stationId, slot.mediaId);
      po.playout.playCart(m, ['voice_track', 'tts', 'news', 'ad'].includes(m.category));
    }
    this.publish('cardwall.triggered', stationId, { ...slot, server: !!po });
    return slot;
  }

  // ---------- intern ----------

  autoFill(rt: StationRuntime, force = false): void {
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

  publishQueue(stationId: string): void {
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

  changed(): void {
    this.docs.touch('airdeck');
  }

  snapshot(): PersistedState {
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

  rt(id: string): StationRuntime {
    const rt = this.stations.get(id);
    if (!rt) throw new AppError(404, 'not_found', 'Sender nicht gefunden');
    return rt;
  }

  sourceOf(stationId: string, id: string): SourceConfig {
    const s = this.engine.get(id);
    if (!s || s.stationId !== stationId) throw new AppError(404, 'not_found', 'Quelle nicht gefunden');
    return s;
  }

  outputOf(stationId: string, id: string): BroadcastOutput {
    const o = this.outputs.get(id);
    if (!o || o.cfg.stationId !== stationId) throw new AppError(404, 'not_found', 'Ausgang nicht gefunden');
    return o;
  }
}

