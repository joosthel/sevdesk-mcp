import { describe, expect, it } from "vitest";

import {
  LEGACY_TAX_TYPES,
  TAX_RULES,
  looksForeign,
  num,
  parseSevdeskDate,
  readTaxTreatment,
  round2,
  supplierKey,
} from "../src/lib/vat.js";
import { parseReceiptFilename } from "../src/tools/audit.js";

describe("tax rule reference", () => {
  it("maps taxRule 5 to Reverse Charge §13b", () => {
    expect(TAX_RULES["5"].label).toContain("Reverse Charge");
    expect(TAX_RULES["5"].reverseCharge).toBe(true);
    expect(TAX_RULES["5"].allowedRates).toEqual([0]);
  });

  it("keeps the legacy taxType mapping intact", () => {
    expect(TAX_RULES["1"].legacyTaxType).toBe("default");
    expect(TAX_RULES["3"].legacyTaxType).toBe("eu");
    expect(TAX_RULES["5"].legacyTaxType).toBe("noteu");
    expect(LEGACY_TAX_TYPES.noteu?.reverseCharge).toBe(true);
    expect(LEGACY_TAX_TYPES.default?.reverseCharge).toBe(false);
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
