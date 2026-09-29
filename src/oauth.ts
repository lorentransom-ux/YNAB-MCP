import { randomUUID } from 'node:crypto';
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

interface PendingAuth {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
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

// Called by the /oauth/approve POST route in index.ts
export function handleApproval(
  nonce: string,
  action: 'approve' | 'deny'
): string | null {
  const pending = pendingAuths.get(nonce);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingAuths.delete(nonce);
    return null;
  }
  pendingAuths.delete(nonce);

  const url = new URL(pending.params.redirectUri);

  if (action === 'deny') {
    url.searchParams.set('error', 'access_denied');
    if (pending.params.state) url.searchParams.set('state', pending.params.state);
    return url.toString();
  }

  const code = randomUUID();
  authCodes.set(code, {
    challenge: pending.params.codeChallenge,
    clientId: pending.client.client_id,
    redirectUri: pending.params.redirectUri,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  url.searchParams.set('code', code);
  if (pending.params.state) url.searchParams.set('state', pending.params.state);
  return url.toString();
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
    });

    const appName = escapeHtml(client.client_name ?? 'An application');
    const nonceEscaped = escapeHtml(nonce);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize YNAB Access</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 440px; margin: 80px auto; padding: 0 24px; color: #111; }
    h1 { font-size: 1.25rem; margin-bottom: 8px; }
    p { color: #555; line-height: 1.5; }
    .buttons { display: flex; gap: 12px; margin-top: 32px; }
    button { padding: 10px 24px; border-radius: 6px; border: none; cursor: pointer; font-size: 1rem; font-weight: 500; }
    .approve { background: #0f766e; color: #fff; }
    .approve:hover { background: #0d6460; }
    .deny { background: #e5e7eb; color: #374151; }
    .deny:hover { background: #d1d5db; }
  </style>
</head>
<body>
  <h1>Authorize YNAB access?</h1>
  <p><strong>${appName}</strong> is requesting read-only access to your YNAB budget data through this MCP server.</p>
  <div class="buttons">
    <form method="POST" action="/oauth/approve">
      <input type="hidden" name="nonce" value="${nonceEscaped}">
      <input type="hidden" name="action" value="approve">
      <button type="submit" class="approve">Approve</button>
    </form>
    <form method="POST" action="/oauth/approve">
      <input type="hidden" name="nonce" value="${nonceEscaped}">
      <input type="hidden" name="action" value="deny">
      <button type="submit" class="deny">Deny</button>
    </form>
  </div>
</body>
</html>`);
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
