import { isAbsolute, resolve, sep } from "node:path";

import type { SevdeskClient } from "../client.js";
import type { Config } from "../config.js";

export interface ToolContext {
  client: SevdeskClient;
  config: Config;
}

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** Declared so clients (and the read-only gate) know before calling. */
  mutating: boolean;
  /**
   * Keep the tool listed and callable in read-only mode even though it is
   * declared mutating — for tools that decide per call (sevdesk_call also
   * covers reads; its writes are still refused at the client layer).
   */
  listInReadOnly?: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/** One rule for every write tool: a per-call dryRun argument or the global flag. */
export function isDryRun(args: Record<string, unknown>, ctx: ToolContext): boolean {
  return (optBool(args, "dryRun") ?? false) || ctx.config.dryRun;
}

/**
 * Enforce the SEVDESK_RECEIPT_DIRS allowlist. Filesystem access is disabled
 * until the user names directories explicitly; paths outside them are refused.
 */
export function assertAllowedPath(ctx: ToolContext, filePath: string): string {
  if (!isAbsolute(filePath)) throw new Error("File path must be absolute.");
  const target = resolve(filePath);
  const allow = ctx.config.allowedReceiptDirs;
  if (allow.length === 0) {
    throw new Error(
      "Refused: filesystem access is disabled by default. Set SEVDESK_RECEIPT_DIRS to a " +
        "colon-separated allowlist of directories to enable the receipt file tools.",
    );
  }
  const ok = allow.some((a) => target === resolve(a) || target.startsWith(resolve(a) + sep));
  if (!ok) {
    throw new Error(`Refused: ${target} is outside SEVDESK_RECEIPT_DIRS (${allow.join(", ")}).`);
  }
  return target;
}

export const str = (description: string, extra: Record<string, unknown> = {}) => ({
  type: "string",
  description,
  ...extra,
});

export const int = (description: string, extra: Record<string, unknown> = {}) => ({
  type: "integer",
  description,
  ...extra,
});

export const bool = (description: string, extra: Record<string, unknown> = {}) => ({
  type: "boolean",
  description,
  ...extra,
});

export const obj = (description: string) => ({
  type: "object",
  description,
  additionalProperties: true,
});

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`Missing required string argument '${key}'.`);
  }
  return v.trim();
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (["true", "1", "yes"].includes(v.toLowerCase())) return true;
    if (["false", "0", "no"].includes(v.toLowerCase())) return false;
  }
  return undefined;
}
