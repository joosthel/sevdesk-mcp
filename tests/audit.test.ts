import { describe, expect, it } from "vitest";

import type { ToolContext } from "../src/lib/tool.js";
import { auditTools } from "../src/tools/audit.js";

type Row = Record<string, unknown>;

const auditVat = auditTools.find((t) => t.name === "sevdesk_audit_vat")!;
const reverseChargeReport = auditTools.find((t) => t.name === "sevdesk_reverse_charge_report")!;

/**
 * Minimal stand-in for SevdeskClient: the audit tools only use getAll (voucher
 * sweep) and request (position fetch). Position fetches for ids listed in
 * `failingIds` throw, to exercise the warning path.
 */
function stubCtx(
  vouchers: Row[],
  positionsByVoucher: Record<string, Row[]>,
  failingIds: string[] = [],
): ToolContext {
  const client = {
    async getAll(): Promise<Row[]> {
      return vouchers;
    },
    async request(opts: { query?: Record<string, unknown> }): Promise<{ data: { objects: Row[] } }> {
      const id = String(opts.query?.["voucher[id]"] ?? "");
      if (failingIds.includes(id)) throw new Error("boom");
      return { data: { objects: positionsByVoucher[id] ?? [] } };
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

interface AuditResult {
  findings: Array<{ code: string; severity: string; voucherId: string }>;
  warnings: string[];
}

async function runAudit(ctx: ToolContext): Promise<AuditResult> {
  return (await auditVat.handler({}, ctx)) as AuditResult;
}

describe("sevdesk_audit_vat", () => {
  it("flags a foreign supplier expense on taxRule 9 with only 0 % positions", async () => {
    const ctx = stubCtx(
      [voucher({ id: "1", taxRule: { id: "9" }, supplierName: "Northwind Cloud, PBC" })],
      { "1": [{ taxRate: 0 }] },
    );
    const result = await runAudit(ctx);
    const f = result.findings.find((x) => x.code === "zero_rate_booked_as_domestic");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("high");
  });

  it("accepts a correctly booked reverse-charge expense (taxRule 12)", async () => {
    const ctx = stubCtx(
      [voucher({ id: "2", taxRule: { id: "12" }, supplierName: "Northwind Cloud, PBC" })],
      { "2": [{ taxRate: 0 }] },
    );
    const result = await runAudit(ctx);
    expect(result.findings.filter((f) => f.voucherId === "2")).toEqual([]);
  });

  it("flags a revenue rule sitting on an expense voucher", async () => {
    const ctx = stubCtx(
      [
        voucher({
          id: "3",
          taxRule: { id: "1" },
          supplierName: "Musterbau GmbH",
          sumTax: 19,
          sumGross: 119,
        }),
      ],
      { "3": [{ taxRate: 19 }] },
    );
    const result = await runAudit(ctx);
    expect(result.findings.some((f) => f.code === "rule_side_mismatch")).toBe(true);
  });

  it("flags VAT charged on a reverse-charge booking", async () => {
    const ctx = stubCtx(
      [
        voucher({
          id: "4",
          taxRule: { id: "12" },
          supplierName: "Northwind Cloud, PBC",
          sumTax: 19,
          sumGross: 119,
        }),
      ],
      { "4": [{ taxRate: 19 }] },
    );
    const result = await runAudit(ctx);
    expect(result.findings.some((f) => f.code === "reverse_charge_with_vat")).toBe(true);
  });

  it("flags rules the API does not accept on vouchers", async () => {
    const ctx = stubCtx(
      [voucher({ id: "5", creditDebit: "D", taxRule: { id: "18" }, supplierName: "Kunde AB" })],
      { "5": [{ taxRate: 0 }] },
    );
    const result = await runAudit(ctx);
    expect(result.findings.some((f) => f.code === "rule_not_usable_in_vouchers")).toBe(true);
  });

  it("surfaces failed position fetches as warnings instead of swallowing them", async () => {
    const ctx = stubCtx(
      [voucher({ id: "6", taxRule: { id: "9" }, supplierName: "Musterbau GmbH" })],
      {},
      ["6"],
    );
    const result = await runAudit(ctx);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("6");
  });
});

describe("sevdesk_reverse_charge_report", () => {
  it("separates deductible, non-deductible and own-revenue reverse charge", async () => {
    const ctx = stubCtx(
      [
        voucher({ id: "10", taxRule: { id: "12" }, supplierName: "Northwind Cloud, PBC" }),
        voucher({ id: "11", taxRule: { id: "13" }, supplierName: "Orbit Labs, Inc." }),
        voucher({ id: "12", creditDebit: "D", taxRule: { id: "5" }, supplierName: "Kunde SARL" }),
      ],
      {},
    );
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

  it("suspects foreign-supplier expenses on rule 9/10 with zero tax", async () => {
    const ctx = stubCtx(
      [voucher({ id: "13", taxRule: { id: "9" }, supplierName: "Northwind Cloud, PBC" })],
      {},
    );
    const result = (await reverseChargeReport.handler({}, ctx)) as {
      possiblyMissing: { count: number };
    };
    expect(result.possiblyMissing.count).toBe(1);
  });
});
