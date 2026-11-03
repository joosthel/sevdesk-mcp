import { Server } from "@modelcontextprotocol/server";

import type { ToolContext, ToolDef } from "./lib/tool.js";
import { auditTools } from "./tools/audit.js";
import { discoveryTools } from "./tools/discovery.js";
import { resourceTools } from "./tools/resources.js";

/** Longest tool result passed to the model; a list endpoint can return megabytes. */
export const MAX_OUTPUT_CHARS = 200_000;

export function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  // Do not cut between the halves of a surrogate pair (emoji etc.).
  let cut = MAX_OUTPUT_CHARS;
  const unit = text.charCodeAt(cut - 1);
  if (unit >= 0xd800 && unit <= 0xdbff) cut--;
  return (
    text.slice(0, cut) +
    `\n\n[Output truncated at ${cut} of ${text.length} characters. ` +
    "Narrow the request: a smaller limit/offset, a date range or filters.]"
  );
}

export const VERSION = "0.5.0";

/** Every tool the server exposes, in listing order. */
export const tools: ToolDef[] = [...resourceTools, ...auditTools, ...discoveryTools];

/**
 * Assemble the MCP server: tool listing and dispatch. Transport-agnostic —
 * the stdio entry point (index.ts) connects it to stdin/stdout, and a hosted
 * variant can connect the same server to an HTTP transport.
 */
export function buildServer(ctx: ToolContext): Server {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const writesOn = !ctx.config.readOnly;
  const bookingOn = writesOn && ctx.config.allowBooking === true;

  const server = new Server(
    { name: "sevdesk-mcp", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        `sevDesk accounting (German SMB bookkeeping) for AI agents. ` +
        `Mode: ${ctx.config.readOnly ? "READ-ONLY — write tools are hidden" : ctx.config.dryRun ? "DRY-RUN — writes preview instead of sending" : "read/write — writes default to drafts"}` +
        `${bookingOn ? "; booking tools enabled (SEVDESK_ALLOW_BOOKING) — they book and remove payments, confirm each booking with the user" : ""}. ` +
        `Start with sevdesk_ping: it verifies the token and reports the account's ` +
        `bookkeeping generation. Tax rules are never guessed: write tools that need one ` +
        `take taxRuleId explicitly, and sevdesk_receipt_guidance lists what each booking ` +
        `account allows. ` +
        `Prefer the curated sevdesk_* tools; for anything else use sevdesk_call after ` +
        `sevdesk_list_operations / sevdesk_describe_operation. Every write accepts ` +
        `dryRun:true for a preview. Dates are yyyy-mm-dd; amounts EUR unless stated.`,
      // The tool list is fixed for the lifetime of the process (read-only
      // filtering depends only on startup config), so 2026-era clients may
      // cache it. Private: the listing varies with this deployment's config.
      cacheHints: { "tools/list": { ttlMs: 3_600_000, cacheScope: "private" } },
    },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: tools
      // Hide write tools entirely in read-only mode so they cannot be attempted.
      // Tools with listInReadOnly decide per call and stay visible. Booking
      // tools additionally need SEVDESK_ALLOW_BOOKING.
      .filter((t) => !(ctx.config.readOnly && t.mutating && !t.listInReadOnly))
      .filter((t) => !t.booking || bookingOn)
      .map((t) => ({
        name: t.name,
        title: t.title,
        description:
          t.description +
          (t.mutating && !ctx.config.readOnly
            ? " ⚠️ This tool can change data in sevDesk."
            : ""),
        inputSchema: t.inputSchema,
        // Standard MCP hints so clients can shape confirmation UX. Tools that
        // can delete (sevdesk_call) or remove payments (reset_voucher_to_open)
        // declare themselves destructive.
        annotations: {
          readOnlyHint: !t.mutating,
          destructiveHint: t.destructive === true,
          openWorldHint: true,
        },
      })),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = byName.get(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      };
    }

    // Same rule as the listing filter — a hidden write tool is also refused
    // here, so a stale tool list cannot reach a handler. The HTTP client
    // refuses mutating requests independently as the last line.
    if (ctx.config.readOnly && tool.mutating && !tool.listInReadOnly) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Refused: '${name}' modifies data in sevDesk, but the server runs with SEVDESK_READ_ONLY=true.`,
          },
        ],
      };
    }

    if (tool.booking && !bookingOn) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `Refused: '${name}' books or removes payments in sevDesk. Booking tools are off ` +
              "unless the server runs with SEVDESK_ALLOW_BOOKING=true.",
          },
        ],
      };
    }

    try {
      const result = await tool.handler((rawArgs ?? {}) as Record<string, unknown>, ctx);
      const text = capOutput(
        typeof result === "string" ? result : (JSON.stringify(result, null, 2) ?? ""),
      );
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
