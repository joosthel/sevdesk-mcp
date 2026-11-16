#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { catalog } from "./catalog.js";
import { SevdeskClient } from "./client.js";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./lib/env.js";
import type { ToolContext } from "./lib/tool.js";
import { VERSION, buildServer, tools } from "./server.js";

async function main(): Promise<void> {
  // A .env beside package.json is a convenience for runs outside an MCP
  // client; the client's own env block still wins over anything in it.
  const envFile = loadDotEnv();
  const config = loadConfig();
  const client = new SevdeskClient(config);
  const ctx: ToolContext = { client, config };

  // These used to pick a VAT regime; silently ignoring them would leave a
  // stale config looking effective.
  if (process.env.SEVDESK_VAT_REGIME !== undefined || process.env.SEVDESK_KLEINUNTERNEHMER !== undefined) {
    console.error(
      "SEVDESK_VAT_REGIME / SEVDESK_KLEINUNTERNEHMER are no longer read: tax rules are now " +
        "passed explicitly (taxRuleId) on the write tools that need one.",
    );
  }

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
      (config.allowBooking && !config.readOnly ? " + booking" : "") +
      (envFile ? ` · loaded ${envFile}` : ""),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
