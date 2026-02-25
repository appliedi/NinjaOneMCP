/**
 * HTTP and SSE Transport Implementation for MCP Server
 * Modern implementation with proper CORS, error handling, and security
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { timingSafeEqual } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * Token authentication middleware.
 * When MCP_AUTH_TOKEN is set, all requests (except /health) must include
 * a matching ?token= query parameter. Skipped entirely when unset.
 */
function tokenAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MCP_AUTH_TOKEN;
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
 * HTTP Transport Server
 * Provides REST-like interface for MCP server functionality
 */
export async function createHttpServer(mcpServer: Server, port: number): Promise<void> {
  const app = express();

  // Security and parsing middleware
  app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost',
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(tokenAuth);

  // Health check endpoint (exempt from token auth)
  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      service: 'ninjaone-mcp-server',
      version: '1.3.0',
      timestamp: new Date().toISOString(),
      transport: 'http'
    });
  });

  // Server info endpoint
  app.get('/info', (req: Request, res: Response) => {
    res.json({
      name: 'ninjaone-mcp-server',
      version: '1.3.0',
      description: 'NinjaONE RMM MCP Server with HTTP transport',
      capabilities: {
        tools: true,
        resources: false,
        prompts: false,
        logging: true
      },
      transports: ['stdio', 'http', 'sse']
    });
  });

  // Tools listing endpoint (REST-style convenience)
  app.get('/tools', async (req: Request, res: Response) => {
    try {
      // Simplified response for now
      res.json({
        tools: [
          { name: 'get_devices', description: 'List all devices' },
          { name: 'get_device', description: 'Get specific device' },
          { name: 'reboot_device', description: 'Reboot a device' },
          { name: 'query_antivirus_status', description: 'Query antivirus status' },
          { name: 'query_device_health', description: 'Query device health' },
          { name: 'get_organizations', description: 'List organizations' },
          { name: 'get_alerts', description: 'Get system alerts' }
        ]
      });
    } catch (error) {
      console.error('Tools endpoint error:', error);
      res.status(500).json({
        error: 'Failed to retrieve tools',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Error handling middleware
  app.use((error: any, req: Request, res: Response, next: any) => {
    console.error('Express error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || 'Unknown error occurred'
    });
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not found',
      message: `Route ${req.method} ${req.path} not found`,
      availableEndpoints: [
        'GET /health',
        'GET /info', 
        'GET /tools'
      ]
    });
  });

  return new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      console.error(`HTTP server listening on port ${port}`);
      resolve();
    });

    server.on('error', (error) => {
      console.error('HTTP server error:', error);
      reject(error);
    });
  });
}

/**
 * Server-Sent Events (SSE) Transport Server
 * Provides real-time streaming interface for MCP server
 */
export async function createSseServer(mcpServer: Server, port: number): Promise<void> {
  const app = express();

  // Security and parsing middleware
  app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost',
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cache-Control']
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(tokenAuth);

  // Health check (exempt from token auth)
  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      service: 'ninjaone-mcp-server',
      version: '1.3.0',
      timestamp: new Date().toISOString(),
      transport: 'sse'
    });
  });

  // SSE endpoint for real-time communication
  app.get('/events', async (req: Request, res: Response) => {
    // Set SSE headers (CORS handled by middleware)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Send initial connection event
    res.write(`data: ${JSON.stringify({
      type: 'connected',
      timestamp: new Date().toISOString(),
      server: 'ninjaone-mcp-server'
    })}\n\n`);

    // Handle client disconnect
    req.on('close', () => {
      console.error('SSE client disconnected');
    });

    // Keep connection alive with periodic heartbeat
    const heartbeat = setInterval(() => {
      res.write(`data: ${JSON.stringify({
        type: 'heartbeat',
        timestamp: new Date().toISOString()
      })}\n\n`);
    }, 30000); // 30 second heartbeat

    req.on('close', () => {
      clearInterval(heartbeat);
    });
  });

  return new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      console.error(`SSE server listening on port ${port}`);
      resolve();
    });

    server.on('error', (error) => {
      console.error('SSE server error:', error);
      reject(error);
    });
  });
}
