// AirDeck Automation Core: Medien, Queue, Decks, Cardwall, Sendeuhr, Backtiming.
// Reine Domain-Logik ohne I/O – läuft identisch auf Server, Windows und Android.

export type MediaCategory =
  | 'music'
  | 'jingle'
  | 'sweeper'
  | 'station_id'
  | 'drop'
  | 'news'
  | 'ad'
  | 'voice_track'
  | 'tts'
  | 'bed'
  | 'stream';

export const MEDIA_CATEGORIES: readonly MediaCategory[] = [
  'music', 'jingle', 'sweeper', 'station_id', 'drop', 'news', 'ad', 'voice_track', 'tts', 'bed', 'stream',
];

export interface MediaItem {
  id: string;
  title: string;
  artist: string;
  category: MediaCategory;
  /** Dateiname relativ zum Medienordner */
  file: string;
  durationMs: number | null;
  cueInMs?: number;
  cueOutMs?: number;
  /** Überblendpunkt vor Ende (Segue) */
  segueMs?: number;
  introMs?: number;
  bpm?: number;
  gainDb?: number;
  addedAt: number;
  /** Frei wählbarer Ordner (wie in der Bibliothek der Live-Automation) */
  folder?: string;
  /** Ursprünglicher Dateiname beim Upload (für M3U-Abgleich) */
  originalName?: string;
  /** Externe Quelle (URL/Stream) statt Datei */
  url?: string;
  album?: string;
  genre?: string;
  year?: number;
  /** Von der KI erzeugt (Moderation/Nachrichten) – wird automatisch aufgeräumt */
  generatedBy?: 'ai';
  /** Gemessene integrierte Lautheit (EBU R128, LUFS) */
  lufs?: number;
  /** Gemessener True-Peak in dBTP */
  truePeakDb?: number;
  /** Herkunft, z. B. "nextcloud:/Radio/Hits/x.mp3" (verhindert doppelte Übernahme) */
  source?: string;
  /** Eingebundener Ordner: absoluter Pfad der Originaldatei (wird nie kopiert und nie gelöscht) */
  linkedPath?: string;
  /** Track-Check: Übersteuerung, Bitrate, stille Datei, automatisch gesetzte Cue-Punkte */
  check?: { at: number; clipped: number; bitrateKbps: number | null; silent: boolean; autoCueIn?: number; autoCueOut?: number };
}

export interface QueueEntry {
  uid: string;
  mediaId: string;
  addedAt: number;
  origin: 'manual' | 'clock' | 'emergency' | 'plan' | 'schedule' | 'ai';
}

export type DeckId = 'A' | 'B' | 'C' | 'D';
export const DECK_IDS: readonly DeckId[] = ['A', 'B', 'C', 'D'];

export interface DeckState {
  id: DeckId;
  mediaId: string | null;
  status: 'empty' | 'cued' | 'playing' | 'paused';
  startedAt?: number;
}

export interface CartSlot {
  id: string;
  label: string;
  color: string;
  mediaId: string | null;
  group: string;
}

/** Sendeuhr: Folge von Kategorien pro Stunde. */
export interface ClockTemplate {
  id: string;
  name: string;
  slots: MediaCategory[];
}

export interface RotationRules {
  /** Mindestabstand gleicher Interpret (Anzahl Titel) */
  artistSeparation: number;
  /** Mindestabstand gleicher Titel (Anzahl Titel) */
  titleSeparation: number;
}

export const DEFAULT_ROTATION: RotationRules = { artistSeparation: 3, titleSeparation: 20 };

/** Effektive Laufzeit unter Berücksichtigung von Cue-In/Out und Segue. */
export function playLength(m: MediaItem): number | null {
  if (m.durationMs == null) return null;
  const end = Math.min(m.cueOutMs ?? m.durationMs, m.durationMs);
  const len = end - (m.cueInMs ?? 0) - (m.segueMs ?? 0);
  return Math.max(0, len);
}

/** "Interpret - Titel.mp3" → Metadaten. */
export function parseFileName(file: string): { artist: string; title: string } {
  const base = file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const i = base.indexOf(' - ');
  if (i > 0) return { artist: base.slice(0, i).trim(), title: base.slice(i + 3).trim() };
  return { artist: '', title: base.trim() };
}

/**
 * Wählt den nächsten Titel einer Kategorie mit Rotationsregeln.
 * history: zuletzt gespielte Media-IDs, neueste zuerst.
 * Regeln werden schrittweise gelockert, damit die Automation nie stehen bleibt.
 */
export function pickNext(
  library: readonly MediaItem[],
  category: MediaCategory,
  history: readonly string[],
  rules: RotationRules = DEFAULT_ROTATION,
  random: () => number = Math.random,
): MediaItem | null {
  const pool = library.filter((m) => m.category === category);
  if (pool.length === 0) return null;
  const byId = new Map(library.map((m) => [m.id, m]));
  const recentArtists = (n: number) =>
    new Set(history.slice(0, n).map((id) => byId.get(id)?.artist.toLowerCase()).filter((a): a is string => !!a));
  const lastPlayedIndex = (id: string) => {
    const i = history.indexOf(id);
    return i === -1 ? Infinity : i;
  };
  const attempts: Array<(m: MediaItem) => boolean> = [
    (m) => lastPlayedIndex(m.id) >= rules.titleSeparation && !(m.artist && recentArtists(rules.artistSeparation).has(m.artist.toLowerCase())),
    (m) => lastPlayedIndex(m.id) >= rules.titleSeparation,
    (m) => lastPlayedIndex(m.id) > 0,
    () => true,
  ];
  for (const ok of attempts) {
    const hits = pool.filter(ok);
    if (hits.length) {
      // Unter den Kandidaten den am längsten nicht gespielten bevorzugen, Gleichstand zufällig.
      const best = Math.max(...hits.map((m) => lastPlayedIndex(m.id)));
      const top = hits.filter((m) => lastPlayedIndex(m.id) === best);
      return top[Math.floor(random() * top.length)] ?? top[0]!;
    }
  }
  return null;
}

export interface BacktimeRow {
  uid: string;
  mediaId: string;
  startsAt: number;
  endsAt: number;
  known: boolean;
}

/** Backtiming: Startzeiten der Queue ab jetzt und Abweichung zur Zielzeit (z. B. Stundenende). */
export function backtime(
  queue: readonly QueueEntry[],
  library: ReadonlyMap<string, MediaItem>,
  now: number,
  remainingCurrentMs: number,
  targetAt?: number,
): { rows: BacktimeRow[]; deviationMs: number | null } {
  let t = now + Math.max(0, remainingCurrentMs);
  const rows: BacktimeRow[] = [];
  for (const q of queue) {
    const m = library.get(q.mediaId);
    const len = m ? playLength(m) : null;
    rows.push({ uid: q.uid, mediaId: q.mediaId, startsAt: t, endsAt: t + (len ?? 0), known: len != null });
    t += len ?? 0;
  }
  return { rows, deviationMs: targetAt === undefined ? null : t - targetAt };
}

let uidCounter = 0;
export function uid(prefix = 'q'): string {
  uidCounter = (uidCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${uidCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export class PlayQueue {
  private items: QueueEntry[] = [];

  constructor(initial: QueueEntry[] = []) {
    this.items = [...initial];
  }

  list(): QueueEntry[] {
    return [...this.items];
  }

  get length(): number {
    return this.items.length;
  }

  add(mediaId: string, origin: QueueEntry['origin'] = 'manual', index?: number): QueueEntry {
    const e: QueueEntry = { uid: uid(), mediaId, addedAt: Date.now(), origin };
    if (index === undefined || index < 0 || index >= this.items.length) this.items.push(e);
    else this.items.splice(index, 0, e);
    return e;
  }

  remove(uidToRemove: string): boolean {
    const i = this.items.findIndex((x) => x.uid === uidToRemove);
    if (i === -1) return false;
    this.items.splice(i, 1);
    return true;
  }

  move(uidToMove: string, toIndex: number): boolean {
    const i = this.items.findIndex((x) => x.uid === uidToMove);
    if (i === -1) return false;
    const [e] = this.items.splice(i, 1);
    const target = Math.max(0, Math.min(toIndex, this.items.length));
    this.items.splice(target, 0, e!);
    return true;
  }

  shift(): QueueEntry | undefined {
    return this.items.shift();
  }

  clear(): void {
    this.items = [];
  }

  /** Reihenfolge zufällig mischen (Fisher-Yates). */
  shuffle(random: () => number = Math.random): void {
    for (let i = this.items.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [this.items[i], this.items[j]] = [this.items[j]!, this.items[i]!];
    }
  }

  /** Entfernt automatisch hinzugefügte Einträge (z. B. bei Wechsel des Sendeplans). */
  pruneOrigins(origins: ReadonlyArray<QueueEntry['origin']>): void {
    this.items = this.items.filter((x) => !origins.includes(x.origin));
  }

  /** Entfernt Einträge, deren Medium nicht mehr existiert. */
  prune(exists: (mediaId: string) => boolean): void {
    this.items = this.items.filter((x) => exists(x.mediaId));
  }
}

/**
 * Füllt die Queue nach Sendeuhr auf, bis mindestens minItems drin sind.
 * Kategorien ohne Material werden übersprungen (Automation bleibt stabil).
 */
export function fillFromClock(
  queue: PlayQueue,
  library: readonly MediaItem[],
  clock: ClockTemplate,
  history: readonly string[],
  cursor: number,
  minItems: number,
  rules: RotationRules = DEFAULT_ROTATION,
  random: () => number = Math.random,
): number {
  if (clock.slots.length === 0) return cursor;
  const recent = [...queue.list().map((q) => q.mediaId).reverse(), ...history];
  let guard = clock.slots.length * Math.max(1, minItems);
  while (queue.length < minItems && guard-- > 0) {
    const cat = clock.slots[cursor % clock.slots.length]!;
    cursor = (cursor + 1) % clock.slots.length;
    const m = pickNext(library, cat, recent, rules, random);
    if (!m) continue;
    queue.add(m.id, 'clock');
    recent.unshift(m.id);
  }
  return cursor;
}

export interface SilenceConfig {
  /** Pegel in dBFS, unter dem als Stille gilt */
  thresholdDb: number;
  /** Dauer in ms, bis Stille-Alarm ausgelöst wird */
  durationMs: number;
}

/** Stilleerkennung auf Pegel-Samples (dBFS, z. B. alle 100 ms aus dem Meter). */
export class SilenceDetector {
  private silentSince: number | null = null;
  private alarmed = false;
  private readonly cfg: SilenceConfig;

  constructor(cfg: SilenceConfig = { thresholdDb: -50, durationMs: 10_000 }) {
    this.cfg = cfg;
  }

  /** Liefert 'silence' beim Auslösen, 'recovered' beim Ende, sonst null. */
  feed(levelDb: number, at: number): 'silence' | 'recovered' | null {
    if (levelDb < this.cfg.thresholdDb) {
      if (this.silentSince === null) this.silentSince = at;
      if (!this.alarmed && at - this.silentSince >= this.cfg.durationMs) {
        this.alarmed = true;
        return 'silence';
      }
      return null;
    }
    this.silentSince = null;
    if (this.alarmed) {
      this.alarmed = false;
      return 'recovered';
    }
    return null;
  }

  get isSilent(): boolean {
    return this.alarmed;
  }
}

export function defaultCardwall(): CartSlot[] {
  const colors = ['#1fa971', '#1b7fd6', '#d9434f', '#e08a1e', '#7b4fd6', '#15a3b8'];
  const groups = ['Jingles', 'Sweeper', 'Station IDs', 'Drops', 'News', 'Werbung'];
  return Array.from({ length: 12 }, (_, i) => ({
    id: `cart${i + 1}`,
    label: `Cart ${i + 1}`,
    color: colors[i % colors.length]!,
    mediaId: null,
    group: groups[i % groups.length]!,
  }));
}

export const DEFAULT_CLOCK: ClockTemplate = {
  id: 'default',
  name: 'Standard-Stunde',
  slots: ['station_id', 'music', 'music', 'jingle', 'music', 'music', 'sweeper', 'music', 'music', 'drop', 'music', 'music'],
};
