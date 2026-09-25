// PostgreSQL über „pg“ (reines JavaScript). Standard für Self-Hosted-Server.

import pg from 'pg';
import type { DatabaseProvider, DbHealth, Row } from './types.ts';

/** `?` → `$1, $2 …` (Fragezeichen in Zeichenketten-Literalen kommen in unserem SQL nicht vor) */
export function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// BIGINT (Zeitstempel in ms) als Zahl statt als Text liefern – die Werte liegen weit unter 2^53
pg.types.setTypeParser(20, (v) => Number(v));

type Client = pg.Pool | pg.PoolClient;

class PgTx implements DatabaseProvider {
  readonly dialect = 'postgres' as const;
  protected readonly client: Client;
  constructor(client: Client) {
    this.client = client;
  }
  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.client.query(toPg(sql), params)).rows as T[];
  }
  async exec(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return { changes: (await this.client.query(toPg(sql), params)).rowCount ?? 0 };
  }
  async transaction<T>(fn: (tx: DatabaseProvider) => Promise<T>): Promise<T> {
    // bereits in einer Transaktion: Savepoint
    await this.client.query('SAVEPOINT sp');
    try {
      const r = await fn(this);
      await this.client.query('RELEASE SAVEPOINT sp');
      return r;
    } catch (err) {
      await this.client.query('ROLLBACK TO SAVEPOINT sp');
      throw err;
    }
  }
  async health(): Promise<DbHealth> {
    return { ok: true, engine: 'PostgreSQL', version: '?', latencyMs: 0 };
  }
  async close(): Promise<void> {}
}

export class PostgresProvider extends PgTx {
  private readonly pool: pg.Pool;

  constructor(url: string, opts: { password?: string; max?: number } = {}) {
    // pg übernimmt Werte aus der Adresse vorrangig – ein getrennt übergebenes Passwort daher in die Adresse setzen
    let connectionString = url;
    if (opts.password) {
      const u = new URL(url);
      u.password = encodeURIComponent(opts.password);
      connectionString = u.toString();
    }
    const pool = new pg.Pool({ connectionString, max: opts.max ?? 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
    // Verbindungsabbrüche im Leerlauf nicht als unbehandelten Fehler werfen – der nächste Zugriff verbindet neu
    pool.on('error', () => {});
    super(pool);
    this.pool = pool;
  }

  override async transaction<T>(fn: (tx: DatabaseProvider) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(new PgTx(c));
      await c.query('COMMIT');
      return r;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  override async health(): Promise<DbHealth> {
    const t = performance.now();
    try {
      const v = (await this.pool.query<{ v: string }>('SHOW server_version')).rows[0]?.v ?? '?';
      return { ok: true, engine: 'PostgreSQL', version: v.split(' ')[0]!, latencyMs: Math.round((performance.now() - t) * 10) / 10 };
    } catch (err) {
      return { ok: false, engine: 'PostgreSQL', version: '?', latencyMs: 0, error: (err as Error).message };
    }
  }

  override async close(): Promise<void> {
    await this.pool.end();
  }
}
