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

  function linkCtx(voucher: Row, tx: Row) {
    const sent: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = {
      async request(req: { method: string; path: string; body?: unknown }) {
        if (req.method === "PUT") {
          sent.push(req);
          voucher.paidAmount = Math.abs(num((req.body as Row).amount));
          voucher.status = "1000";
          tx.status = "400";
          return { status: 200, data: { objects: voucher } };
        }
        if (req.path.startsWith("/Voucher/")) return { status: 200, data: { objects: [voucher] } };
        if (req.path.startsWith("/CheckAccountTransaction/")) {
          return { status: 200, data: { objects: [tx] } };
        }
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

  const openVoucher = (): Row => ({
    id: "156016310",
    status: "100",
    creditDebit: "C",
    sumGross: "16.99",
    paidAmount: 0,
    enshrined: null,
  });
  const openTx = (): Row => ({
    id: "1869078520",
    status: "100",
    amount: "-16.99",
    valueDate: "2026-06-24T00:00:00+02:00",
    checkAccount: { id: "6232758", objectName: "CheckAccount" },
  });

  it("books the voucher against the existing transaction", async () => {
    const { ctx, sent } = linkCtx(openVoucher(), openTx());
    const result = (await link.handler(
      { voucherId: "156016310", transactionId: "1869078520" },
      ctx,
    )) as { linked: boolean; voucher: { status: string }; transaction: { status: string } };
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe("/Voucher/156016310/bookAmount");
    const body = sent[0].body as Row;
    expect(body.amount).toBe(-16.99);
    expect(body.date).toBe("2026-06-24");
    expect(body.createFeed).toBe(false);
    expect(body.type).toBe("FULL_PAYMENT");
    expect(body.checkAccount).toEqual({ id: 6232758, objectName: "CheckAccount" });
    expect(body.checkAccountTransaction).toEqual({
      id: 1869078520,
      objectName: "CheckAccountTransaction",
    });
    expect(result.linked).toBe(true);
    expect(result.voucher.status).toBe("bezahlt");
    expect(result.transaction.status).toBe("gebucht");
  });

  it("books part of a split payment", async () => {
    const tx = { ...openTx(), amount: "-27.99" };
    const voucher = { ...openVoucher(), sumGross: "17.82" };
    const { ctx, sent } = linkCtx(voucher, tx);
    await link.handler({ voucherId: "1", transactionId: "2" }, ctx);
    expect((sent[0].body as Row).amount).toBe(-17.82);
    expect((sent[0].body as Row).type).toBe("FULL_PAYMENT");
  });

  it("books a partial amount as type N", async () => {
    const { ctx, sent } = linkCtx({ ...openVoucher(), sumGross: "30" }, { ...openTx(), amount: "-10" });
    await link.handler({ voucherId: "1", transactionId: "2", amount: 10 }, ctx);
    expect((sent[0].body as Row).type).toBe("N");
  });

  it("refuses an already paid voucher", async () => {
    const { ctx, sent } = linkCtx({ ...openVoucher(), status: "1000" }, openTx());
    await expect(link.handler({ voucherId: "1", transactionId: "2" }, ctx)).rejects.toThrow(/already paid/);
    expect(sent).toEqual([]);
  });

  it("refuses an already booked transaction", async () => {
    const { ctx, sent } = linkCtx(openVoucher(), { ...openTx(), status: "400" });
    await expect(link.handler({ voucherId: "1", transactionId: "2" }, ctx)).rejects.toThrow(/gebucht/);
    expect(sent).toEqual([]);
  });

  it("refuses a sign mismatch", async () => {
    const { ctx, sent } = linkCtx(openVoucher(), { ...openTx(), amount: "16.99" });
    await expect(link.handler({ voucherId: "1", transactionId: "2" }, ctx)).rejects.toThrow(/Sign mismatch/);
    expect(sent).toEqual([]);
  });

  it("refuses an amount above the transaction", async () => {
    const { ctx, sent } = linkCtx({ ...openVoucher(), sumGross: "20" }, openTx());
    await expect(link.handler({ voucherId: "1", transactionId: "2" }, ctx)).rejects.toThrow(
      /exceeds the transaction/,
    );
    expect(sent).toEqual([]);
  });

  it("refuses drafts", async () => {
    const { ctx, sent } = linkCtx({ ...openVoucher(), status: "50" }, openTx());
    await expect(link.handler({ voucherId: "1", transactionId: "2" }, ctx)).rejects.toThrow(/draft/);
    expect(sent).toEqual([]);
  });

  it("previews without sending under dryRun", async () => {
    const { ctx, sent } = linkCtx(openVoucher(), openTx());
    const result = (await link.handler(
      { voucherId: "1", transactionId: "2", dryRun: true },
      ctx,
    )) as { dryRun: boolean };
    expect(result.dryRun).toBe(true);
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

  it("resets a partially paid voucher", async () => {
    const { ctx, sent } = resetCtx({ id: "1", status: "750", paidAmount: -21.42, enshrined: null });
    const result = (await reset.handler({ voucherId: "1" }, ctx)) as { status: string; changed: boolean };
    expect(sent[0].path).toBe("/Voucher/1/resetToOpen");
    expect(result).toMatchObject({ changed: true, status: "offen" });
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
