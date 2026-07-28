import { describe, expect, it } from "vitest";

import {
  LEGACY_TAX_TYPE_RULES,
  TAX_RULES,
  classifyForeign,
  looksForeign,
  monthKey,
  num,
  parseSevdeskDate,
  readTaxTreatment,
  round2,
  supplierKey,
  voucherSide,
  ymd,
} from "../src/lib/vat.js";
import { parseReceiptFilename } from "../src/tools/audit.js";

describe("tax rule reference", () => {
  it("classifies §13b reverse-charge rules on both sides", () => {
    for (const id of ["5", "12", "13", "14"] as const) {
      expect(TAX_RULES[id].reverseCharge).toBe(true);
      expect(TAX_RULES[id].allowedRates).toEqual([0]);
    }
    expect(TAX_RULES["5"].side).toBe("revenue");
    expect(TAX_RULES["12"].side).toBe("expense");
  });

  it("does not treat intra-community supplies as reverse charge", () => {
    expect(TAX_RULES["3"].reverseCharge).toBe(false);
    expect(TAX_RULES["3"].allowedRates).toEqual([0, 7, 19]);
  });

  it("maps the deprecated taxTypes per the 2.0 spec", () => {
    expect(TAX_RULES["1"].legacyTaxType).toBe("default");
    expect(TAX_RULES["3"].legacyTaxType).toBe("eu");
    expect(TAX_RULES["17"].legacyTaxType).toBe("noteu");
    expect(TAX_RULES["5"].legacyTaxType).toBeNull();
    expect(LEGACY_TAX_TYPE_RULES.revenue.noteu).toBe("17");
    expect(LEGACY_TAX_TYPE_RULES.expense.default).toBe("9");
  });

  it("covers the expense side", () => {
    expect(TAX_RULES["8"].side).toBe("expense");
    expect(TAX_RULES["9"].side).toBe("expense");
    expect(TAX_RULES["9"].allowedRates).toEqual([0, 7, 19]);
    expect(TAX_RULES["10"].allowedRates).toEqual([0]);
  });

  it("marks rules the API refuses on vouchers", () => {
    for (const id of ["18", "19", "20", "21"] as const) {
      expect(TAX_RULES[id].usableInVouchers).toBe(false);
    }
    expect(TAX_RULES["9"].usableInVouchers).toBe(true);
  });

  it("knows the non-taxable rules the live ReceiptGuidance exposes", () => {
    expect(TAX_RULES["16"].side).toBe("expense");
    expect(TAX_RULES["16"].allowedRates).toEqual([0]);
    expect(TAX_RULES["22"].side).toBe("revenue");
    expect(TAX_RULES["22"].reverseCharge).toBe(false);
  });
});

describe("classifyForeign", () => {
  const countries = new Map([
    [supplierKey("Acme Org"), "us"],
    [supplierKey("Musterbau GmbH"), "de"],
  ]);

  it("trusts the contact country over everything", () => {
    expect(classifyForeign("Acme Org", countries)).toEqual({
      verdict: "foreign",
      source: "country",
      country: "us",
    });
    expect(classifyForeign("Musterbau GmbH", countries)).toEqual({
      verdict: "domestic",
      source: "country",
      country: "de",
    });
  });

  it("falls back to the legal-suffix heuristic", () => {
    expect(classifyForeign("Brightpath International Ltd.", countries)).toEqual({
      verdict: "foreign",
      source: "suffix",
      country: null,
    });
  });

  it("stays agnostic without any signal", () => {
    expect(classifyForeign("Nordlicht Studio", countries).verdict).toBe("unknown");
    expect(classifyForeign(null, countries).verdict).toBe("unknown");
    expect(classifyForeign("Acme Org").verdict).toBe("unknown");
  });
});

describe("voucherSide", () => {
  it("reads creditDebit before anything else", () => {
    expect(voucherSide({ creditDebit: "C" })).toBe("expense");
    expect(voucherSide({ creditDebit: "D" })).toBe("revenue");
  });

  it("falls back to the tax rule's side", () => {
    expect(voucherSide({ taxRule: { id: "9" } })).toBe("expense");
    expect(voucherSide({ taxRule: { id: 1 } })).toBe("revenue");
  });

  it("returns null when it cannot tell", () => {
    expect(voucherSide({})).toBeNull();
  });
});

describe("readTaxTreatment", () => {
  it("prefers taxRule (API 2.0) over taxType (API 1.0)", () => {
    const t = readTaxTreatment({
      taxRule: { id: "5", objectName: "TaxRule" },
      taxType: "default",
    });
    expect(t.ruleId).toBe("5");
    expect(t.reverseCharge).toBe(true);
  });

  it("falls back to taxType when no taxRule is present", () => {
    const t = readTaxTreatment({ taxType: "noteu" });
    expect(t.ruleId).toBeNull();
    expect(t.legacyType).toBe("noteu");
    expect(t.reverseCharge).toBe(true);
  });

  it("reports unknown when neither field is set", () => {
    expect(readTaxTreatment({}).unknown).toBe(true);
    expect(readTaxTreatment(null).unknown).toBe(true);
  });

  it("does not treat domestic bookings as reverse charge", () => {
    const t = readTaxTreatment({ taxRule: { id: "1", objectName: "TaxRule" } });
    expect(t.reverseCharge).toBe(false);
    expect(t.allowedRates).toEqual([0, 7, 19]);
  });

  it("recognises expense-side reverse charge (taxRule 12)", () => {
    const t = readTaxTreatment({ taxRule: { id: "12", objectName: "TaxRule" }, creditDebit: "C" });
    expect(t.reverseCharge).toBe(true);
    expect(t.side).toBe("expense");
    expect(t.sideMismatch).toBe(false);
  });

  it("treats deductible expenses (taxRule 9) as plain domestic, tolerating numeric ids", () => {
    const t = readTaxTreatment({ taxRule: { id: 9, objectName: "TaxRule" }, creditDebit: "C" });
    expect(t.ruleId).toBe("9");
    expect(t.reverseCharge).toBe(false);
    expect(t.allowedRates).toEqual([0, 7, 19]);
  });

  it("flags a revenue rule sitting on an expense voucher", () => {
    const t = readTaxTreatment({ taxRule: { id: "1", objectName: "TaxRule" }, creditDebit: "C" });
    expect(t.sideMismatch).toBe(true);
  });

  it("resolves legacy taxType per voucher side", () => {
    const expense = readTaxTreatment({ taxType: "noteu", creditDebit: "C" });
    expect(expense.reverseCharge).toBe(true);

    // On the revenue side, noteu maps to rule 17 — not taxable in Germany, no §13b base.
    const revenue = readTaxTreatment({ taxType: "noteu", creditDebit: "D" });
    expect(revenue.reverseCharge).toBe(false);
    expect(revenue.equivalentRuleId).toBe("17");

    const dflt = readTaxTreatment({ taxType: "default", creditDebit: "C" });
    expect(dflt.equivalentRuleId).toBe("9");
    expect(dflt.allowedRates).toEqual([0, 7, 19]);
  });
});

describe("supplier heuristics", () => {
  it("flags typical foreign legal forms", () => {
    expect(looksForeign("Northwind Cloud, PBC")).toBe(true);
    expect(looksForeign("orbit - Data & Labs, Inc.")).toBe(true);
    expect(looksForeign("Brightpath International Ltd.")).toBe(true);
  });

  it("does not flag German legal forms", () => {
    expect(looksForeign("Musterbau GmbH")).toBe(false);
    expect(looksForeign("Beispiel Studio UG")).toBe(false);
    expect(looksForeign("Kommunikationsdesign e.V.")).toBe(false);
  });

  it("groups the same supplier written differently", () => {
    expect(supplierKey("Acme Org")).toBe(supplierKey("acme org."));
    expect(supplierKey("Northwind Cloud, PBC")).toBe(supplierKey("Northwind Cloud PBC"));
  });
});

describe("number and date parsing", () => {
  it("reads sevDesk's stringified numbers", () => {
    expect(num("107.10")).toBe(107.1);
    expect(num("107,10")).toBe(107.1);
    expect(num(undefined)).toBe(0);
  });

  it("rounds to cents", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(33.605)).toBe(33.61);
  });

  it("accepts dd.mm.yyyy, ISO and unix timestamps", () => {
    expect(parseSevdeskDate("26.06.2026")?.getFullYear()).toBe(2026);
    expect(parseSevdeskDate("2026-06-26")?.getMonth()).toBe(5);
    expect(parseSevdeskDate("")).toBeNull();
  });

  it("keeps the calendar date of timezone-carrying timestamps", () => {
    // sevDesk stores voucher dates as local midnight ("2026-06-30T00:00:00+02:00").
    // Formatting through UTC would shift them to the previous day.
    const d = parseSevdeskDate("2026-06-30T00:00:00+02:00");
    expect(d && ymd(d)).toBe("2026-06-30");
    expect(d && monthKey(d)).toBe("2026-06");
  });
});

describe("parseReceiptFilename", () => {
  it("reads the YYMMDD + #reference convention", () => {
    const p = parseReceiptFilename("260626_Acme-Cloud_#INV-2043.pdf");
    expect(p.date && p.date.getFullYear()).toBe(2026);
    expect(p.reference).toBe("INV-2043");
  });

  it("reads the ISO date + amount convention", () => {
    const p = parseReceiptFilename("2026-06-26_AcmeCloud_45.60.pdf");
    expect(p.date && p.date.getMonth()).toBe(5);
    expect(p.amount).toBe(45.6);
  });

  it("returns nulls it cannot parse rather than guessing", () => {
    const p = parseReceiptFilename("scan001.pdf");
    expect(p.date).toBeNull();
    expect(p.amount).toBeNull();
    expect(p.reference).toBeNull();
  });
});

describe("round2 edge cases", () => {
  it("rounds half away from zero, symmetrically", () => {
    expect(round2(-33.605)).toBe(-33.61);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(-2.675)).toBe(-2.68);
  });

  it("survives the amounts this project actually sees", () => {
    expect(round2(39.99 / 1.19)).toBe(33.61);
    expect(round2(107.1 - 107.1 / 1.19)).toBe(17.1);
    expect(round2(0)).toBe(0);
  });
});
