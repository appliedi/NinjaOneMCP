/**
 * HTTP and SSE Transport Implementation for MCP Server
 * Uses the MCP SDK's StreamableHTTPServerTransport for protocol compliance.
 * Each client session gets its own Server + Transport pair.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { randomUUID, timingSafeEqual } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

/**
 * Token authentication middleware.
 * When MCP_AUTH_TOKEN is set, all requests (except /health) must include
 * a matching ?token= query parameter. Skipped entirely when unset.
 */
function tokenAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MCP_AUTH_TOKEN?.trim();
  if (!expected) return next();
  if (req.path === '/health') return next();

  const provided = typeof req.query.token === 'string' ? req.query.token : '';
  if (
    provided.length === expected.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  ) {
    return next();
  }

  res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing token' });
}

/**
 * HTTP Transport Server using MCP Streamable HTTP protocol.
 * Each session gets a fresh MCP Server instance via the factory.
 */
export async function createHttpServer(
  serverFactory: () => Server,
  port: number
): Promise<void> {
  const app = express();

  app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Mcp-Session-Id'],
    exposedHeaders: ['Mcp-Session-Id']
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.text({ type: '*/*', limit: '10mb' }));
  app.use(tokenAuth);

  // Track active transports by session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Health check endpoint (exempt from token auth)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      service: 'ninjaone-mcp-server',
      version: '1.3.0',
      timestamp: new Date().toISOString(),
      transport: 'streamable-http',
      activeSessions: transports.size
    });
  });

  // MCP Streamable HTTP endpoint
  app.all('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST') {
      // Handle body parsing: express.json() may not parse if Content-Type is missing
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { /* leave as-is */ }
      }
      if (!body || (typeof body === 'object' && Object.keys(body).length === 0 && !Array.isArray(body))) {
        console.error(`[MCP] POST with empty/unparsed body. Content-Type: ${req.headers['content-type']}`);
        res.status(400).json({ error: 'Bad Request', message: 'Request body is empty or not valid JSON' });
        return;
      }

      if (isInitializeRequest(body)) {
        // New session — create transport + server
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) transports.delete(sid);
        };

        const mcpServer = serverFactory();
        await mcpServer.connect(transport as Parameters<typeof mcpServer.connect>[0]);
        await transport.handleRequest(req, res, body);

        if (transport.sessionId) {
          transports.set(transport.sessionId, transport);
        }
        return;
      }

      // Existing session
      if (!sessionId || !transports.has(sessionId)) {
        console.error(`[MCP] POST non-init without valid session. sessionId: ${sessionId || 'none'}, method: ${body?.method}, active sessions: ${transports.size}`);
        res.status(400).json({ error: 'Bad Request', message: 'Invalid or missing session ID' });
        return;
      }
      await transports.get(sessionId)!.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'GET') {
      // SSE stream for server-initiated messages
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).json({ error: 'Bad Request', message: 'Invalid or missing session ID' });
        return;
      }
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    if (req.method === 'DELETE') {
      // Session teardown
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).json({ error: 'Bad Request', message: 'Invalid or missing session ID' });
        return;
      }
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      transports.delete(sessionId);
      return;
    }

    res.status(405).json({ error: 'Method Not Allowed' });
  });

  return new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      console.error(`Streamable HTTP server listening on port ${port}`);
      resolve();
    });

    server.on('error', (error) => {
      console.error('HTTP server error:', error);
      reject(error);
    });
  });
}

/**
 * SSE Transport — delegates to the Streamable HTTP transport.
 */
export async function createSseServer(
  serverFactory: () => Server,
  port: number
): Promise<void> {
  return createHttpServer(serverFactory, port);
}
