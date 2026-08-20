#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { catalog } from "./catalog.js";
import { SevdeskClient } from "./client.js";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./lib/env.js";
import { createProfileResolver } from "./lib/profile.js";
import type { ToolContext } from "./lib/tool.js";
import { VERSION, buildServer, tools } from "./server.js";

async function main(): Promise<void> {
  // A .env beside package.json is a convenience for runs outside an MCP
  // client; the client's own env block still wins over anything in it.
  const envFile = loadDotEnv();
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
      `mode: ${config.readOnly ? "READ-ONLY" : config.dryRun ? "DRY-RUN" : "read/write"}` +
      (envFile ? ` · loaded ${envFile}` : ""),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
