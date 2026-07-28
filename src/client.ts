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

export class SevdeskApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly payload: unknown,
  ) {
    super(
      `sevDesk API ${status} on ${method} ${path}: ` +
        (typeof payload === "string" ? payload : JSON.stringify(payload)).slice(0, 600),
    );
    this.name = "SevdeskApiError";
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SevdeskClient {
  constructor(private readonly config: Config) {}

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

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const res = await fetch(url, {
          method: opts.method.toUpperCase(),
          headers,
          body: payload,
          signal: controller.signal,
        });

        const text = await res.text();
        let data: unknown = text;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            /* keep the raw string; sevDesk returns plain text on some errors */
          }
        }

        if (!res.ok) {
          if (RETRYABLE.has(res.status) && attempt < this.config.maxRetries) {
            const retryAfter = Number(res.headers.get("retry-after"));
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : 2 ** attempt * 500;
            await sleep(waitMs);
            continue;
          }
          throw new SevdeskApiError(res.status, opts.method, opts.path, data);
        }

        return { status: res.status, data: data as T };
      } catch (err) {
        lastError = err;
        if (err instanceof SevdeskApiError) throw err;
        // Network-level failure or timeout: retry with backoff.
        if (attempt < this.config.maxRetries) {
          await sleep(2 ** attempt * 500);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Request to ${opts.method} ${opts.path} failed`);
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
}
