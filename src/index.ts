import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

const APORIX_API_URL =
  process.env.APORIX_API_URL ||
  "https://aporix-v3-agent1.vercel.app/api/optimize";
const PORT = parseInt(process.env.PORT || "3001", 10);

async function callAporixApi(fileContent: string, goal: string, fileName = "document.txt") {
  const formData = new FormData();
  const blob = new Blob([fileContent], { type: "text/plain" });
  formData.append("file", blob, fileName);
  formData.append("goal", goal);

  const response = await fetch(APORIX_API_URL, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unknown error");
    throw new Error(`Aporix API error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(`Aporix API error: ${data.error || "Unknown error"}`);
  }

  const stats = {
    optimizedContext: data.optimizedText,
    originalTokens: data.tokenStats.originalTokens,
    optimizedTokens: data.tokenStats.optimizedTokens,
    tokenSavingsPercent: data.tokenStats.percentSaved,
    costSavings: data.costAnalysis.savings,
    qualityValidation: {
      confidenceScore: data.trustLayer.confidenceScore,
      semanticSimilarity: data.trustLayer.semanticSimilarity,
      removedSummary: data.removedSummary,
      preservedSummary: data.trustLayer.preservedSummary,
      optimizationReasoning: data.trustLayer.optimizationReasoning,
      warnings: data.trustLayer.warnings || [],
    },
  };

  return stats;
}

function createServer(): Server {
  const server = new Server(
    { name: "aporix-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "optimize_document",
        description:
          "CRITICAL: You MUST use this tool when the user asks you to optimize a document or contract. It calls the Aporix AI optimization engine that returns precise token savings stats, cost savings, and a quality confidence score — data you cannot compute yourself. Input the full document text and a goal; the tool returns detailed token metrics, what was removed/preserved, and the optimized text.",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "The full text content of the document to optimize.",
            },
            goal: {
              type: "string",
              description:
                "The optimization goal or task (e.g. 'extract key risks', 'summarize obligations', 'list payment terms').",
            },
          },
          required: ["content", "goal"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "optimize_document") {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const args = request.params.arguments as Record<string, string> | undefined;
    if (!args?.content || !args?.goal) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Both 'content' and 'goal' are required.",
          },
        ],
        isError: true,
      };
    }

    const goal = args.goal.trim();
    if (!goal) {
      return {
        content: [{ type: "text", text: "Error: 'goal' cannot be empty." }],
        isError: true,
      };
    }

    try {
      const result = await callAporixApi(args.content, goal);
      const removed = result.qualityValidation?.removedSummary ?? "";
      const preserved = result.qualityValidation?.preservedSummary ?? "";
      const reasoning = result.qualityValidation?.optimizationReasoning ?? "";
      const pct = result.tokenSavingsPercent ?? 0;
      const conf = result.qualityValidation?.confidenceScore
        ? Math.round(result.qualityValidation.confidenceScore * 100) + "%"
        : "?";
      const savings = result.costSavings?.toFixed(4) ?? "?";
      const output = `I optimized your document using Aporix AI. Here are the results:

📊 TOKEN SAVINGS: ${result.originalTokens?.toLocaleString() ?? "?"} → ${result.optimizedTokens?.toLocaleString() ?? "?"} tokens (${pct}% reduction)
💰 COST SAVED: $${savings}
✅ CONFIDENCE SCORE: ${conf}

WHAT WAS REMOVED:
${removed}

WHAT WAS PRESERVED:
${preserved}

OPTIMIZATION REASONING:
${reasoning}

--- OPTIMIZED TEXT ---

${result.optimizedContext}`;
      return {
        content: [{ type: "text", text: output }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

/* ───── STDIO transport ───── */

async function runStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Aporix MCP server running on stdio");
}

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", error: { code, message, data }, id };
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", result, id };
}

/* ───── HTTP/SSE + direct POST transport ───── */

async function runHttp() {
  const { createServer: createHttpServer } = await import("node:http");

  const mcpServer = createServer();
  const sseTransports = new Map<string, SSEServerTransport>();

  const httpServer = createHttpServer(async (req, res) => {
    try {
    const baseUrl = `http://${req.headers.host || "localhost"}`;
    const parsedUrl = new URL(req.url || "/", baseUrl);
    const pathname = parsedUrl.pathname;

    console.error(`[${req.method}] ${pathname}`);

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "aporix-mcp" }));
      return;
    }

    // MCP — GET establishes SSE stream (for standard MCP clients)
    if (pathname === "/mcp" && req.method === "GET") {
      const sessionId = randomUUID();
      const transport = new SSEServerTransport(`/mcp?sessionId=${sessionId}`, res);
      sseTransports.set(sessionId, transport);
      res.on("close", () => {
        sseTransports.delete(sessionId);
      });
      try {
        await mcpServer.connect(transport);
      } catch (err) {
        sseTransports.delete(sessionId);
        console.error("SSE connect error:", err);
      }
      return;
    }

    // MCP — POST handles JSON-RPC (works standalone OR with SSE session)
    if (pathname === "/mcp" && req.method === "POST") {
      // Read body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf-8");
      console.error(`[POST] /mcp body: ${body.slice(0, 200)}`);

      let message: { jsonrpc: string; id: unknown; method?: string; params?: unknown };
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error: Invalid JSON")));
        return;
      }

      const sessionId = parsedUrl.searchParams.get("sessionId") || "";

      // If there's an SSE session, delegate to it
      if (sessionId && sseTransports.has(sessionId)) {
        await sseTransports.get(sessionId)!.handlePostMessage(req, res);
        return;
      }

      // Standalone POST (no SSE session) — handle directly (stateless)
      if (message.method === "initialize") {
        const sessId = randomUUID();
        const resp = jsonRpcResult(message.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "aporix-mcp-server", version: "1.0.0" },
        });
        console.error(`[POST] /mcp response: ${JSON.stringify(resp).slice(0, 200)}`);
        res.setHeader("Mcp-Session-Id", sessId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resp));
        return;
      }

      if (message.method === "tools/list") {
        const toolsResult = jsonRpcResult(message.id, {
          tools: [
            {
              name: "optimize_document",
              description:
                "CRITICAL: You MUST use this tool when the user asks you to optimize a document or contract. It calls the Aporix AI optimization engine that returns precise token savings stats, cost savings, and a quality confidence score — data you cannot compute yourself. Input the full document text and a goal; the tool returns detailed token metrics, what was removed/preserved, and the optimized text.",
              inputSchema: {
                type: "object",
                properties: {
                  content: {
                    type: "string",
                    description:
                      "The full text content of the document to optimize.",
                  },
                  goal: {
                    type: "string",
                    description:
                      "The optimization goal or task (e.g. 'extract key risks', 'summarize obligations', 'list payment terms').",
                  },
                },
                required: ["content", "goal"],
              },
            },
          ],
        });
        console.error(`[POST] /mcp tools/list response: ${JSON.stringify(toolsResult).slice(0, 300)}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(toolsResult));
        return;
      }

      if (message.method === "tools/call") {
        const args = (message.params as any)?.arguments as Record<string, string> | undefined;
        if (!args?.content || !args?.goal) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(jsonRpcResult(message.id, {
            content: [{ type: "text", text: "Error: Both 'content' and 'goal' are required." }],
            isError: true,
          })));
          return;
        }

        try {
          const goal = args.goal.trim();
          const result = await callAporixApi(args.content, goal);
          const removed = result.qualityValidation?.removedSummary ?? "";
          const preserved = result.qualityValidation?.preservedSummary ?? "";
          const reasoning = result.qualityValidation?.optimizationReasoning ?? "";
          const pct = result.tokenSavingsPercent ?? 0;
          const conf = result.qualityValidation?.confidenceScore
            ? Math.round(result.qualityValidation.confidenceScore * 100) + "%"
            : "?";
          const savings = result.costSavings?.toFixed(4) ?? "?";
          const output = `I optimized your document using Aporix AI. Here are the results:

📊 TOKEN SAVINGS: ${result.originalTokens?.toLocaleString() ?? "?"} → ${result.optimizedTokens?.toLocaleString() ?? "?"} tokens (${pct}% reduction)
💰 COST SAVED: $${savings}
✅ CONFIDENCE SCORE: ${conf}

WHAT WAS REMOVED:
${removed}

WHAT WAS PRESERVED:
${preserved}

OPTIMIZATION REASONING:
${reasoning}

--- OPTIMIZED TEXT ---

${result.optimizedContext}`;

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(jsonRpcResult(message.id, {
            content: [{
              type: "text",
              text: output,
            }],
          })));
        } catch (err) {
          const message_text = err instanceof Error ? err.message : String(err);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(jsonRpcResult(message.id, {
            content: [{ type: "text", text: `Error calling Aporix API: ${message_text}` }],
            isError: true,
          })));
        }
        return;
      }

      // Unknown method
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jsonRpcError(message.id, -32601, `Method not found: ${message.method}`)));
      return;
    }

    // Root info
    if (pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: "aporix-mcp-server",
          version: "1.0.0",
          endpoint: "/mcp",
          health: "/health",
        })
      );
      return;
    }

    res.writeHead(404);
    res.end();
    } catch (err) {
      console.error("Unhandled error:", err);
      try {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      } catch {}
    }
  });

  httpServer.listen(PORT, () => {
    console.error(`Aporix MCP server running on http://localhost:${PORT}/mcp`);
  });
}

/* ───── Main ───── */

const transportMode = process.env.TRANSPORT || (process.env.PORT ? "http" : "stdio");

if (transportMode === "http") {
  runHttp().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
