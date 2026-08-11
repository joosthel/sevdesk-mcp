#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { catalog } from "./catalog.js";
import { SevdeskClient } from "./client.js";
import { loadConfig } from "./config.js";
import { createProfileResolver } from "./lib/profile.js";
import type { ToolContext } from "./lib/tool.js";
import { VERSION, buildServer, tools } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SevdeskClient(config);
  const ctx: ToolContext = {
    client,
    config,
    getProfile: createProfileResolver(client, config),
  };

  // serveStdio negotiates the protocol era per connection: 2026-07-28
  // clients get the stateless envelope, 2025-era clients the classic
  // initialize handshake — same server instance either way.
  serveStdio(() => buildServer(ctx), {
    onerror: (err) => console.error(err.message),
  });

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
