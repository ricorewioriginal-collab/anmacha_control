// Datenbankschicht (docs/architecture/DATABASE.md). Außerhalb von src/server/db schreibt kein Modul SQL.

export type Dialect = 'sqlite' | 'postgres' | 'mysql';
export type Row = Record<string, unknown>;

export interface DbHealth {
  ok: boolean;
  engine: string;
  version: string;
  latencyMs: number;
  error?: string;
}

/**
 * Gemeinsame Schnittstelle aller Datenbanken. SQL wird immer mit `?` als Platzhalter geschrieben,
 * der Provider übersetzt bei Bedarf (PostgreSQL: $1, $2 …).
 */
export interface DatabaseProvider {
  readonly dialect: Dialect;
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  transaction<T>(fn: (tx: DatabaseProvider) => Promise<T>): Promise<T>;
  health(): Promise<DbHealth>;
  close(): Promise<void>;
  /** Nur SQLite: synchroner Zugriff (Laden beim Start, letztes Speichern beim Beenden) */
  readonly sync?: SyncAccess;
}

export interface SyncAccess {
  query<T = Row>(sql: string, params?: unknown[]): T[];
  exec(sql: string, params?: unknown[]): { changes: number };
  transaction<T>(fn: () => T): T;
}

export class DatabaseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
