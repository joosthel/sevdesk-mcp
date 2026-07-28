/**
 * German VAT semantics as sevDesk models them.
 *
 * sevDesk 1.0 used `taxType` (a string); the sevdesk-Update 2.0 replaced it
 * with `taxRule` (an object holding a numeric id) and split the rules into a
 * revenue set and an expense set. Documents created under either generation
 * still appear in API responses, so every check here understands both.
 *
 * Source: sevDesk OpenAPI 2.0.0 — the "Tax Rules" tables in the API
 * description, plus Model_Voucher.taxRule / .taxType / .creditDebit.
 */

export type VoucherSide = "revenue" | "expense";

export interface TaxRule {
  label: string;
  side: VoucherSide;
  /** Position rates the API accepts for this rule; null = depends on the destination country (OSS). */
  allowedRates: readonly number[] | null;
  /** §13b/§18b rules: positions carry 0 % and the tax base belongs in the reverse-charge declaration. */
  reverseCharge: boolean;
  /** The deprecated 1.0 taxType this rule replaces, where the spec maps one. */
  legacyTaxType: string | null;
  /** The API rejects some revenue rules on vouchers (One Stop Shop, §18b). */
  usableInVouchers: boolean;
  /** Part of the Kleinunternehmer (§19 UStG) rule set. */
  kleinunternehmer: boolean;
}

export const TAX_RULES = {
  // Revenue (outgoing invoices, debit vouchers)
  "1": {
    label: "Umsatzsteuerpflichtige Umsätze",
    side: "revenue",
    allowedRates: [0, 7, 19],
    reverseCharge: false,
    legacyTaxType: "default",
    usableInVouchers: true,
    kleinunternehmer: false,
  },
  "2": {
    label: "Ausfuhren",
    side: "revenue",
    allowedRates: [0],
    reverseCharge: false,
    legacyTaxType: null,
    usableInVouchers: true,
    kleinunternehmer: false,
  },
  "3": {
    label: "Innergemeinschaftliche Lieferungen",
    side: "revenue",
    allowedRates: [0, 7, 19],
    reverseCharge: false,
    legacyTaxType: "eu",
    usableInVouchers: true,
    kleinunternehmer: false,
  },
  "4": {
    label: "Steuerfreie Umsätze §4 UStG",
    side: "revenue",
    allowedRates: [0],
    reverseCharge: false,
    legacyTaxType: null,
    usableInVouchers: true,
    kleinunternehmer: false,
  },
  "5": {
    label: "Reverse Charge gem. §13b UStG (Feld 60)",
    side: "revenue",
    allowedRates: [0],
    reverseCharge: true,
    legacyTaxType: null,
    usableInVouchers: true,
    kleinunternehmer: false,
  },
  "11": {
    label: "Steuer nicht erhoben nach §19 UStG (Kleinunternehmer)",
    side: "revenue",
    allowedRates: [0],
    reverseCharge: false,
    legacyTaxType: "ss",
    usableInVouchers: true,
    kleinunternehmer: true,
  },
  "17": {
    label: "Nicht im Inland steuerbare Leistung",
    side: "revenue",
    allowedRates: [0],
    reverseCharge: false,
    legacyTaxType: "noteu",
    usableInVouchers: true,
    kleinunternehmer: false,
  },
  "18": {
    label: "One Stop Shop (goods)",
    side: "revenue",
    allowedRates: null,
    reverseCharge: false,
    legacyTaxType: null,
    usableInVouchers: false,
    kleinunternehmer: false,
  },
  "19": {
    label: "One Stop Shop (electronic service)",
    side: "revenue",
    allowedRates: null,
    reverseCharge: false,
    legacyTaxType: null,
    usableInVouchers: false,
    kleinunternehmer: false,
  },
  "20": {
    label: "One Stop Shop (other service)",
    side: "revenue",
    allowedRates: null,
    reverseCharge: false,
    legacyTaxType: null,
    usableInVouchers: false,
    kleinunternehmer: false,
  },
  "21": {
    label: "Reverse Charge gem. §18b UStG (Feld 21)",
    side: "revenue",
    allowedRates: [0],
    reverseCharge: true,
    legacyTaxType: null,
    usableInVouchers: false,
    kleinunternehmer: false,
  },
  // Expense (incoming vouchers, credit side)
  "8": {
    label: "Innergemeinschaftliche Erwerbe",
    side: "expense",
    allowedRates: [0, 7, 19],
    reverseCharge: false,
    legacyTaxType: null,
    usableInVouchers: true,
    kleinunternehmer: false,
  },
  "9": {
    label: "Vorsteuerabziehbare Aufwendungen",
    side: "expense",
    allowedRates: [0, 7, 19],
    reverseCharge: false,
    legacyTaxType: "default",
    usableInVouchers: true,
    kleinunternehmer: false,
  },
  "10": {
    label: "Nicht vorsteuerabziehbare Aufwendungen",
    side: "expense",
    allowedRates: [0],
    reverseCharge: false,
    legacyTaxType: "ss",
    usableInVouchers: true,
    kleinunternehmer: true,
  },
  "12": {
    label: "Reverse Charge gem. §13b Abs. 2 UStG mit Vorsteuerabzug",
    side: "expense",
    allowedRates: [0],
    reverseCharge: true,
    legacyTaxType: null,
    usableInVouchers: true,
    kleinunternehmer: false,
  },
  "13": {
    label: "Reverse Charge gem. §13b UStG ohne Vorsteuerabzug",
    side: "expense",
    allowedRates: [0],
    reverseCharge: true,
    legacyTaxType: null,
    usableInVouchers: true,
    kleinunternehmer: true,
  },
  "14": {
    label: "Reverse Charge gem. §13b Abs. 1 EU Umsätze",
    side: "expense",
    allowedRates: [0],
    reverseCharge: true,
    legacyTaxType: null,
    usableInVouchers: true,
    kleinunternehmer: false,
  },
  // Not in the spec's documentation tables, but returned by the live
  // ReceiptGuidance endpoints (e.g. Privatentnahmen, durchlaufende Posten).
  "16": {
    label: "Nicht steuerbar (Ausgabe)",
    side: "expense",
    allowedRates: [0],
    reverseCharge: false,
    legacyTaxType: null,
    usableInVouchers: true,
    kleinunternehmer: false,
  },
  "22": {
    label: "Nicht steuerbar (Einnahme)",
    side: "revenue",
    allowedRates: [0],
    reverseCharge: false,
    legacyTaxType: null,
    usableInVouchers: true,
    kleinunternehmer: false,
  },
} as const satisfies Record<string, TaxRule>;

export type TaxRuleId = keyof typeof TAX_RULES;

/** Deprecated taxType → modern rule id, per side, as the 2.0 spec maps them. */
export const LEGACY_TAX_TYPE_RULES: Record<VoucherSide, Record<string, TaxRuleId>> = {
  revenue: { default: "1", eu: "3", noteu: "17", ss: "11" },
  expense: { default: "9", ss: "10" },
};

/**
 * Semantics for taxTypes the spec does not map on a given side (or when the
 * side is unknown). These follow the 1.0 meaning: `noteu` marked reverse
 * charge (§13b) — on today's expense side that is rule 12, 13 or 14.
 * The spec is silent about expense-side `eu`/`noteu`; treat these as
 * best-effort readings, not verdicts.
 */
const LEGACY_FALLBACK: Record<
  string,
  { label: string; reverseCharge: boolean; allowedRates: readonly number[] | null }
> = {
  default: { label: "Umsatzsteuer ausweisen", reverseCharge: false, allowedRates: null },
  eu: {
    label: "Innergemeinschaftliche Lieferung / Erwerb (EU)",
    reverseCharge: false,
    allowedRates: null,
  },
  noteu: {
    label: "Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)",
    reverseCharge: true,
    allowedRates: [0],
  },
  custom: { label: "Custom tax set", reverseCharge: false, allowedRates: null },
  ss: {
    label: "Nicht umsatzsteuerpflichtig nach §19 Abs. 1 UStG",
    reverseCharge: false,
    allowedRates: [0],
  },
};

export const VOUCHER_STATUS: Record<string, string> = {
  "50": "Entwurf",
  "100": "offen",
  "1000": "bezahlt",
};

export interface TaxTreatment {
  ruleId: TaxRuleId | null;
  /** Modern rule the deprecated taxType maps to, when only a taxType was present. */
  equivalentRuleId: TaxRuleId | null;
  legacyType: string | null;
  label: string;
  /** Which side of the books the document belongs to, when determinable. */
  side: VoucherSide | null;
  /** The rule belongs to the other side than the document's creditDebit says. */
  sideMismatch: boolean;
  reverseCharge: boolean;
  allowedRates: readonly number[] | null;
  usableInVouchers: boolean;
  /** True when neither field was present — we cannot judge the booking. */
  unknown: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function lookupTaxRule(id: unknown): { id: TaxRuleId; rule: TaxRule } | null {
  if (id === undefined || id === null) return null;
  const key = String(id);
  if (key in TAX_RULES) {
    const known = key as TaxRuleId;
    return { id: known, rule: TAX_RULES[known] };
  }
  return null;
}

function declaredSide(d: Record<string, unknown> | null): VoucherSide | null {
  const cd = typeof d?.creditDebit === "string" ? d.creditDebit.toUpperCase() : null;
  if (cd === "C") return "expense";
  if (cd === "D") return "revenue";
  return null;
}

/**
 * Which side of the books a voucher belongs to. `creditDebit` ('C' = money
 * out = expense, 'D' = money in = revenue) wins; the tax rule's own side is
 * the fallback.
 */
export function voucherSide(doc: unknown): VoucherSide | null {
  const d = asRecord(doc);
  const declared = declaredSide(d);
  if (declared) return declared;
  return lookupTaxRule(asRecord(d?.taxRule)?.id)?.rule.side ?? null;
}

/** Read the tax treatment off a voucher/invoice object, tolerating both API generations. */
export function readTaxTreatment(doc: unknown): TaxTreatment {
  const d = asRecord(doc);
  const side = declaredSide(d);
  const found = lookupTaxRule(asRecord(d?.taxRule)?.id);

  const rawLegacy = d?.taxType;
  const legacyType =
    typeof rawLegacy === "string" && rawLegacy in LEGACY_FALLBACK ? rawLegacy : null;

  if (found) {
    return {
      ruleId: found.id,
      equivalentRuleId: null,
      legacyType,
      label: found.rule.label,
      side: side ?? found.rule.side,
      sideMismatch: side !== null && side !== found.rule.side,
      reverseCharge: found.rule.reverseCharge,
      allowedRates: found.rule.allowedRates,
      usableInVouchers: found.rule.usableInVouchers,
      unknown: false,
    };
  }

  if (legacyType) {
    const mappedId = side ? LEGACY_TAX_TYPE_RULES[side][legacyType] : undefined;
    if (mappedId) {
      const rule = TAX_RULES[mappedId];
      return {
        ruleId: null,
        equivalentRuleId: mappedId,
        legacyType,
        label: `${rule.label} (via taxType "${legacyType}")`,
        side,
        sideMismatch: false,
        reverseCharge: rule.reverseCharge,
        allowedRates: rule.allowedRates,
        usableInVouchers: rule.usableInVouchers,
        unknown: false,
      };
    }
    const fallback = LEGACY_FALLBACK[legacyType]!;
    return {
      ruleId: null,
      equivalentRuleId: null,
      legacyType,
      label: fallback.label,
      side,
      sideMismatch: false,
      reverseCharge: fallback.reverseCharge,
      allowedRates: fallback.allowedRates,
      usableInVouchers: true,
      unknown: false,
    };
  }

  return {
    ruleId: null,
    equivalentRuleId: null,
    legacyType: null,
    label: "unbekannt",
    side,
    sideMismatch: false,
    reverseCharge: false,
    allowedRates: null,
    usableInVouchers: true,
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

export interface ForeignVerdict {
  verdict: "foreign" | "domestic" | "unknown";
  /** What decided it: the contact's registered country, or the name-suffix heuristic. */
  source: "country" | "suffix" | null;
  /** Lower-case ISO code when a contact record was matched. */
  country: string | null;
}

/**
 * Where a supplier is established. The contact's country (keyed by
 * `supplierKey`) is authoritative when present; otherwise the legal-suffix
 * heuristic gives a hint, never a verdict.
 */
export function classifyForeign(
  name: string | undefined | null,
  countryBySupplier?: ReadonlyMap<string, string>,
): ForeignVerdict {
  const key = supplierKey(name ?? "");
  const country = (key && countryBySupplier?.get(key)) || null;
  if (country) {
    return { verdict: country === "de" ? "domestic" : "foreign", source: "country", country };
  }
  if (name && looksForeign(name)) {
    return { verdict: "foreign", source: "suffix", country: null };
  }
  return { verdict: "unknown", source: null, country: null };
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
  // Bookkeeping dates are calendar dates. sevDesk sends them as local
  // midnight with an offset ("2026-06-30T00:00:00+02:00") — take the date
  // part literally instead of letting timezone conversion shift the day.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function ymd(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

export function monthKey(date: Date): string {
  return ymd(date).slice(0, 7);
}
