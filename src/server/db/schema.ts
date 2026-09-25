// Schema und Migrationen. Tabellen werden einmal beschrieben und je Dialekt als DDL erzeugt –
// so gibt es keine drei Fassungen derselben Migration, und die Migrationen stecken im Programm
// (auch im Windows-Einzelprogramm, das keine losen SQL-Dateien mitliefert).

import type { DatabaseProvider, Dialect } from './types.ts';

export type ColType = 'key' | 'text' | 'long' | 'int' | 'bigint' | 'real';

export interface TableSpec {
  name: string;
  columns: Record<string, ColType>;
  primaryKey: string[];
  indexes?: string[][];
}

function colType(t: ColType, d: Dialect): string {
  switch (t) {
    // Schlüssel: MySQL braucht eine feste Länge für Primärschlüssel und Indizes
    case 'key': return d === 'mysql' ? 'VARCHAR(191)' : 'TEXT';
    case 'text': return d === 'mysql' ? 'TEXT' : 'TEXT';
    case 'long': return d === 'mysql' ? 'LONGTEXT' : 'TEXT';
    case 'int': return 'INTEGER';
    case 'bigint': return d === 'sqlite' ? 'INTEGER' : 'BIGINT';
    case 'real': return d === 'postgres' ? 'DOUBLE PRECISION' : d === 'mysql' ? 'DOUBLE' : 'REAL';
  }
}

export function createTableSql(t: TableSpec, d: Dialect): string[] {
  const cols = Object.entries(t.columns).map(([c, ty]) => `${c} ${colType(ty, d)}${t.primaryKey.includes(c) ? ' NOT NULL' : ''}`);
  const tail = d === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' : '';
  const out = [`CREATE TABLE IF NOT EXISTS ${t.name} (${cols.join(', ')}, PRIMARY KEY (${t.primaryKey.join(', ')}))${tail}`];
  for (const idx of t.indexes ?? []) {
    const name = `ix_${t.name}_${idx.join('_')}`;
    // MySQL kennt kein CREATE INDEX IF NOT EXISTS – die Migration läuft ohnehin nur einmal
    out.push(d === 'mysql' ? `CREATE INDEX ${name} ON ${t.name} (${idx.join(', ')})` : `CREATE INDEX IF NOT EXISTS ${name} ON ${t.name} (${idx.join(', ')})`);
  }
  return out;
}

/**
 * Erste Fassung. Jede Zeile hat die Such- und Sortierspalten, die die Datenbank braucht, und den
 * vollständigen Datensatz als JSON in `data` (als Text – keine Abhängigkeit von JSON-Funktionen der Datenbank).
 */
const S = 'station_id';
const perStation = (name: string, extra: Record<string, ColType> = {}, indexes: string[][] = []): TableSpec => ({
  name, columns: { [S]: 'key', id: 'key', position: 'int', ...extra, data: 'long' }, primaryKey: [S, 'id'], indexes: [[S, 'position'], ...indexes],
});

export const TABLES_V1: TableSpec[] = [
  { name: 'stations', columns: { id: 'key', name: 'text', position: 'int', data: 'long' }, primaryKey: ['id'] },
  perStation('sources'),
  perStation('outputs'),
  perStation('media', { title: 'text', artist: 'text', category: 'key', file: 'text', duration_ms: 'bigint', added_at: 'bigint' }, [[S, 'category']]),
  perStation('playlists'),
  { name: 'playlist_items', columns: { [S]: 'key', playlist_id: 'key', position: 'int', media_id: 'key' }, primaryKey: [S, 'playlist_id', 'position'] },
  perStation('queue_items', { media_id: 'key', origin: 'key', added_at: 'bigint' }),
  perStation('clock_templates'),
  perStation('clock_events'),
  perStation('program_plans'),
  perStation('jobs'),
  perStation('recording_plans'),
  perStation('recordings'),
  perStation('play_log', { at: 'bigint', media_id: 'key' }, [[S, 'at']]),
  { name: 'settings', columns: { scope: 'key', name: 'key', data: 'long' }, primaryKey: ['scope', 'name'] },
  { name: 'users', columns: { id: 'key', username: 'key', data: 'long' }, primaryKey: ['id'], indexes: [['username']] },
  { name: 'sessions', columns: { id: 'key', user_id: 'key', expires_at: 'bigint', data: 'long' }, primaryKey: ['id'], indexes: [['user_id']] },
  { name: 'api_tokens', columns: { id: 'key', hash: 'key', data: 'long' }, primaryKey: ['id'], indexes: [['hash']] },
  { name: 'bridge_keys', columns: { id: 'key', station_id: 'key' }, primaryKey: ['id'] },
  { name: 'ai_usage', columns: { id: 'key', data: 'long' }, primaryKey: ['id'] },
];

export const TABLES = new Map(TABLES_V1.map((t) => [t.name, t]));

export interface Migration {
  version: number;
  name: string;
  up: (d: Dialect) => string[];
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial', up: (d) => TABLES_V1.flatMap((t) => createTableSql(t, d)) },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Führt ausstehende Migrationen aus. Stand in meta.schema_version. */
export async function migrate(db: DatabaseProvider): Promise<{ from: number; to: number }> {
  const metaSql = createTableSql({ name: 'meta', columns: { name: 'key', value: 'text' }, primaryKey: ['name'] }, db.dialect)[0]!;
  await db.exec(metaSql);
  const cur = Number((await db.query<{ value: string }>("SELECT value FROM meta WHERE name = 'schema_version'"))[0]?.value ?? 0);
  if (cur > SCHEMA_VERSION) throw new Error(`Die Datenbank hat Schema ${cur}, dieses Programm kennt nur ${SCHEMA_VERSION}. Bitte AirDeck aktualisieren.`);
  for (const m of MIGRATIONS.filter((x) => x.version > cur)) {
    // SQLite und PostgreSQL führen DDL transaktional aus; bei MySQL schützt die Sicherung vor der Migration
    await db.transaction(async (tx) => {
      for (const sql of m.up(db.dialect)) await tx.exec(sql);
      await tx.exec(upsertSql(db.dialect, 'meta', ['name', 'value'], ['name']), ['schema_version', String(m.version)]);
    });
  }
  return { from: cur, to: Math.max(cur, SCHEMA_VERSION) };
}

/** Synchrone Variante für SQLite beim Start. */
export function migrateSync(db: DatabaseProvider): { from: number; to: number } {
  const s = db.sync!;
  s.exec(createTableSql({ name: 'meta', columns: { name: 'key', value: 'text' }, primaryKey: ['name'] }, 'sqlite')[0]!);
  const cur = Number(s.query<{ value: string }>("SELECT value FROM meta WHERE name = 'schema_version'")[0]?.value ?? 0);
  if (cur > SCHEMA_VERSION) throw new Error(`Die Datenbank hat Schema ${cur}, dieses Programm kennt nur ${SCHEMA_VERSION}. Bitte AirDeck aktualisieren.`);
  for (const m of MIGRATIONS.filter((x) => x.version > cur)) {
    s.transaction(() => {
      for (const sql of m.up('sqlite')) s.exec(sql);
      s.exec(upsertSql('sqlite', 'meta', ['name', 'value'], ['name']), ['schema_version', String(m.version)]);
    });
  }
  return { from: cur, to: Math.max(cur, SCHEMA_VERSION) };
}

/** Mehrzeiliges Upsert: INSERT … VALUES (…),(…) mit ON CONFLICT bzw. ON DUPLICATE KEY. */
export function upsertSql(d: Dialect, table: string, cols: string[], pk: string[], rows = 1): string {
  const one = `(${cols.map(() => '?').join(', ')})`;
  const values = Array.from({ length: rows }, () => one).join(', ');
  const upd = cols.filter((c) => !pk.includes(c));
  const base = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values}`;
  if (d === 'mysql') return `${base} ON DUPLICATE KEY UPDATE ${(upd.length ? upd : pk).map((c) => `${c} = VALUES(${c})`).join(', ')}`;
  return `${base} ON CONFLICT (${pk.join(', ')}) DO ${upd.length ? `UPDATE SET ${upd.map((c) => `${c} = excluded.${c}`).join(', ')}` : 'NOTHING'}`;
}

/** DELETE für mehrere Schlüssel (auch zusammengesetzte). */
export function deleteSql(table: string, pk: string[], rows: number): string {
  const one = pk.length === 1 ? `${pk[0]} = ?` : `(${pk.map((c) => `${c} = ?`).join(' AND ')})`;
  return `DELETE FROM ${table} WHERE ${Array.from({ length: rows }, () => one).join(' OR ')}`;
}
