import { delimiter, isAbsolute } from "node:path";

/** Runtime configuration, read once at startup from the environment. */

export interface Config {
  apiToken: string;
  baseUrl: string;
  /** When true, every mutating operation is refused before it reaches the API. */
  readOnly: boolean;
  /** When true, mutating operations describe what they would send instead of sending it. */
  dryRun: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  /**
   * Client-side request pacing in requests/second (token bucket), so bursty
   * fan-outs don't collide with sevDesk's throttle. 0 disables pacing.
   */
  rateLimitPerSec: number;
  /** Log method/path/status to stderr — never query strings, bodies or the token. */
  debug: boolean;
  /** Directories the audit tools are allowed to read receipt files from. */
  allowedReceiptDirs: string[];
  /**
   * When true, the booking tools (book a voucher against a bank transaction,
   * remove a voucher's payments) are listed and callable. Off by default.
   * Covers the curated tools only; sevdesk_call is not gated by it.
   */
  allowBooking: boolean;
}

function bool(name: string, value: string | undefined, fallback = false): boolean {
  const t = value?.trim().toLowerCase() ?? "";
  if (t === "") return fallback;
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (["0", "false", "no", "off"].includes(t)) return false;
  throw new Error(`${name} must be one of 1/true/yes/on or 0/false/no/off (got '${value}').`);
}

/** A whole number >= min; empty means the default, anything else invalid throws. */
function int(name: string, value: string | undefined, fallback: number, min: number): number {
  const t = value?.trim() ?? "";
  if (t === "") return fallback;
  const n = Number(t);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number >= ${min} (got '${value}').`);
  return n;
}

/** Fractional, with an explicit 0 meaning "disabled". */
function rate(name: string, value: string | undefined, fallback: number): number {
  const t = value?.trim() ?? "";
  if (t === "") return fallback;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number >= 0 (got '${value}').`);
  return n;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The token travels as a header, so the base URL must be https. Plain http is
 * allowed for loopback only, so local proxies and test servers keep working.
 */
function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SEVDESK_BASE_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error(
      `SEVDESK_BASE_URL must use https:// (got ${url.protocol}//${url.host}) — the API token is ` +
        "sent as a header and must not travel in cleartext. http:// is only accepted for " +
        "localhost, 127.0.0.1 and [::1].",
    );
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(
      "SEVDESK_BASE_URL must not carry a query string, fragment or credentials — " +
        "the token goes in SEVDESK_API_TOKEN, and paths are appended to the base.",
    );
  }
  // Rebuilt from the parsed URL so a bare "?" / "#" or stray whitespace cannot leak into requests.
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

/** Split on the platform delimiter (":" or ";" on Windows) and refuse relative entries. */
function parseReceiptDirs(raw: string | undefined): string[] {
  const dirs = (raw ?? "")
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const d of dirs) {
    if (!isAbsolute(d)) {
      throw new Error(
        `SEVDESK_RECEIPT_DIRS entry '${d}' is not an absolute path — a relative entry would ` +
          "resolve against whatever directory the MCP client launched this server in.",
      );
    }
  }
  return dirs;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiToken = env.SEVDESK_API_TOKEN?.trim();
  if (!apiToken) {
    throw new Error(
      "SEVDESK_API_TOKEN is not set.\n" +
        "Create a token in sevDesk under Settings -> Users -> your user -> API, " +
        "then put it in the `env` block of your MCP client configuration.",
    );
  }

  return {
    apiToken,
    baseUrl: parseBaseUrl(env.SEVDESK_BASE_URL ?? "https://my.sevdesk.de/api/v1"),
    readOnly: bool("SEVDESK_READ_ONLY", env.SEVDESK_READ_ONLY),
    dryRun: bool("SEVDESK_DRY_RUN", env.SEVDESK_DRY_RUN),
    requestTimeoutMs: int("SEVDESK_TIMEOUT_MS", env.SEVDESK_TIMEOUT_MS, 30_000, 1),
    maxRetries: int("SEVDESK_MAX_RETRIES", env.SEVDESK_MAX_RETRIES, 3, 0),
    rateLimitPerSec: rate("SEVDESK_RATE_LIMIT", env.SEVDESK_RATE_LIMIT, 4),
    debug: bool("SEVDESK_DEBUG", env.SEVDESK_DEBUG),
    allowedReceiptDirs: parseReceiptDirs(env.SEVDESK_RECEIPT_DIRS),
    allowBooking: bool("SEVDESK_ALLOW_BOOKING", env.SEVDESK_ALLOW_BOOKING),
  };
}

export class ReadOnlyError extends Error {
  constructor(what: string) {
    super(
      `Refused: '${what}' would modify data in sevDesk, but the server runs with ` +
        `SEVDESK_READ_ONLY=true. Unset that variable to allow writes.`,
    );
    this.name = "ReadOnlyError";
  }
}
