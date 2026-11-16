import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { migrations } from './schema.ts';

export interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export class Database implements Queryable {
  private constructor(private readonly embedded: PGlite | null, private readonly pool: pg.Pool | null,
    private readonly lock: pg.PoolClient | null) {}
  static async open(options: { directory?: string; url?: string } = {}): Promise<Database> {
    let database: Database;
    if (options.url) {
      const pool = new pg.Pool({ connectionString: options.url, max: 4 });
      const lock = await pool.connect();
      const result = await lock.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(27112602) AS acquired');
      if (!result.rows[0]?.acquired) { lock.release(); await pool.end(); throw new Error('Another OutOfOffice process owns this database.'); }
      database = new Database(null, pool, lock);
    } else {
      if (options.directory) await mkdir(options.directory, { recursive: true });
      const embedded = new PGlite(options.directory ? join(options.directory, 'postgres') : undefined);
      await embedded.waitReady; database = new Database(embedded, null, null);
    }
    try {
      await database.transaction(async tx => { for (const sql of migrations) await tx.query(sql); });
      return database;
    } catch (error) { await database.close(); throw error; }
  }
  async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    if (this.embedded) return this.embedded.query<T>(sql, params);
    return this.pool!.query<T>(sql, params);
  }
  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    if (this.embedded) return this.embedded.transaction(tx => work(tx));
    const connection = await this.pool!.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT pg_advisory_xact_lock(hashtext('OutOfOffice-control'))");
      const result = await work(connection);
      await connection.query('COMMIT'); return result;
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
  async close(): Promise<void> {
    if (this.embedded) await this.embedded.close();
    if (this.lock) { await this.lock.query('SELECT pg_advisory_unlock(27112602)'); this.lock.release(); }
    if (this.pool) await this.pool.end();
  }
}
