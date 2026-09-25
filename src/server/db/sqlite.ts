// SQLite über node:sqlite (in Node 22 eingebaut, kein natives Zusatzmodul, läuft auch im Windows-Einzelprogramm).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseProvider, DbHealth, Row, SyncAccess } from './types.ts';

type SqliteModule = typeof import('node:sqlite');
type Db = InstanceType<SqliteModule['DatabaseSync']>;
type Param = null | number | bigint | string | Uint8Array;

/** node:sqlite meldet sich in Node 22 noch als „experimentell“ – diese eine Warnung unterdrücken. */
function loadSqlite(): SqliteModule {
  const orig = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    const text = typeof w === 'string' ? w : w.message;
    if (/SQLite is an experimental feature/.test(text)) return;
    return (orig as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    return process.getBuiltinModule('node:sqlite') as SqliteModule;
  } finally {
    process.emitWarning = orig;
  }
}

const param = (v: unknown): Param => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || v instanceof Uint8Array) return v;
  return JSON.stringify(v);
};

export class SqliteProvider implements DatabaseProvider {
  readonly dialect = 'sqlite' as const;
  readonly file: string;
  private readonly db: Db;
  private depth = 0;
  private closed = false;
  readonly sync: SyncAccess;

  constructor(file: string) {
    this.file = file;
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(file);
    // WAL: Lesen und Schreiben blockieren sich nicht; NORMAL reicht mit WAL für Absturzsicherheit
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const self = this;
    this.sync = {
      query<T>(sql: string, params: unknown[] = []): T[] {
        return self.db.prepare(sql).all(...params.map(param)) as T[];
      },
      exec(sql: string, params: unknown[] = []) {
        if (!params.length && sql.includes(';')) {
          self.db.exec(sql);
          return { changes: 0 };
        }
        return { changes: Number(self.db.prepare(sql).run(...params.map(param)).changes) };
      },
      transaction<T>(fn: () => T): T {
        // verschachtelt über Savepoints
        const sp = `sp${self.depth}`;
        self.db.exec(self.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
        self.depth++;
        try {
          const r = fn();
          self.depth--;
          self.db.exec(self.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
          return r;
        } catch (err) {
          self.depth--;
          self.db.exec(self.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw err;
        }
      },
    };
  }

  async query<T = Row>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.sync.query<T>(sql, params);
  }

  async exec(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    return this.sync.exec(sql, params);
  }

  async transaction<T>(fn: (tx: DatabaseProvider) => Promise<T>): Promise<T> {
    // Schreibzugriffe laufen bei SQLite ohnehin nacheinander; die Arbeit darf aber nicht über await
    // mit anderen Schreibern verschränkt werden – daher nur Funktionen ohne echte Wartezeit übergeben.
    const sp = `sp${this.depth}`;
    this.db.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const r = await fn(this);
      this.depth--;
      this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return r;
    } catch (err) {
      this.depth--;
      this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  async health(): Promise<DbHealth> {
    const t = performance.now();
    try {
      const v = this.sync.query<{ v: string }>('SELECT sqlite_version() AS v')[0]?.v ?? '?';
      return { ok: true, engine: 'SQLite', version: v, latencyMs: Math.round((performance.now() - t) * 10) / 10 };
    } catch (err) {
      return { ok: false, engine: 'SQLite', version: '?', latencyMs: 0, error: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
