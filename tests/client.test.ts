/**
 * Transport-policy tests for SevdeskClient: the retry rules that protect
 * against duplicate writes, the Retry-After clamp, error classification and
 * the client-side rate limiter.
 */
import { describe, expect, it } from "vitest";

import { SevdeskApiError, SevdeskClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { RateLimiter } from "../src/lib/rate-limiter.js";

function makeClient(opts: {
  responses: Array<{ status: number; body?: string; headers?: Record<string, string> } | "network">;
  env?: Record<string, string>;
}) {
  const calls: Array<{ method: string; url: string }> = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: String(init?.method), url: String(url) });
    const next = opts.responses[Math.min(i++, opts.responses.length - 1)];
    if (next === "network") throw new TypeError("fetch failed");
    return new Response(next.body ?? "{}", {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers },
    });
  }) as typeof fetch;

  const config = loadConfig({
    SEVDESK_API_TOKEN: "t",
    SEVDESK_RATE_LIMIT: "0", // pacing off unless a test opts in
    ...opts.env,
  });
  const client = new SevdeskClient(config, {
    fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_000_000,
    random: () => 0.5,
  });
  return { client, calls, sleeps };
}

describe("retry policy", () => {
  it("retries a GET on 500 and succeeds", async () => {
    const { client, calls } = makeClient({
      responses: [{ status: 500 }, { status: 200, body: '{"objects":[]}' }],
    });
    const res = await client.request({ method: "GET", path: "/Voucher" });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  it("never retries a write on 500 — a duplicate draft is worse than an error", async () => {
    const { client, calls } = makeClient({
      responses: [{ status: 500 }, { status: 201 }],
    });
    await expect(
      client.request({ method: "POST", path: "/Invoice/Factory/saveInvoice", body: {} }),
    ).rejects.toMatchObject({ status: 500, kind: "upstream" });
    expect(calls.length).toBe(1);
  });

  it("never retries a write on a network failure, and says why", async () => {
    const { client, calls } = makeClient({
      responses: ["network", { status: 201 }],
    });
    await expect(
      client.request({ method: "POST", path: "/Voucher/Factory/saveVoucher", body: {} }),
    ).rejects.toThrow(/not retried to avoid duplicates/);
    expect(calls.length).toBe(1);
  });

  it("retries a GET on a network failure", async () => {
    const { client, calls } = makeClient({
      responses: ["network", { status: 200, body: '{"objects":[]}' }],
    });
    const res = await client.request({ method: "GET", path: "/Invoice" });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  it("DOES retry a write on 429 — a throttled call was never executed", async () => {
    const { client, calls } = makeClient({
      responses: [{ status: 429 }, { status: 201, body: '{"objects":{}}' }],
    });
    const res = await client.request({ method: "POST", path: "/Voucher/Factory/saveVoucher", body: {} });
    expect(res.status).toBe(201);
    expect(calls.length).toBe(2);
  });

  it("gives up after maxRetries", async () => {
    const { client, calls } = makeClient({
      responses: [{ status: 503 }],
      env: { SEVDESK_MAX_RETRIES: "2" },
    });
    await expect(client.request({ method: "GET", path: "/Voucher" })).rejects.toMatchObject({
      status: 503,
    });
    expect(calls.length).toBe(3); // initial + 2 retries
  });
});

describe("Retry-After handling", () => {
  it("clamps a huge Retry-After so a buggy header cannot hang the request", async () => {
    const { client, sleeps } = makeClient({
      responses: [
        { status: 429, headers: { "retry-after": "3600" } },
        { status: 200, body: "{}" },
      ],
    });
    await client.request({ method: "GET", path: "/Voucher" });
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(30_000);
  });

  it("clamps a zero Retry-After to a minimum wait instead of hammering", async () => {
    const { client, sleeps } = makeClient({
      responses: [
        { status: 429, headers: { "retry-after": "0" } },
        { status: 200, body: "{}" },
      ],
    });
    await client.request({ method: "GET", path: "/Voucher" });
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(250);
  });

  it("understands the HTTP-date form of Retry-After", async () => {
    const { client, sleeps } = makeClient({
      responses: [
        // now() is pinned to 1_000_000; a date 5s later must wait ~5000ms.
        { status: 429, headers: { "retry-after": new Date(1_005_000).toUTCString() } },
        { status: 200, body: "{}" },
      ],
    });
    await client.request({ method: "GET", path: "/Voucher" });
    expect(sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(sleeps[0]).toBeLessThanOrEqual(6_000);
  });
});

describe("error classification", () => {
  it.each([
    [400, "validation"],
    [401, "auth"],
    [404, "not_found"],
    [429, "rate_limited"],
    [502, "upstream"],
  ] as const)("classifies %i as %s", async (status, kind) => {
    const { client } = makeClient({
      responses: [{ status }],
      env: { SEVDESK_MAX_RETRIES: "0" },
    });
    await expect(client.request({ method: "GET", path: "/Voucher" })).rejects.toMatchObject({
      status,
      kind,
    });
  });

  it("surfaces sevDesk's own error message instead of a JSON dump", async () => {
    const { client } = makeClient({
      responses: [
        {
          status: 400,
          body: '{"error":{"message":"taxRule is invalid for this voucher","code":151}}',
        },
      ],
    });
    await expect(client.request({ method: "GET", path: "/Voucher" })).rejects.toThrow(
      /taxRule is invalid for this voucher \(code 151\)/,
    );
  });

  it("classifies transport failures as network errors with status 0", async () => {
    const { client } = makeClient({
      responses: ["network"],
      env: { SEVDESK_MAX_RETRIES: "0" },
    });
    await expect(client.request({ method: "GET", path: "/Voucher" })).rejects.toMatchObject({
      status: 0,
      kind: "network",
    });
    const err = await client.request({ method: "GET", path: "/Voucher" }).catch((e) => e);
    expect(err).toBeInstanceOf(SevdeskApiError);
  });
});

describe("rate limiter", () => {
  it("lets a burst through up to capacity, then paces to the refill rate", async () => {
    let clock = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(2, 2, () => clock, async (ms) => {
      waits.push(ms);
      clock += ms;
    });
    await limiter.acquire();
    await limiter.acquire();
    expect(waits.length).toBe(0); // burst capacity
    await limiter.acquire(); // bucket empty: must wait ~500ms at 2/s
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(500);
  });

  it("refills over time", async () => {
    let clock = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(1, 1, () => clock, async (ms) => {
      waits.push(ms);
      clock += ms;
    });
    await limiter.acquire();
    clock += 1000; // a full second passes: one token back
    await limiter.acquire();
    expect(waits.length).toBe(0);
  });

  it("serializes concurrent acquires so callers cannot share one token", async () => {
    let clock = 0;
    let slept = 0;
    const limiter = new RateLimiter(1, 1000, () => clock, async (ms) => {
      slept += ms;
      clock += ms;
    });
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    expect(slept).toBeGreaterThan(0); // 2nd and 3rd caller had to wait
  });

  it("is wired into the client when SEVDESK_RATE_LIMIT is set", async () => {
    const sleeps: number[] = [];
    let clock = 0;
    const fetchFn = (async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const config = loadConfig({ SEVDESK_API_TOKEN: "t", SEVDESK_RATE_LIMIT: "1" });
    const client = new SevdeskClient(config, {
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      random: () => 0.5,
    });
    await client.request({ method: "GET", path: "/Voucher" });
    await client.request({ method: "GET", path: "/Voucher" }); // second must be paced
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(900);
  });
});

describe("config parsing", () => {
  it("defaults the rate limit to 4/s and accepts 0 as 'off'", () => {
    expect(loadConfig({ SEVDESK_API_TOKEN: "t" }).rateLimitPerSec).toBe(4);
    expect(loadConfig({ SEVDESK_API_TOKEN: "t", SEVDESK_RATE_LIMIT: "0" }).rateLimitPerSec).toBe(0);
    expect(loadConfig({ SEVDESK_API_TOKEN: "t", SEVDESK_RATE_LIMIT: "2.5" }).rateLimitPerSec).toBe(2.5);
    expect(loadConfig({ SEVDESK_API_TOKEN: "t", SEVDESK_RATE_LIMIT: "nope" }).rateLimitPerSec).toBe(4);
  });
});
