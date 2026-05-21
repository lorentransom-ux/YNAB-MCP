import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const app = express();
app.use(express.json());

const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!MCP_AUTH_TOKEN) {
  console.warn('[YNAB-MCP] WARNING: MCP_AUTH_TOKEN is not set — the /mcp endpoint is unprotected');
}

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!MCP_AUTH_TOKEN) {
    next();
    return;
  }
  const authHeader = req.headers['authorization'];
  if (authHeader === `Bearer ${MCP_AUTH_TOKEN}`) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

const transports = new Map<string, StreamableHTTPServerTransport>();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', sessions: transports.size });
});

app.post('/mcp', requireAuth, async (req, res) => {
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

app.get('/mcp', requireAuth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.delete('/mcp', requireAuth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[YNAB-MCP] Server listening on port ${PORT}`);
  if (!process.env.YNAB_TOKEN) {
    console.warn('[YNAB-MCP] WARNING: YNAB_TOKEN environment variable is not set');
  }
  if (!MCP_AUTH_TOKEN) {
    console.warn('[YNAB-MCP] WARNING: MCP_AUTH_TOKEN is not set — set it to protect your budget data');
  }
});

process.on('SIGTERM', async () => {
  console.log('[YNAB-MCP] SIGTERM received, shutting down...');
  for (const [sid, transport] of transports) {
    try {
      await transport.close();
    } catch {
      // ignore close errors during shutdown
    }
    transports.delete(sid);
  }
  process.exit(0);
});
