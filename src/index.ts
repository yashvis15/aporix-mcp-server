import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const APORIX_API_URL =
  process.env.APORIX_API_URL ||
  "https://aporix-v3-agent1.vercel.app/api/optimize";
const PORT = parseInt(process.env.PORT || "3001", 10);
const VALID_EXTENSIONS = [".pdf", ".txt", ".json", ".md"];

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
          "Optimizes documents into task-specific LLM context and returns token savings and quality metrics. Removes boilerplate, recitals, definitions, and irrelevant content while preserving goal-relevant facts, dates, names, and obligations.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description:
                "Absolute path to the document file on disk. Supported formats: PDF, TXT, JSON, MD.",
            },
            goal: {
              type: "string",
              description:
                "The optimization goal or task (e.g. 'extract key risks', 'summarize obligations', 'list payment terms').",
            },
          },
          required: ["file_path", "goal"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "optimize_document") {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const args = request.params.arguments as Record<string, string> | undefined;
    if (!args?.file_path || !args?.goal) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Both 'file_path' and 'goal' are required.",
          },
        ],
        isError: true,
      };
    }

    const filePath = resolve(args.file_path);
    const goal = args.goal.trim();

    if (!goal) {
      return {
        content: [{ type: "text", text: "Error: 'goal' cannot be empty." }],
        isError: true,
      };
    }

    if (!existsSync(filePath)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: File not found at "${filePath}".`,
          },
        ],
        isError: true,
      };
    }

    const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
    if (!VALID_EXTENSIONS.includes(ext)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Unsupported file format "${ext}". Supported: ${VALID_EXTENSIONS.join(", ")}.`,
          },
        ],
        isError: true,
      };
    }

    try {
      const fileBuffer = await readFile(filePath);
      const fileName = basename(filePath);

      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: "application/octet-stream" });
      formData.append("file", blob, fileName);
      formData.append("goal", goal);

      const response = await fetch(APORIX_API_URL, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "Unknown error");
        return {
          content: [
            {
              type: "text",
              text: `Aporix API error (${response.status}): ${errorBody}`,
            },
          ],
          isError: true,
        };
      }

      const data = await response.json();

      if (!data.success) {
        return {
          content: [
            {
              type: "text",
              text: `Aporix API error: ${data.error || "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }

      const result = {
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `Error calling Aporix API: ${message}`,
          },
        ],
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
                "Optimizes documents into task-specific LLM context and returns token savings and quality metrics. Removes boilerplate, recitals, definitions, and irrelevant content while preserving goal-relevant facts, dates, names, and obligations.",
              inputSchema: {
                type: "object",
                properties: {
                  file_path: {
                    type: "string",
                    description:
                      "Absolute path to the document file on disk. Supported formats: PDF, TXT, JSON, MD.",
                  },
                  goal: {
                    type: "string",
                    description:
                      "The optimization goal or task (e.g. 'extract key risks', 'summarize obligations', 'list payment terms').",
                  },
                },
                required: ["file_path", "goal"],
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
        if (!args?.file_path || !args?.goal) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(jsonRpcResult(message.id, {
            content: [{ type: "text", text: "Error: Both 'file_path' and 'goal' are required." }],
            isError: true,
          })));
          return;
        }

        try {
          const { readFile } = await import("node:fs/promises");
          const { resolve, basename } = await import("node:path");
          const { existsSync } = await import("node:fs");

          const filePath = resolve(args.file_path);
          const goal = args.goal.trim();

          if (!existsSync(filePath)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(jsonRpcResult(message.id, {
              content: [{ type: "text", text: `Error: File not found at "${filePath}".` }],
              isError: true,
            })));
            return;
          }

          const VALID_EXTENSIONS = [".pdf", ".txt", ".json", ".md"];
          const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
          if (!VALID_EXTENSIONS.includes(ext)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(jsonRpcResult(message.id, {
              content: [{ type: "text", text: `Error: Unsupported file format "${ext}". Supported: ${VALID_EXTENSIONS.join(", ")}.` }],
              isError: true,
            })));
            return;
          }

          const fileBuffer = await readFile(filePath);
          const fileName = basename(filePath);

          const formData = new FormData();
          const blob = new Blob([fileBuffer], { type: "application/octet-stream" });
          formData.append("file", blob, fileName);
          formData.append("goal", goal);

          const apiUrl = process.env.APORIX_API_URL || "https://aporix-v3-agent1.vercel.app/api/optimize";
          const response = await fetch(apiUrl, { method: "POST", body: formData });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "Unknown error");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(jsonRpcResult(message.id, {
              content: [{ type: "text", text: `Aporix API error (${response.status}): ${errorBody}` }],
              isError: true,
            })));
            return;
          }

          const data = await response.json();

          if (!data.success) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(jsonRpcResult(message.id, {
              content: [{ type: "text", text: `Aporix API error: ${data.error || "Unknown error"}` }],
              isError: true,
            })));
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(jsonRpcResult(message.id, {
            content: [{
              type: "text",
              text: JSON.stringify({
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
              }, null, 2),
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
