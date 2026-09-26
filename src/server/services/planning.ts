// Planung: Playlists, Zeitplan-Jobs, Stunden-Uhr, Sendeplan und deren Ausführung im Takt des Kerns.

import type { AirDeckApp } from '../app.ts';
import { pickNext as pickFromPool, type MediaItem } from '../../core/automation.ts';
import {
  activeWindow, clockDue, dueJobs, nextOccurrence, validateClock, validateWindow,
  type ClockEvent, type JobTarget, type ProgramPlan, type Repeat, type ScheduledJob,
} from '../../core/scheduler.ts';
import { AppError, newId, safeColor, type Playlist } from '../model.ts';

export class PlanningService {
  private readonly app: AirDeckApp;

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  lastSchedAt = Date.now();

  readonly activePlanId = new Map<string, string | null>();

  playlists(stationId: string): Playlist[] {
    return this.app.rt(stationId).data.playlists ?? [];
  }

  savePlaylist(stationId: string, id: string | null, input: { name?: string; color?: string; items?: unknown; mode?: unknown }): Playlist {
    const rt = this.app.rt(stationId);
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
      delete pl.shuffleOrder; // Reihenfolge ist ungültig geworden, wird bei Bedarf neu gemischt
    }
    if (input.mode === 'manual' || input.mode === 'shuffle') pl.mode = input.mode;
    this.app.publish('playlists.changed', stationId, list);
    this.app.changed();
    return pl;
  }

  /** Playlist im Shuffle-Modus neu mischen: Fisher-Yates, danach direkt aufeinanderfolgende Titel desselben Interpreten möglichst auflösen. */
  reshufflePlaylist(stationId: string, id: string): Playlist {
    const rt = this.app.rt(stationId);
    const pl = rt.data.playlists?.find((p) => p.id === id);
    if (!pl) throw new AppError(404, 'not_found', 'Playlist nicht gefunden');
    const byId = new Map(rt.data.library.map((m) => [m.id, m]));
    const order = shuffleSeparated(pl.items, (mid) => byId.get(mid)?.artist ?? '');
    pl.shuffleOrder = order;
    this.app.publish('playlists.changed', stationId, rt.data.playlists);
    this.app.changed();
    return pl;
  }

  deletePlaylist(stationId: string, id: string): void {
    const rt = this.app.rt(stationId);
    if (rt.data.plans?.some((p) => p.playlistId === id)) throw new AppError(409, 'in_use', 'Playlist wird im Sendeplan verwendet');
    rt.data.playlists = (rt.data.playlists ?? []).filter((p) => p.id !== id);
    this.app.publish('playlists.changed', stationId, rt.data.playlists);
    this.app.changed();
  }

  saveQueueAsPlaylist(stationId: string, name: string): Playlist {
    return this.savePlaylist(stationId, null, { name, items: this.app.rt(stationId).queue.list().map((q) => q.mediaId) });
  }

  /** Playlist abspielen: ersetzt die Queue und schaltet per Crossfade weiter. Im Shuffle-Modus mit gemischter Reihenfolge. */
  playPlaylist(stationId: string, id: string): void {
    const rt = this.app.rt(stationId);
    const pl = rt.data.playlists?.find((p) => p.id === id);
    if (!pl || !pl.items.length) throw new AppError(404, 'empty', 'Playlist ist leer oder existiert nicht');
    let order = pl.items;
    if (pl.mode === 'shuffle') {
      if (!pl.shuffleOrder || pl.shuffleOrder.length !== pl.items.length || pl.shuffleOrder.some((mid) => !pl.items.includes(mid))) this.reshufflePlaylist(stationId, id);
      order = pl.shuffleOrder ?? pl.items;
    }
    rt.queue.clear();
    for (const mid of order) rt.queue.add(mid, 'manual');
    this.app.publishQueue(stationId);
    this.app.advance(stationId);
  }

  planning(stationId: string): unknown {
    const d = this.app.rt(stationId).data;
    const now = new Date();
    return {
      jobs: [...(d.jobs ?? [])].sort((a, b) => a.at - b.at), clockEvents: d.clockEvents ?? [], plans: d.plans ?? [],
      recPlans: d.recPlans ?? [], activePlanId: activeWindow(d.plans ?? [], now)?.id ?? null,
    };
  }

  saveJob(stationId: string, input: Record<string, unknown>): ScheduledJob {
    const rt = this.app.rt(stationId);
    const at = typeof input.at === 'string' || typeof input.at === 'number' ? new Date(input.at).getTime() : NaN;
    if (!Number.isFinite(at)) throw new AppError(400, 'invalid_time', 'Ungültiger Zeitpunkt');
    const repeat = (['none', 'hourly', 'daily', 'weekdays', 'weekly'] as Repeat[]).includes(input.repeat as Repeat) ? (input.repeat as Repeat) : 'none';
    const job: ScheduledJob = { id: newId('job'), at, repeat, ...this.jobTarget(stationId, input) };
    (rt.data.jobs ??= []).push(job);
    this.planningChanged(stationId);
    return job;
  }

  deleteJob(stationId: string, id: string): void {
    const rt = this.app.rt(stationId);
    rt.data.jobs = (rt.data.jobs ?? []).filter((j) => j.id !== id);
    this.planningChanged(stationId);
  }

  saveClockEvent(stationId: string, id: string | null, input: Record<string, unknown>): ClockEvent {
    const rt = this.app.rt(stationId);
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
    const rt = this.app.rt(stationId);
    rt.data.clockEvents = (rt.data.clockEvents ?? []).filter((e) => e.id !== id);
    this.planningChanged(stationId);
  }

  /** Uhr-Event sofort auslösen (Test). */
  fireClockEvent(stationId: string, id: string): void {
    const ev = this.app.rt(stationId).data.clockEvents?.find((e) => e.id === id);
    if (!ev) throw new AppError(404, 'not_found', 'Uhr-Event nicht gefunden');
    this.executeTarget(stationId, ev, 'manual');
  }

  savePlan(stationId: string, id: string | null, input: Record<string, unknown>): ProgramPlan {
    const rt = this.app.rt(stationId);
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
    const rt = this.app.rt(stationId);
    rt.data.plans = (rt.data.plans ?? []).filter((p) => p.id !== id);
    this.planningChanged(stationId);
  }

  jobTarget(stationId: string, input: Record<string, unknown>): JobTarget {
    const kind = input.kind as JobTarget['kind'];
    const mode = (['now', 'track', 'fx'] as const).includes(input.mode as never) ? (input.mode as JobTarget['mode']) : 'track';
    const label = typeof input.label === 'string' ? input.label.slice(0, 80) : undefined;
    const rt = this.app.rt(stationId);
    switch (kind) {
      case 'media':
        this.app.svc.media.media(stationId, String(input.mediaId ?? ''));
        return { kind, mediaId: String(input.mediaId), mode, label };
      case 'folder':
        if (!rt.data.library.some((m) => (m.folder ?? '') === String(input.folder ?? ''))) throw new AppError(400, 'empty_folder', 'Ordner ist leer');
        return { kind, folder: String(input.folder ?? ''), mode, label };
      case 'url': {
        const m = this.app.svc.media.addUrlMedia(stationId, { url: String(input.url ?? ''), title: label, durationMs: Number(input.durationMs) || undefined });
        return { kind: 'media', mediaId: m.id, mode, label: label ?? m.title };
      }
      case 'playlist':
        if (!rt.data.playlists?.some((p) => p.id === input.playlistId)) throw new AppError(400, 'invalid_playlist', 'Playlist wählen');
        return { kind, playlistId: String(input.playlistId), mode: 'now', label };
      default:
        throw new AppError(400, 'invalid_kind', 'Art: media, folder, url oder playlist');
    }
  }

  planningChanged(stationId: string): void {
    this.app.publish('planning.changed', stationId, this.planning(stationId));
    this.app.changed();
  }

  executeTarget(stationId: string, t: JobTarget, origin: string): void {
    const rt = this.app.rt(stationId);
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
        this.app.audit.write({ kind: 'schedule', event: 'target_missing', stationId, label: t.label });
        return;
      }
      if (t.mode === 'fx') {
        const po = this.app.playouts.get(stationId);
        if (po) po.playout.playCart(m, true);
        else this.app.publish('automation.command', stationId, { action: 'fx', mediaId: m.id });
      } else {
        rt.queue.add(m.id, 'schedule', 0);
        this.app.publishQueue(stationId);
        if (t.mode === 'now') this.app.advance(stationId);
      }
    }
    this.app.audit.write({ kind: 'schedule', event: 'fired', stationId, origin, label: t.label, mode: t.mode });
    this.app.publish('schedule.fired', stationId, { label: t.label, kind: t.kind, mode: t.mode, origin });
  }

  processSchedules(): void {
    const now = Date.now();
    const from = this.lastSchedAt;
    this.lastSchedAt = now;
    const minuteChanged = Math.floor(from / 60000) !== Math.floor(now / 60000);
    for (const [stationId, rt] of this.app.stations) {
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
        this.app.autoFill(rt);
        this.app.publishQueue(stationId);
        this.app.publish('planning.changed', stationId, this.planning(stationId));
      }
      this.activePlanId.set(stationId, planId);
      // Aufnahme-Zeitfenster
      const recPlan = activeWindow(rt.data.recPlans ?? [], d);
      const active = this.app.svc.recorder.recorders.get(stationId);
      if (recPlan && !active) this.app.svc.recorder.startRecording(stationId, recPlan.label, recPlan.id);
      if (!recPlan && active?.rec.planId) this.app.svc.recorder.stopRecording(stationId);
    }
  }
}

/**
 * Fisher-Yates-Shuffle, danach ein Durchgang, der direkt aufeinanderfolgende Titel desselben
 * Interpreten so weit möglich auflöst (Tausch mit dem nächsten passenden Titel) - kein naiver
 * Zufall, aber auch keine vollständige Rotations-Engine (die ist ein eigener, größerer Punkt).
 */
export function shuffleSeparated(items: string[], artistOf: (id: string) => string): string[] {
  const order = [...items];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  for (let i = 1; i < order.length; i++) {
    if (artistOf(order[i]!) !== artistOf(order[i - 1]!) || !artistOf(order[i]!)) continue;
    const j = order.findIndex((id, k) => k > i && artistOf(id) !== artistOf(order[i - 1]!));
    if (j !== -1) [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}
