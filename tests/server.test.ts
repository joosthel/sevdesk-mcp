/** Drives the real tools/list and tools/call handlers over a linked in-memory transport. */
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { SevdeskClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import type { ToolContext, ToolDef } from "../src/lib/tool.js";
import { MAX_OUTPUT_CHARS, buildServer, capOutput, tools } from "../src/server.js";

type Row = Record<string, unknown>;

async function connect(opts: { readOnly?: boolean; allowBooking?: boolean; fetchCalls?: string[] } = {}) {
  const config = loadConfig({
    SEVDESK_API_TOKEN: "t",
    SEVDESK_RATE_LIMIT: "0",
    SEVDESK_READ_ONLY: opts.readOnly ? "true" : "false",
    SEVDESK_ALLOW_BOOKING: opts.allowBooking ? "true" : "false",
  });
  const client = new SevdeskClient(config, {
    fetchFn: (async (url: RequestInfo | URL) => {
      opts.fetchCalls?.push(String(url));
      return new Response('{"objects":[]}', { status: 200 });
    }) as typeof fetch,
  });
  const ctx: ToolContext = { client, config };
  const server = buildServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const pending = new Map<number, (m: Row) => void>();
  a.onmessage = (m) => {
    const msg = m as Row;
    if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
  };
  await a.start();
  let id = 0;
  const rpc = (method: string, params: Row = {}) =>
    new Promise<Row>((res) => {
      const n = ++id;
      pending.set(n, res);
      void a.send({ jsonrpc: "2.0", id: n, method, params } as never);
    });
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  await a.send({ jsonrpc: "2.0", method: "notifications/initialized" } as never);
  const list = async () =>
    ((await rpc("tools/list")).result as { tools: Array<Row & { name: string; annotations: Row }> }).tools;
  const call = async (name: string, args: Row = {}) =>
    (await rpc("tools/call", { name, arguments: args })).result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
  return { list, call, close: () => a.close() };
}

describe("buildServer handlers", () => {
  it("hides write tools in read-only mode but keeps sevdesk_call", async () => {
    const s = await connect({ readOnly: true });
    const names = (await s.list()).map((t) => t.name);
    expect(names).not.toContain("sevdesk_create_invoice");
    expect(names).not.toContain("sevdesk_upload_voucher_file");
    expect(names).toContain("sevdesk_call");
    expect(names).toContain("sevdesk_list_vouchers");
    await s.close();
    const rw = await connect();
    expect((await rw.list()).map((t) => t.name)).toContain("sevdesk_create_invoice");
    await rw.close();
  });

  it("refuses a hidden write tool at call time, before any HTTP", async () => {
    const fetchCalls: string[] = [];
    const s = await connect({ readOnly: true, fetchCalls });
    const r = await s.call("sevdesk_create_invoice", { contactId: 1, taxRuleId: "1", positions: [] });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/SEVDESK_READ_ONLY/);
    expect(fetchCalls).toHaveLength(0);
    await s.close();
  });

  it("lists booking tools only with SEVDESK_ALLOW_BOOKING and writes enabled", async () => {
    const booking = ["sevdesk_link_transaction", "sevdesk_reset_voucher_to_open"];
    const off = await connect();
    const offNames = (await off.list()).map((t) => t.name);
    expect(offNames.filter((n) => booking.includes(n))).toEqual([]);
    expect(offNames).toContain("sevdesk_create_voucher");
    await off.close();

    const on = await connect({ allowBooking: true });
    const onTools = await on.list();
    expect(onTools.map((t) => t.name)).toEqual(expect.arrayContaining(booking));
    expect(onTools.find((t) => t.name === "sevdesk_reset_voucher_to_open")!.annotations.destructiveHint).toBe(true);
    await on.close();

    const ro = await connect({ readOnly: true, allowBooking: true });
    expect((await ro.list()).map((t) => t.name).filter((n) => booking.includes(n))).toEqual([]);
    await ro.close();
  });

  it("gives the read-only refusal for a booking tool even with SEVDESK_ALLOW_BOOKING", async () => {
    const fetchCalls: string[] = [];
    const s = await connect({ readOnly: true, allowBooking: true, fetchCalls });
    const r = await s.call("sevdesk_reset_voucher_to_open", { voucherId: "1" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/SEVDESK_READ_ONLY/);
    expect(fetchCalls).toHaveLength(0);
    await s.close();
  });

  it("refuses a booking tool at call time without SEVDESK_ALLOW_BOOKING, before any HTTP", async () => {
    const fetchCalls: string[] = [];
    const s = await connect({ fetchCalls });
    const r = await s.call("sevdesk_link_transaction", { transactionId: "1", voucherId: "2" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/SEVDESK_ALLOW_BOOKING/);
    expect(fetchCalls).toHaveLength(0);
    await s.close();
  });

  it("maps destructive to destructiveHint and mutating to readOnlyHint", async () => {
    const s = await connect();
    const byName = new Map((await s.list()).map((t) => [t.name, t.annotations]));
    expect(byName.get("sevdesk_call")!.destructiveHint).toBe(true);
    expect(byName.get("sevdesk_list_vouchers")).toMatchObject({ destructiveHint: false, readOnlyHint: true });
    expect(byName.get("sevdesk_create_invoice")).toMatchObject({ destructiveHint: false, readOnlyHint: false });
    await s.close();
  });

  it("caps oversized tool results in tools/call", async () => {
    const big: ToolDef = {
      name: "test_big_output",
      description: "x",
      inputSchema: { type: "object", properties: {} },
      mutating: false,
      handler: async () => "y".repeat(MAX_OUTPUT_CHARS + 1000),
    };
    tools.push(big);
    try {
      const s = await connect();
      const r = await s.call("test_big_output");
      expect(r.content[0]!.text).toMatch(/Output truncated at \d+ of \d+ characters/);
      expect(r.content[0]!.text.length).toBeLessThan(MAX_OUTPUT_CHARS + 300);
      await s.close();
    } finally {
      tools.pop();
    }
  });

  it("sevdesk_call refuses state-changing GETs in read-only mode with no HTTP", async () => {
    const fetchCalls: string[] = [];
    const s = await connect({ readOnly: true, fetchCalls });
    const cases: Array<[string, Row]> = [
      ["sendCreditNoteByPrinting", { creditNoteId: 5 }],
      ["exportDatevCSV", { enshrineDocuments: true }],
      ["exportDatevDepricated", { enshrine: "true" }],
      ["invoiceGetPdf", { invoiceId: 5, preventSendBy: "no" }],
      ["voucherFactorySaveVoucher", {}],
    ];
    for (const [operationId, params] of cases) {
      const r = await s.call("sevdesk_call", { operationId, params });
      expect(r.isError, operationId).toBe(true);
      expect(r.content[0]!.text, operationId).toMatch(/SEVDESK_READ_ONLY/);
    }
    expect(fetchCalls).toHaveLength(0);

    // Plain reads, and enshrine flags that are off or are read filters, still pass.
    for (const [operationId, params] of [
      ["exportDatevCSV", {}],
      ["exportDatevCSV", { enshrineDocuments: false, includeEnshrined: true }],
      ["exportDatevDepricated", { withEnshrinedDocuments: true, enshrine: "0" }],
    ] as Array<[string, Row]>) {
      const r = await s.call("sevdesk_call", { operationId, params });
      expect(r.isError, operationId).toBeFalsy();
    }
    expect(fetchCalls).toHaveLength(3);
    await s.close();
  });

  it("sevdesk_call previews state-changing GETs on dryRun instead of sending", async () => {
    const fetchCalls: string[] = [];
    const s = await connect({ fetchCalls });
    for (const [operationId, params] of [
      ["sendCreditNoteByPrinting", { creditNoteId: 5 }],
      ["exportDatevCSV", { enshrineDocuments: true }],
      ["exportDatevDepricated", { enshrine: true }],
      ["invoiceGetPdf", { invoiceId: 5, preventSendBy: false }],
    ] as Array<[string, Row]>) {
      const r = await s.call("sevdesk_call", { operationId, params, dryRun: true });
      expect(JSON.parse(r.content[0]!.text), operationId).toMatchObject({ dryRun: true });
    }
    expect(fetchCalls).toHaveLength(0);
    await s.close();
  });
});

describe("capOutput", () => {
  it("does not split a surrogate pair at the cut", () => {
    const out = capOutput("a".repeat(MAX_OUTPUT_CHARS - 1) + "😀");
    const kept = out.split("\n\n[Output truncated")[0]!;
    expect(kept).toBe("a".repeat(MAX_OUTPUT_CHARS - 1));
    expect(out).toMatch(new RegExp(`truncated at ${MAX_OUTPUT_CHARS - 1} of ${MAX_OUTPUT_CHARS + 1}`));
  });
});

describe("client read-only gate", () => {
  it("refuses a write before fetch", async () => {
    let calls = 0;
    const client = new SevdeskClient(
      loadConfig({ SEVDESK_API_TOKEN: "t", SEVDESK_READ_ONLY: "true", SEVDESK_RATE_LIMIT: "0" }),
      { fetchFn: (async () => (calls++, new Response("{}"))) as typeof fetch },
    );
    await expect(client.request({ method: "POST", path: "/X", body: {} })).rejects.toThrow(/READ_ONLY/);
    await expect(client.request({ method: "GET", path: "/X", mutating: true })).rejects.toThrow(/READ_ONLY/);
    expect(calls).toBe(0);
  });
});

describe("tool-level guards", () => {
  const tool = (n: string) => tools.find((t) => t.name === n)!;

  it("list_vouchers clamps a negative or huge limit, and publishes the cap", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: String(i), voucherDate: "2026-01-01", status: "100" }));
    const ctx = {
      client: { getAll: async () => rows },
      config: { readOnly: false, dryRun: false },
    } as unknown as ToolContext;
    const list = tool("sevdesk_list_vouchers");
    expect(((await list.handler({ limit: -1 }, ctx)) as { vouchers: unknown[] }).vouchers).toHaveLength(1);
    expect(((await list.handler({ limit: 1e9 }, ctx)) as { vouchers: unknown[] }).vouchers).toHaveLength(5);
    expect((list.inputSchema.properties.limit as Row).maximum).toBe(1000);
  });

  it("get_voucher refuses a non-numeric id before any request", async () => {
    const ctx = {
      client: { request: async () => { throw new Error("must not be called"); } },
      config: { readOnly: false, dryRun: false },
    } as unknown as ToolContext;
    await expect(tool("sevdesk_get_voucher").handler({ voucherId: "1/../2" }, ctx)).rejects.toThrow(
      "voucherId must be a numeric id.",
    );
  });
});
