#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { catalog } from "./catalog.js";
import { SevdeskClient } from "./client.js";
import { loadConfig } from "./config.js";
import type { ToolContext } from "./lib/tool.js";
import { VERSION, buildServer, tools } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SevdeskClient(config);
  const ctx: ToolContext = { client, config };

  const server = buildServer(ctx);
  await server.connect(new StdioServerTransport());

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
