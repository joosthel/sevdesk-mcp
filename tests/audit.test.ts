import { describe, expect, it } from "vitest";

import type { ToolContext } from "../src/lib/tool.js";
import { auditTools } from "../src/tools/audit.js";

type Row = Record<string, unknown>;

const auditVat = auditTools.find((t) => t.name === "sevdesk_audit_vat")!;
const reverseChargeReport = auditTools.find((t) => t.name === "sevdesk_reverse_charge_report")!;
const reconcile = auditTools.find((t) => t.name === "sevdesk_reconcile_transactions")!;

interface StubData {
  vouchers?: Row[];
  positionsByVoucher?: Record<string, Row[]>;
  failingPositionIds?: string[];
  contacts?: Row[];
  guidance?: Row[];
  transactions?: Row[];
}

/**
 * Minimal stand-in for SevdeskClient, routing by path: voucher sweeps,
 * position fetches, contact and guidance lookups, transactions.
 */
function stubCtx(d: StubData): ToolContext {
  const client = {
    async getAll(path: string): Promise<Row[]> {
      if (path === "/Voucher") return d.vouchers ?? [];
      if (path === "/Contact") return d.contacts ?? [];
      if (path === "/CheckAccountTransaction") return d.transactions ?? [];
      return [];
    },
    async request(opts: { path: string; query?: Record<string, unknown> }) {
      if (opts.path === "/VoucherPos") {
        const id = String(opts.query?.["voucher[id]"] ?? "");
        if (d.failingPositionIds?.includes(id)) throw new Error("boom");
        return { status: 200, data: { objects: d.positionsByVoucher?.[id] ?? [] } };
      }
      if (opts.path.startsWith("/ReceiptGuidance")) {
        return { status: 200, data: { objects: d.guidance ?? [] } };
      }
      return { status: 200, data: {} };
    },
  };
  return { client, config: {} } as unknown as ToolContext;
}

function voucher(overrides: Row): Row {
  return {
    creditDebit: "C",
    voucherDate: "2026-06-01",
    status: "100",
    sumNet: 100,
    sumTax: 0,
    sumGross: 100,
    ...overrides,
  };
}

function contact(name: string, countryCode: string): Row {
  return { name, addresses: [{ country: { code: countryCode } }] };
}

interface AuditResult {
  findings: Array<{ code: string; severity: string; voucherId: string; detail: string }>;
  warnings: string[];
}

async function runAudit(d: StubData): Promise<AuditResult> {
  return (await auditVat.handler({}, stubCtx(d))) as AuditResult;
}

describe("sevdesk_audit_vat", () => {
  it("flags a foreign supplier expense on taxRule 9 with only 0 % positions", async () => {
    const result = await runAudit({
      vouchers: [voucher({ id: "1", taxRule: { id: "9" }, supplierName: "Northwind Cloud, PBC" })],
      positionsByVoucher: { "1": [{ taxRate: 0 }] },
    });
    const f = result.findings.find((x) => x.code === "zero_rate_booked_as_domestic");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("high");
  });

  it("accepts a correctly booked reverse-charge expense (taxRule 12)", async () => {
    const result = await runAudit({
      vouchers: [voucher({ id: "2", taxRule: { id: "12" }, supplierName: "Northwind Cloud, PBC" })],
      positionsByVoucher: { "2": [{ taxRate: 0 }] },
    });
    expect(result.findings.filter((f) => f.voucherId === "2")).toEqual([]);
  });

  it("flags a revenue rule sitting on an expense voucher", async () => {
    const result = await runAudit({
      vouchers: [
        voucher({
          id: "3",
          taxRule: { id: "1" },
          supplierName: "Musterbau GmbH",
          sumTax: 19,
          sumGross: 119,
        }),
      ],
      positionsByVoucher: { "3": [{ taxRate: 19 }] },
    });
    expect(result.findings.some((f) => f.code === "rule_side_mismatch")).toBe(true);
  });

  it("flags VAT charged on a reverse-charge booking", async () => {
    const result = await runAudit({
      vouchers: [
        voucher({
          id: "4",
          taxRule: { id: "12" },
          supplierName: "Northwind Cloud, PBC",
          sumTax: 19,
          sumGross: 119,
        }),
      ],
      positionsByVoucher: { "4": [{ taxRate: 19 }] },
    });
    expect(result.findings.some((f) => f.code === "reverse_charge_with_vat")).toBe(true);
  });

  it("flags rules the API does not accept on vouchers", async () => {
    const result = await runAudit({
      vouchers: [
        voucher({ id: "5", creditDebit: "D", taxRule: { id: "18" }, supplierName: "Kunde AB" }),
      ],
      positionsByVoucher: { "5": [{ taxRate: 0 }] },
    });
    expect(result.findings.some((f) => f.code === "rule_not_usable_in_vouchers")).toBe(true);
  });

  it("surfaces failed position fetches as warnings instead of swallowing them", async () => {
    const result = await runAudit({
      vouchers: [voucher({ id: "6", taxRule: { id: "9" }, supplierName: "Musterbau GmbH" })],
      failingPositionIds: ["6"],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("6");
  });

  it("raises severity when the supplier's contact country is foreign", async () => {
    const result = await runAudit({
      vouchers: [voucher({ id: "7", taxRule: { id: "9" }, supplierName: "Acme Org" })],
      positionsByVoucher: { "7": [{ taxRate: 0 }] },
      contacts: [contact("Acme Org", "us")],
    });
    const f = result.findings.find((x) => x.code === "zero_rate_booked_as_domestic");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("high");
    expect(f!.detail).toContain("us");
  });

  it("lowers severity when the contact is registered in Germany", async () => {
    const result = await runAudit({
      vouchers: [voucher({ id: "8", taxRule: { id: "9" }, supplierName: "Nordlicht Studio" })],
      positionsByVoucher: { "8": [{ taxRate: 0 }] },
      contacts: [contact("Nordlicht Studio", "de")],
    });
    const f = result.findings.find((x) => x.code === "zero_rate_booked_as_domestic");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("low");
  });

  it("flags a tax rule the position's booking account does not allow", async () => {
    const result = await runAudit({
      vouchers: [voucher({ id: "9", taxRule: { id: "16" }, supplierName: "Musterbau GmbH" })],
      positionsByVoucher: { "9": [{ taxRate: 0, accountDatev: { id: "4279" } }] },
      guidance: [
        {
          accountDatevId: 4279,
          accountNumber: "6837",
          accountName: "laufende Gebühren für Lizenzen",
          allowedTaxRules: [{ id: 9 }, { id: 12 }, { id: 13 }],
        },
      ],
    });
    const f = result.findings.find((x) => x.code === "account_rule_mismatch");
    expect(f).toBeDefined();
    expect(f!.detail).toContain("6837");
  });

  it("does not flag account/rule combinations the guidance allows", async () => {
    const result = await runAudit({
      vouchers: [
        voucher({ id: "10", taxRule: { id: "12" }, supplierName: "Northwind Cloud, PBC" }),
      ],
      positionsByVoucher: { "10": [{ taxRate: 0, accountDatev: { id: "4279" } }] },
      guidance: [
        { accountDatevId: 4279, accountNumber: "6837", allowedTaxRules: [{ id: 12 }] },
      ],
    });
    expect(result.findings.some((f) => f.code === "account_rule_mismatch")).toBe(false);
  });
});

describe("sevdesk_reverse_charge_report", () => {
  it("separates deductible, non-deductible and own-revenue reverse charge", async () => {
    const ctx = stubCtx({
      vouchers: [
        voucher({ id: "10", taxRule: { id: "12" }, supplierName: "Northwind Cloud, PBC" }),
        voucher({ id: "11", taxRule: { id: "13" }, supplierName: "Orbit Labs, Inc." }),
        voucher({ id: "12", creditDebit: "D", taxRule: { id: "5" }, supplierName: "Kunde SARL" }),
      ],
    });
    const result = (await reverseChargeReport.handler({}, ctx)) as {
      reverseChargeExpenses: {
        deductible: { count: number; taxBase: number };
        nonDeductible: { count: number; vatPayable: number };
      };
      ownReverseChargeRevenue: { count: number };
    };
    expect(result.reverseChargeExpenses.deductible.count).toBe(1);
    expect(result.reverseChargeExpenses.deductible.taxBase).toBe(100);
    expect(result.reverseChargeExpenses.nonDeductible.count).toBe(1);
    expect(result.reverseChargeExpenses.nonDeductible.vatPayable).toBe(19);
    expect(result.ownReverseChargeRevenue.count).toBe(1);
  });

  it("suspects foreign suppliers via contact country, not just name suffix", async () => {
    const ctx = stubCtx({
      vouchers: [voucher({ id: "13", taxRule: { id: "9" }, supplierName: "Acme Org" })],
      contacts: [contact("Acme Org", "us")],
    });
    const result = (await reverseChargeReport.handler({}, ctx)) as {
      possiblyMissing: { count: number };
    };
    expect(result.possiblyMissing.count).toBe(1);
  });
});

describe("sevdesk_reconcile_transactions", () => {
  const tx = (overrides: Row): Row => ({
    valueDate: "2026-06-30T00:00:00+02:00",
    amount: "-107.1",
    payeePayerName: "SUPPLIER X",
    status: "100",
    ...overrides,
  });

  it("matches a payment to a voucher by amount and date proximity", async () => {
    const result = (await reconcile.handler(
      {},
      stubCtx({
        vouchers: [voucher({ id: "1", voucherDate: "2026-06-29", supplierName: "X" })],
        transactions: [tx({ id: "t1", amount: "-100" })],
      }),
    )) as { matched: number; unmatchedTransactions: Row[]; vouchersWithoutPayment: Row[] };
    expect(result.matched).toBe(1);
    expect(result.unmatchedTransactions).toEqual([]);
    expect(result.vouchersWithoutPayment).toEqual([]);
  });

  it("reports payments without any plausible voucher", async () => {
    const result = (await reconcile.handler(
      {},
      stubCtx({
        vouchers: [],
        transactions: [tx({ id: "t2", amount: "-31.82", payeePayerName: "ACME.ORG" })],
      }),
    )) as { matched: number; unmatchedTransactions: Array<{ payee: string }> };
    expect(result.matched).toBe(0);
    expect(result.unmatchedTransactions).toHaveLength(1);
    expect(result.unmatchedTransactions[0]!.payee).toBe("ACME.ORG");
  });

  it("reports non-draft vouchers that no payment covers", async () => {
    const result = (await reconcile.handler(
      {},
      stubCtx({
        vouchers: [
          voucher({ id: "2", supplierName: "Y" }),
          voucher({ id: "3", status: "50", supplierName: "Draft Z" }),
        ],
        transactions: [],
      }),
    )) as { vouchersWithoutPayment: Row[] };
    expect(result.vouchersWithoutPayment).toHaveLength(1);
  });
});
