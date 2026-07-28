/**
 * German VAT semantics as sevDesk models them.
 *
 * sevDesk 1.0 used `taxType` (a string); sevDesk 2.0 replaced it with
 * `taxRule` (an object holding a numeric id). Both still appear in API
 * responses depending on the account, so every check here understands both.
 *
 * Source: sevDesk OpenAPI 2.0.0, Model_Voucher.taxRule / Model_Voucher.taxType.
 */

export const TAX_RULES = {
  "1": {
    label: "Umsatzsteuerpflichtige Umsätze",
    legacyTaxType: "default",
    allowedRates: [0, 7, 19],
    reverseCharge: false,
  },
  "2": {
    label: "Ausfuhren",
    legacyTaxType: null,
    allowedRates: [0],
    reverseCharge: false,
  },
  "3": {
    label: "Innergemeinschaftliche Lieferungen",
    legacyTaxType: "eu",
    allowedRates: [0, 7, 19],
    reverseCharge: true,
  },
  "4": {
    label: "Steuerfreie Umsätze §4 UStG",
    legacyTaxType: null,
    allowedRates: [0],
    reverseCharge: false,
  },
  "5": {
    label: "Reverse Charge gem. §13b UStG",
    legacyTaxType: "noteu",
    allowedRates: [0],
    reverseCharge: true,
  },
  "11": {
    label: "Steuer nicht erhoben nach §19 UStG (Kleinunternehmer)",
    legacyTaxType: "ss",
    allowedRates: [0],
    reverseCharge: false,
  },
} as const;

export type TaxRuleId = keyof typeof TAX_RULES;

export const LEGACY_TAX_TYPES: Record<string, { label: string; reverseCharge: boolean }> = {
  default: { label: "Umsatzsteuer ausweisen", reverseCharge: false },
  eu: { label: "Steuerfreie innergemeinschaftliche Lieferung (EU)", reverseCharge: true },
  noteu: {
    label: "Steuerschuldnerschaft des Leistungsempfängers (außerhalb EU)",
    reverseCharge: true,
  },
  custom: { label: "Custom tax set", reverseCharge: false },
  ss: { label: "Nicht umsatzsteuerpflichtig nach §19 Abs. 1 UStG", reverseCharge: false },
};

export const VOUCHER_STATUS: Record<string, string> = {
  "50": "Entwurf",
  "100": "offen",
  "1000": "bezahlt",
};

export interface TaxTreatment {
  ruleId: TaxRuleId | null;
  legacyType: string | null;
  label: string;
  reverseCharge: boolean;
  allowedRates: readonly number[] | null;
  /** True when neither field was present — we cannot judge the booking. */
  unknown: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Read the tax treatment off a voucher/invoice object, tolerating both API generations. */
export function readTaxTreatment(doc: unknown): TaxTreatment {
  const d = asRecord(doc);
  const rule = asRecord(d?.taxRule);
  const rawId = rule?.id;
  const ruleId =
    rawId !== undefined && rawId !== null && String(rawId) in TAX_RULES
      ? (String(rawId) as TaxRuleId)
      : null;

  const rawLegacy = d?.taxType;
  const legacyType = typeof rawLegacy === "string" && rawLegacy in LEGACY_TAX_TYPES
    ? rawLegacy
    : null;

  if (ruleId) {
    const r = TAX_RULES[ruleId];
    return {
      ruleId,
      legacyType,
      label: r.label,
      reverseCharge: r.reverseCharge,
      allowedRates: r.allowedRates,
      unknown: false,
    };
  }
  if (legacyType) {
    const l = LEGACY_TAX_TYPES[legacyType]!;
    return {
      ruleId: null,
      legacyType,
      label: l.label,
      reverseCharge: l.reverseCharge,
      allowedRates: null,
      unknown: false,
    };
  }
  return {
    ruleId: null,
    legacyType: null,
    label: "unbekannt",
    reverseCharge: false,
    allowedRates: null,
    unknown: true,
  };
}

export function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number.parseFloat(value.replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Round to cents, half away from zero.
 *
 * `Math.round(n * 100) / 100` is wrong for money: 33.605 is stored as
 * 33.604999999999996, so multiplying first rounds it down to 33.60. Shifting
 * the exponent through the decimal string instead re-parses the literal the
 * user actually meant, which lands on 33.61.
 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  const shifted = Number(`${Math.abs(n)}e2`);
  if (!Number.isFinite(shifted)) return Math.round(n * 100) / 100;
  return sign * Number(`${Math.round(shifted)}e-2`);
}

/**
 * Heuristic: does this supplier look like it is established outside Germany?
 * Used only to *raise a question*, never to decide a booking automatically.
 */
const FOREIGN_MARKERS = [
  /\binc\.?\b/i,
  /\bllc\b/i,
  /\bl\.?l\.?c\.?\b/i,
  /\bcorp\b/i,
  /\bltd\.?\b/i,
  /\blimited\b/i,
  /\bpbc\b/i,
  /\bs\.?à\.?r\.?l\.?\b/i,
  /\bsarl\b/i,
  /\bb\.?v\.?\b/i,
  /\bs\.?a\.?s\.?\b/i,
  /\boy\b/i,
  /\bab\b/i,
  /\bplc\b/i,
];

const DOMESTIC_MARKERS = [
  /\bgmbh\b/i,
  /\bug\b/i,
  /\bmbh\b/i,
  /\bkg\b/i,
  /\bohg\b/i,
  /\be\.?\s?v\.?\b/i,
  /\bgbr\b/i,
  /\bag\b/i,
];

export function looksForeign(supplierName: string | undefined | null): boolean {
  if (!supplierName) return false;
  if (DOMESTIC_MARKERS.some((re) => re.test(supplierName))) return false;
  return FOREIGN_MARKERS.some((re) => re.test(supplierName));
}

/** Normalised supplier key so "Acme Org" and "acme org." group together. */
export function supplierKey(name: unknown): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(gmbh|ug|ag|kg|ohg|inc|llc|ltd|limited|corp|pbc|co|company|the)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** sevDesk returns dd.mm.yyyy or an ISO timestamp depending on the field. */
export function parseSevdeskDate(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return new Date(value * 1000);
  const s = String(value).trim();
  const de = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (de) return new Date(Number(de[3]), Number(de[2]) - 1, Number(de[1]));
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}
