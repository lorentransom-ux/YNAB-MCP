import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError, InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  getOAuthClient,
  saveOAuthClient,
  saveOAuthToken,
  findOAuthToken,
  pruneExpiredOAuthTokens,
} from './db.js';
import { loadConfig } from './config.js';
import { isTelegramConfigured, sendTelegram } from './telegram.js';

interface PendingAuth {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
  failedAttempts: number;
}

interface AuthCode {
  challenge: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
}

const ACCESS_TOKEN_TTL_S = 3600;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Registered clients and issued tokens are stored in Postgres (see db.ts) so they
// survive redeploys. Only the approval flow's short-lived state stays in memory:
// pending approvals expire in 10 minutes and authorization codes in 5, so losing
// them on a restart just means retrying a login that was mid-flight.
const pendingAuths = new Map<string, PendingAuth>();
const authCodes = new Map<string, AuthCode>();

function pruneExpired(): void {
  const now = Date.now();
  for (const map of [pendingAuths, authCodes]) {
    for (const [key, entry] of map) {
      if (entry.expiresAt < now) map.delete(key);
    }
  }
  pruneExpiredOAuthTokens().catch((err) => {
    console.error('[OAuth] Failed to prune expired tokens:', err instanceof Error ? err.message : err);
  });
}

const pruneTimer = setInterval(pruneExpired, 10 * 60 * 1000);
pruneTimer.unref?.();

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Approval passphrase. Client registration is open (connectors register
// themselves), so without this anyone who learned the server URL could register
// an app and click Approve on their own behalf. APPROVAL_PASSPHRASE proves the
// person approving is the owner. If it isn't set, approvals are refused: failing
// closed is safer than silently reverting to an unprotected Approve button.
// ---------------------------------------------------------------------------

const APPROVAL_PASSPHRASE = process.env.APPROVAL_PASSPHRASE ?? '';
const MAX_FAILURES_PER_REQUEST = 5;
const LOCKOUT_FAILURES = 10;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

let recentFailures: number[] = [];
let lockedUntil = 0;

export function approvalsEnabled(): boolean {
  return APPROVAL_PASSPHRASE.length > 0;
}

// Hash both sides first so timingSafeEqual gets equal-length inputs and the
// comparison time doesn't reveal how much of a guess was right.
function passphraseMatches(input: string): boolean {
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(APPROVAL_PASSPHRASE).digest();
  return timingSafeEqual(a, b);
}

function clientLabel(client: OAuthClientInformationFull): string {
  // Plain text only: the alert is sent with Markdown parsing enabled, and the
  // name is supplied by whoever registered the client.
  return (client.client_name ?? 'unnamed app').replace(/[^\w .()-]/g, '').slice(0, 60) || 'unnamed app';
}

// Security alerts go to USER1 (the server owner) over Telegram. Failures to
// alert are logged, never thrown, so they can't break the approval response.
function sendSecurityAlert(text: string): void {
  console.warn(`[OAuth] SECURITY: ${text}`);
  const ownerName = process.env.USER1_NAME?.toLowerCase();
  const owner = loadConfig().users.find((u) => u.name.toLowerCase() === ownerName);
  if (!isTelegramConfigured() || !owner?.telegramChatId) {
    console.error('[OAuth] Could not send security alert: Telegram or USER1 chat ID not configured');
    return;
  }
  sendTelegram(owner.telegramChatId, `⚠️ YNAB MCP security: ${text}`).catch(() => {
    /* sendTelegram already logged the failure */
  });
}

function recordFailure(client: OAuthClientInformationFull, pending: PendingAuth): void {
  const now = Date.now();
  recentFailures = recentFailures.filter((t) => now - t < LOCKOUT_WINDOW_MS);
  recentFailures.push(now);
  pending.failedAttempts += 1;

  if (recentFailures.length >= LOCKOUT_FAILURES) {
    lockedUntil = now + LOCKOUT_WINDOW_MS;
    recentFailures = [];
    sendSecurityAlert(
      `${LOCKOUT_FAILURES} wrong approval passphrases in 15 minutes. Approvals are locked for 15 minutes. ` +
        `If this wasn't you, someone knows your server address.`
    );
  } else if (pending.failedAttempts === 1) {
    sendSecurityAlert(`wrong approval passphrase entered while connecting "${clientLabel(client)}".`);
  }
}

export type ApprovalResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'page'; status: number; html: string }
  | { kind: 'error'; status: number; message: string };

// Called by the /oauth/approve POST route in index.ts
export function handleApproval(
  nonce: string,
  action: 'approve' | 'deny',
  passphrase: string | undefined
): ApprovalResult {
  const pending = pendingAuths.get(nonce);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingAuths.delete(nonce);
    return { kind: 'error', status: 400, message: 'Authorization request expired or not found. Please try connecting again.' };
  }

  if (action === 'approve') {
    if (!approvalsEnabled()) {
      console.error('[OAuth] Approval refused: APPROVAL_PASSPHRASE is not set on the server');
      return {
        kind: 'error',
        status: 503,
        message: 'Approvals are disabled because APPROVAL_PASSPHRASE is not set on the server. Set it in Railway, then connect again.',
      };
    }
    if (Date.now() < lockedUntil) {
      return {
        kind: 'error',
        status: 429,
        message: 'Too many wrong passphrases. Approvals are locked for 15 minutes.',
      };
    }
    if (!passphrase || !passphraseMatches(passphrase)) {
      recordFailure(pending.client, pending);
      if (pending.failedAttempts >= MAX_FAILURES_PER_REQUEST || Date.now() < lockedUntil) {
        pendingAuths.delete(nonce);
        return { kind: 'error', status: 403, message: 'Too many wrong passphrases. Please start connecting again.' };
      }
      return { kind: 'page', status: 401, html: renderApprovalPage(pending.client, nonce, 'Incorrect passphrase. Try again.') };
    }
  }

  pendingAuths.delete(nonce);
  const url = new URL(pending.params.redirectUri);

  if (action === 'deny') {
    url.searchParams.set('error', 'access_denied');
    if (pending.params.state) url.searchParams.set('state', pending.params.state);
    return { kind: 'redirect', url: url.toString() };
  }

  const code = randomUUID();
  authCodes.set(code, {
    challenge: pending.params.codeChallenge,
    clientId: pending.client.client_id,
    redirectUri: pending.params.redirectUri,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  console.log(`[OAuth] Approved client ${pending.client.client_id} (${clientLabel(pending.client)})`);

  url.searchParams.set('code', code);
  if (pending.params.state) url.searchParams.set('state', pending.params.state);
  return { kind: 'redirect', url: url.toString() };
}

function renderApprovalPage(client: OAuthClientInformationFull, nonce: string, error?: string): string {
  const appName = escapeHtml(client.client_name ?? 'An application');
  const nonceEscaped = escapeHtml(nonce);
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize YNAB Access</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 440px; margin: 80px auto; padding: 0 24px; color: #111; }
    h1 { font-size: 1.25rem; margin-bottom: 8px; }
    p { color: #555; line-height: 1.5; }
    .error { color: #b91c1c; font-weight: 500; }
    label { display: block; margin-top: 24px; font-weight: 500; }
    input[type=password] { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 10px; font-size: 1rem; border: 1px solid #d1d5db; border-radius: 6px; }
    .buttons { display: flex; gap: 12px; margin-top: 20px; }
    button { padding: 10px 24px; border-radius: 6px; border: none; cursor: pointer; font-size: 1rem; font-weight: 500; }
    .approve { background: #0f766e; color: #fff; }
    .approve:hover { background: #0d6460; }
    .deny { background: #e5e7eb; color: #374151; }
    .deny:hover { background: #d1d5db; }
  </style>
</head>
<body>
  <h1>Authorize YNAB access?</h1>
  <p><strong>${appName}</strong> is requesting access to read and change your YNAB budget through this MCP server, including adding, editing, and deleting transactions.</p>
  ${errorHtml}
  <form method="POST" action="/oauth/approve">
    <input type="hidden" name="nonce" value="${nonceEscaped}">
    <input type="hidden" name="action" value="approve">
    <label for="passphrase">Approval passphrase</label>
    <input type="password" id="passphrase" name="passphrase" autocomplete="current-password" required autofocus>
    <div class="buttons">
      <button type="submit" class="approve">Approve</button>
      <button type="submit" class="deny" formnovalidate name="action" value="deny">Deny</button>
    </div>
  </form>
</body>
</html>`;
}

const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId: string) {
    return getOAuthClient(clientId);
  },

  async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) {
    const fullClient: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_secret: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
    };
    await saveOAuthClient(fullClient);
    console.log(`[OAuth] Registered client ${fullClient.client_id} (${fullClient.client_name ?? 'unnamed'})`);
    return fullClient;
  },
};

export const oauthProvider: OAuthServerProvider = {
  get clientsStore(): OAuthRegisteredClientsStore {
    return clientsStore;
  },

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const nonce = randomUUID();
    pendingAuths.set(nonce, {
      client,
      params,
      expiresAt: Date.now() + 10 * 60 * 1000,
      failedAttempts: 0,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderApprovalPage(client, nonce));
  },

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const entry = authCodes.get(authorizationCode);
    if (!entry || entry.expiresAt < Date.now() || entry.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return entry.challenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const entry = authCodes.get(authorizationCode);
    if (!entry || entry.expiresAt < Date.now() || entry.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    authCodes.delete(authorizationCode);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const now = Date.now();

    await saveOAuthToken(accessToken, 'access', client.client_id, now + ACCESS_TOKEN_TTL_S * 1000);
    await saveOAuthToken(refreshToken, 'refresh', client.client_id, now + REFRESH_TOKEN_TTL_MS);

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
    };
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string
  ): Promise<OAuthTokens> {
    const entry = await findOAuthToken(refreshToken, 'refresh');
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }

    const accessToken = randomUUID();
    await saveOAuthToken(accessToken, 'access', client.client_id, Date.now() + ACCESS_TOKEN_TTL_S * 1000);

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
    };
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // A database error propagates as a plain Error, which requireBearerAuth turns
    // into a 500: the client retries rather than discarding a token that is still
    // valid and sending the user back through the approval page.
    let entry: Awaited<ReturnType<typeof findOAuthToken>>;
    try {
      entry = await findOAuthToken(token, 'access');
    } catch (err) {
      console.error('[OAuth] Token lookup failed:', err instanceof Error ? err.message : err);
      throw err;
    }
    if (!entry) {
      // Must be an InvalidTokenError: requireBearerAuth maps it to a 401, which is
      // the client's signal to refresh or re-run OAuth.
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: [],
      expiresAt: Math.floor(entry.expiresAtMs / 1000),
    };
  },
};
