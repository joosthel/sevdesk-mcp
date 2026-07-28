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
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
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
