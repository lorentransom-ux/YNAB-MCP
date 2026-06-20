import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createMcpServer } from './server.js';
import { oauthProvider, handleApproval } from './oauth.js';
import { initScheduler } from './scheduler.js';
import { initAlerts } from './alerts.js';
import { seedConfigFromEnv } from './config.js';
import { handleInboundTelegram } from './telegram-chat.js';
import { isTelegramConfigured, registerTelegramWebhook } from './telegram.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${PORT}`;

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// OAuth 2.0 endpoints (/.well-known/oauth-authorization-server, /authorize, /token, /register)
app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(SERVER_URL),
    resourceName: 'YNAB MCP Server',
  })
);

// Approval page form handler
app.post('/oauth/approve', (req, res) => {
  const { nonce, action } = req.body as { nonce?: string; action?: string };
  if (!nonce || (action !== 'approve' && action !== 'deny')) {
    res.status(400).send('Invalid request');
    return;
  }
  const redirectUrl = handleApproval(nonce, action);
  if (!redirectUrl) {
    res.status(400).send('Authorization request expired or not found. Please try connecting again.');
    return;
  }
  res.redirect(redirectUrl);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/telegram', handleInboundTelegram);

const bearerAuth = requireBearerAuth({ verifier: oauthProvider });

const transports = new Map<string, StreamableHTTPServerTransport>();

app.post('/mcp', bearerAuth, async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          console.log(`[MCP] Session initialized: ${sid}`);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          transports.delete(sid);
          console.log(`[MCP] Session closed: ${sid}`);
        }
      };

      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: no valid session or initialize request' },
      id: null,
    });
  } catch (err) {
    console.error('[MCP] POST error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', bearerAuth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.delete('/mcp', bearerAuth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[YNAB-MCP] Server listening on port ${PORT}`);
  console.log(`[YNAB-MCP] Server URL: ${SERVER_URL}`);
  if (!process.env.YNAB_TOKEN) {
    console.warn('[YNAB-MCP] WARNING: YNAB_TOKEN is not set');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[YNAB-MCP] WARNING: ANTHROPIC_API_KEY is not set — Telegram chat will fail on first message');
  }
  if (!isTelegramConfigured()) {
    console.warn('[YNAB-MCP] WARNING: TELEGRAM_BOT_TOKEN is not set — Telegram chat disabled');
  } else {
    void registerTelegramWebhook(SERVER_URL);
  }
  seedConfigFromEnv();
  initScheduler();
  initAlerts();
});

process.on('SIGTERM', async () => {
  console.log('[YNAB-MCP] SIGTERM received, shutting down...');
  for (const [sid, transport] of transports) {
    try { await transport.close(); } catch { /* ignore */ }
    transports.delete(sid);
  }
  process.exit(0);
});
