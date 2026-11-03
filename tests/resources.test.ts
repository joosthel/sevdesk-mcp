import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { ToolContext } from "../src/lib/tool.js";
import { resourceTools } from "../src/tools/resources.js";

const ping = resourceTools.find((t) => t.name === "sevdesk_ping")!;
const setTaxRule = resourceTools.find((t) => t.name === "sevdesk_set_tax_rule")!;
const receiptGuidance = resourceTools.find((t) => t.name === "sevdesk_receipt_guidance")!;
const createInvoice = resourceTools.find((t) => t.name === "sevdesk_create_invoice")!;
const getInvoicePdf = resourceTools.find((t) => t.name === "sevdesk_get_invoice_pdf")!;
const markInvoiceSent = resourceTools.find((t) => t.name === "sevdesk_mark_invoice_sent")!;

type Row = Record<string, unknown>;

function ctxWith(
  respond: (path: string) => { status: number; data: unknown },
): ToolContext {
  const client = {
    async request(opts: { path: string }): Promise<{ status: number; data: unknown }> {
      return respond(opts.path);
    },
  };
  return {
    client,
    config: {
      baseUrl: "https://example.test/api/v1",
      readOnly: true,
      dryRun: false,
      allowedReceiptDirs: [],
    },
  } as unknown as ToolContext;
}

describe("sevdesk_ping", () => {
  it("reports the account's bookkeeping system version", async () => {
    const ctx = ctxWith((path) =>
      path === "/Tools/bookkeepingSystemVersion"
        ? { status: 200, data: { objects: { version: "2.0" } } }
        : { status: 200, data: {} },
    );
    const result = (await ping.handler({}, ctx)) as {
      ok: boolean;
      bookkeepingSystemVersion: unknown;
    };
    expect(result.ok).toBe(true);
    expect(result.bookkeepingSystemVersion).toBe("2.0");
    expect(result).not.toHaveProperty("vatProfile");
  });

  it("still succeeds when the version endpoint fails", async () => {
    const ctx = ctxWith((path) => {
      if (path === "/Tools/bookkeepingSystemVersion") throw new Error("404");
      return { status: 200, data: {} };
    });
    const result = (await ping.handler({}, ctx)) as {
      ok: boolean;
      bookkeepingSystemVersion: unknown;
    };
    expect(result.ok).toBe(true);
    expect(String(result.bookkeepingSystemVersion)).toContain("unknown");
  });
});

/** Stub that serves one voucher and records every mutating request. */
function voucherCtx(v: Row | null, opts: { dryRun?: boolean } = {}) {
  const sent: Array<{ method: string; path: string; body?: unknown }> = [];
  const client = {
    async request(req: { method: string; path: string; body?: unknown }) {
      if (req.method === "PUT") {
        sent.push(req);
        if (v) Object.assign(v, req.body as Row);
        return { status: 200, data: { objects: [v] } };
      }
      if (req.path.startsWith("/Voucher/")) {
        return { status: 200, data: { objects: v ? [v] : [] } };
      }
      if (req.path.startsWith("/ReceiptGuidance")) {
        return {
          status: 200,
          data: {
            objects: [
              {
                accountDatevId: 4279,
                accountNumber: "6837",
                accountName: "laufende Gebühren für Lizenzen",
                description: "z.B. Software-Abonnements",
                allowedTaxRules: [
                  { id: 9, name: "VORST_ABZUGSF_AUFW", taxRates: ["ZERO", "SEVEN", "NINETEEN"] },
                  { id: 12, name: "REV_CHARGE_13B_MIT_VORST_ABZUG_0", taxRates: ["ZERO"] },
                ],
                allowedReceiptTypes: ["EXPENSE"],
              },
              {
                accountDatevId: 2571,
                accountNumber: "1350",
                accountName: "Kautionen",
                description: "Gezahlte Kautionen",
                allowedTaxRules: [{ id: 16, name: "NICHT_STEUERBAR_EXPENSE", taxRates: ["ZERO"] }],
                allowedReceiptTypes: ["EXPENSE"],
              },
            ],
          },
        };
      }
      return { status: 200, data: {} };
    },
  };
  const ctx = {
    client,
    config: { readOnly: false, dryRun: opts.dryRun ?? false, allowedReceiptDirs: [] },
  } as unknown as ToolContext;
  return { ctx, sent };
}

describe("sevdesk_set_tax_rule", () => {
  const baseVoucher = (): Row => ({
    id: "42",
    creditDebit: "C",
    status: "50",
    supplierName: "Acme Cloud, Inc.",
    voucherDate: "2026-06-01",
    sumGross: 100,
    taxRule: { id: "9", objectName: "TaxRule" },
    enshrined: null,
  });

  it("rebooks a voucher onto the requested rule and verifies the result", async () => {
    const { ctx, sent } = voucherCtx(baseVoucher());
    const result = (await setTaxRule.handler({ voucherId: "42", taxRuleId: "12" }, ctx)) as {
      before: { ruleId: string };
      after: { ruleId: string };
      verified: boolean;
    };
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe("/Voucher/42");
    expect(sent[0]!.body).toEqual({ taxRule: { id: "12", objectName: "TaxRule" } });
    expect(result.before.ruleId).toBe("9");
    expect(result.after.ruleId).toBe("12");
    expect(result.verified).toBe(true);
  });

  it("previews instead of sending when dryRun is set", async () => {
    const { ctx, sent } = voucherCtx(baseVoucher());
    const result = (await setTaxRule.handler(
      { voucherId: "42", taxRuleId: "12", dryRun: true },
      ctx,
    )) as { dryRun: boolean };
    expect(result.dryRun).toBe(true);
    expect(sent).toEqual([]);
  });

  it("refuses enshrined vouchers", async () => {
    const { ctx, sent } = voucherCtx({ ...baseVoucher(), enshrined: "2026-07-01T00:00:00+02:00" });
    await expect(setTaxRule.handler({ voucherId: "42", taxRuleId: "12" }, ctx)).rejects.toThrow(
      /enshrined|festgeschrieben/i,
    );
    expect(sent).toEqual([]);
  });

  it.each(["100", "1000"])("refuses a non-draft voucher (status %s), even as a dry run", async (status) => {
    const { ctx, sent } = voucherCtx({ ...baseVoucher(), status });
    await expect(
      setTaxRule.handler({ voucherId: "42", taxRuleId: "12", dryRun: true }, ctx),
    ).rejects.toThrow(/not a draft/);
    await expect(setTaxRule.handler({ voucherId: "42", taxRuleId: "12" }, ctx)).rejects.toThrow(
      /not a draft/,
    );
    expect(sent).toEqual([]);
  });

  it("refuses rules from the wrong side of the books", async () => {
    const { ctx, sent } = voucherCtx(baseVoucher());
    await expect(setTaxRule.handler({ voucherId: "42", taxRuleId: "1" }, ctx)).rejects.toThrow(
      /revenue rule|expense/i,
    );
    expect(sent).toEqual([]);
  });

  it("does nothing when the rule is already set", async () => {
    const { ctx, sent } = voucherCtx(baseVoucher());
    const result = (await setTaxRule.handler({ voucherId: "42", taxRuleId: "9" }, ctx)) as {
      changed: boolean;
    };
    expect(result.changed).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("sevdesk_receipt_guidance", () => {
  it("returns compact accounts with numeric rates", async () => {
    const { ctx } = voucherCtx(null);
    const result = (await receiptGuidance.handler({ accountNumber: "6837" }, ctx)) as {
      returned: number;
      accounts: Array<{ accountNumber: string; allowedTaxRules: Array<{ id: string; rates: number[] }> }>;
    };
    expect(result.returned).toBe(1);
    const acc = result.accounts[0]!;
    expect(acc.accountNumber).toBe("6837");
    expect(acc.allowedTaxRules.find((r) => r.id === "9")!.rates).toEqual([0, 7, 19]);
  });

  it("filters by tax rule", async () => {
    const { ctx } = voucherCtx(null);
    const result = (await receiptGuidance.handler({ taxRuleId: "12" }, ctx)) as {
      accounts: Array<{ accountNumber: string }>;
    };
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.accountNumber).toBe("6837");
  });
});

/** Stub for the invoice tools: records writes, serves one invoice and a PDF. */
function invoiceCtx(
  invoice: Row | null,
  config: Record<string, unknown> = {},
) {
  const sent: Array<{ method: string; path: string; body?: unknown; query?: unknown }> = [];
  const client = {
    async request(req: {
      method: string;
      path: string;
      body?: unknown;
      query?: Record<string, unknown>;
    }) {
      if (req.method === "POST" && req.path === "/Invoice/Factory/saveInvoice") {
        sent.push(req);
        return {
          status: 201,
          data: { objects: { invoice: { id: "900", invoiceNumber: "RE-1001", status: "50" } } },
        };
      }
      if (req.method === "PUT" && req.path.endsWith("/sendBy")) {
        sent.push(req);
        if (invoice) invoice.sendType = (req.body as Row).sendType;
        return { status: 200, data: { objects: invoice } };
      }
      if (req.path.endsWith("/getPdf")) {
        sent.push(req);
        return {
          status: 200,
          data: {
            objects: {
              filename: "RE-1001.pdf",
              content: Buffer.from("PDF-BYTES").toString("base64"),
            },
          },
        };
      }
      if (req.path.startsWith("/Invoice/")) {
        return { status: 200, data: { objects: invoice ? [invoice] : [] } };
      }
      return { status: 200, data: {} };
    },
  };
  const ctx = {
    client,
    config: {
      readOnly: false,
      dryRun: false,
      allowedReceiptDirs: [],
      ...config,
    },
  } as unknown as ToolContext;
  return { ctx, sent };
}

describe("sevdesk_create_invoice", () => {
  const args = {
    contactId: "77",
    taxRuleId: "1",
    positions: [{ name: "Consulting", quantity: 2, price: 100, taxRate: 19 }],
  };

  it("always creates drafts under the rule it was given", async () => {
    const { ctx, sent } = invoiceCtx(null);
    const result = (await createInvoice.handler(args, ctx)) as {
      invoiceId: string;
      status: string;
    };
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body as {
      invoice: { status: string; taxRule: { id: string }; contact: { id: number } };
      invoicePosSave: Array<{ name: string; taxRate: number }>;
    };
    // Invoice draft status is 100 — 50 means "deactivated recurring invoice" for invoices.
    expect(body.invoice.status).toBe("100");
    expect(body.invoice.taxRule.id).toBe("1");
    expect(body.invoice.contact.id).toBe(77);
    expect(body.invoicePosSave[0]!.name).toBe("Consulting");
    expect(result.invoiceId).toBe("900");
  });

  it("rejects unparseable position values instead of coercing them", async () => {
    const { ctx } = invoiceCtx(null);
    await expect(
      createInvoice.handler(
        { contactId: "77", taxRuleId: "1", positions: [{ name: "X", price: 100, taxRate: null }] },
        ctx,
      ),
    ).rejects.toThrow(/taxRate/);
    await expect(
      createInvoice.handler(
        { contactId: "77", taxRuleId: "1", positions: [{ name: "X", price: 100, quantity: 0 }] },
        ctx,
      ),
    ).rejects.toThrow(/quantity/);
  });

  it("refuses without a taxRuleId instead of guessing one", async () => {
    const { ctx, sent } = invoiceCtx(null);
    await expect(
      createInvoice.handler({ contactId: "77", positions: [{ name: "Consulting", price: 100 }] }, ctx),
    ).rejects.toThrow(/taxRuleId is required/);
    expect(sent).toEqual([]);
    expect(createInvoice.inputSchema.required).toContain("taxRuleId");
  });

  it("gives rule 11 0 % and the §19 text, rule 1 19 %", async () => {
    const { ctx, sent } = invoiceCtx(null);
    const positions = [{ name: "Consulting", price: 100 }];
    await createInvoice.handler({ contactId: "77", taxRuleId: "11", positions }, ctx);
    await createInvoice.handler({ contactId: "77", taxRuleId: "1", positions }, ctx);
    const bodies = sent.map(
      (c) =>
        c.body as {
          invoice: { taxRule: { id: string }; taxText: string };
          invoicePosSave: Array<{ taxRate: number }>;
        },
    );
    expect(bodies[0]!.invoice.taxRule.id).toBe("11");
    expect(bodies[0]!.invoicePosSave[0]!.taxRate).toBe(0);
    expect(bodies[0]!.invoice.taxText).toBe("Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.");
    expect(bodies[1]!.invoicePosSave[0]!.taxRate).toBe(19);
  });

  it("previews with dryRun instead of sending", async () => {
    const { ctx, sent } = invoiceCtx(null, { dryRun: true });
    const result = (await createInvoice.handler(args, ctx)) as { dryRun: boolean };
    expect(result.dryRun).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe("sevdesk_get_invoice_pdf", () => {
  it("saves the PDF into an allowlisted directory without touching send state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-mcp-test-"));
    const { ctx, sent } = invoiceCtx(null, { allowedReceiptDirs: [dir] });
    const result = (await getInvoicePdf.handler({ invoiceId: "900", directory: dir }, ctx)) as {
      saved: string;
    };
    expect(result.saved).toBe(join(await realpath(dir), "RE-1001.pdf"));
    expect(String(await readFile(result.saved))).toBe("PDF-BYTES");
    const pdfCall = sent.find((c) => c.path.endsWith("/getPdf"))!;
    expect((pdfCall.query as Row).preventSendBy).toBe(true);
  });

  it("refuses without a directory allowlist", async () => {
    const { ctx } = invoiceCtx(null);
    await expect(
      getInvoicePdf.handler({ invoiceId: "900", directory: "/tmp/x" }, ctx),
    ).rejects.toThrow(/SEVDESK_RECEIPT_DIRS/);
  });

  it("never overwrites an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-mcp-test-"));
    const { ctx } = invoiceCtx(null, { allowedReceiptDirs: [dir] });
    await getInvoicePdf.handler({ invoiceId: "900", directory: dir }, ctx);
    await expect(getInvoicePdf.handler({ invoiceId: "900", directory: dir }, ctx)).rejects.toThrow(
      /exists/i,
    );
  });
});

describe("sevdesk_mark_invoice_sent", () => {
  it("marks a non-enshrined invoice as sent by PDF and verifies", async () => {
    const invoice: Row = { id: "900", status: "100", enshrined: null, sendType: null };
    const { ctx, sent } = invoiceCtx(invoice);
    const result = (await markInvoiceSent.handler({ invoiceId: "900" }, ctx)) as {
      verified: boolean;
    };
    const put = sent.find((c) => c.path.endsWith("/sendBy"))!;
    expect((put.body as Row).sendType).toBe("VPDF");
    expect(result.verified).toBe(true);
  });

  it("refuses enshrined invoices", async () => {
    const invoice: Row = { id: "900", enshrined: "2026-01-01", sendType: null };
    const { ctx, sent } = invoiceCtx(invoice);
    await expect(markInvoiceSent.handler({ invoiceId: "900" }, ctx)).rejects.toThrow(
      /enshrined|festgeschrieben/i,
    );
    expect(sent.filter((c) => c.method === "PUT")).toEqual([]);
  });
});

describe("sevdesk_summarize", () => {
  const summarize = resourceTools.find((t) => t.name === "sevdesk_summarize")!;

  function summarizeCtx(rows: Row[]): ToolContext {
    return {
      client: { async getAll() { return rows; } },
      config: { readOnly: true, dryRun: false, allowedReceiptDirs: [] },
    } as unknown as ToolContext;
  }

  const invoices: Row[] = [
    { invoiceDate: "2026-07-05", status: "200", sumNet: 100, sumTax: 19, sumGross: 119, contact: { name: "Alpha" } },
    { invoiceDate: "2026-07-20", status: "200", sumNet: 200, sumTax: 38, sumGross: 238, contact: { name: "Beta" } },
    { invoiceDate: "2026-06-01", status: "1000", sumNet: 50, sumTax: 9.5, sumGross: 59.5, contact: { name: "Alpha" } },
  ];

  it("groups invoices by month with correct sums and no rows in the output", async () => {
    const out = (await summarize.handler({ kind: "invoices" }, summarizeCtx(invoices))) as {
      total: { count: number; net: number; gross: number };
      groups: Array<{ key: string; count: number; gross: number }>;
    };
    expect(out.total.count).toBe(3);
    expect(out.total.net).toBe(350);
    expect(out.total.gross).toBe(416.5);
    expect(out.groups.map((g) => g.key)).toEqual(["2026-06", "2026-07"]);
    expect(out.groups[1]!.gross).toBe(357);
    expect(JSON.stringify(out)).not.toContain("Alpha"); // aggregates only
  });

  it("decodes status codes into labels when grouping by status", async () => {
    const out = (await summarize.handler(
      { kind: "invoices", groupBy: "status" },
      summarizeCtx(invoices),
    )) as { groups: Array<{ key: string; count: number }> };
    const keys = out.groups.map((g) => g.key).sort();
    expect(keys).toEqual(["bezahlt", "offen"]);
  });

  it("filters by date range and reports scanned vs matched", async () => {
    const out = (await summarize.handler(
      { kind: "invoices", from: "2026-07-01", to: "2026-07-31" },
      summarizeCtx(invoices),
    )) as { scanned: number; matched: number; total: { count: number } };
    expect(out.scanned).toBe(3);
    expect(out.matched).toBe(2);
    expect(out.total.count).toBe(2);
  });

  it("filters vouchers by side (expense vs revenue)", async () => {
    const vouchers: Row[] = [
      { voucherDate: "2026-07-01", status: "1000", creditDebit: "C", sumNet: 40, sumTax: 7.6, sumGross: 47.6, supplierName: "Hetzner" },
      { voucherDate: "2026-07-02", status: "100", creditDebit: "D", sumNet: 500, sumTax: 95, sumGross: 595, supplierName: "Kunde" },
    ];
    const out = (await summarize.handler(
      { kind: "vouchers", side: "expense", groupBy: "none" },
      summarizeCtx(vouchers),
    )) as { total: { count: number; gross: number } };
    expect(out.total.count).toBe(1);
    expect(out.total.gross).toBe(47.6);
  });

  it("folds groups beyond maxGroups into '(andere)' without losing the totals", async () => {
    const out = (await summarize.handler(
      { kind: "invoices", groupBy: "contact", maxGroups: 1 },
      summarizeCtx(invoices),
    )) as { total: { count: number }; groups: Array<{ key: string; count: number }> };
    expect(out.groups.length).toBe(2); // top-1 + (andere)
    expect(out.groups[1]!.key).toBe("(andere)");
    expect(out.total.count).toBe(3); // nothing dropped
  });

  it("rejects an unknown kind", async () => {
    await expect(summarize.handler({ kind: "contacts" }, summarizeCtx([]))).rejects.toThrow(
      /kind must be/,
    );
  });
});

describe("sevdesk_create_voucher", () => {
  const createVoucher = resourceTools.find((t) => t.name === "sevdesk_create_voucher")!;

  const args = {
    supplierName: "Acme Ltd",
    voucherDate: "01.09.2026",
    taxRuleId: "9",
    positions: [{ sumNet: 100, taxRate: 19 }],
    dryRun: true,
  };

  it("attaches an uploaded receipt as a top-level 'filename'", async () => {
    const out = (await createVoucher.handler(
      { ...args, fileName: "abc123hash.pdf" },
      ctxWith(() => ({ status: 200, data: {} })),
    )) as { wouldSend: { body: Record<string, unknown> } };

    // sevDesk's saveVoucher schema puts the attachment next to `voucher`,
    // not inside it — in the wrong place it is silently dropped.
    expect(out.wouldSend.body.filename).toBe("abc123hash.pdf");
    expect(out.wouldSend.body.voucher).not.toHaveProperty("fileName");
    expect(out.wouldSend.body.voucher).not.toHaveProperty("filename");
  });

  it("refuses without a taxRuleId instead of defaulting one", async () => {
    const { taxRuleId: _omit, ...noRule } = args;
    await expect(
      createVoucher.handler(noRule, ctxWith(() => ({ status: 200, data: {} }))),
    ).rejects.toThrow(/taxRuleId is required/);
    expect(createVoucher.inputSchema.required).toContain("taxRuleId");
  });

  it("refuses a revenue rule on a C voucher, and an expense rule on a D voucher", async () => {
    const ctx = ctxWith(() => ({ status: 200, data: {} }));
    await expect(createVoucher.handler({ ...args, taxRuleId: "1" }, ctx)).rejects.toThrow(
      /revenue rule/,
    );
    await expect(
      createVoucher.handler({ ...args, taxRuleId: "9", creditDebit: "D" }, ctx),
    ).rejects.toThrow(/expense rule/);
  });

  it("passes the given rule through", async () => {
    const out = (await createVoucher.handler(
      { ...args, taxRuleId: "12", positions: [{ sumNet: 100, taxRate: 0 }] },
      ctxWith(() => ({ status: 200, data: {} })),
    )) as { wouldSend: { body: { voucher: Record<string, Row> } } };
    expect(out.wouldSend.body.voucher.taxRule).toEqual({ id: "12", objectName: "TaxRule" });
  });

  it("offers the expense-side rules its own description points at", async () => {
    const rules = (createVoucher.inputSchema.properties.taxRuleId as { enum: string[] }).enum;

    // sevDesk's ReceiptGuidance returns these for expense accounts; the spec's
    // Model_Voucher enum lists only the revenue side, which is what this
    // schema used to copy.
    expect(rules).toEqual(expect.arrayContaining(["9", "10", "12", "13", "14"]));
    expect(rules).toEqual(expect.arrayContaining(["1", "11"]));
  });

  it("omits 'filename' entirely when no receipt was uploaded", async () => {
    const out = (await createVoucher.handler(
      args,
      ctxWith(() => ({ status: 200, data: {} })),
    )) as { wouldSend: { body: Record<string, unknown> } };

    expect(out.wouldSend.body).not.toHaveProperty("filename");
  });
});

describe("sevdesk_upload_voucher_file", () => {
  const upload = resourceTools.find((t) => t.name === "sevdesk_upload_voucher_file")!;

  it("returns the filename token without sevDesk's base64 preview", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-mcp-test-"));
    const file = join(dir, "beleg.pdf");
    await writeFile(file, "%PDF-1.4 test");

    const ctx = {
      client: {
        async request(): Promise<{ status: number; data: unknown }> {
          return {
            status: 201,
            // sevDesk renders the upload and echoes the preview back — tens of
            // thousands of base64 characters the caller has no use for.
            data: {
              objects: {
                filename: "abc123hash.pdf",
                contentHash: "deadbeef",
                pages: 1,
                content: ["/9j/4AAQSkZJRgABAQEAyADIAAD".repeat(500)],
              },
            },
          };
        },
      },
      config: {
        baseUrl: "https://example.test/api/v1",
        readOnly: false,
        dryRun: false,
        allowedReceiptDirs: [dir],
      },
    } as unknown as ToolContext;

    const out = (await upload.handler({ filePath: file }, ctx)) as {
      response: { objects: Record<string, unknown> };
    };

    expect(out.response.objects.filename).toBe("abc123hash.pdf");
    expect(out.response.objects.contentHash).toBe("deadbeef");
    expect(out.response.objects).not.toHaveProperty("content");
  });
});


describe("sevdesk_link_transaction", () => {
  const link = resourceTools.find((t) => t.name === "sevdesk_link_transaction")!;

  /** Stateful stub: bookAmount changes the voucher and the transaction like sevDesk does. */
  function linkCtx(vouchers: Record<string, Row>, tx: Row, opts: { failOn?: string } = {}) {
    const sent: Array<{ method: string; path: string; body?: unknown }> = [];
    let linked = 0;
    const client = {
      async request(req: { method: string; path: string; body?: unknown }) {
        const id = req.path.split("/")[2] ?? "";
        if (req.method === "PUT") {
          if (opts.failOn === id) throw new Error("sevDesk 422: rejected.");
          sent.push(req);
          const v = vouchers[id]!;
          const amount = Math.abs(num((req.body as Row).amount));
          v.paidAmount = num(v.paidAmount) + amount;
          v.status = num(v.paidAmount) >= num(v.sumGross) ? "1000" : "750";
          linked += amount;
          tx.status = linked >= Math.abs(num(tx.amount)) ? "400" : "200";
          return { status: 200, data: { objects: v } };
        }
        if (req.path.startsWith("/Voucher/")) {
          const v = vouchers[id];
          return { status: 200, data: { objects: v ? [v] : [] } };
        }
        if (req.path.startsWith("/CheckAccountTransaction/")) return { status: 200, data: { objects: [tx] } };
        return { status: 404, data: {} };
      },
    };
    const ctx = {
      client,
      config: { baseUrl: "https://example.test/api/v1", readOnly: false, dryRun: false, allowedReceiptDirs: [] },
      getProfile: async () => stubProfile(),
    } as unknown as ToolContext;
    return { ctx, sent };
  }

  function num(v: unknown): number {
    return typeof v === "number" ? v : Number.parseFloat(String(v));
  }

  const voucher = (over: Row = {}): Row => ({
    status: "100",
    creditDebit: "C",
    sumGross: "16.99",
    paidAmount: 0,
    enshrined: null,
    ...over,
  });
  const openTx = (over: Row = {}): Row => ({
    id: "1869078520",
    status: "100",
    amount: "-16.99",
    valueDate: "2026-06-24T00:00:00+02:00",
    checkAccount: { id: "6232758", objectName: "CheckAccount" },
    ...over,
  });

  it("books the voucher against the existing transaction", async () => {
    const { ctx, sent } = linkCtx({ "156016310": voucher() }, openTx());
    const result = (await link.handler({ voucherId: "156016310", transactionId: "1869078520" }, ctx)) as {
      linked: boolean;
      unassigned: number;
      vouchers: Array<{ status: string; paidAmount: number }>;
      transaction: { status: string };
    };
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe("/Voucher/156016310/bookAmount");
    expect(sent[0]!.body).toEqual({
      amount: -16.99,
      date: "2026-06-24",
      type: "FULL_PAYMENT",
      checkAccount: { id: 6232758, objectName: "CheckAccount" },
      checkAccountTransaction: { id: 1869078520, objectName: "CheckAccountTransaction" },
      createFeed: false,
    });
    expect(result.linked).toBe(true);
    expect(result.unassigned).toBe(0);
    expect(result.vouchers[0]).toMatchObject({ status: "bezahlt", paidAmount: 16.99 });
    expect(result.transaction.status).toBe("gebucht");
  });

  it("books revenue against incoming money with a positive amount", async () => {
    const { ctx, sent } = linkCtx({ "1": voucher({ creditDebit: "D" }) }, openTx({ amount: "16.99" }));
    await link.handler({ voucherId: "1", transactionId: "2" }, ctx);
    expect((sent[0]!.body as Row).amount).toBe(16.99);
  });

  it("books a split payment in one call", async () => {
    const { ctx, sent } = linkCtx(
      { "1": voucher({ sumGross: "17.82" }), "2": voucher({ sumGross: "10.17" }) },
      openTx({ amount: "-27.99" }),
    );
    const result = (await link.handler(
      { transactionId: "9", allocations: [{ voucherId: "1" }, { voucherId: "2" }] },
      ctx,
    )) as { total: number; unassigned: number; transaction: { status: string } };
    expect(sent.map((r) => (r.body as Row).amount)).toEqual([-17.82, -10.17]);
    expect(result).toMatchObject({ total: 27.99, unassigned: 0, transaction: { status: "gebucht" } });
  });

  it("refuses a split payment that exceeds the transaction, before booking anything", async () => {
    const { ctx, sent } = linkCtx(
      { "1": voucher({ sumGross: "60" }), "2": voucher({ sumGross: "60" }) },
      openTx({ amount: "-100" }),
    );
    await expect(
      link.handler({ transactionId: "9", allocations: [{ voucherId: "1" }, { voucherId: "2" }] }, ctx),
    ).rejects.toThrow(/add up to 120, more than transaction 9 holds \(100\)/);
    expect(sent).toEqual([]);
  });

  it("refuses a transaction that is already partly linked", async () => {
    const { ctx, sent } = linkCtx({ "2": voucher({ sumGross: "60" }) }, openTx({ amount: "-100", status: "200" }));
    await expect(link.handler({ voucherId: "2", transactionId: "9" }, ctx)).rejects.toThrow(
      /already linked to a voucher or invoice.*sevDesk UI/,
    );
    expect(sent).toEqual([]);
  });

  it("reports what was booked when a later booking in a split fails", async () => {
    const { ctx, sent } = linkCtx(
      { "1": voucher({ sumGross: "10" }), "2": voucher({ sumGross: "10" }), "3": voucher({ sumGross: "10" }) },
      openTx({ amount: "-30" }),
      { failOn: "2" },
    );
    await expect(
      link.handler(
        { transactionId: "9", allocations: [{ voucherId: "1" }, { voucherId: "2" }, { voucherId: "3" }] },
        ctx,
      ),
    ).rejects.toThrow(/Booking voucher 2 on transaction 9 did not confirm.*Booked before it: 1\. Not attempted: 3\./);
    expect(sent).toHaveLength(1);
  });

  it("treats a failed first booking as unknown, not as nothing booked", async () => {
    const { ctx } = linkCtx(
      { "1": voucher({ sumGross: "10" }), "2": voucher({ sumGross: "10" }) },
      openTx({ amount: "-20" }),
      { failOn: "1" },
    );
    await expect(
      link.handler({ transactionId: "9", allocations: [{ voucherId: "1" }, { voucherId: "2" }] }, ctx),
    ).rejects.toThrow(/voucher 1 .*may or may not have saved it\. Booked before it: none\. Not attempted: 2\./);
  });

  it("refuses the same voucher written with leading zeros", async () => {
    const { ctx, sent } = linkCtx({ "50": voucher({ sumGross: "50" }) }, openTx({ amount: "-100" }));
    await expect(
      link.handler({ transactionId: "9", allocations: [{ voucherId: "50" }, { voucherId: "050" }] }, ctx),
    ).rejects.toThrow(/Voucher 50 appears twice/);
    expect(sent).toEqual([]);
  });

  it("never books more than the gross amount when paidAmount is negative", async () => {
    const { ctx, sent } = linkCtx({ "1": voucher({ sumGross: "50", paidAmount: -20 }) }, openTx({ amount: "-100" }));
    await link.handler({ voucherId: "1", transactionId: "9" }, ctx);
    expect((sent[0]!.body as Row).amount).toBe(-50);
  });

  it("refuses foreign-currency vouchers", async () => {
    const { ctx, sent } = linkCtx({ "1": voucher({ currency: "USD" }) }, openTx());
    await expect(link.handler({ voucherId: "1", transactionId: "2" }, ctx)).rejects.toThrow(/USD/);
    expect(sent).toEqual([]);
  });

  it("still reports success when the read-back fails after booking", async () => {
    const { ctx, sent } = linkCtx({ "1": voucher() }, openTx());
    const inner = ctx.client.request.bind(ctx.client);
    (ctx.client as unknown as { request: unknown }).request = async (req: { method: string; path: string }) => {
      if (req.method === "GET" && sent.length > 0) throw new Error("sevDesk 503");
      return inner(req as never);
    };
    const result = (await link.handler({ voucherId: "1", transactionId: "2" }, ctx)) as { linked: boolean };
    expect(result.linked).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("books a partial amount as type N", async () => {
    const { ctx, sent } = linkCtx({ "1": voucher({ sumGross: "30" }) }, openTx({ amount: "-10" }));
    await link.handler({ voucherId: "1", transactionId: "2", amount: 10 }, ctx);
    expect((sent[0]!.body as Row).type).toBe("N");
  });

  it("refuses an already paid voucher", async () => {
    const { ctx, sent } = linkCtx({ "1": voucher({ status: "1000" }) }, openTx());
    await expect(link.handler({ voucherId: "1", transactionId: "2" }, ctx)).rejects.toThrow(/already paid/);
    expect(sent).toEqual([]);
  });

  it("refuses an already booked transaction", async () => {
    const { ctx, sent } = linkCtx({ "1": voucher() }, openTx({ status: "400" }));
    await expect(link.handler({ voucherId: "1", transactionId: "2" }, ctx)).rejects.toThrow(/gebucht/);
    expect(sent).toEqual([]);
  });

  it("refuses an expense voucher against incoming money", async () => {
    const { ctx, sent } = linkCtx({ "1": voucher() }, openTx({ amount: "16.99" }));
    await expect(link.handler({ voucherId: "1", transactionId: "2" }, ctx)).rejects.toThrow(/Direction mismatch/);
    expect(sent).toEqual([]);
  });

  it("refuses an amount above the transaction", async () => {
    const { ctx, sent } = linkCtx({ "1": voucher({ sumGross: "20" }) }, openTx());
    await expect(link.handler({ voucherId: "1", transactionId: "2" }, ctx)).rejects.toThrow(/more than transaction/);
    expect(sent).toEqual([]);
  });

  it("refuses an amount above the voucher's open amount", async () => {
    const { ctx, sent } = linkCtx({ "1": voucher() }, openTx({ amount: "-50" }));
    await expect(link.handler({ voucherId: "1", transactionId: "2", amount: 20 }, ctx)).rejects.toThrow(
      /exceeds its open amount/,
    );
    expect(sent).toEqual([]);
  });

  it("refuses drafts", async () => {
    const { ctx, sent } = linkCtx({ "1": voucher({ status: "50" }) }, openTx());
    await expect(link.handler({ voucherId: "1", transactionId: "2" }, ctx)).rejects.toThrow(/draft/);
    expect(sent).toEqual([]);
  });

  it("refuses malformed argument combinations", async () => {
    const { ctx } = linkCtx({ "1": voucher() }, openTx());
    await expect(link.handler({ transactionId: "2" }, ctx)).rejects.toThrow(/exactly one of voucherId/);
    await expect(
      link.handler({ transactionId: "2", voucherId: "1", allocations: [{ voucherId: "1" }] }, ctx),
    ).rejects.toThrow(/exactly one of voucherId/);
    await expect(
      link.handler({ transactionId: "2", allocations: [{ voucherId: "1" }, { voucherId: "1" }] }, ctx),
    ).rejects.toThrow(/appears twice/);
    await expect(link.handler({ transactionId: "2", allocations: [{ voucherId: "x" }] }, ctx)).rejects.toThrow(
      /Allocation 1: voucherId/,
    );
    await expect(link.handler({ transactionId: "2", voucherId: "1", amount: "abc" }, ctx)).rejects.toThrow(
      /amount must be a number/,
    );
  });

  it("previews every booking without sending under dryRun", async () => {
    const { ctx, sent } = linkCtx(
      { "1": voucher({ sumGross: "60" }), "2": voucher({ sumGross: "30" }) },
      openTx({ amount: "-100" }),
    );
    const result = (await link.handler(
      { transactionId: "9", allocations: [{ voucherId: "1" }, { voucherId: "2" }], dryRun: true },
      ctx,
    )) as { dryRun: boolean; unassigned: number; wouldSend: unknown[] };
    expect(result).toMatchObject({ dryRun: true, unassigned: 10 });
    expect(result.wouldSend).toHaveLength(2);
    expect(sent).toEqual([]);
  });
});

describe("sevdesk_reset_voucher_to_open", () => {
  const reset = resourceTools.find((t) => t.name === "sevdesk_reset_voucher_to_open")!;

  function resetCtx(voucher: Row) {
    const sent: Array<{ method: string; path: string }> = [];
    const client = {
      async request(req: { method: string; path: string }) {
        if (req.method === "PUT") {
          sent.push(req);
          voucher.status = "100";
          voucher.paidAmount = 0;
          return { status: 200, data: { objects: voucher } };
        }
        return { status: 200, data: { objects: [voucher] } };
      },
    };
    const ctx = {
      client,
      config: { baseUrl: "https://example.test/api/v1", readOnly: false, dryRun: false, allowedReceiptDirs: [] },
      getProfile: async () => stubProfile(),
    } as unknown as ToolContext;
    return { ctx, sent };
  }

  it("resets a partially paid voucher and reports what it removed", async () => {
    const { ctx, sent } = resetCtx({ id: "1", status: "750", paidAmount: 21.42, currency: "EUR", enshrined: null });
    const result = await reset.handler({ voucherId: "1" }, ctx);
    expect(sent[0]!.path).toBe("/Voucher/1/resetToOpen");
    expect(result).toMatchObject({
      changed: true,
      status: "offen",
      before: { status: "teilbezahlt", paidAmount: 21.42 },
    });
  });

  it("leaves an open voucher alone", async () => {
    const { ctx, sent } = resetCtx({ id: "1", status: "100", enshrined: null });
    const result = (await reset.handler({ voucherId: "1" }, ctx)) as { changed: boolean };
    expect(result.changed).toBe(false);
    expect(sent).toEqual([]);
  });

  it("refuses enshrined vouchers", async () => {
    const { ctx, sent } = resetCtx({ id: "1", status: "1000", enshrined: "2026-01-01" });
    await expect(reset.handler({ voucherId: "1" }, ctx)).rejects.toThrow(/enshrined/);
    expect(sent).toEqual([]);
  });

  it("refuses foreign-currency vouchers", async () => {
    const { ctx, sent } = resetCtx({ id: "1", status: "1000", currency: "usd", enshrined: null });
    await expect(reset.handler({ voucherId: "1" }, ctx)).rejects.toThrow(/USD.*exchange rate/);
    expect(sent).toEqual([]);
  });

  it("previews without sending under dryRun", async () => {
    const { ctx, sent } = resetCtx({ id: "1", status: "1000", paidAmount: 5, enshrined: null });
    const result = await reset.handler({ voucherId: "1", dryRun: true }, ctx);
    expect(result).toMatchObject({ dryRun: true, before: { paidAmount: 5 } });
    expect(sent).toEqual([]);
  });
});

describe("sevdesk_create_voucher booking account", () => {
  const createVoucher = resourceTools.find((t) => t.name === "sevdesk_create_voucher")!;

  it("sends accountDatevId as the position's accountDatev", async () => {
    const out = (await createVoucher.handler(
      {
        supplierName: "Acme Ltd",
        voucherDate: "01.09.2026",
        taxRuleId: "10",
        positions: [{ sumGross: 12.5, taxRate: 0, accountDatevId: "4266" }],
        dryRun: true,
      },
      ctxWith(() => ({ status: 200, data: {} })),
    )) as { wouldSend: { body: { voucherPosSave: Row[] } } };
    expect(out.wouldSend.body.voucherPosSave[0].accountDatev).toEqual({ id: "4266", objectName: "AccountDatev" });
  });

  it("refuses a non-numeric accountDatevId", async () => {
    await expect(
      createVoucher.handler(
        {
          supplierName: "Acme Ltd",
          voucherDate: "01.09.2026",
          taxRuleId: "10",
          positions: [{ sumGross: 12.5, taxRate: 0, accountDatevId: "../x" }],
          dryRun: true,
        },
        ctxWith(() => ({ status: 200, data: {} })),
      ),
    ).rejects.toThrow(/accountDatevId/);
  });
});
