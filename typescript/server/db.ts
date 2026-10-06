// One pool for the process. DATABASE_URL is used exactly as given: it carries sslmode=verify-full, and the driver checks
// the database's certificate against the system's CAs. Never set a host, password or TLS option of your own.
import pg from 'pg';
import { required } from './env.ts';
import { log } from './log.ts';

const { DATABASE_URL } = required('DATABASE_URL');

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
pool.on('error', (e) => log.warn('database connection lost', { error: e.message }));

// Runs `fn` in one transaction: everything it writes lands together, or nothing does.
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
