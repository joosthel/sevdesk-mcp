import { describe, expect, it } from "vitest";

import type { ToolContext } from "../src/lib/tool.js";
import { resourceTools } from "../src/tools/resources.js";

const ping = resourceTools.find((t) => t.name === "sevdesk_ping")!;
const setTaxRule = resourceTools.find((t) => t.name === "sevdesk_set_tax_rule")!;
const receiptGuidance = resourceTools.find((t) => t.name === "sevdesk_receipt_guidance")!;

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
