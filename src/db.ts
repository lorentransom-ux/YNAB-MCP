import pg from 'pg';
import type { AppConfig } from './config.js';

// Single shared connection pool. Railway injects DATABASE_URL — in production it
// references the Postgres service's PRIVATE URL (host postgres.railway.internal),
// so traffic stays on the internal network and incurs no egress fees.
const connectionString = process.env.DATABASE_URL;

// SSL is only needed when connecting over Railway's PUBLIC proxy (*.rlwy.net) or
// any other non-private, non-local host. The private network and local Postgres
// connect without TLS.
function needsSsl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    if (host.endsWith('.railway.internal')) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    return true;
  } catch {
    return false;
  }
}

const pool = new pg.Pool({
  connectionString,
  ...(needsSsl(connectionString) ? { ssl: { rejectUnauthorized: false } } : {}),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Creates the config table if absent. Wrapped in a retry loop because Railway's
// private DNS is not resolvable for the first few seconds of a fresh container's
// life — without this a redeploy can crash on the boot race with ENOTFOUND.
export async function initDb(): Promise<void> {
  if (!connectionString) {
    throw new Error('[DB] DATABASE_URL is not set — cannot connect to Postgres');
  }
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_config (
          id int PRIMARY KEY DEFAULT 1,
          data jsonb NOT NULL,
          CHECK (id = 1)
        );
      `);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === attempts) {
        throw new Error(`[DB] Failed to initialize after ${attempts} attempts: ${msg}`);
      }
      const backoff = Math.min(2000, 500 * attempt);
      console.warn(`[DB] Connection attempt ${attempt}/${attempts} failed (${msg}) — retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

// Returns the single stored config blob, or null if none has been saved yet.
export async function readConfigRow(): Promise<AppConfig | null> {
  const result = await pool.query<{ data: AppConfig }>('SELECT data FROM app_config WHERE id = 1');
  return result.rows[0]?.data ?? null;
}

// Upserts the single config blob.
export async function writeConfigRow(config: AppConfig): Promise<void> {
  await pool.query(
    `INSERT INTO app_config (id, data) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [JSON.stringify(config)]
  );
}
