// Ablage der Programmdaten als benannte Dokumente („airdeck“, „users“, „tokens“ …).
//
//  FileDocStore – eine JSON-Datei je Dokument (bisheriges Verhalten; für eigenständige Module und Tests)
//  DbDocStore   – Datenbank: jedes Dokument wird auf Tabellenzeilen abgebildet (siehe mappings.ts).
//                 Geschrieben wird entprellt und nur, was sich geändert hat (Zeilenvergleich per Prüfsumme).
//                 Fällt die Datenbank aus, bleibt der Stand im Speicher maßgeblich, das Schreiben wird mit
//                 wachsendem Abstand wiederholt (DATABASE.md „Health“).

import { createHash } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeFileAtomic } from '../store.ts';
import { deleteSql, TABLES, upsertSql } from '../db/schema.ts';
import type { DatabaseProvider, Row } from '../db/types.ts';
import { mappingFor, type RowSet } from './mappings.ts';

export interface DocStoreStatus {
  kind: 'file' | 'database';
  state: 'ok' | 'error';
  lastError: string | null;
  lastWriteAt: number | null;
  pending: number;
}

export interface DocStore {
  get<T>(name: string, fallback: T): T;
  /** Festen Wert ablegen (z. B. Einstellungen) */
  set(name: string, value: unknown): void;
  /** Lebenden Wert anbinden: bei touch() wird der aktuelle Stand über den Getter gelesen */
  bind(name: string, getter: () => unknown): void;
  touch(name: string): void;
  flush(): Promise<void>;
  /** Letztes Speichern beim Beenden; bei Server-Datenbanken nur, was ohne Warten geht */
  flushSync(): void;
  onWrite: ((name: string) => void) | null;
  status(): DocStoreStatus;
}

/** Namen der bisherigen JSON-Dateien im Datenordner, die in die Datenbank übernommen werden. */
export const KNOWN_DOCS = ['airdeck', 'tokens', 'users', 'sessions', 'ai', 'ai-usage', 'update', 'nextcloud', 'bridge-keys'] as const;

const DELAY: Record<string, number> = { airdeck: 300, sessions: 1000, 'ai-usage': 2000 };

// ---------- Dateien ----------

export class FileDocStore implements DocStore {
  private readonly dir: string;
  private readonly values = new Map<string, unknown>();
  private readonly getters = new Map<string, () => unknown>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  onWrite: ((name: string) => void) | null = null;
  private lastWriteAt: number | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  get<T>(name: string, fallback: T): T {
    return readJson<T>(this.file(name), fallback);
  }

  set(name: string, value: unknown): void {
    this.values.set(name, value);
    this.write(name);
  }

  bind(name: string, getter: () => unknown): void {
    this.getters.set(name, getter);
  }

  touch(name: string): void {
    if (this.timers.has(name)) return;
    const t = setTimeout(() => this.write(name), DELAY[name] ?? 300);
    t.unref();
    this.timers.set(name, t);
  }

  private write(name: string): void {
    const t = this.timers.get(name);
    if (t) clearTimeout(t);
    this.timers.delete(name);
    const v = this.getters.get(name)?.() ?? this.values.get(name);
    if (v === undefined) return;
    writeFileAtomic(this.file(name), JSON.stringify(v, null, 1), 0o600);
    this.lastWriteAt = Date.now();
    this.onWrite?.(name);
  }

  async flush(): Promise<void> {
    this.flushSync();
  }

  flushSync(): void {
    for (const name of [...this.timers.keys()]) this.write(name);
  }

  status(): DocStoreStatus {
    return { kind: 'file', state: 'ok', lastError: null, lastWriteAt: this.lastWriteAt, pending: this.timers.size };
  }
}

// ---------- Datenbank ----------

type Plan = [string, unknown[]][];
const RETRY_S = [2, 5, 15, 30, 60];
const MAX_PARAMS = 900;

const sig = (values: unknown[]): string => createHash('sha1').update(JSON.stringify(values)).digest('base64');

export class DbDocStore implements DocStore {
  readonly db: DatabaseProvider;
  private readonly values = new Map<string, unknown>();
  private readonly getters = new Map<string, () => unknown>();
  /** zuletzt gespeicherte Zeilen je Dokument → Tabelle → Schlüssel → Prüfsumme */
  private readonly saved = new Map<string, Map<string, Map<string, string>>>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> | null = null;
  private failures = 0;
  private lastError: string | null = null;
  private lastWriteAt: number | null = null;
  onWrite: ((name: string) => void) | null = null;
  /** Zustandswechsel der Datenbank (für DATABASE_STATUS_CHANGED) */
  onStatus: ((s: DocStoreStatus) => void) | null = null;

  private constructor(db: DatabaseProvider) {
    this.db = db;
  }

  /** Laden (alle Datenbanken). */
  static async open(db: DatabaseProvider): Promise<DbDocStore> {
    const s = new DbDocStore(db);
    const rows: RowSet = new Map();
    for (const t of TABLES.keys()) rows.set(t, await db.query<Row>(`SELECT * FROM ${t}`));
    s.load(rows);
    return s;
  }

  /** Laden ohne Warten (nur SQLite) – für den synchronen Programmstart. */
  static openSync(db: DatabaseProvider): DbDocStore {
    if (!db.sync) throw new Error('openSync nur mit SQLite');
    const s = new DbDocStore(db);
    const rows: RowSet = new Map();
    for (const t of TABLES.keys()) rows.set(t, db.sync.query<Row>(`SELECT * FROM ${t}`));
    s.load(rows);
    return s;
  }

  private load(rows: RowSet): void {
    for (const t of rows.values()) for (const r of t) if (typeof r.data === 'string') r.data = JSON.parse(r.data);
    const names = new Set<string>([...KNOWN_DOCS]);
    for (const r of rows.get('settings') ?? []) if (r.scope === 'global') names.add(String(r.name));
    for (const name of names) {
      const m = mappingFor(name);
      const v = m.fromRows(rows);
      if (v === undefined) continue;
      this.values.set(name, v);
      // Ausgangsstand merken, damit das erste Speichern nur Änderungen schreibt
      this.saved.set(name, this.signatures(m.toRows(v)));
    }
  }

  private signatures(rows: RowSet): Map<string, Map<string, string>> {
    const out = new Map<string, Map<string, string>>();
    for (const [table, list] of rows) {
      const spec = TABLES.get(table)!;
      const cols = Object.keys(spec.columns);
      const m = new Map<string, string>();
      for (const r of list) m.set(JSON.stringify(spec.primaryKey.map((k) => r[k])), sig(cols.map((c) => r[c])));
      out.set(table, m);
    }
    return out;
  }

  get<T>(name: string, fallback: T): T {
    return this.values.has(name) ? (this.values.get(name) as T) : fallback;
  }

  set(name: string, value: unknown): void {
    this.values.set(name, value);
    this.touch(name);
  }

  bind(name: string, getter: () => unknown): void {
    this.getters.set(name, getter);
  }

  touch(name: string): void {
    this.dirty.add(name);
    this.schedule(DELAY[name] ?? 300);
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, ms);
    this.timer.unref();
  }

  private current(name: string): unknown {
    const g = this.getters.get(name);
    if (!g) return this.values.get(name);
    const v = g();
    this.values.set(name, v);
    return v;
  }

  /** Schreibplan für alle geänderten Dokumente + die neuen Prüfsummen (erst nach Erfolg übernehmen). */
  private plan(): { plan: Plan; next: Map<string, Map<string, Map<string, string>>>; names: string[] } {
    const plan: Plan = [];
    const next = new Map<string, Map<string, Map<string, string>>>();
    const names = [...this.dirty];
    for (const name of names) {
      const v = this.current(name);
      if (v === undefined) continue;
      const rows = mappingFor(name).toRows(v);
      const before = this.saved.get(name) ?? new Map<string, Map<string, string>>();
      const after = this.signatures(rows);
      next.set(name, after);
      for (const [table, list] of rows) {
        const spec = TABLES.get(table)!;
        const cols = Object.keys(spec.columns);
        const old = before.get(table) ?? new Map<string, string>();
        const now = after.get(table)!;
        const changed = list.filter((r) => old.get(JSON.stringify(spec.primaryKey.map((k) => r[k]))) !== now.get(JSON.stringify(spec.primaryKey.map((k) => r[k]))));
        const per = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
        for (let i = 0; i < changed.length; i += per) {
          const chunk = changed.slice(i, i + per);
          plan.push([upsertSql(this.db.dialect, table, cols, spec.primaryKey, chunk.length), chunk.flatMap((r) => cols.map((c) => (c === 'data' ? JSON.stringify(r[c]) : r[c] ?? null)))]);
        }
      }
      // weggefallene Zeilen (nur die, die dieses Dokument selbst geschrieben hat)
      for (const [table, old] of before) {
        const spec = TABLES.get(table)!;
        const now = after.get(table);
        const gone = [...old.keys()].filter((k) => !now?.has(k)).map((k) => JSON.parse(k) as unknown[]);
        const per = Math.max(1, Math.floor(MAX_PARAMS / spec.primaryKey.length));
        for (let i = 0; i < gone.length; i += per) {
          const chunk = gone.slice(i, i + per);
          plan.push([deleteSql(table, spec.primaryKey, chunk.length), chunk.flat()]);
        }
      }
    }
    return { plan, next, names };
  }

  private done(names: string[], next: Map<string, Map<string, Map<string, string>>>): void {
    for (const [n, s] of next) this.saved.set(n, s);
    this.lastWriteAt = Date.now();
    const wasError = this.lastError !== null;
    this.failures = 0;
    this.lastError = null;
    if (wasError) this.onStatus?.(this.status());
    for (const n of names) this.onWrite?.(n);
  }

  private failed(names: string[], err: unknown): void {
    // Änderungen bleiben vorgemerkt und werden später erneut geschrieben
    for (const n of names) this.dirty.add(n);
    const wasOk = this.lastError === null;
    this.lastError = (err as Error).message;
    const delay = RETRY_S[Math.min(this.failures, RETRY_S.length - 1)]! * 1000;
    this.failures++;
    if (wasOk) this.onStatus?.(this.status());
    this.schedule(delay);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // nie zwei Schreibvorgänge gleichzeitig: sonst könnten Prüfsummen einander überholen
    while (this.writing) await this.writing.catch(() => {});
    if (!this.dirty.size) return;
    const { plan, next, names } = this.plan();
    this.dirty.clear();
    if (!plan.length) return this.done(names, next);
    this.writing = (async () => {
      try {
        await this.db.transaction(async (tx) => {
          for (const [sql, params] of plan) await tx.exec(sql, params);
        });
        this.done(names, next);
      } catch (err) {
        this.failed(names, err);
        throw err;
      } finally {
        this.writing = null;
      }
    })();
    return this.writing;
  }

  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const s = this.db.sync;
    if (!s || this.writing || !this.dirty.size) {
      // Server-Datenbank: letzter Schreibvorgang läuft asynchron weiter (main.ts wartet darauf)
      if (!s) void this.flush().catch(() => {});
      return;
    }
    const { plan, next, names } = this.plan();
    this.dirty.clear();
    try {
      s.transaction(() => {
        for (const [sql, params] of plan) s.exec(sql, params);
      });
      this.done(names, next);
    } catch (err) {
      this.failed(names, err);
    }
  }

  status(): DocStoreStatus {
    return { kind: 'database', state: this.lastError ? 'error' : 'ok', lastError: this.lastError, lastWriteAt: this.lastWriteAt, pending: this.dirty.size };
  }
}

function readImportable(dir: string, store: DbDocStore): string[] {
  const found: string[] = [];
  for (const n of KNOWN_DOCS) {
    const f = join(dir, `${n}.json`);
    if (!existsSync(f)) continue;
    // defekte Dateien sichert readJson selbst (…corrupt-<zeit>) – dann gibt es nichts zu übernehmen
    const v = readJson<unknown>(f, undefined);
    if (v === undefined || v === null) continue;
    store.set(n, v);
    found.push(n);
  }
  return found;
}

function markImported(dir: string, store: DbDocStore, found: string[], log: (name: string) => void): string[] {
  if (store.status().state === 'error') throw new Error(`Übernahme der JSON-Daten fehlgeschlagen: ${store.status().lastError}`);
  for (const n of found) {
    const f = join(dir, `${n}.json`);
    renameSync(f, existsSync(`${f}.imported`) ? `${f}.imported-${Date.now()}` : `${f}.imported`);
    log(n);
  }
  return found;
}

/**
 * Übernahme der bisherigen JSON-Dateien (Migration „000_import_json“): Jede vorhandene Datei ersetzt das
 * gleichnamige Dokument und wird danach in `<name>.json.imported` umbenannt. Gelöscht wird nichts.
 * Dasselbe gilt für einen vom Sync geholten Stand (sync.ts schreibt airdeck.json).
 */
export async function importJsonFiles(dir: string, store: DbDocStore, log: (name: string) => void = () => {}): Promise<string[]> {
  const found = readImportable(dir, store);
  if (!found.length) return [];
  await store.flush().catch(() => {});
  return markImported(dir, store, found, log);
}

/** Dasselbe ohne Warten (SQLite beim synchronen Start). */
export function importJsonFilesSync(dir: string, store: DbDocStore, log: (name: string) => void = () => {}): string[] {
  const found = readImportable(dir, store);
  if (!found.length) return [];
  store.flushSync();
  return markImported(dir, store, found, log);
}
