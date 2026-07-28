#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { catalog } from "./catalog.js";
import { SevdeskClient } from "./client.js";
import { loadConfig } from "./config.js";
import type { ToolContext, ToolDef } from "./lib/tool.js";
import { auditTools } from "./tools/audit.js";
import { discoveryTools } from "./tools/discovery.js";
import { resourceTools } from "./tools/resources.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SevdeskClient(config);
  const ctx: ToolContext = { client, config };

  const tools: ToolDef[] = [...resourceTools, ...auditTools, ...discoveryTools];
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "sevdesk-mcp", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools
      // Hide write tools entirely in read-only mode so they cannot be attempted.
      .filter((t) => !(config.readOnly && t.mutating && t.name !== "sevdesk_call"))
      .map((t) => ({
        name: t.name,
        title: t.title,
        description:
          t.description +
          (t.mutating && !config.readOnly
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

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only — stdout carries the MCP protocol.
  console.error(
    `sevdesk-mcp ${VERSION} ready · ${tools.length} tools · ` +
      `${catalog.operationCount} API operations · ` +
      `mode: ${config.readOnly ? "READ-ONLY" : config.dryRun ? "DRY-RUN" : "read/write"}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
