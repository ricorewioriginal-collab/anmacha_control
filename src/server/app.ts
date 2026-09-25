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

import {
  ALL_SCOPES, AUDIO_FILE_RE, AppError, SLUG, SYSTEM_PRINCIPAL, canSee, hashToken, newId, normalizeMount, posInt, publicOutput, publicSource,
  relayKey, safeColor, timingSafeEqualStr, wrap,
  type ActiveRecording, type ApiToken, type BridgeConfig, type HubEvent, type NowPlaying, type PersistedState, type PlayLogEntry,
  type Playlist, type PlayoutConfig, type Principal, type Recording, type Station, type StationData, type StationRuntime,
} from './model.ts';
// Bisherige Importe aus app.ts bleiben gültig
export * from './model.ts';
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
import { createServices, type Services } from './services/index.ts';
import { DEFAULT_SOURCE, Updater, type UpdateSource } from './update.ts';
import { AiService } from './ai/service.ts';
import { AiDirector, DEFAULT_AI, type AiStationConfig, type AiSource } from './ai/director.ts';
import { AiError } from './ai/providers.ts';
import { Nextcloud, NextcloudError, cleanPath, type NextcloudConfig } from './nextcloud.ts';
import { liquidsoapScript } from './liquidsoap.ts';
import { UserStore } from './users.ts';
import { lautfmStatus, listenUrlOf, type StreamStatus } from './status.ts';
import { PullRelay, fetchAzuracast, fetchIcecastMount, type ExternalNow } from './bridge.ts';

import { readFileSync, writeFileSync } from 'node:fs';
import { NOTIFY_EVENTS, Notifier, validateExportPath, validateWebhookUrl, type IntegrationsConfig, type NotifyEvent } from './notify.ts';
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
  readonly playouts = new Map<string, { playout: Playout; source: SourceConfig }>();
  /** kann sich im Betrieb ändern: fehlgeschlagene Erkennung wird im Hintergrund wiederholt */
  ffmpeg: FfmpegInfo | null;
  readonly health: HealthManager;
  readonly mode: Mode;
  readonly version: string;
  readonly paths: AirDeckConfig['paths'];
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

  // ---------- Tokens / Auth ----------

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
    if (e.type === 'TAKEOVER_COMPLETED') this.relayFor(e.stationId, e.target).setActive(e.sourceId ?? null);
    if (e.type === 'OFF_AIR') this.relayFor(e.stationId, e.target).setActive(null);
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

  static readonly LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

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

  removeLogoFile(id: string): void {
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
    if (this.svc.recorder.recorders.has(id)) this.svc.recorder.stopRecording(id);
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

  readonly loudQueue: { stationId: string; id: string }[] = [];
  loudBusy = false;

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

  async runLoudness(): Promise<void> {
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
      const pl = this.svc.planning.savePlaylist(stationId, null, { name: target.playlistName, items: ids });
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

  // ---------- Zeitplan, Stunden-Uhr, Sendeplan ----------

  /** Nächsten Titel starten – im Server-Playout direkt, sonst übernimmt das Studio (Event). */
  advance(stationId: string): void {
    const po = this.playouts.get(stationId);
    if (po) po.playout.skip();
    else this.publish('automation.command', stationId, { action: 'next' });
  }

  // ---------- Recorder / Replays ----------

  // ---------- Benachrichtigungen, Webhooks, Now-Playing-Export ----------

  // ---------- Updates ----------

  // ---------- Brücke zu bestehenden Systemen ----------

  // ---------- Bridge-API für Entwickler: externe Schlüssel → AirDeck-Sender (idempotent) ----------

  // ---------- Stream-Status (öffentlich, wie Icecast) ----------


  // ---------- Liquidsoap ----------

  // ---------- Nextcloud-Brücke ----------

  // ---------- Android-App / Netzwerk ----------

  // ---------- KI-Automation ----------

  // ---------- laut.fm ----------

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

