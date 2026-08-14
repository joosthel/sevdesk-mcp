import { RateLimiter } from "./lib/rate-limiter.js";
import { ReadOnlyError, type Config } from "./config.js";

export interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** multipart/form-data payload, used for receipt file upload. */
  form?: FormData;
  /** Set by callers that already know the operation mutates data. */
  mutating?: boolean;
}

export interface ApiResult<T = unknown> {
  status: number;
  data: T;
}

/** A short category so the caller (an agent) knows what to do next. */
export type SevdeskErrorKind =
  | "validation"
  | "auth"
  | "not_found"
  | "rate_limited"
  | "upstream"
  | "network";

export class SevdeskApiError extends Error {
  readonly kind: SevdeskErrorKind;

  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly payload: unknown,
  ) {
    super(`sevDesk API ${status} on ${method} ${path}: ${describePayload(payload)}`);
    this.name = "SevdeskApiError";
    this.kind = SevdeskApiError.classify(status);
  }

  private static classify(status: number): SevdeskErrorKind {
    if (status === 0) return "network";
    if (status === 400 || status === 406 || status === 409 || status === 422) return "validation";
    if (status === 401 || status === 403) return "auth";
    if (status === 404) return "not_found";
    if (status === 429) return "rate_limited";
    return "upstream";
  }
}

/**
 * Prefer sevDesk's own error message (`{"error": {"message": …}}`) over the raw
 * JSON dump — the message names the offending field, the dump buries it.
 */
function describePayload(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const err = (payload as Record<string, unknown>).error;
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      const msg = typeof e.message === "string" ? e.message.trim() : "";
      if (msg) return typeof e.code === "number" || typeof e.code === "string" ? `${msg} (code ${e.code})` : msg;
    }
  }
  return (typeof payload === "string" ? payload : JSON.stringify(payload)).slice(0, 600);
}

/**
 * 5xx statuses worth retrying — but ONLY for non-mutating requests. 429 is
 * handled separately: a throttled call was never executed, so it is always
 * safe to retry, writes included.
 */
const RETRYABLE_5XX = new Set([500, 502, 503, 504]);
/** Clamp any retry wait so a hostile/buggy `Retry-After` can't hang a request. */
const MIN_RETRY_WAIT_MS = 250;
const MAX_RETRY_WAIT_MS = 30_000;

/** Flatten nested query objects into sevDesk's `a[b]=c` bracket syntax. */
export function encodeQuery(query: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(`${prefix}[${k}]`, v);
      }
    } else {
      parts.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [k, v] of Object.entries(query)) walk(k, v);
  return parts.join("&");
}

/** Injectable seams for deterministic tests; production uses the defaults. */
export interface ClientHooks {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Jitter source in [0,1). */
  random?: () => number;
}

export class SevdeskClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly limiter: RateLimiter | null;

  constructor(
    private readonly config: Config,
    hooks: ClientHooks = {},
  ) {
    this.fetchFn = hooks.fetchFn ?? fetch;
    this.sleep = hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = hooks.now ?? (() => Date.now());
    this.random = hooks.random ?? Math.random;
    this.limiter =
      config.rateLimitPerSec > 0
        ? new RateLimiter(
            Math.max(1, Math.ceil(config.rateLimitPerSec)),
            config.rateLimitPerSec,
            this.now,
            this.sleep,
          )
        : null;
  }

  /** Substitute `{id}`-style path parameters and report any that are missing. */
  static fillPath(path: string, params: Record<string, unknown>): string {
    return path.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const value = params[name];
      if (value === undefined || value === null || value === "") {
        throw new Error(`Missing required path parameter '${name}' for ${path}`);
      }
      return encodeURIComponent(String(value));
    });
  }

  async request<T = unknown>(opts: RequestOptions): Promise<ApiResult<T>> {
    const mutating = opts.mutating ?? opts.method.toUpperCase() !== "GET";
    if (mutating && this.config.readOnly) {
      throw new ReadOnlyError(`${opts.method} ${opts.path}`);
    }

    const qs = opts.query ? encodeQuery(opts.query) : "";
    const url = `${this.config.baseUrl}${opts.path}${qs ? `?${qs}` : ""}`;

    const headers: Record<string, string> = {
      Authorization: this.config.apiToken,
      Accept: "application/json",
      "User-Agent": "sevdesk-mcp",
    };

    let payload: BodyInit | undefined;
    if (opts.form) {
      payload = opts.form; // fetch sets the multipart boundary itself
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }

    for (let attempt = 0; ; attempt++) {
      await this.limiter?.acquire();

      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: opts.method.toUpperCase(),
          headers,
          body: payload,
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch (err) {
        // Transport failure or our own timeout. The request may or may not have
        // reached sevDesk — replaying a write here could create a duplicate
        // draft, so only non-mutating calls are retried.
        if (!mutating && attempt < this.config.maxRetries) {
          this.log(opts.method, opts.path, "network-error (retrying)");
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        this.log(opts.method, opts.path, "network-error");
        throw new SevdeskApiError(
          0,
          opts.method,
          opts.path,
          `Network error${mutating ? " (write not retried to avoid duplicates)" : ""}: ${
            err instanceof Error ? err.message : "unknown"
          }`,
        );
      }

      this.log(opts.method, opts.path, String(res.status));

      // 429 is always safe to retry: a throttled call was never executed.
      if (res.status === 429 && attempt < this.config.maxRetries) {
        await this.drain(res);
        await this.sleep(this.retryAfterMs(res, attempt));
        continue;
      }
      // Transient upstream errors: retry only non-mutating calls (a 5xx on a
      // write is ambiguous — sevDesk may have persisted the document).
      if (RETRYABLE_5XX.has(res.status) && !mutating && attempt < this.config.maxRetries) {
        await this.drain(res);
        await this.sleep(this.backoffMs(attempt));
        continue;
      }

      // Read the body defensively: a stream that fails mid-read must not turn
      // into a retry (ambiguous for writes) or an unclassified crash.
      let data: unknown;
      try {
        const text = await res.text();
        data = text;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            /* keep the raw string; sevDesk returns plain text on some errors */
          }
        }
      } catch (err) {
        if (!res.ok) throw new SevdeskApiError(res.status, opts.method, opts.path, undefined);
        throw new SevdeskApiError(
          0,
          opts.method,
          opts.path,
          `Response body could not be read: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }

      if (!res.ok) throw new SevdeskApiError(res.status, opts.method, opts.path, data);
      return { status: res.status, data: data as T };
    }
  }

  /**
   * GET every page of a collection endpoint. sevDesk caps `limit` at 1000 and
   * returns `{ objects: [...] }`, so we walk offsets until a short page arrives.
   */
  async getAll<T = Record<string, unknown>>(
    path: string,
    query: Record<string, unknown> = {},
    opts: { pageSize?: number; maxItems?: number } = {},
  ): Promise<T[]> {
    const pageSize = Math.min(opts.pageSize ?? 500, 1000);
    const maxItems = opts.maxItems ?? 20_000;
    const out: T[] = [];

    for (let offset = 0; out.length < maxItems; offset += pageSize) {
      const { data } = await this.request<{ objects?: T[] }>({
        method: "GET",
        path,
        query: { ...query, limit: pageSize, offset },
      });
      const batch = data?.objects ?? [];
      out.push(...batch);
      if (batch.length < pageSize) break;
    }
    return out.slice(0, maxItems);
  }

  /** Discard an abandoned response body so the keep-alive socket can be reused. */
  private async drain(res: Response): Promise<void> {
    try {
      await res.body?.cancel();
    } catch {
      // A body already errored/closed is fine to ignore.
    }
  }

  /** Wait per `Retry-After` if present (clamped), else jittered exponential backoff. */
  private retryAfterMs(res: Response, attempt: number): number {
    const header = res.headers.get("retry-after");
    if (header) {
      const trimmed = header.trim();
      let ms: number | undefined;
      if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
        ms = Number(trimmed) * 1000;
      } else {
        const date = Date.parse(trimmed);
        if (!Number.isNaN(date)) ms = date - this.now();
      }
      if (ms !== undefined) {
        // Never hammer (floor) and never hang for minutes/hours (ceiling).
        return Math.min(MAX_RETRY_WAIT_MS, Math.max(MIN_RETRY_WAIT_MS, ms));
      }
    }
    return this.backoffMs(attempt);
  }

  /** Exponential backoff with full jitter, capped at 8s. */
  private backoffMs(attempt: number): number {
    const base = Math.min(8000, 500 * 2 ** attempt);
    return Math.floor(base * (0.5 + this.random() * 0.5));
  }

  private log(method: string, path: string, status: string): void {
    if (this.config.debug) {
      // Path only — never query (may contain filters), never headers/body.
      console.error(`[sevdesk] ${method.toUpperCase()} ${path.split("?")[0]} -> ${status}`);
    }
  }
}
