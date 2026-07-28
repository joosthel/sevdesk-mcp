import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { ToolContext, ToolDef } from "./lib/tool.js";
import { auditTools } from "./tools/audit.js";
import { discoveryTools } from "./tools/discovery.js";
import { resourceTools } from "./tools/resources.js";

export const VERSION = "0.3.0";

/** Every tool the server exposes, in listing order. */
export const tools: ToolDef[] = [...resourceTools, ...auditTools, ...discoveryTools];

/**
 * Assemble the MCP server: tool listing and dispatch. Transport-agnostic —
 * the stdio entry point (index.ts) connects it to stdin/stdout, and a hosted
 * variant can connect the same server to an HTTP transport.
 */
export function buildServer(ctx: ToolContext): Server {
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "sevdesk-mcp", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools
      // Hide write tools entirely in read-only mode so they cannot be attempted.
      // sevdesk_call stays listed — it also covers reads — and refuses mutating
      // operations at call time.
      .filter((t) => !(ctx.config.readOnly && t.mutating && t.name !== "sevdesk_call"))
      .map((t) => ({
        name: t.name,
        title: t.title,
        description:
          t.description +
          (t.mutating && !ctx.config.readOnly
            ? " ⚠️ This tool can change data in sevDesk."
            : ""),
        inputSchema: t.inputSchema,
      })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = byName.get(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      };
    }

    try {
      const result = await tool.handler((rawArgs ?? {}) as Record<string, unknown>, ctx);
      const text =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  });

  return server;
}
