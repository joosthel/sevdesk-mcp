/** Input-validation and transport guards: each one closes a way for a fallible caller to do harm. */
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { SevdeskApiError, SevdeskClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import {
  assertAllowedPath,
  optLimit,
  optRange,
  requireId,
  type ToolContext,
} from "../src/lib/tool.js";
import { MAX_OUTPUT_CHARS, capOutput, tools } from "../src/server.js";
import { catalog } from "../src/catalog.js";

type Row = Record<string, unknown>;
const env = (extra: Record<string, string>) => ({ SEVDESK_API_TOKEN: "t", ...extra });
const tool = (name: string) => tools.find((t) => t.name === name)!;

describe("config", () => {
  it("accepts https and loopback http, refuses cleartext elsewhere", () => {
    expect(loadConfig(env({ SEVDESK_BASE_URL: "https://proxy.example/api/v1/" })).baseUrl).toBe(
      "https://proxy.example/api/v1",
    );
    for (const u of ["http://localhost:8080/api", "http://127.0.0.1/api", "http://[::1]:9/api"]) {
      expect(loadConfig(env({ SEVDESK_BASE_URL: u })).baseUrl).toBe(u);
    }
    expect(() => loadConfig(env({ SEVDESK_BASE_URL: "http://example.com" }))).toThrow(/https/);
    expect(() => loadConfig(env({ SEVDESK_BASE_URL: "ftp://example.com" }))).toThrow(/https/);
    expect(() => loadConfig(env({ SEVDESK_BASE_URL: "not a url" }))).toThrow(/valid URL/);
  });

  it("splits receipt dirs on the platform delimiter and refuses relative entries", () => {
    const a = process.platform === "win32" ? "C:\\a" : "/a";
    const b = process.platform === "win32" ? "D:\\b" : "/b";
    expect(loadConfig(env({ SEVDESK_RECEIPT_DIRS: [a, b].join(delimiter) })).allowedReceiptDirs).toEqual([a, b]);
    expect(() => loadConfig(env({ SEVDESK_RECEIPT_DIRS: `${a}${delimiter}receipts` }))).toThrow(
      /not an absolute path/,
    );
  });
});

describe("client transport guards", () => {
  const cfg = loadConfig(env({ SEVDESK_RATE_LIMIT: "0" }));

  it("does not follow redirects and does not retry them", async () => {
    let calls = 0;
    let redirectMode: unknown;
    const client = new SevdeskClient(cfg, {
      fetchFn: (async (_u: unknown, init?: RequestInit) => {
        calls++;
        redirectMode = init?.redirect;
        return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
      }) as typeof fetch,
      sleep: async () => {},
    });
    const err = await client.request({ method: "GET", path: "/Voucher" }).catch((e) => e);
    expect(redirectMode).toBe("manual");
    expect(err).toBeInstanceOf(SevdeskApiError);
    expect(String(err.message)).toMatch(/redirect.*does not follow/is);
    expect(calls).toBe(1);
  });

  it("refuses a GET with a body up front, without calling fetch", async () => {
    let calls = 0;
    const client = new SevdeskClient(cfg, {
      fetchFn: (async () => {
        calls++;
        return new Response("{}");
      }) as typeof fetch,
    });
    await expect(client.request({ method: "GET", path: "/Voucher", body: { a: 1 } })).rejects.toThrow(
      /cannot carry a request body/,
    );
    expect(calls).toBe(0);
  });

  it("rejects '.' and '..' as path parameters", () => {
    expect(SevdeskClient.fillPath("/Voucher/{id}", { id: "42" })).toBe("/Voucher/42");
    expect(() => SevdeskClient.fillPath("/Voucher/{id}", { id: ".." })).toThrow(/Refused/);
    expect(() => SevdeskClient.fillPath("/Voucher/{id}", { id: "." })).toThrow(/Refused/);
  });
});

describe("arg helpers", () => {
  it("requireId accepts non-negative integers and digit strings only", () => {
    expect(requireId({ voucherId: 42 }, "voucherId")).toBe("42");
    expect(requireId({ voucherId: "0042" }, "voucherId")).toBe("0042");
    for (const bad of ["abc", "1/../2", "1?x=2", "-1", 1.5, -3, NaN, undefined, "", {}]) {
      expect(() => requireId({ voucherId: bad }, "voucherId")).toThrow("voucherId must be a numeric id.");
    }
  });

  it("optLimit floors and clamps to [1, max]", () => {
    expect(optLimit({}, "limit", 200, 1000)).toBe(200);
    expect(optLimit({ limit: -1 }, "limit", 200, 1000)).toBe(1);
    expect(optLimit({ limit: 0 }, "limit", 200, 1000)).toBe(1);
    expect(optLimit({ limit: 2.9 }, "limit", 200, 1000)).toBe(2);
    expect(optLimit({ limit: 1e9 }, "limit", 200, 1000)).toBe(1000);
    expect(optLimit({ limit: "abc" }, "limit", 200, 1000)).toBe(200);
  });
});

describe("assertAllowedPath", () => {
  it("follows symlinks: a link inside the allowlist pointing out is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "sevdesk-mcp-sym-"));
    const allowed = join(root, "receipts");
    const outside = join(root, "secret");
    await mkdir(allowed);
    await mkdir(outside);
    await writeFile(join(outside, "key"), "secret");
    await writeFile(join(allowed, "ok.pdf"), "x");
    await symlink(join(outside, "key"), join(allowed, "link.pdf"));
    await symlink(outside, join(allowed, "linkdir"));
    const ctx = { config: { allowedReceiptDirs: [allowed] } } as unknown as ToolContext;

    await expect(assertAllowedPath(ctx, join(allowed, "ok.pdf"))).resolves.toMatch(/ok\.pdf$/);
    await expect(assertAllowedPath(ctx, join(allowed, "link.pdf"))).rejects.toThrow(/outside/);
    await expect(assertAllowedPath(ctx, join(allowed, "linkdir"))).rejects.toThrow(/outside/);
    await expect(assertAllowedPath(ctx, join(allowed, "..", "secret", "key"))).rejects.toThrow(/outside/);
    await expect(assertAllowedPath(ctx, join(allowed, "missing.pdf"))).rejects.toThrow(/Not found/);
  });

  it("accepts a symlinked allowlist entry when the target is inside its real path", async () => {
    const root = await mkdtemp(join(tmpdir(), "sevdesk-mcp-sym-"));
    const real = join(root, "real");
    await mkdir(real);
    await writeFile(join(real, "a.pdf"), "x");
    await symlink(real, join(root, "alias"));
    const ctx = { config: { allowedReceiptDirs: [join(root, "alias")] } } as unknown as ToolContext;
    await expect(assertAllowedPath(ctx, join(real, "a.pdf"))).resolves.toBe(join(real, "a.pdf"));
  });
});

describe("annotations and output cap", () => {
  it("only sevdesk_call and the payment reset are destructive", () => {
    expect(tools.filter((t) => t.destructive).map((t) => t.name).sort()).toEqual([
      "sevdesk_call",
      "sevdesk_reset_voucher_to_open",
    ]);
  });

  it("marks exactly the payment tools as booking tools", () => {
    expect(tools.filter((t) => t.booking).map((t) => t.name).sort()).toEqual([
      "sevdesk_link_transaction",
      "sevdesk_reset_voucher_to_open",
    ]);
    expect(tools.filter((t) => t.booking).every((t) => t.mutating)).toBe(true);
  });

  it("parses SEVDESK_ALLOW_BOOKING strictly and defaults to off", () => {
    expect(loadConfig(env({})).allowBooking).toBe(false);
    expect(loadConfig(env({ SEVDESK_ALLOW_BOOKING: "true" })).allowBooking).toBe(true);
    expect(() => loadConfig(env({ SEVDESK_ALLOW_BOOKING: "maybe" }))).toThrow(/SEVDESK_ALLOW_BOOKING/);
  });

  it("truncates oversized output with a final notice", () => {
    expect(capOutput("short")).toBe("short");
    const out = capOutput("x".repeat(MAX_OUTPUT_CHARS + 500));
    expect(out.startsWith("x".repeat(MAX_OUTPUT_CHARS))).toBe(true);
    expect(out).toMatch(
      new RegExp(`truncated at ${MAX_OUTPUT_CHARS} of ${MAX_OUTPUT_CHARS + 500} characters`),
    );
  });
});

describe("sevdesk_call guards", () => {
  const call = tool("sevdesk_call");
  function ctx(readOnly = false) {
    const sent: Array<{ method: string; path: string; query?: Row }> = [];
    return {
      sent,
      ctx: {
        client: {
          async request(o: { method: string; path: string; query?: Row }) {
            sent.push(o);
            return { status: 200, data: {} };
          },
        },
        config: { readOnly, dryRun: false, baseUrl: "https://example.test/api/v1" },
      } as unknown as ToolContext,
    };
  }

  it("requires numeric path parameters", async () => {
    const { ctx: c, sent } = ctx();
    for (const bad of ["..", "1/../2", "abc", "1?x"]) {
      await expect(
        call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: bad } }, c),
      ).rejects.toThrow(/numeric id/);
    }
    expect(sent).toHaveLength(0);
  });

  it("refuses a body on a GET operation, naming it", async () => {
    const { ctx: c } = ctx();
    await expect(
      call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 1 }, body: { a: 1 } }, c),
    ).rejects.toThrow(/invoiceGetPdf.*no request body/);
  });

  it("defaults preventSendBy to true on every operation that has it", async () => {
    const { ctx: c, sent } = ctx();
    for (const op of ["invoiceGetPdf", "creditNoteGetPdf", "orderGetPdf"]) {
      const idName = op === "invoiceGetPdf" ? "invoiceId" : op === "orderGetPdf" ? "orderId" : "creditNoteId";
      await call.handler({ operationId: op, params: { [idName]: 5 } }, c);
    }
    expect(sent.map((s) => s.query?.preventSendBy)).toEqual([true, true, true]);
  });

  it("refuses preventSendBy=false in read-only mode but allows it otherwise", async () => {
    const ro = ctx(true);
    await expect(
      call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 5, preventSendBy: false } }, ro.ctx),
    ).rejects.toThrow(/SEVDESK_READ_ONLY/);
    await call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 5 } }, ro.ctx);
    expect(ro.sent[0]!.query?.preventSendBy).toBe(true);

    const rw = ctx(false);
    await call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 5, preventSendBy: false } }, rw.ctx);
    expect(rw.sent[0]!.query?.preventSendBy).toBe(false);
  });
});

describe("sevdesk_create_voucher validation", () => {
  const create = tool("sevdesk_create_voucher");
  const c = { client: {}, config: { readOnly: false, dryRun: true } } as unknown as ToolContext;
  const base = { supplierName: "A", voucherDate: "01.09.2026", taxRuleId: "9" };
  const run = (extra: Row) => create.handler({ ...base, ...extra }, c);

  it("requires a numeric taxRate, exactly one sum, and an allowed rate", async () => {
    await expect(run({ positions: [{ sumNet: 1 }] })).rejects.toThrow(/Position 1: taxRate/);
    await expect(run({ positions: [{ sumNet: 1, taxRate: "19" }] })).rejects.toThrow(/taxRate/);
    await expect(run({ positions: [{ taxRate: 19 }] })).rejects.toThrow(/exactly one of sumNet or sumGross/);
    await expect(run({ positions: [{ sumNet: 1, sumGross: 2, taxRate: 19 }] })).rejects.toThrow(/exactly one/);
    await expect(run({ positions: [{ sumNet: "1", taxRate: 19 }] })).rejects.toThrow(/sumNet must be/);
    await expect(run({ taxRuleId: "12", positions: [{ sumNet: 1, taxRate: 19 }] })).rejects.toThrow(
      /not allowed with rule 12/,
    );
    await expect(run({ positions: [{ sumGross: 119, taxRate: 19, accountingTypeId: "x" }] })).rejects.toThrow(
      /numeric id/,
    );
    const ok = (await run({ positions: [{ sumGross: 119, taxRate: 19 }] })) as {
      wouldSend: { body: { voucherPosSave: Row[] } };
    };
    expect(ok.wouldSend.body.voucherPosSave[0]).toMatchObject({ net: false, sumGross: 119, taxRate: 19 });
  });

  it("refuses extra keys that collide with fields the tool sets", async () => {
    const positions = [{ sumNet: 1, taxRate: 19 }];
    await expect(run({ positions, extra: { status: "1000", taxRule: {}, note: "x" } })).rejects.toThrow(
      /status, taxRule/,
    );
    const ok = (await run({ positions, extra: { note: "x" } })) as {
      wouldSend: { body: { voucher: Row } };
    };
    expect(ok.wouldSend.body.voucher.note).toBe("x");
  });
});

describe("sevdesk_create_invoice validation", () => {
  const create = tool("sevdesk_create_invoice");
  const c = { client: {}, config: { readOnly: false, dryRun: true } } as unknown as ToolContext;
  const run = (a: Row) => create.handler({ taxRuleId: "1", contactId: "7", ...a }, c);

  it("requires a numeric contactId, a non-empty name and a finite price", async () => {
    await expect(run({ contactId: "abc", positions: [{ name: "x", price: 1 }] })).rejects.toThrow(
      "contactId must be a numeric id.",
    );
    await expect(run({ positions: [{ name: "  ", price: 1 }] })).rejects.toThrow(/name must be/);
    await expect(run({ positions: [{ name: "x", price: "abc" }] })).rejects.toThrow(/price must be/);
    await expect(run({ positions: [{ name: "x" }] })).rejects.toThrow(/price must be/);
    await expect(run({ positions: [{ name: "x", price: 10 }] })).resolves.toMatchObject({ dryRun: true });
  });
});

describe("sevdesk_upload_voucher_file mime types", () => {
  const upload = tool("sevdesk_upload_voucher_file");

  it("maps known extensions and refuses unknown ones without mimeType", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-mcp-mime-"));
    const c = {
      client: {},
      config: { readOnly: false, dryRun: true, allowedReceiptDirs: [dir] },
    } as unknown as ToolContext;
    const mimeOf = async (name: string, extra: Row = {}) => {
      await writeFile(join(dir, name), "x");
      const out = (await upload.handler({ filePath: join(dir, name), ...extra }, c)) as {
        wouldSend: { mime: string };
      };
      return out.wouldSend.mime;
    };
    expect(await mimeOf("a.XML")).toBe("application/xml");
    expect(await mimeOf("a.jpg")).toBe("image/jpeg");
    expect(await mimeOf("a.jpeg")).toBe("image/jpeg");
    expect(await mimeOf("a.pdf")).toBe("application/pdf");
    expect(await mimeOf("a.png")).toBe("image/png");
    await expect(mimeOf("a.heic")).rejects.toThrow(/mimeType/);
    expect(await mimeOf("a.heic", { mimeType: "image/heic" })).toBe("image/heic");
  });
});

describe("sevdesk_call body and preventSendBy edge cases", () => {
  const call = tool("sevdesk_call");
  function ctx() {
    const sent: Array<{ query?: Row; body?: unknown; mutating?: boolean }> = [];
    return {
      sent,
      ctx: {
        client: {
          async request(o: { query?: Row; body?: unknown; mutating?: boolean }) {
            sent.push(o);
            return { status: 200, data: {} };
          },
        },
        config: { readOnly: false, dryRun: false, baseUrl: "https://example.test/api/v1" },
      } as unknown as ToolContext,
    };
  }

  it("treats null and {} bodies as absent on a GET, but refuses a real body", async () => {
    const { ctx: c, sent } = ctx();
    await call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 1 }, body: null }, c);
    await call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 1 }, body: {} }, c);
    expect(sent.every((s) => s.body === undefined)).toBe(true);
    await expect(
      call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 1 }, body: { a: 1 } }, c),
    ).rejects.toThrow(/no request body/);
  });

  it("defaults a null preventSendBy and normalizes truthy strings to a literal true", async () => {
    const { ctx: c, sent } = ctx();
    for (const v of [null, "yes", "1", "true"]) {
      await call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 1, preventSendBy: v } }, c);
    }
    expect(sent.map((s) => s.query?.preventSendBy)).toEqual([true, true, true, true]);
    expect(sent.every((s) => s.mutating === false)).toBe(true);
  });

  it("passes mutating=true to the client for state-changing GETs", async () => {
    const { ctx: c, sent } = ctx();
    await call.handler({ operationId: "exportDatevCSV", params: { enshrineDocuments: true } }, c);
    expect(sent[0]!.mutating).toBe(true);
  });
});

describe("remaining create_voucher / upload guards", () => {
  const create = tool("sevdesk_create_voucher");
  const c = { client: {}, config: { readOnly: false, dryRun: true } } as unknown as ToolContext;
  const base = { supplierName: "A", voucherDate: "01.09.2026", taxRuleId: "9" };

  it("refuses a rule that is not usable on vouchers (rule 18 on a D voucher)", async () => {
    await expect(
      create.handler({ ...base, taxRuleId: "18", creditDebit: "D", positions: [{ sumNet: 1, taxRate: 19 }] }, c),
    ).rejects.toThrow(/not usable on a voucher/);
  });

  it("refuses mixed net/gross positions and unknown creditDebit values", async () => {
    await expect(
      create.handler({ ...base, positions: [{ sumNet: 1, taxRate: 19 }, { sumGross: 2, taxRate: 19 }] }, c),
    ).rejects.toThrow(/mix sumNet and sumGross/);
    await expect(
      create.handler({ ...base, creditDebit: "d", positions: [{ sumNet: 1, taxRate: 19 }] }, c),
    ).rejects.toThrow(/creditDebit must be/);
  });

  it("refuses extra.taxType / extra.taxSet", async () => {
    await expect(
      create.handler({ ...base, positions: [{ sumNet: 1, taxRate: 19 }], extra: { taxType: "default" } }, c),
    ).rejects.toThrow(/taxType/);
  });

  it("uploads an allowlisted symlink named .pdf that points at an extension-less file", async () => {
    const root = await mkdtemp(join(tmpdir(), "sevdesk-mcp-alias-"));
    await writeFile(join(root, "scan"), "x");
    await symlink(join(root, "scan"), join(root, "alias.pdf"));
    const cx = { client: {}, config: { readOnly: false, dryRun: true, allowedReceiptDirs: [root] } } as unknown as ToolContext;
    const out = (await tool("sevdesk_upload_voucher_file").handler({ filePath: join(root, "alias.pdf") }, cx)) as {
      wouldSend: { mime: string; file: string };
    };
    expect(out.wouldSend.mime).toBe("application/pdf");
    expect(out.wouldSend.file).toBe(join(root, "alias.pdf"));
  });
});

describe("round 3 guards", () => {
  const call = tool("sevdesk_call");
  const mk = () => {
    const sent: Array<{ body?: unknown; mutating?: boolean }> = [];
    return {
      sent,
      ctx: {
        client: { async request(o: { body?: unknown }) { sent.push(o); return { status: 200, data: {} }; } },
        config: { readOnly: false, dryRun: false, baseUrl: "https://example.test/api/v1" },
      } as unknown as ToolContext,
    };
  };

  it("keeps an empty body on a write but accepts null/{}/[] as no body on a GET", async () => {
    const { ctx, sent } = mk();
    await call.handler({ operationId: "voucherFactorySaveVoucher", body: {} }, ctx);
    expect(sent[0]!.body).toEqual({});
    for (const b of [null, {}, []]) {
      await call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 1 }, body: b }, ctx);
    }
    expect(sent.slice(1).every((s) => s.body === undefined)).toBe(true);
    await expect(
      call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 1 }, body: [1] }, ctx),
    ).rejects.toThrow(/no request body/);
  });

  it("treats enshrine: 0 as a read", async () => {
    const { ctx, sent } = mk();
    await call.handler({ operationId: "exportDatevCSV", params: { enshrineDocuments: 0 } }, ctx);
    expect(sent[0]!.mutating).toBe(false);
  });

  it("validates extra and position shapes", async () => {
    const c = { client: {}, config: { readOnly: false, dryRun: true } } as unknown as ToolContext;
    const v = { supplierName: "A", voucherDate: "01.09.2026", taxRuleId: "9" };
    const ok = [{ sumNet: 1, taxRate: 19 }];
    for (const extra of [null, [], "x"]) {
      await expect(tool("sevdesk_create_voucher").handler({ ...v, positions: ok, extra }, c)).rejects.toThrow(/extra must be/);
    }
    for (const bad of [null, "x", []]) {
      await expect(tool("sevdesk_create_voucher").handler({ ...v, positions: [bad] }, c)).rejects.toThrow("Position 1: must be an object.");
      await expect(
        tool("sevdesk_create_invoice").handler({ contactId: 1, taxRuleId: "1", positions: [ok[0], bad] }, c),
      ).rejects.toThrow("Position 2: must be an object.");
    }
  });

  it("refuses base URLs with query, fragment or credentials", () => {
    for (const u of ["https://x.test/api?a=1", "https://x.test/api#f", "https://u:p@x.test/api", "https://u@x.test/api"]) {
      expect(() => loadConfig(env({ SEVDESK_BASE_URL: u }))).toThrow(/query string, fragment or credentials/);
    }
  });

  it("truncates a long sevDesk error message", () => {
    const e = new SevdeskApiError(400, "GET", "/x", { error: { message: "m".repeat(2000) } });
    expect(e.message.length).toBeLessThan(700);
  });

  it("get_invoice_pdf refuses a non-directory before any request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-mcp-pdf-"));
    await writeFile(join(dir, "f"), "x");
    let calls = 0;
    const c = {
      client: { async request() { calls++; return { status: 200, data: {} }; } },
      config: { readOnly: false, dryRun: false, allowedReceiptDirs: [dir] },
    } as unknown as ToolContext;
    await expect(tool("sevdesk_get_invoice_pdf").handler({ invoiceId: 1, directory: join(dir, "f") }, c)).rejects.toThrow(/Not a directory/);
    expect(calls).toBe(0);
  });
});

describe("audit argument bounds and diff truncation", () => {
  const dup = tool("sevdesk_find_duplicates");
  it("has bounded schemas for the numeric args", () => {
    const props = (n: string) => tool(n).inputSchema.properties as Record<string, Row>;
    expect(props("sevdesk_find_duplicates").dayWindow).toMatchObject({ minimum: 0, maximum: 366 });
    expect(props("sevdesk_diff_receipt_folder").dayTolerance).toMatchObject({ minimum: 0, maximum: 366 });
    expect(props("sevdesk_diff_receipt_folder").maxVouchers).toMatchObject({ minimum: 1, maximum: 20000 });
    expect(dup).toBeDefined();
  });

  it("clamps a negative day window instead of silently matching nothing", async () => {
    const ctx = {
      client: { getAll: async () => [
        { id: "1", voucherDate: "2026-06-01", sumGross: 10, supplierName: "A", status: "100", creditDebit: "C" },
        { id: "2", voucherDate: "2026-06-01", sumGross: 10, supplierName: "A", status: "100", creditDebit: "C" },
      ] },
      config: {},
    } as unknown as ToolContext;
    const out = (await dup.handler({ dayWindow: -50 }, ctx)) as { sameSupplierSameAmount: unknown[] };
    expect(out.sameSupplierSameAmount.length).toBe(1); // same-day pair is still found at window 0
  });

  it("diff_receipt_folder flags a hit voucher cap, and refuses non-string extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-mcp-diff-"));
    await writeFile(join(dir, "a.pdf"), "x");
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: String(i), voucherDate: "2026-06-01", status: "100" }));
    const ctx = {
      client: { getAll: async (_p: string, _q: unknown, o: { maxItems: number }) => rows.slice(0, o.maxItems) },
      config: { allowedReceiptDirs: [dir] },
    } as unknown as ToolContext;
    const diff = tool("sevdesk_diff_receipt_folder");
    const hit = (await diff.handler({ directory: dir, maxVouchers: 3 }, ctx)) as Row;
    expect(hit.truncated).toBe(true);
    expect(String(hit.warning)).toMatch(/maxVouchers/);
    const ok = (await diff.handler({ directory: dir, maxVouchers: 5 }, ctx)) as Row;
    expect(ok.truncated).toBe(false);
    // exactly at the cap is not truncation
    const exact = (await diff.handler({ directory: dir, maxVouchers: 4 }, ctx)) as Row;
    expect(exact.truncated).toBe(false);
    await expect(diff.handler({ directory: dir, extensions: [1] }, ctx)).rejects.toThrow(/extensions must be/);
  });
});

describe("round 4", () => {
  const rowsCtx = (n: number, extra: Row = {}) =>
    ({
      client: {
        getAll: async (_p: string, _q: unknown, o: { maxItems: number }) =>
          Array.from({ length: Math.min(n, o.maxItems) }, (_, i) => ({
            id: String(i), voucherDate: "2026-06-01", sumGross: 10 + i, supplierName: "S" + i,
            status: "100", creditDebit: "C", ...extra,
          })),
        request: async () => ({ status: 200, data: { objects: [] } }),
      },
      config: {},
    }) as unknown as ToolContext;

  it("every voucher-fetching audit flags truncation, but not an exact fit", async () => {
    for (const name of [
      "sevdesk_audit_vat",
      "sevdesk_reverse_charge_report",
      "sevdesk_find_duplicates",
      "sevdesk_subscription_gaps",
      "sevdesk_reconcile_transactions",
    ]) {
      const t = tools.find((x) => x.name === name);
      if (!t) continue;
      const a = name === "sevdesk_reconcile_transactions" ? { maxItems: 3 } : { maxVouchers: 3 };
      const cut = JSON.stringify(await t.handler({ ...a, includePositions: false }, rowsCtx(10)));
      expect(cut, name).toMatch(/"truncated": ?true/);
      expect(cut, name).toMatch(/maxVouchers|raise|Raise/);
      const exact = JSON.stringify(await t.handler({ ...a, includePositions: false }, rowsCtx(3)));
      expect(exact, name).toMatch(/"truncated": ?false/);
    }
  });

  it("builds the base URL from the parsed URL", () => {
    for (const u of ["https://my.sevdesk.de/api/v1?", "https://my.sevdesk.de/api/v1#", "  https://my.sevdesk.de/api/v1/  "]) {
      expect(loadConfig(env({ SEVDESK_BASE_URL: u })).baseUrl).toBe("https://my.sevdesk.de/api/v1");
    }
  });

  it("refuses fileName in extra, accepts numeric taxRuleId, falls back on bad PDF names", async () => {
    const c = { client: {}, config: { readOnly: false, dryRun: true } } as unknown as ToolContext;
    const v = { supplierName: "A", voucherDate: "01.09.2026", positions: [{ sumNet: 1, taxRate: 0 }] };
    await expect(
      tool("sevdesk_create_voucher").handler({ ...v, taxRuleId: "9", extra: { filename: "x.pdf" } }, c),
    ).rejects.toThrow(/fileName/);
    const out = (await tool("sevdesk_create_voucher").handler({ ...v, taxRuleId: 9 }, c)) as {
      wouldSend: { body: { voucher: { taxRule: { id: string } } } };
    };
    expect(out.wouldSend.body.voucher.taxRule.id).toBe("9");
    await expect(
      tool("sevdesk_create_invoice").handler({ contactId: 1, taxRuleId: 1, positions: [{ name: "x", price: 1 }] }, c),
    ).resolves.toMatchObject({ dryRun: true });

    const dir = await mkdtemp(join(tmpdir(), "sevdesk-mcp-pdfname-"));
    const pc = {
      client: { request: async () => ({ status: 200, data: { content: Buffer.from("x").toString("base64"), filename: ".." } }) },
      config: { readOnly: false, dryRun: false, allowedReceiptDirs: [dir] },
    } as unknown as ToolContext;
    const saved = (await tool("sevdesk_get_invoice_pdf").handler({ invoiceId: 7, directory: dir }, pc)) as { saved: string };
    expect(saved.saved).toMatch(/invoice-7\.pdf$/);
  });

  it("floors integer audit args but keeps rate fractional", () => {
    expect(optRange({ x: 2.9 }, "x", 1, 0, 10, true)).toBe(2);
    expect(optRange({ x: 2.9 }, "x", 1, 0, 10)).toBe(2.9);
    expect(optRange({ x: 99 }, "x", 1, 0, 10)).toBe(10);
  });
});

describe("round 5", () => {
  const dry = { client: {}, config: { readOnly: false, dryRun: false } } as unknown as ToolContext;

  it("refuses relative upload paths even when the cwd is inside the allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "sevdesk-mcp-rel-"));
    await writeFile(join(root, "receipt.pdf"), "x");
    const cx = { client: {}, config: { readOnly: false, dryRun: true, allowedReceiptDirs: [root] } } as unknown as ToolContext;
    const cwd = process.cwd();
    try {
      process.chdir(root);
    } catch {
      /* worker without chdir: the relative-path check does not depend on it */
    }
    try {
      for (const p of ["receipt.pdf", "../x.pdf"]) {
        await expect(tool("sevdesk_upload_voucher_file").handler({ filePath: p }, cx)).rejects.toThrow(/absolute/);
      }
    } finally {
      try { process.chdir(cwd); } catch { /* ignore */ }
    }
  });

  it("validates explicit invoice rates against the rule and derives the invoice text", async () => {
    const create = tool("sevdesk_create_invoice");
    const run = (taxRuleId: string, rates: Array<number | undefined>) =>
      create.handler(
        { contactId: 1, taxRuleId, dryRun: true, positions: rates.map((taxRate) => ({ name: "x", price: 1, taxRate })) },
        dry,
      ) as Promise<{ wouldSend: { body: { invoice: Row } } }>;
    await expect(run("11", [19])).rejects.toThrow(/Position 1: taxRate 19 is not allowed with rule 11/);
    const seven = (await run("1", [7, 7])).wouldSend.body.invoice;
    expect(seven).toMatchObject({ taxRate: 7, taxText: "Umsatzsteuer 7%" });
    const mixed = (await run("1", [7, 19])).wouldSend.body.invoice;
    expect(mixed.taxRate).toBe(19);
    expect(String(mixed.taxText)).not.toMatch(/Umsatzsteuer \d/);
    expect((await run("11", [0])).wouldSend.body.invoice.taxText).toMatch(/§ 19 UStG/);
  });

  it("refuses an unparseable dryRun instead of writing, and reads 1 / ' TRUE '", async () => {
    const create = tool("sevdesk_create_invoice");
    const a = { contactId: 1, taxRuleId: "1", positions: [{ name: "x", price: 1 }] };
    for (const bad of ["dry", 2, {}]) {
      await expect(create.handler({ ...a, dryRun: bad }, dry)).rejects.toThrow("dryRun must be true or false.");
    }
    for (const ok of [1, " TRUE ", "on"]) {
      await expect(create.handler({ ...a, dryRun: ok }, dry)).resolves.toMatchObject({ dryRun: true });
    }
  });

  it("parses boolean and numeric env vars strictly", () => {
    for (const [k, v] of [["SEVDESK_READ_ONLY", "maybe"], ["SEVDESK_DRY_RUN", "2"], ["SEVDESK_DEBUG", "tru"]]) {
      expect(() => loadConfig(env({ [k!]: v! }))).toThrow(new RegExp(k!));
    }
    expect(loadConfig(env({ SEVDESK_READ_ONLY: " ON " })).readOnly).toBe(true);
    expect(loadConfig(env({ SEVDESK_READ_ONLY: "Off" })).readOnly).toBe(false);
    expect(loadConfig(env({ SEVDESK_READ_ONLY: "" })).readOnly).toBe(false);
    expect(loadConfig(env({ SEVDESK_MAX_RETRIES: "0" })).maxRetries).toBe(0);
    expect(() => loadConfig(env({ SEVDESK_MAX_RETRIES: "-1" }))).toThrow(/SEVDESK_MAX_RETRIES/);
    expect(() => loadConfig(env({ SEVDESK_MAX_RETRIES: "x" }))).toThrow(/SEVDESK_MAX_RETRIES/);
    expect(() => loadConfig(env({ SEVDESK_TIMEOUT_MS: "0" }))).toThrow(/SEVDESK_TIMEOUT_MS/);
  });

  it("does not retry at all with SEVDESK_MAX_RETRIES=0, 429 included", async () => {
    let calls = 0;
    const client = new SevdeskClient(loadConfig(env({ SEVDESK_MAX_RETRIES: "0", SEVDESK_RATE_LIMIT: "0" })), {
      fetchFn: (async () => (calls++, new Response("{}", { status: 429 }))) as typeof fetch,
      sleep: async () => {},
    });
    await expect(client.request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(SevdeskApiError);
    expect(calls).toBe(1);
  });

  it("sevdesk_call refuses unparseable preventSendBy / enshrine values and normalizes the rest", async () => {
    const sent: Array<{ query?: Row }> = [];
    const c = {
      client: { async request(o: { query?: Row }) { sent.push(o); return { status: 200, data: {} }; } },
      config: { readOnly: false, dryRun: false, baseUrl: "https://example.test/api/v1" },
    } as unknown as ToolContext;
    const call = tool("sevdesk_call");
    await expect(
      call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 1, preventSendBy: "maybe" } }, c),
    ).rejects.toThrow("preventSendBy must be true or false.");
    await expect(
      call.handler({ operationId: "exportDatevCSV", params: { enshrineDocuments: {} } }, c),
    ).rejects.toThrow("enshrineDocuments must be true or false.");
    expect(sent).toHaveLength(0);
    await call.handler({ operationId: "exportDatevCSV", params: { enshrineDocuments: "0" } }, c);
    expect(sent[0]!.query!.enshrineDocuments).toBe(false);
  });

  it("list tools flag truncation but not an exact fit", async () => {
    const mk = (n: number) =>
      ({
        client: {
          getAll: async (_p: string, _q: unknown, o: { maxItems: number }) =>
            Array.from({ length: Math.min(n, o.maxItems) }, (_, i) => ({ id: String(i), voucherDate: "2026-06-01", invoiceDate: "2026-06-01", valueDate: "2026-06-01" })),
        },
        config: {},
      }) as unknown as ToolContext;
    const caps: Record<string, number> = {
      sevdesk_list_vouchers: 2000,
      sevdesk_list_invoices: 2000,
      sevdesk_list_contacts: 5000,
      sevdesk_list_transactions: 5000,
    };
    for (const [name, cap] of Object.entries(caps)) {
      const over = (await tool(name).handler({}, mk(cap + 1))) as Row;
      expect(over.truncated, name).toBe(true);
      expect(String(over.warning), name).toContain(String(cap));
      const exact = (await tool(name).handler({}, mk(cap))) as Row;
      expect(exact.truncated, name).toBe(false);
      expect(exact).not.toHaveProperty("warning");
    }
  });

  it("names transactions and maxItems when reconcile hits its transaction cap", async () => {
    const c = {
      client: {
        getAll: async (p: string, _q: unknown, o: { maxItems: number }) =>
          p === "/CheckAccountTransaction"
            ? Array.from({ length: o.maxItems }, (_, i) => ({ id: String(i), valueDate: "2026-06-01", amount: 1 }))
            : [],
      },
      config: {},
    } as unknown as ToolContext;
    const out = (await tool("sevdesk_reconcile_transactions").handler({ maxItems: 2 }, c)) as Row;
    expect(out.truncated).toBe(true);
    expect(String(out.warning)).toMatch(/transactions/);
    expect(String(out.warning)).toMatch(/maxItems/);
    expect(String(out.warning)).not.toMatch(/vouchers/);
  });

  it("pages voucher positions beyond one page and warns about unfetchable supplier contacts being cut", async () => {
    const calls: string[] = [];
    const c = {
      client: {
        getAll: async (p: string) => {
          calls.push(p);
          if (p === "/Voucher")
            return [{ id: "1", voucherDate: "2026-06-01", creditDebit: "C", status: "100", supplierName: "A", sumGross: 1 }];
          if (p === "/Contact") return Array.from({ length: 2001 }, (_, i) => ({ id: String(i), name: "c" + i }));
          return [];
        },
        request: async () => ({ status: 200, data: { objects: [] } }),
      },
      config: {},
    } as unknown as ToolContext;
    const out = (await tool("sevdesk_audit_vat").handler({}, c)) as { warnings: string[] };
    expect(calls).toContain("/VoucherPos");
    expect(out.warnings.join(" ")).toMatch(/contacts.*supplier-name heuristic/);
  });

  it("only accepts plain .pdf names from the API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-mcp-fname-"));
    const save = async (filename: string) => {
      const c = {
        client: { request: async () => ({ status: 200, data: { content: Buffer.from("x").toString("base64"), filename } }) },
        config: { readOnly: false, dryRun: false, allowedReceiptDirs: [dir] },
      } as unknown as ToolContext;
      return ((await tool("sevdesk_get_invoice_pdf").handler({ invoiceId: 3, directory: dir }, c)) as { saved: string }).saved;
    };
    expect(await save("RE 2026-1.PDF")).toMatch(/RE 2026-1\.PDF$/);
    expect(await save("evil.sh")).toMatch(/invoice-3\.pdf$/);
  });

  it("every path parameter in the catalog is an integer or number", () => {
    const bad = catalog.operations.flatMap((o) =>
      o.params.filter((p) => p.in === "path" && p.type !== "integer" && p.type !== "number").map((p) => `${o.operationId}.${p.name}:${p.type}`),
    );
    expect(bad).toEqual([]);
  });
});

describe("round 6", () => {
  it("list tools and summarize take a published maxItems cap that the warning names", async () => {
    const mk = (n: number) =>
      ({
        client: {
          getAll: async (_p: string, _q: unknown, o: { maxItems: number }) =>
            Array.from({ length: Math.min(n, o.maxItems) }, (_, i) => ({ id: String(i), voucherDate: "2026-06-01", invoiceDate: "2026-06-01", valueDate: "2026-06-01" })),
        },
        config: {},
      }) as unknown as ToolContext;
    for (const name of ["sevdesk_list_vouchers", "sevdesk_list_invoices", "sevdesk_list_contacts", "sevdesk_list_transactions"]) {
      expect((tool(name).inputSchema.properties.maxItems as Row).maximum, name).toBe(20000);
      const out = (await tool(name).handler({ maxItems: 3 }, mk(10))) as Row;
      expect(out.truncated, name).toBe(true);
      expect(String(out.warning), name).toMatch(/first 3 .*Raise maxItems/);
      expect(String(out.warning)).not.toMatch(/from\/to/);
      expect(((await tool(name).handler({ maxItems: 99999 }, mk(10))) as Row).truncated).toBe(false);
    }
    expect((tool("sevdesk_summarize").inputSchema.properties.maxItems as Row).maximum).toBe(20000);
    const sum = (await tool("sevdesk_summarize").handler({ kind: "invoices", maxItems: 3 }, mk(10))) as Row;
    expect(sum.truncated).toBe(true);
    expect(String(sum.warning)).toMatch(/Raise maxItems/);
  });

  it("keeps Unicode PDF names from the API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-mcp-uni-"));
    const c = {
      client: { request: async () => ({ status: 200, data: { content: Buffer.from("x").toString("base64"), filename: "Rechnung_Müller.pdf" } }) },
      config: { readOnly: false, dryRun: false, allowedReceiptDirs: [dir] },
    } as unknown as ToolContext;
    const out = (await tool("sevdesk_get_invoice_pdf").handler({ invoiceId: 3, directory: dir }, c)) as { saved: string };
    expect(out.saved).toMatch(/Rechnung_Müller\.pdf$/);
  });

  it("create_voucher accepts only status 50/100/1000", async () => {
    const c = { client: {}, config: { readOnly: false, dryRun: true } } as unknown as ToolContext;
    const a = { supplierName: "A", voucherDate: "01.09.2026", taxRuleId: "9", positions: [{ sumNet: 1, taxRate: 19 }] };
    for (const bad of ["75", "draft", 1]) {
      await expect(tool("sevdesk_create_voucher").handler({ ...a, status: bad }, c)).rejects.toThrow(/status must be/);
    }
    const out = (await tool("sevdesk_create_voucher").handler({ ...a, status: 100 }, c)) as {
      wouldSend: { body: { voucher: Row } };
    };
    expect(out.wouldSend.body.voucher.status).toBe("100");
  });

  it("names an unusable allowlist entry instead of calling the target 'outside'", async () => {
    const root = await mkdtemp(join(tmpdir(), "sevdesk-mcp-bad-"));
    await writeFile(join(root, "f.pdf"), "x");
    const missing = join(root, "does-not-exist");
    const ctx = { config: { allowedReceiptDirs: [missing] } } as unknown as ToolContext;
    await expect(assertAllowedPath(ctx, join(root, "f.pdf"))).rejects.toThrow(/does-not-exist.*does not exist or is not accessible/);
  });

  it("refuses non-integer or negative numeric taxRuleIds with a specific message", async () => {
    const c = { client: {}, config: { readOnly: false, dryRun: true } } as unknown as ToolContext;
    const v = { supplierName: "A", voucherDate: "01.09.2026", positions: [{ sumNet: 1, taxRate: 19 }] };
    for (const bad of [12.5, -1]) {
      await expect(tool("sevdesk_create_voucher").handler({ ...v, taxRuleId: bad }, c)).rejects.toThrow(/whole-number rule id/);
      await expect(
        tool("sevdesk_create_invoice").handler({ contactId: 1, taxRuleId: bad, positions: [{ name: "x", price: 1 }] }, c),
      ).rejects.toThrow(/whole-number rule id/);
      await expect(tool("sevdesk_set_tax_rule").handler({ voucherId: 1, taxRuleId: bad }, c)).rejects.toThrow(/whole-number rule id/);
    }
  });

  it("scrubs content from upload responses whether objects is an object or an array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-mcp-scrub-"));
    await writeFile(join(dir, "a.pdf"), "x");
    const run = async (objects: unknown) => {
      const c = {
        client: { request: async () => ({ status: 201, data: { objects } }) },
        config: { readOnly: false, dryRun: false, allowedReceiptDirs: [dir] },
      } as unknown as ToolContext;
      return ((await tool("sevdesk_upload_voucher_file").handler({ filePath: join(dir, "a.pdf") }, c)) as { response: { objects: unknown } }).response.objects;
    };
    expect(await run({ filename: "h.pdf", content: "BIG" })).toEqual({ filename: "h.pdf" });
    expect(await run([{ filename: "h.pdf", content: "BIG" }, { filename: "i.pdf" }])).toEqual([{ filename: "h.pdf" }, { filename: "i.pdf" }]);
    expect(await run("odd")).toBe("odd");
  });

  it("diff_receipt_folder emits a single truncation message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-mcp-one-"));
    await writeFile(join(dir, "a.pdf"), "x");
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: String(i), voucherDate: "2026-06-01", status: "100" }));
    const c = {
      client: { getAll: async (_p: string, _q: unknown, o: { maxItems: number }) => rows.slice(0, o.maxItems) },
      config: { allowedReceiptDirs: [dir] },
    } as unknown as ToolContext;
    const out = (await tool("sevdesk_diff_receipt_folder").handler({ directory: dir, maxVouchers: 3 }, c)) as Row;
    expect(out.truncated).toBe(true);
    expect(String(out.warning)).toMatch(/vouchersWithoutFile may be incomplete/);
    expect(String(out.note)).not.toMatch(/Truncated/);
  });
});
