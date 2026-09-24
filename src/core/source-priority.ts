// AirDeck Source Priority Engine
// Regel: positive Ganzzahl, kleinere Zahl = höhere Priorität.
// Priorität allein ist keine Berechtigung – jede Übernahme wird autorisiert.

export type SourceType =
  | 'live_studio'
  | 'remote_studio'
  | 'mobile'
  | 'automation'
  | 'backup_automation'
  | 'emergency'
  | 'relay'
  | 'url_stream';

export type SourceState =
  | 'disconnected'
  | 'connecting'
  | 'standby'
  | 'takeover_pending'
  | 'taking_over'
  | 'active'
  | 'blocked'
  | 'failed'
  | 'fallback';

export type TakeoverPolicy = 'auto' | 'manual' | 'never';

export interface SourceConfig {
  id: string;
  stationId: string;
  name: string;
  type: SourceType;
  /** Ziel, z. B. Mountpoint "/live" */
  target: string;
  priority: number;
  takeoverPolicy: TakeoverPolicy;
  /** Rollen, die diese Quelle auf Sendung bringen dürfen */
  allowedRoles: string[];
  fallbackSourceId?: string;
  blocked?: boolean;
  /** Verweis auf ein Secret im Secret Store – niemals das Secret selbst */
  credentialRef?: string;
}

export interface SourceRuntime {
  state: SourceState;
  healthy: boolean;
  healthReason?: string;
  connectedAt?: number;
  pendingSince?: number;
  activeSince?: number;
  lastChange: number;
}

export type Source = SourceConfig & SourceRuntime;

export interface Actor {
  id: string;
  roles: string[];
  /** Sender, auf die der Actor Zugriff hat; '*' = alle */
  stationIds: string[];
}

export type EngineEventType =
  | 'SOURCE_CONNECTED'
  | 'SOURCE_DISCONNECTED'
  | 'SOURCE_HEALTH_CHANGED'
  | 'SOURCE_PRIORITY_CHANGED'
  | 'TAKEOVER_REQUESTED'
  | 'TAKEOVER_APPROVED'
  | 'TAKEOVER_REJECTED'
  | 'TAKEOVER_STARTED'
  | 'TAKEOVER_COMPLETED'
  | 'SOURCE_DISPLACED'
  | 'SOURCE_FAILED'
  | 'FALLBACK_STARTED'
  | 'FALLBACK_COMPLETED'
  | 'OFF_AIR';

export interface EngineEvent {
  type: EngineEventType;
  at: number;
  stationId: string;
  target: string;
  sourceId?: string;
  actorId?: string;
  data?: Record<string, unknown>;
}

export interface EngineOptions {
  /** Quelle muss so lange stabil verbunden sein, bevor sie automatisch übernimmt (Anti-Flapping). */
  stableMs?: number;
  /** Nach einer automatischen Übernahme sind weitere automatische Übernahmen so lange gesperrt. */
  cooldownMs?: number;
  now?: () => number;
}

export class PriorityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function validatePriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new PriorityError('invalid_priority', 'Priority muss eine positive Ganzzahl (>= 1) sein');
  }
  return value;
}

export function canAccessStation(actor: Actor, stationId: string): boolean {
  return actor.stationIds.includes('*') || actor.stationIds.includes(stationId);
}

export function isAuthorized(actor: Actor, source: SourceConfig): boolean {
  if (!canAccessStation(actor, source.stationId)) return false;
  if (actor.roles.includes('admin')) return true;
  return source.allowedRoles.some((r) => actor.roles.includes(r));
}

const SYSTEM: Actor = { id: 'system', roles: ['admin'], stationIds: ['*'] };
const ONLINE: ReadonlySet<SourceState> = new Set(['standby', 'takeover_pending', 'taking_over', 'active', 'fallback']);

export class SourcePriorityEngine {
  private readonly sources = new Map<string, Source>();
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private readonly lastTakeoverAt = new Map<string, number>();
  private readonly stableMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: EngineOptions = {}) {
    this.stableMs = opts.stableMs ?? 0;
    this.cooldownMs = opts.cooldownMs ?? 0;
    this.now = opts.now ?? Date.now;
  }

  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- Konfiguration ----------

  addSource(cfg: SourceConfig): Source {
    if (this.sources.has(cfg.id)) throw new PriorityError('duplicate', `Quelle ${cfg.id} existiert bereits`);
    validatePriority(cfg.priority);
    if (!cfg.stationId || !cfg.target) throw new PriorityError('invalid_source', 'stationId und target sind Pflicht');
    const src: Source = {
      ...cfg,
      allowedRoles: [...cfg.allowedRoles],
      state: cfg.blocked ? 'blocked' : 'disconnected',
      healthy: true,
      lastChange: this.now(),
    };
    this.sources.set(src.id, src);
    return this.view(src);
  }

  updateSource(id: string, patch: Partial<Omit<SourceConfig, 'id' | 'stationId'>>, actor: Actor = SYSTEM): Source {
    const src = this.require(id);
    if (!isAuthorized(actor, src)) throw new PriorityError('forbidden', 'Keine Berechtigung für diese Quelle');
    if (patch.priority !== undefined) {
      validatePriority(patch.priority);
      if (patch.priority !== src.priority) {
        const from = src.priority;
        src.priority = patch.priority;
        this.emit('SOURCE_PRIORITY_CHANGED', src, actor, { from, to: patch.priority });
      }
    }
    if (patch.name !== undefined) src.name = patch.name;
    if (patch.type !== undefined) src.type = patch.type;
    if (patch.takeoverPolicy !== undefined) src.takeoverPolicy = patch.takeoverPolicy;
    if (patch.allowedRoles !== undefined) src.allowedRoles = [...patch.allowedRoles];
    if (patch.fallbackSourceId !== undefined) src.fallbackSourceId = patch.fallbackSourceId || undefined;
    if (patch.credentialRef !== undefined) src.credentialRef = patch.credentialRef || undefined;
    if (patch.target !== undefined && patch.target !== src.target) {
      if (ONLINE.has(src.state)) throw new PriorityError('busy', 'Target kann nur bei getrennter Quelle geändert werden');
      src.target = patch.target;
    }
    if (patch.blocked !== undefined && patch.blocked !== !!src.blocked) {
      src.blocked = patch.blocked;
      if (patch.blocked) {
        const wasActive = src.state === 'active';
        this.setState(src, 'blocked');
        if (wasActive) this.fallback(src.stationId, src.target, src, actor);
      } else {
        this.setState(src, 'disconnected');
      }
    }
    this.evaluate(src.stationId, src.target);
    return this.view(src);
  }

  removeSource(id: string, actor: Actor = SYSTEM): void {
    const src = this.require(id);
    if (!isAuthorized(actor, src)) throw new PriorityError('forbidden', 'Keine Berechtigung für diese Quelle');
    const wasActive = src.state === 'active';
    this.sources.delete(id);
    if (wasActive) this.fallback(src.stationId, src.target, src, actor);
  }

  // ---------- Laufzeit ----------

  /** Quelle meldet sich (z. B. Encoder verbindet). */
  connect(id: string, actor: Actor = SYSTEM): Source {
    const src = this.require(id);
    if (!isAuthorized(actor, src)) {
      this.emit('TAKEOVER_REJECTED', src, actor, { reason: 'forbidden' });
      throw new PriorityError('forbidden', 'Nicht autorisiert, diese Quelle zu verbinden');
    }
    if (src.blocked) {
      this.emit('TAKEOVER_REJECTED', src, actor, { reason: 'blocked' });
      throw new PriorityError('blocked', 'Quelle ist gesperrt');
    }
    if (ONLINE.has(src.state)) return this.view(src);
    const t = this.now();
    src.connectedAt = t;
    this.setState(src, 'connecting');
    this.emit('SOURCE_CONNECTED', src, actor);
    this.setState(src, 'standby');
    this.evaluate(src.stationId, src.target, actor);
    return this.view(src);
  }

  disconnect(id: string, actor: Actor = SYSTEM): void {
    const src = this.require(id);
    if (!ONLINE.has(src.state) && src.state !== 'connecting') return;
    const wasActive = src.state === 'active';
    src.connectedAt = undefined;
    this.setState(src, 'disconnected');
    this.emit('SOURCE_DISCONNECTED', src, actor);
    if (wasActive) this.fallback(src.stationId, src.target, src, actor);
  }

  /** Aktive Quelle gibt freiwillig ab (DJ Handover zurück an Automation). */
  release(id: string, actor: Actor = SYSTEM): void {
    const src = this.require(id);
    if (!isAuthorized(actor, src)) throw new PriorityError('forbidden', 'Keine Berechtigung');
    this.disconnect(id, actor);
  }

  fail(id: string, reason: string): void {
    const src = this.require(id);
    const wasActive = src.state === 'active';
    src.healthy = false;
    src.healthReason = reason;
    src.connectedAt = undefined;
    this.setState(src, 'failed');
    this.emit('SOURCE_FAILED', src, SYSTEM, { reason });
    if (wasActive) this.fallback(src.stationId, src.target, src, SYSTEM);
  }

  setHealth(id: string, healthy: boolean, reason?: string): void {
    const src = this.require(id);
    if (src.healthy === healthy) return;
    src.healthy = healthy;
    src.healthReason = healthy ? undefined : reason;
    this.emit('SOURCE_HEALTH_CHANGED', src, SYSTEM, { healthy, reason });
    if (!healthy && src.state === 'active') {
      this.fail(id, reason ?? 'unhealthy');
      return;
    }
    if (healthy && src.state === 'failed') this.setState(src, 'disconnected');
    this.evaluate(src.stationId, src.target);
  }

  /**
   * Manuelle Übernahme durch Operator. Ohne force gelten die Prioritätsregeln,
   * mit force (Operator/Emergency Override) darf auch eine niedrigere Priorität übernehmen.
   */
  requestTakeover(id: string, actor: Actor, opts: { force?: boolean; stationId?: string } = {}): Source {
    const src = this.require(id);
    this.emit('TAKEOVER_REQUESTED', src, actor, { force: !!opts.force });
    const reject = (code: string, msg: string): never => {
      this.emit('TAKEOVER_REJECTED', src, actor, { reason: code });
      throw new PriorityError(code, msg);
    };
    if (opts.stationId && opts.stationId !== src.stationId) reject('wrong_station', 'Quelle gehört zu einem anderen Sender');
    if (!isAuthorized(actor, src)) reject('forbidden', 'Nicht autorisiert');
    if (src.blocked) reject('blocked', 'Quelle ist gesperrt');
    if (src.takeoverPolicy === 'never') reject('policy', 'Policy verbietet Übernahme');
    if (!src.healthy) reject('unhealthy', 'Quelle ist nicht gesund');
    if (!ONLINE.has(src.state)) reject('not_connected', 'Quelle ist nicht verbunden');
    if (opts.force && !(actor.roles.includes('admin') || actor.roles.includes('operator'))) {
      reject('forbidden', 'Override nur für Operator/Admin');
    }
    const active = this.activeFor(src.stationId, src.target);
    if (active?.id === src.id) return this.view(src);
    if (active && !opts.force && active.priority <= src.priority) {
      reject('lower_priority', `Aktive Quelle hat gleiche oder höhere Priorität (${active.priority})`);
    }
    this.emit('TAKEOVER_APPROVED', src, actor);
    this.activate(src, active, actor, 'manual');
    return this.view(src);
  }

  /** Zeitgesteuerte Auswertung (Anti-Flapping-Fenster). Regelmäßig aufrufen. */
  tick(): void {
    const targets = new Set<string>();
    for (const s of this.sources.values()) if (s.state === 'takeover_pending') targets.add(`${s.stationId}\u0000${s.target}`);
    for (const key of targets) {
      const [stationId, target] = key.split('\u0000') as [string, string];
      this.evaluate(stationId, target);
    }
  }

  // ---------- Abfragen ----------

  get(id: string): Source | undefined {
    const s = this.sources.get(id);
    return s && this.view(s);
  }

  list(stationId?: string): Source[] {
    return [...this.sources.values()]
      .filter((s) => !stationId || s.stationId === stationId)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map((s) => this.view(s));
  }

  activeFor(stationId: string, target: string): Source | undefined {
    for (const s of this.sources.values()) {
      if (s.stationId === stationId && s.target === target && s.state === 'active') return this.view(s);
    }
    return undefined;
  }

  /** Nur Konfiguration – Laufzeitstatus wird bewusst nicht persistiert. */
  exportConfig(): SourceConfig[] {
    return [...this.sources.values()].map((s) => ({
      id: s.id,
      stationId: s.stationId,
      name: s.name,
      type: s.type,
      target: s.target,
      priority: s.priority,
      takeoverPolicy: s.takeoverPolicy,
      allowedRoles: [...s.allowedRoles],
      fallbackSourceId: s.fallbackSourceId,
      blocked: s.blocked,
      credentialRef: s.credentialRef,
    }));
  }

  /**
   * Wiederherstellung nach Neustart: alle Quellen starten getrennt.
   * Quellen müssen sich neu verbinden – so entstehen nie zwei konkurrierende aktive Quellen.
   */
  static restore(configs: SourceConfig[], opts: EngineOptions = {}): SourcePriorityEngine {
    const e = new SourcePriorityEngine(opts);
    for (const c of configs) e.addSource(c);
    return e;
  }

  // ---------- intern ----------

  private require(id: string): Source {
    const s = this.sources.get(id);
    if (!s) throw new PriorityError('not_found', `Quelle ${id} nicht gefunden`);
    return s;
  }

  private view(s: Source): Source {
    return { ...s, allowedRoles: [...s.allowedRoles] };
  }

  private setState(s: Source, state: SourceState): void {
    s.state = state;
    s.lastChange = this.now();
    if (state !== 'takeover_pending') s.pendingSince = undefined;
    if (state !== 'active') s.activeSince = undefined;
  }

  private emit(type: EngineEventType, s: SourceConfig, actor: Actor, data?: Record<string, unknown>): void {
    const e: EngineEvent = { type, at: this.now(), stationId: s.stationId, target: s.target, sourceId: s.id, actorId: actor.id, data };
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // Listener-Fehler dürfen die Engine nie stören
      }
    }
  }

  /** Beste Kandidatin: kleinste Priority, bei Gleichstand die zuerst verbundene, dann ID. */
  private candidates(stationId: string, target: string, exclude?: string): Source[] {
    return [...this.sources.values()]
      .filter(
        (s) =>
          s.stationId === stationId &&
          s.target === target &&
          s.id !== exclude &&
          s.healthy &&
          !s.blocked &&
          (s.state === 'standby' || s.state === 'takeover_pending'),
      )
      .sort(
        (a, b) =>
          a.priority - b.priority || (a.connectedAt ?? 0) - (b.connectedAt ?? 0) || a.id.localeCompare(b.id),
      );
  }

  private evaluate(stationId: string, target: string, actor: Actor = SYSTEM): void {
    const active = this.activeFor(stationId, target);
    const t = this.now();
    for (const c of this.candidates(stationId, target)) {
      if (c.takeoverPolicy !== 'auto') continue;
      // Gleiche Priorität verdrängt nie: die sendende Quelle bleibt (deterministisch).
      if (active && c.priority >= active.priority) {
        if (c.state === 'takeover_pending') this.setState(c, 'standby');
        continue;
      }
      if (active) {
        const last = this.lastTakeoverAt.get(`${stationId}\u0000${target}`);
        if (last !== undefined && t - last < this.cooldownMs) continue;
        if (this.stableMs > 0) {
          if (c.state !== 'takeover_pending') {
            this.setState(c, 'takeover_pending');
            c.pendingSince = t;
          }
          if (t - (c.pendingSince ?? t) < this.stableMs) continue;
        }
      }
      this.emit('TAKEOVER_APPROVED', c, actor, { auto: true });
      this.activate(c, active, actor, active ? 'auto' : 'initial');
      return;
    }
  }

  private activate(next: Source, prev: Source | undefined, actor: Actor, mode: string): void {
    this.setState(next, 'taking_over');
    this.emit('TAKEOVER_STARTED', next, actor, { from: prev?.id, mode });
    if (prev) {
      const p = this.sources.get(prev.id);
      if (p) {
        this.setState(p, 'standby');
        this.emit('SOURCE_DISPLACED', p, actor, { by: next.id });
      }
    }
    this.setState(next, 'active');
    next.activeSince = this.now();
    if (prev) this.lastTakeoverAt.set(`${next.stationId}\u0000${next.target}`, next.activeSince);
    this.emit('TAKEOVER_COMPLETED', next, actor, { from: prev?.id, mode, priority: next.priority });
  }

  private fallback(stationId: string, target: string, from: SourceConfig, actor: Actor): void {
    this.emit('FALLBACK_STARTED', from, actor);
    // Zuerst die explizit konfigurierte Fallback-Quelle, sonst beste verfügbare Priorität.
    const preferred = from.fallbackSourceId ? this.sources.get(from.fallbackSourceId) : undefined;
    const pool = this.candidates(stationId, target);
    // Manuelle Quellen nur, wenn sie ausdrücklich als Fallback eingetragen sind.
    const next =
      preferred && pool.some((c) => c.id === preferred.id) && preferred.takeoverPolicy !== 'never'
        ? preferred
        : pool.find((c) => c.takeoverPolicy === 'auto');
    if (!next) {
      this.emit('OFF_AIR', from, actor, { reason: 'no_fallback_source' });
      return;
    }
    this.activate(next, undefined, actor, 'fallback');
    this.emit('FALLBACK_COMPLETED', next, actor, { from: from.id });
  }
}
