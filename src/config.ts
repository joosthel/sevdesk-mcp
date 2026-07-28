/** Runtime configuration, read once at startup from the environment. */

export interface Config {
  apiToken: string;
  baseUrl: string;
  /** When true, every mutating operation is refused before it reaches the API. */
  readOnly: boolean;
  /** When true, mutating operations describe what they would send instead of sending it. */
  dryRun: boolean;
  /** §19 UStG small-business scheme: audit suggestions point to the KU rule set (13/10/11). */
  kleinunternehmer: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  /** Directories the audit tools are allowed to read receipt files from. */
  allowedReceiptDirs: string[];
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
    baseUrl: (env.SEVDESK_BASE_URL ?? "https://my.sevdesk.de/api/v1").replace(/\/+$/, ""),
    readOnly: bool(env.SEVDESK_READ_ONLY, false),
    dryRun: bool(env.SEVDESK_DRY_RUN, false),
    kleinunternehmer: bool(env.SEVDESK_KLEINUNTERNEHMER, false),
    requestTimeoutMs: int(env.SEVDESK_TIMEOUT_MS, 30_000),
    maxRetries: int(env.SEVDESK_MAX_RETRIES, 3),
    allowedReceiptDirs: (env.SEVDESK_RECEIPT_DIRS ?? "")
      .split(":")
      .map((s) => s.trim())
      .filter(Boolean),
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
