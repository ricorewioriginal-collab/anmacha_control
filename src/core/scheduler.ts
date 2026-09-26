// Planung: Zeitplan (einmalig/wiederholt), Stunden-Uhr (Minuten-Events), Sendeplan (Zeitfenster → Playlist),
// Aufnahme-Zeitfenster. Reine Logik in Ortszeit; Wochentage 0 = Montag … 6 = Sonntag.

export type Repeat = 'none' | 'hourly' | 'daily' | 'weekdays' | 'weekly';
export type JobKind = 'media' | 'folder' | 'url' | 'playlist';
/** now = sofort per Crossfade, track = nach dem laufenden Titel, fx = über der Musik (Ducking) */
export type JobMode = 'now' | 'track' | 'fx';

export interface JobTarget {
  kind: JobKind;
  mediaId?: string;
  folder?: string;
  url?: string;
  /** Laufzeit für URL-Streams (sonst endlos, bis weitergeschaltet wird) */
  durationMs?: number;
  playlistId?: string;
  mode: JobMode;
  label?: string;
}

export interface ScheduledJob extends JobTarget {
  id: string;
  at: number;
  repeat: Repeat;
}

export interface ClockEvent extends JobTarget {
  id: string;
  enabled: boolean;
  /** Minuten 0–59, zu denen ausgelöst wird */
  minutes: number[];
  /** Stunden 0–23; leer = jede Stunde */
  hours: number[];
  /** Wochentage 0–6 (Mo–So); leer = jeden Tag */
  days: number[];
}

export interface TimeWindow {
  id: string;
  label: string;
  days: number[];
  from: string; // "HH:MM"
  to: string; // "HH:MM" (kleiner als from = über Mitternacht)
}

export interface ProgramPlan extends TimeWindow {
  playlistId: string;
  shuffle: boolean;
}

export type RecordingPlan = TimeWindow;

export const weekday = (d: Date): number => (d.getDay() + 6) % 7;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function parseHHMM(s: string): number {
  const m = HHMM.exec(s);
  if (!m) throw new Error(`Ungültige Uhrzeit: ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Nächster Termin nach `after` für wiederholte Jobs (oder null bei einmaligen). */
export function nextOccurrence(job: Pick<ScheduledJob, 'at' | 'repeat'>, after: number): number | null {
  if (job.repeat === 'none') return null;
  let t = new Date(job.at);
  const step = (d: Date): Date => {
    const n = new Date(d);
    if (job.repeat === 'hourly') n.setHours(n.getHours() + 1);
    else if (job.repeat === 'weekly') n.setDate(n.getDate() + 7);
    else n.setDate(n.getDate() + 1);
    return n;
  };
  // Grobe Annäherung für lange Pausen (z. B. PC war aus), dann exakt weiterzählen
  const span = job.repeat === 'hourly' ? 3600e3 : job.repeat === 'weekly' ? 7 * 86400e3 : 86400e3;
  if (after - t.getTime() > span * 2) {
    const skip = Math.floor((after - t.getTime()) / span) - 1;
    if (job.repeat === 'hourly') t.setHours(t.getHours() + skip);
    else t.setDate(t.getDate() + skip * (job.repeat === 'weekly' ? 7 : 1));
  }
  for (let guard = 0; guard < 10_000; guard++) {
    t = step(t);
    if (t.getTime() <= after) continue;
    if (job.repeat === 'weekdays' && weekday(t) > 4) continue;
    return t.getTime();
  }
  return null;
}

/** Jobs mit Termin in (from, to]. */
export function dueJobs<T extends Pick<ScheduledJob, 'at'>>(jobs: readonly T[], from: number, to: number): T[] {
  return jobs.filter((j) => j.at > from && j.at <= to);
}

/** Nächster Termin nach `after`, an dem ein Uhr-Event auslöst (Minuten/Stunden/Wochentage-Muster). */
export function nextClockOccurrence(e: Pick<ClockEvent, 'enabled' | 'minutes' | 'hours' | 'days'>, after: number): number | null {
  if (!e.enabled || e.minutes.length === 0) return null;
  const d = new Date(after);
  d.setSeconds(0, 0);
  for (let guard = 0; guard < 7 * 24 * 60; guard++) {
    d.setMinutes(d.getMinutes() + 1);
    if (d.getTime() <= after) continue;
    if (e.minutes.includes(d.getMinutes()) && (e.hours.length === 0 || e.hours.includes(d.getHours())) && (e.days.length === 0 || e.days.includes(weekday(d)))) {
      return d.getTime();
    }
  }
  return null;
}

/**
 * Nächster "harter" Termin (Hard Time) innerhalb von `lookaheadMs`: ein Uhr-Event oder Zeitplan-Job
 * im Modus "sofort" (mode: 'now'). Auto-Fill soll davor keinen zu langen Titel mehr anfangen.
 */
export function nextHardMark(clockEvents: readonly ClockEvent[], jobs: readonly ScheduledJob[], now: number, lookaheadMs: number): number | null {
  const limit = now + lookaheadMs;
  let best: number | null = null;
  for (const e of clockEvents) {
    if (e.mode !== 'now') continue;
    const t = nextClockOccurrence(e, now);
    if (t !== null && t <= limit && (best === null || t < best)) best = t;
  }
  for (const j of jobs) {
    if (j.mode !== 'now') continue;
    const t = j.at > now ? j.at : nextOccurrence(j, now);
    if (t !== null && t <= limit && (best === null || t < best)) best = t;
  }
  return best;
}

/** Uhr-Events, die zur Minute des Datums passen. */
export function clockDue<T extends ClockEvent>(events: readonly T[], d: Date): T[] {
  const min = d.getMinutes();
  const hour = d.getHours();
  const day = weekday(d);
  return events.filter(
    (e) => e.enabled && e.minutes.includes(min) && (e.hours.length === 0 || e.hours.includes(hour)) && (e.days.length === 0 || e.days.includes(day)),
  );
}

/** Liegt das Datum im Zeitfenster (inkl. Fenster über Mitternacht)? */
export function inWindow(w: Pick<TimeWindow, 'days' | 'from' | 'to'>, d: Date): boolean {
  const from = parseHHMM(w.from);
  const to = parseHHMM(w.to);
  const now = d.getHours() * 60 + d.getMinutes();
  const day = weekday(d);
  const dayOk = (x: number) => w.days.length === 0 || w.days.includes(x);
  if (from === to) return dayOk(day); // ganzer Tag
  if (from < to) return dayOk(day) && now >= from && now < to;
  // über Mitternacht: Start am Vortag zählt für den frühen Teil
  return (now >= from && dayOk(day)) || (now < to && dayOk((day + 6) % 7));
}

export function activeWindow<T extends TimeWindow>(windows: readonly T[], d: Date): T | undefined {
  return windows.find((w) => inWindow(w, d));
}

export function validateWindow(w: TimeWindow): void {
  parseHHMM(w.from);
  parseHHMM(w.to);
  if (!Array.isArray(w.days) || w.days.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) throw new Error('Ungültige Wochentage');
}

export function validateClock(e: ClockEvent): void {
  const ints = (a: unknown, max: number) => Array.isArray(a) && a.every((x) => Number.isInteger(x) && x >= 0 && x <= max);
  if (!ints(e.minutes, 59) || e.minutes.length === 0) throw new Error('Mindestens eine Minute (0–59) angeben');
  if (!ints(e.hours, 23)) throw new Error('Ungültige Stunden');
  if (!ints(e.days, 6)) throw new Error('Ungültige Wochentage');
}

/** M3U-Zeilen → Einträge (Dateiname + optional "Interpret - Titel" aus #EXTINF). */
export function parseM3U(text: string): Array<{ path: string; title?: string; durationMs?: number }> {
  const out: Array<{ path: string; title?: string; durationMs?: number }> = [];
  let info: { title?: string; durationMs?: number } = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const ext = /^#EXTINF:(-?\d+(?:\.\d+)?)\s*(?:[^,]*),(.*)$/.exec(line);
    if (ext) {
      const secs = Number(ext[1]);
      info = { title: ext[2]!.trim() || undefined, durationMs: secs > 0 ? Math.round(secs * 1000) : undefined };
      continue;
    }
    if (line.startsWith('#')) continue;
    out.push({ path: line, ...info });
    info = {};
  }
  return out;
}

export function toM3U(items: ReadonlyArray<{ title: string; artist: string; durationMs: number | null; path: string }>): string {
  const lines = ['#EXTM3U'];
  for (const i of items) {
    lines.push(`#EXTINF:${i.durationMs ? Math.round(i.durationMs / 1000) : -1},${i.artist ? `${i.artist} - ` : ''}${i.title}`);
    lines.push(i.path);
  }
  return lines.join('\r\n') + '\r\n';
}
