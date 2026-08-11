import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { VatProfile } from "../src/lib/profile.js";
import type { ToolContext } from "../src/lib/tool.js";
import { resourceTools } from "../src/tools/resources.js";

function stubProfile(
  regime: "regular" | "kleinunternehmer" | "unknown" = "regular",
): VatProfile {
  return {
    regime,
    source: regime === "unknown" ? "unresolved" : "env",
    evidence: "test stub",
    ledger: null,
  };
}

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
    getProfile: async () => stubProfile(),
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
    getProfile: async () => stubProfile(),
  } as unknown as ToolContext;
  return { ctx, sent };
}

describe("sevdesk_set_tax_rule", () => {
  const baseVoucher = (): Row => ({
    id: "42",
    creditDebit: "C",
    status: "100",
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
  regime: "regular" | "kleinunternehmer" | "unknown" = "regular",
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
    getProfile: async () => stubProfile(regime),
  } as unknown as ToolContext;
  return { ctx, sent };
}

describe("sevdesk_create_invoice", () => {
  const args = {
    contactId: "77",
    positions: [{ name: "Consulting", quantity: 2, price: 100, taxRate: 19 }],
  };

  it("always creates drafts, with the domestic revenue rule by default", async () => {
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
        { contactId: "77", positions: [{ name: "X", price: 100, taxRate: null }] },
        ctx,
      ),
    ).rejects.toThrow(/taxRate/);
    await expect(
      createInvoice.handler(
        { contactId: "77", positions: [{ name: "X", price: 100, quantity: 0 }] },
        ctx,
      ),
    ).rejects.toThrow(/quantity/);
  });

  it("uses the §19 rule for Kleinunternehmer", async () => {
    const { ctx, sent } = invoiceCtx(null, {}, "kleinunternehmer");
    await createInvoice.handler(
      { contactId: "77", positions: [{ name: "Consulting", price: 100 }] },
      ctx,
    );
    const body = sent[0]!.body as {
      invoice: { taxRule: { id: string } };
      invoicePosSave: Array<{ taxRate: number }>;
    };
    expect(body.invoice.taxRule.id).toBe("11");
    expect(body.invoicePosSave[0]!.taxRate).toBe(0);
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
    expect(result.saved).toBe(join(dir, "RE-1001.pdf"));
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
