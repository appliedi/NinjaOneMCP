# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NinjaONE MCP Server — a TypeScript MCP (Model Context Protocol) server that wraps the NinjaONE RMM platform API. It exposes 79 tools for device management, patch management, organization/contact/user CRUD, alerts, queries, custom fields, groups, and audit logs. Distributed as a source project, `.mcpb` bundle for Claude Desktop, and as a Cloud Run deployment on GCP.

## Build & Run Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc) → dist/
npm run dev          # Watch mode (tsc --watch)
npm start            # Run STDIO transport (default)
npm run start:http   # Run HTTP transport on port 3000
npm run start:sse    # Run SSE transport on port 3001
npm test             # Build first, then: node dist/test.js (requires valid .env credentials)
```

Tests are integration tests that hit the live NinjaONE API — they require `NINJA_CLIENT_ID` and `NINJA_CLIENT_SECRET` in `.env`.

### MCPB Bundle

```bash
npm install -g @anthropic-ai/mcpb
mcpb validate manifest.json
mcpb pack . ninjaone-rmm.mcpb
```

## Architecture

All source lives in `src/` and compiles to `dist/`. There is also a `server/` directory containing a pre-built JS bundle for the `.mcpb` distribution (not the dev source).

### Source Files (src/)

- **`index.ts`** — Entry point. Contains:
  - `TOOLS` array: all 79 MCP tool definitions with `inputSchema` JSON schemas
  - `ToolHandler` class: encapsulates all tool routing logic (`routeToolCall()` / `callAPIMethod()` switch statements, plus `getAllDevices()`, `searchDevicesByName()`, `findWindows11Devices()` helpers). Can be registered on any `Server` instance.
  - `createMCPServer(api)`: factory function that creates a configured MCP `Server` with tool handlers
  - `NinjaOneMCPServer` class: manages the `NinjaOneAPI` instance and transport selection
  - `main()`: transport selection based on `MCP_MODE` env var (stdio/http/sse)

- **`ninja-api.ts`** — `NinjaOneAPI` class: OAuth2 client-credentials flow, automatic region auto-detection, all REST API wrappers. Key patterns:
  - Token caching with 5-minute refresh buffer
  - `makeRequest()` is the single HTTP call point (uses native `fetch`)
  - Region resolution: explicit `NINJA_BASE_URL` > `NINJA_REGION` key > auto-detect by trying all candidates
  - Maintenance window uses Unix epoch seconds (not milliseconds)

- **`transport/http.ts`** — Express + MCP Streamable HTTP transport. `createHttpServer(serverFactory, port)` accepts a factory function to create per-session MCP Server instances. Includes token auth middleware and CORS configuration.

- **`test.ts`** — Integration test suite class (`NinjaOneTestSuite`) that tests API connectivity, devices, orgs, alerts, and queries

### Key Type: MaintenanceWindowSelection

```typescript
type MaintenanceWindowSelection =
  | { permanent: true }
  | { permanent: false; value: number; unit: MaintenanceUnit; seconds: number };
```

The `seconds` field is computed at the tool-handler level from `value * MAINTENANCE_UNIT_SECONDS[unit]` and passed to the API layer, which adds it to a start timestamp.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NINJA_CLIENT_ID` | Yes | OAuth2 client ID |
| `NINJA_CLIENT_SECRET` | Yes | OAuth2 client secret |
| `NINJA_BASE_URL` | No | Explicit regional endpoint (e.g., `https://eu.ninjarmm.com`) |
| `NINJA_REGION` | No | Region key: `us`, `us2`, `eu`, `ca`, `oc` |
| `NINJA_BASE_URLS` | No | Comma-separated override for auto-detect candidates |
| `MCP_MODE` | No | `stdio` (default), `http`, or `sse` |
| `HTTP_PORT` | No | Default 3000 |
| `SSE_PORT` | No | Default 3001 |
| `LOG_LEVEL` | No | `info` (default), `debug` |
| `CORS_ORIGIN` | No | CORS allowed origin (default `http://localhost`) |
| `MCP_AUTH_TOKEN` | No | Token for HTTP/SSE auth — when set, all requests (except `/health`) require `?token=` |

MCP clients (Claude Desktop) do NOT load `.env` — credentials must be in the client's JSON config.

## Security

- **SSRF protection**: `setBaseUrl()` validates URLs against known NinjaRMM regions and `*.ninjarmm.com` domain pattern
- **Request timeouts**: All API calls use 30s `AbortController` timeouts
- **CORS**: Defaults to `http://localhost` (not wildcard); configurable via `CORS_ORIGIN`
- **Token auth**: When `MCP_AUTH_TOKEN` is set, HTTP/SSE endpoints require `?token=<value>` on every request (except `/health`). Uses `crypto.timingSafeEqual` to prevent timing attacks

## TypeScript Configuration

- Target: ES2022, Module: ESNext, strict mode enabled
- `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns` are all on
- Source in `src/`, output in `dist/`, ES modules (`"type": "module"` in package.json)

## Adding a New Tool

1. Add the tool definition object to the `TOOLS` array in `src/index.ts` (with `name`, `description`, `inputSchema`)
2. Add the corresponding API method to `NinjaOneAPI` in `src/ninja-api.ts`
3. Add a `case` to either `routeToolCall()` (for complex validation) or `callAPIMethod()` (for simple pass-through) in `src/index.ts`
4. Update `manifest.json` version if publishing a new MCPB bundle

## API Limitations (NinjaONE)

- Organizations and locations cannot be deleted via API (dashboard only)
- `nodeApprovalMode` is read-only after organization creation
- End user `phone` field is read-only after creation
- Script execution requires authorization code flow (not supported here — uses client credentials)
- Patch approval/rejection is only via dashboard or policies

## GCP Cloud Run Deployment

The server runs on Google Cloud Run in project `ninjaone-mcp`, region `us-central1`.

**Service URL**: `https://ninjaone-mcp-533144411057.us-central1.run.app`

### Architecture

- Multi-stage Dockerfile: builds TypeScript in stage 1, copies only compiled JS + prod deps to stage 2
- Uses MCP Streamable HTTP transport (`StreamableHTTPServerTransport` from SDK) at `/mcp` endpoint
- Each client session gets its own MCP Server + Transport pair via factory pattern; `NinjaOneAPI` instance shared across sessions for OAuth token caching
- Runs in HTTP mode (`MCP_MODE=http`) on port 8080
- Secrets stored in GCP Secret Manager (not env vars): `NINJA_CLIENT_ID`, `NINJA_CLIENT_SECRET`, `NINJA_BASE_URL`, `MCP_AUTH_TOKEN`
- Scales 0-3 instances (scales to zero when idle), 512Mi memory, 1 CPU
- `/health` endpoint is unauthenticated (for uptime monitors)
- All other endpoints require `?token=<MCP_AUTH_TOKEN>` query parameter

### Deploy / Update

After making code changes, build, test, then deploy:

```bash
# 1. Build and test locally
npx tsc
node dist/test.js

# 2. Deploy to Cloud Run (builds container in the cloud)
gcloud run deploy ninjaone-mcp \
  --source=. \
  --region=us-central1 \
  --project=ninjaone-mcp \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --set-env-vars="MCP_MODE=http,NODE_ENV=production" \
  --set-secrets="NINJA_CLIENT_ID=NINJA_CLIENT_ID:latest,NINJA_CLIENT_SECRET=NINJA_CLIENT_SECRET:latest,NINJA_BASE_URL=NINJA_BASE_URL:latest,MCP_AUTH_TOKEN=MCP_AUTH_TOKEN:latest" \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=3 \
  --timeout=60

# 3. Verify deployment
curl https://ninjaone-mcp-533144411057.us-central1.run.app/health
```

### Updating Secrets

When rotating credentials or changing the auth token:

```bash
# Update a single secret (e.g., after regenerating NinjaOne API credentials)
echo -n "new-value-here" | gcloud secrets versions add NINJA_CLIENT_SECRET \
  --data-file=- --project=ninjaone-mcp

# Redeploy to pick up the new secret version (Cloud Run caches secrets at startup)
gcloud run services update ninjaone-mcp \
  --region=us-central1 --project=ninjaone-mcp \
  --set-secrets="NINJA_CLIENT_ID=NINJA_CLIENT_ID:latest,NINJA_CLIENT_SECRET=NINJA_CLIENT_SECRET:latest,NINJA_BASE_URL=NINJA_BASE_URL:latest,MCP_AUTH_TOKEN=MCP_AUTH_TOKEN:latest"
```

### MCP Client Registration URL

When registering this server with an MCP client (e.g., Claude), use the `/mcp` endpoint:

```
https://ninjaone-mcp-533144411057.us-central1.run.app/mcp?token=<MCP_AUTH_TOKEN>
```

The server uses the MCP Streamable HTTP protocol — clients must send `Accept: application/json, text/event-stream` headers (Claude does this automatically).

### Useful Commands

```bash
gcloud run services describe ninjaone-mcp --region=us-central1 --project=ninjaone-mcp   # Service details
gcloud run services logs read ninjaone-mcp --region=us-central1 --project=ninjaone-mcp   # View logs
gcloud run revisions list --service=ninjaone-mcp --region=us-central1 --project=ninjaone-mcp  # List revisions
gcloud secrets list --project=ninjaone-mcp                                                # List secrets
```

## CI/CD

GitHub Actions workflow (`.github/workflows/publish-mcp.yml`) triggers on `v*` tags: installs, tests, builds, publishes to NPM, then publishes to MCP Registry via `mcp-publisher`.
