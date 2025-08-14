import 'dotenv/config';
import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') || process.env.DATABASE_URL?.includes('supabase.co')
    ? { rejectUnauthorized: false }
    : false
});

export async function query(q, params) {
  const client = await pool.connect();
  try { return await client.query(q, params); }
  finally { client.release(); }
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const res = await fn(client);
    await client.query('commit');
    return res;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}
