// MariaDB und MySQL über „mysql2“.

import mysql from 'mysql2/promise';
import type { DatabaseProvider, DbHealth, Row } from './types.ts';

type Conn = mysql.Pool | mysql.PoolConnection;

class MyTx implements DatabaseProvider {
  readonly dialect = 'mysql' as const;
  protected readonly conn: Conn;
  constructor(conn: Conn) {
    this.conn = conn;
  }
  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.conn.query(sql, params);
    return rows as T[];
  }
  async exec(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const [r] = await this.conn.query(sql, params);
    return { changes: (r as mysql.ResultSetHeader).affectedRows ?? 0 };
  }
  async transaction<T>(fn: (tx: DatabaseProvider) => Promise<T>): Promise<T> {
    await this.conn.query('SAVEPOINT sp');
    try {
      const r = await fn(this);
      await this.conn.query('RELEASE SAVEPOINT sp');
      return r;
    } catch (err) {
      await this.conn.query('ROLLBACK TO SAVEPOINT sp');
      throw err;
    }
  }
  async health(): Promise<DbHealth> {
    return { ok: true, engine: 'MySQL', version: '?', latencyMs: 0 };
  }
  async close(): Promise<void> {}
}

export class MysqlProvider extends MyTx {
  private readonly pool: mysql.Pool;

  constructor(url: string, opts: { password?: string; max?: number } = {}) {
    const u = new URL(url);
    const pool = mysql.createPool({
      host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username),
      password: opts.password ?? decodeURIComponent(u.password), database: u.pathname.replace(/^\//, ''),
      connectionLimit: opts.max ?? 5, connectTimeout: 10_000, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: false,
    });
    super(pool);
    this.pool = pool;
  }

  override async transaction<T>(fn: (tx: DatabaseProvider) => Promise<T>): Promise<T> {
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const r = await fn(new MyTx(c));
      await c.commit();
      return r;
    } catch (err) {
      await c.rollback().catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  override async health(): Promise<DbHealth> {
    const t = performance.now();
    try {
      const [rows] = await this.pool.query('SELECT VERSION() AS v');
      const v = String((rows as { v: string }[])[0]?.v ?? '?');
      return { ok: true, engine: /mariadb/i.test(v) ? 'MariaDB' : 'MySQL', version: v.split('-')[0]!, latencyMs: Math.round((performance.now() - t) * 10) / 10 };
    } catch (err) {
      return { ok: false, engine: 'MySQL', version: '?', latencyMs: 0, error: (err as Error).message };
    }
  }

  override async close(): Promise<void> {
    await this.pool.end();
  }
}
