import { createHash } from 'node:crypto';
import pg from 'pg';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
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

// Resolves once initDb() has created the schema. The HTTP server starts listening
// before initDb() runs, so OAuth queries await this rather than racing the boot
// (a fresh container can't resolve Railway's private DNS for a few seconds).
let markReady!: () => void;
const ready = new Promise<void>((resolve) => { markReady = resolve; });

// Creates the config and OAuth tables if absent. Wrapped in a retry loop because Railway's
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

        -- OAuth clients registered via dynamic client registration (/register).
        -- data holds the full client record, including client_secret: the SDK's
        -- client authentication compares secrets in plaintext, so it can't be hashed.
        CREATE TABLE IF NOT EXISTS oauth_clients (
          client_id text PRIMARY KEY,
          data jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );

        -- Issued access and refresh tokens, keyed by SHA-256 of the token so a
        -- database read never yields a usable bearer token.
        CREATE TABLE IF NOT EXISTS oauth_tokens (
          token_hash text PRIMARY KEY,
          kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
          client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
          expires_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS oauth_tokens_expires_at_idx ON oauth_tokens (expires_at);
      `);
      markReady();
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

// ---------------------------------------------------------------------------
// OAuth persistence. Clients and tokens live in Postgres so a redeploy or
// restart doesn't log every connected app out. Short-lived state (pending
// approvals, authorization codes) stays in memory in oauth.ts.
// ---------------------------------------------------------------------------

export type TokenKind = 'access' | 'refresh';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function getOAuthClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  await ready;
  const result = await pool.query<{ data: OAuthClientInformationFull }>(
    'SELECT data FROM oauth_clients WHERE client_id = $1',
    [clientId]
  );
  return result.rows[0]?.data;
}

export async function saveOAuthClient(client: OAuthClientInformationFull): Promise<void> {
  await ready;
  await pool.query(
    'INSERT INTO oauth_clients (client_id, data) VALUES ($1, $2)',
    [client.client_id, JSON.stringify(client)]
  );
}

export async function saveOAuthToken(
  token: string,
  kind: TokenKind,
  clientId: string,
  expiresAtMs: number
): Promise<void> {
  await ready;
  await pool.query(
    'INSERT INTO oauth_tokens (token_hash, kind, client_id, expires_at) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))',
    [hashToken(token), kind, clientId, expiresAtMs]
  );
}

// Returns the token's owner and expiry, or null if it was never issued, has
// expired, or is the wrong kind (an access token can't be used to refresh).
export async function findOAuthToken(
  token: string,
  kind: TokenKind
): Promise<{ clientId: string; expiresAtMs: number } | null> {
  await ready;
  const result = await pool.query<{ client_id: string; expires_ms: string }>(
    `SELECT client_id, (extract(epoch FROM expires_at) * 1000)::bigint AS expires_ms
       FROM oauth_tokens
      WHERE token_hash = $1 AND kind = $2 AND expires_at > now()`,
    [hashToken(token), kind]
  );
  const row = result.rows[0];
  return row ? { clientId: row.client_id, expiresAtMs: Number(row.expires_ms) } : null;
}

// Deletes expired tokens. Returns how many rows were removed.
export async function pruneExpiredOAuthTokens(): Promise<number> {
  await ready;
  const result = await pool.query('DELETE FROM oauth_tokens WHERE expires_at <= now()');
  return result.rowCount ?? 0;
}
