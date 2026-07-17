# Aporix MCP Server

MCP server that exposes the [Aporix](https://aporix-v3-agent1.vercel.app) document optimization API as a tool for AI agents (ClawUp, OpenClaw, Claude Desktop, etc.).

Supports **stdio** (local agents) and **HTTP/SSE** (hosted endpoint) transport.

## Tool: `optimize_document`

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| `file_path` | string | Absolute path to the document (PDF, TXT, JSON, MD) |
| `goal` | string | Optimization goal (e.g. "extract key risks") |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| `optimizedContext` | string | Compressed/optimized document text |
| `originalTokens` | number | Estimated original token count |
| `optimizedTokens` | number | Estimated optimized token count |
| `tokenSavingsPercent` | number | Percentage of tokens saved |
| `costSavings` | number | Estimated USD cost savings |
| `qualityValidation` | object | Confidence score, similarity, summaries, warnings |

---

## Local stdio (for local agents)

```bash
npm install
npm run build
npm start
```

Register in `~/.openclaw/openclaw.json`:

```json
{
  "mcpServers": {
    "aporix": {
      "command": "node",
      "args": ["/absolute/path/to/aporix-mcp-server/dist/index.js"]
    }
  }
}
```

## Hosted HTTP/SSE (for ClawUp MCP submission)

### Run locally

```bash
npm run dev:http
# Server starts on http://localhost:3001/mcp
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | GET | SSE connection (client init) |
| `/mcp?sessionId=xxx` | POST | Send JSON-RPC messages |
| `/health` | GET | Health check |
| `/` | GET | Server info |

### Deploy to Railway

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login and deploy
railway login
railway init
railway up

# Set environment variable
railway env set APORIX_API_URL=https://your-domain.vercel.app/api/optimize
```

Railway auto-detects the Dockerfile and sets `PORT`.

### Deploy to Render

1. Create a new **Web Service**
2. Connect your GitHub repo
3. Use these settings:
   - **Runtime**: Docker
   - **Health Check Path**: `/health`
4. Add environment variable:
   - `APORIX_API_URL`: `https://your-domain.vercel.app/api/optimize`

### Deploy to Fly.io

```bash
fly launch
fly secrets set APORIX_API_URL=https://your-domain.vercel.app/api/optimize
fly deploy
```

---

## Submit to ClawUp

Once deployed, paste your public MCP endpoint URL:

```
https://your-app.railway.app/mcp
```

into ClawUp's **MCP Tool Submission** form. The endpoint follows the Model Context Protocol over SSE transport.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APORIX_API_URL` | `https://aporix-v3-agent1.vercel.app/api/optimize` | Aporix backend API |
| `PORT` | `3001` | HTTP server port |
| `TRANSPORT` | auto (`http` if `PORT` is set) | `stdio` or `http` |

## Testing

```bash
# Stdio test
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js

# HTTP test (after starting with npm run dev:http)
curl http://localhost:3001/health
```
