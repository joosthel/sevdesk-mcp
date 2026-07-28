import { readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";

import {
  TAX_RULES,
  VOUCHER_STATUS,
  looksForeign,
  monthKey,
  num,
  parseSevdeskDate,
  readTaxTreatment,
  round2,
  supplierKey,
  ymd,
} from "../lib/vat.js";
import { bool, int, optBool, optNumber, optString, str, type ToolContext, type ToolDef } from "../lib/tool.js";

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

/** Run `worker` over `items` with bounded concurrency. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i] as T);
    }
  });
  await Promise.all(runners);
  return out;
}

interface PeriodArgs {
  from?: Date;
  to?: Date;
}

function readPeriod(args: Record<string, unknown>): PeriodArgs {
  const from = optString(args, "from");
  const to = optString(args, "to");
  return {
    from: from ? parseSevdeskDate(from) ?? undefined : undefined,
    to: to ? parseSevdeskDate(to) ?? undefined : undefined,
  };
}

function inPeriod(date: Date | null, period: PeriodArgs): boolean {
  if (!date) return true;
  if (period.from && date < period.from) return false;
  if (period.to && date > period.to) return false;
  return true;
}

async function fetchVouchers(ctx: ToolContext, period: PeriodArgs, maxItems: number): Promise<Row[]> {
  const query: Record<string, unknown> = { embed: "supplier,taxRule" };
  const all = await ctx.client.getAll<Row>("/Voucher", query, { maxItems });
  return all.filter((v) => inPeriod(parseSevdeskDate(v.voucherDate), period));
}

async function fetchPositions(
  ctx: ToolContext,
  vouchers: Row[],
): Promise<{ positions: Map<string, Row[]>; warnings: string[] }> {
  const positions = new Map<string, Row[]>();
  const warnings: string[] = [];
  await mapLimit(vouchers, 5, async (v) => {
    const id = String(v.id ?? "");
    if (!id) return;
    try {
      const { data } = await ctx.client.request<{ objects?: Row[] }>({
        method: "GET",
        path: "/VoucherPos",
        query: { "voucher[id]": id, "voucher[objectName]": "Voucher", limit: 200 },
      });
      positions.set(id, data?.objects ?? []);
    } catch (err) {
      // A failed fetch must not fail the whole audit, but silently treating it
      // as "no positions" would suppress rate-based findings — say so.
      positions.set(id, []);
      warnings.push(
        `Positions for voucher ${id} could not be fetched ` +
          `(${err instanceof Error ? err.message : String(err)}); rate checks were skipped for it.`,
      );
    }
  });
  return { positions, warnings };
}

function voucherLabel(v: Row): string {
  const date = parseSevdeskDate(v.voucherDate);
  return [
    date ? ymd(date) : "????-??-??",
    String(v.supplierName ?? (v.supplier as Row | undefined)?.name ?? "?"),
    `${round2(num(v.sumGross))} EUR`,
    v.description ? `#${v.description}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/* ------------------------------------------------------------------ */
/* 1. VAT / reverse-charge audit                                       */
/* ------------------------------------------------------------------ */

interface Finding {
  severity: "high" | "medium" | "low";
  code: string;
  voucherId: string;
  voucher: string;
  detail: string;
  suggestion: string;
}

const auditVat: ToolDef = {
  name: "sevdesk_audit_vat",
  title: "Audit VAT treatment of vouchers",
  description:
    "Sweep vouchers (Belege) and flag VAT problems: foreign suppliers booked as plain " +
    "domestic expenses (taxRule 9/10) instead of Reverse Charge §13b (taxRule 12/13/14), " +
    "revenue rules sitting on expense vouchers, tax rates that contradict the chosen rule, " +
    "sums that do not add up, and the same supplier booked inconsistently across vouchers. " +
    "Read-only. This is the check that tells you whether your §13b amounts will be reported " +
    "correctly in the VAT return.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      from: str("Start of period, dd.mm.yyyy or yyyy-mm-dd."),
      to: str("End of period, dd.mm.yyyy or yyyy-mm-dd."),
      includePositions: bool("Fetch line items to check rates per position (default true, slower)."),
      maxVouchers: int("Safety cap on vouchers examined (default 2000)."),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const period = readPeriod(args);
    const withPositions = optBool(args, "includePositions") ?? true;
    const vouchers = await fetchVouchers(ctx, period, optNumber(args, "maxVouchers") ?? 2000);
    const { positions, warnings } = withPositions
      ? await fetchPositions(ctx, vouchers)
      : { positions: new Map<string, Row[]>(), warnings: [] };

    const findings: Finding[] = [];
    const bySupplier = new Map<string, { rules: Set<string>; rates: Set<number>; names: Set<string> }>();

    for (const v of vouchers) {
      const id = String(v.id ?? "");
      const tax = readTaxTreatment(v);
      const name = String(v.supplierName ?? (v.supplier as Row | undefined)?.name ?? "");
      const label = voucherLabel(v);
      const pos = positions.get(id) ?? [];
      const rates = pos.map((p) => num(p.taxRate));

      // group for the cross-voucher consistency check
      const key = supplierKey(name);
      if (key) {
        const entry = bySupplier.get(key) ?? { rules: new Set(), rates: new Set(), names: new Set() };
        entry.rules.add(tax.ruleId ?? tax.legacyType ?? "unknown");
        rates.forEach((r) => entry.rates.add(r));
        entry.names.add(name);
        bySupplier.set(key, entry);
      }

      if (tax.unknown) {
        findings.push({
          severity: "low",
          code: "tax_treatment_unknown",
          voucherId: id,
          voucher: label,
          detail: "Neither taxRule nor taxType is present on this voucher.",
          suggestion: "Open the voucher in sevDesk and check which VAT regulation is set.",
        });
      }

      // Rules from the wrong side of the books, or ones the API refuses on vouchers.
      if (tax.sideMismatch && tax.ruleId) {
        const rule = TAX_RULES[tax.ruleId];
        findings.push({
          severity: "high",
          code: "rule_side_mismatch",
          voucherId: id,
          voucher: label,
          detail:
            `This is ${tax.side === "expense" ? "an expense" : "a revenue"} voucher (creditDebit ` +
            `"${String(v.creditDebit)}") but "${rule.label}" (taxRule ${tax.ruleId}) is a ${rule.side} rule.`,
          suggestion:
            tax.side === "expense"
              ? "Expense vouchers use taxRule 8, 9, 10, 12, 13 or 14."
              : "Revenue documents use taxRule 1, 2, 3, 4, 5, 11 or 17.",
        });
      }

      if (!tax.usableInVouchers && tax.ruleId) {
        findings.push({
          severity: "high",
          code: "rule_not_usable_in_vouchers",
          voucherId: id,
          voucher: label,
          detail: `"${tax.label}" (taxRule ${tax.ruleId}) is not accepted on vouchers by the sevDesk API.`,
          suggestion:
            "Rebook with a voucher-capable rule — One Stop Shop and §18b only exist on invoices.",
        });
      }

      // The headline check: everything at 0 % but booked under a plain domestic
      // rule. On the expense side that is the classic missed reverse charge; on
      // the revenue side it usually means a missing export/EU/§4 rule.
      // /Voucher documents without creditDebit are treated as expenses — that
      // is what vouchers overwhelmingly are.
      const allZero = rates.length > 0 && rates.every((r) => r === 0);
      const effectiveRule = tax.ruleId ?? tax.equivalentRuleId;
      const side = tax.side ?? "expense";
      if (allZero && !tax.reverseCharge && !tax.sideMismatch && !tax.unknown) {
        const foreign = looksForeign(name);
        const bookedAs = `"${tax.label}" (${tax.ruleId ? `taxRule ${tax.ruleId}` : `taxType ${tax.legacyType}`})`;
        if (side === "expense" && (effectiveRule === "9" || effectiveRule === "10")) {
          findings.push({
            severity: foreign ? "high" : "medium",
            code: "zero_rate_booked_as_domestic",
            voucherId: id,
            voucher: label,
            detail:
              `Booked as ${bookedAs} but every position carries 0 % VAT` +
              (foreign ? `, and the supplier name looks non-German.` : `.`),
            suggestion:
              "If this is a service from a supplier established abroad, it is Reverse Charge: " +
              "taxRule 12 (§13b Abs. 2, with input-tax deduction), taxRule 14 (§13b Abs. 1, EU), " +
              "taxRule 13 (without input-tax deduction) — or taxRule 8 for intra-EU goods. " +
              "Otherwise confirm the supplier really invoices without VAT.",
          });
        } else if (side === "revenue" && effectiveRule === "1") {
          findings.push({
            severity: "medium",
            code: "zero_rate_booked_as_domestic",
            voucherId: id,
            voucher: label,
            detail: `Booked as ${bookedAs} but every position carries 0 % VAT.`,
            suggestion:
              "Taxable domestic revenue at 0 % is unusual. Exports use taxRule 2, intra-EU " +
              "supplies taxRule 3, §4-exempt revenue taxRule 4, non-domestic services taxRule 17.",
          });
        }
      }

      // Rates that the chosen rule does not permit.
      if (tax.allowedRates && rates.length) {
        const bad = [...new Set(rates.filter((r) => !tax.allowedRates!.includes(r)))];
        if (bad.length) {
          findings.push({
            severity: "high",
            code: "rate_not_allowed_for_rule",
            voucherId: id,
            voucher: label,
            detail:
              `Tax rule "${tax.label}" permits ${tax.allowedRates.join(" / ")} % ` +
              `but positions use ${bad.join(" / ")} %.`,
            suggestion: "Correct either the tax rule or the position rate — they contradict each other.",
          });
        }
      }

      // Reverse charge must not carry VAT on the position.
      if (tax.reverseCharge && rates.some((r) => r > 0)) {
        findings.push({
          severity: "high",
          code: "reverse_charge_with_vat",
          voucherId: id,
          voucher: label,
          detail: `Booked as reverse charge ("${tax.label}") but a position charges ${Math.max(...rates)} % VAT.`,
          suggestion:
            "Under §13b the supplier invoices without VAT. Either the tax rule or the rate is wrong.",
        });
      }

      // Arithmetic: net + tax should equal gross.
      const net = num(v.sumNet);
      const taxSum = num(v.sumTax);
      const gross = num(v.sumGross);
      if (gross !== 0 && Math.abs(round2(net + taxSum) - round2(gross)) > 0.02) {
        findings.push({
          severity: "medium",
          code: "sums_do_not_add_up",
          voucherId: id,
          voucher: label,
          detail: `sumNet ${round2(net)} + sumTax ${round2(taxSum)} = ${round2(net + taxSum)} ≠ sumGross ${round2(gross)}.`,
          suggestion:
            "Often means a net amount was entered into a gross field (or vice versa). Re-enter from the invoice.",
        });
      }

      // A rate is set but no tax was computed.
      if (rates.some((r) => r > 0) && taxSum === 0 && gross !== 0) {
        findings.push({
          severity: "medium",
          code: "rate_set_but_no_tax",
          voucherId: id,
          voucher: label,
          detail: `Positions use ${Math.max(...rates)} % but sumTax is 0.`,
          suggestion: "Check whether the amount was entered as net or gross.",
        });
      }

      // Booked as paid without a payment date.
      if (String(v.status) === "1000" && !v.payDate) {
        findings.push({
          severity: "low",
          code: "paid_without_paydate",
          voucherId: id,
          voucher: label,
          detail: "Status is 'bezahlt' but payDate is empty.",
          suggestion: "Add the payment date so the cash-basis reporting stays correct.",
        });
      }
    }

    // Same supplier, different treatment across vouchers.
    for (const [key, entry] of bySupplier) {
      if (entry.rules.size > 1) {
        findings.push({
          severity: "high",
          code: "supplier_treated_inconsistently",
          voucherId: "",
          voucher: [...entry.names].join(" / "),
          detail:
            `Supplier "${key}" is booked with ${entry.rules.size} different VAT treatments: ` +
            `${[...entry.rules].join(", ")}.`,
          suggestion: "One of them is wrong. Pick the treatment that matches the supplier's invoices.",
        });
      }
    }

    const order = { high: 0, medium: 1, low: 2 } as const;
    findings.sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code));

    const counts = findings.reduce<Record<string, number>>((acc, f) => {
      acc[f.code] = (acc[f.code] ?? 0) + 1;
      return acc;
    }, {});

    return {
      period: {
        from: period.from ? ymd(period.from) : "beginning",
        to: period.to ? ymd(period.to) : "today",
      },
      vouchersExamined: vouchers.length,
      positionsFetched: withPositions,
      warnings,
      findingCount: findings.length,
      byCode: counts,
      findings,
      taxRuleReference: {
        revenue: ruleSummaries("revenue"),
        expense: ruleSummaries("expense"),
      },
    };
  },
};

function ruleSummaries(side: "revenue" | "expense"): Record<string, string> {
  return Object.fromEntries(
    Object.entries(TAX_RULES)
      .filter(([, r]) => r.side === side)
      .map(([id, r]) => [
        id,
        `${r.label}${r.legacyTaxType ? ` (legacy taxType "${r.legacyTaxType}")` : ""} — rates ` +
          (r.allowedRates ? `${r.allowedRates.join("/")} %` : "country-dependent") +
          (r.usableInVouchers ? "" : " — not usable on vouchers"),
      ]),
  );
}

/* ------------------------------------------------------------------ */
/* 2. reverse-charge report                                            */
/* ------------------------------------------------------------------ */

const reverseChargeReport: ToolDef = {
  name: "sevdesk_reverse_charge_report",
  title: "Reverse-charge (§13b) report",
  description:
    "Total the reverse-charge (§13b) tax base for a period, split by meaning: expense vouchers " +
    "with input-tax deduction (taxRule 12/14, nets to zero), without deduction (taxRule 13, VAT " +
    "actually payable), and your own §13b revenue (taxRule 5). Separately lists vouchers that " +
    "look like they belong in the report but are not booked that way. Read-only.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      from: str("Start of period, dd.mm.yyyy or yyyy-mm-dd."),
      to: str("End of period, dd.mm.yyyy or yyyy-mm-dd."),
      rate: { type: "number", description: "VAT rate to apply to the base (default 19)." },
      maxVouchers: int("Safety cap (default 2000)."),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const period = readPeriod(args);
    const rate = optNumber(args, "rate") ?? 19;
    const vouchers = await fetchVouchers(ctx, period, optNumber(args, "maxVouchers") ?? 2000);

    const deductible: Row[] = [];
    const nonDeductible: Row[] = [];
    const ownRevenue: Row[] = [];
    const legacy: Row[] = [];
    const suspected: Row[] = [];

    for (const v of vouchers) {
      const tax = readTaxTreatment(v);
      const gross = round2(num(v.sumGross));
      const name = String(v.supplierName ?? (v.supplier as Row | undefined)?.name ?? "");
      const effective = tax.ruleId ?? tax.equivalentRuleId;
      const row: Row = { voucher: voucherLabel(v), rule: tax.label, gross };

      if (tax.reverseCharge) {
        if (effective === "12" || effective === "14") deductible.push(row);
        else if (effective === "13") nonDeductible.push(row);
        else if (effective === "5" || effective === "21") ownRevenue.push(row);
        else legacy.push(row); // deprecated taxType "noteu" with no modern rule attached
      } else if (
        (tax.side ?? "expense") === "expense" &&
        (effective === "9" || effective === "10") &&
        num(v.sumTax) === 0 &&
        looksForeign(name)
      ) {
        suspected.push({ voucher: voucherLabel(v), bookedAs: tax.label, gross });
      }
    }

    const sum = (rows: Row[]): number => round2(rows.reduce((s, r) => s + num(r.gross), 0));
    const deductibleBase = sum(deductible);
    const nonDeductibleBase = sum(nonDeductible);
    const legacyBase = sum(legacy);
    const suspectedBase = sum(suspected);

    return {
      period: {
        from: period.from ? ymd(period.from) : "beginning",
        to: period.to ? ymd(period.to) : "today",
      },
      rateApplied: rate,
      reverseChargeExpenses: {
        deductible: {
          count: deductible.length,
          taxBase: deductibleBase,
          vatToDeclare: round2((deductibleBase * rate) / 100),
          note:
            "taxRule 12/14: declare as output tax and deduct as input tax. Nets to zero in " +
            "the payment, but omitting it makes the return incomplete.",
          vouchers: deductible,
        },
        nonDeductible: {
          count: nonDeductible.length,
          taxBase: nonDeductibleBase,
          vatPayable: round2((nonDeductibleBase * rate) / 100),
          note: "taxRule 13: no input-tax deduction — this VAT is actually payable.",
          vouchers: nonDeductible,
        },
        legacy: {
          count: legacy.length,
          taxBase: legacyBase,
          note:
            "Booked with the deprecated taxType 'noteu' and no modern rule attached. Check " +
            "each voucher and treat it like taxRule 12, 13 or 14.",
          vouchers: legacy,
        },
      },
      ownReverseChargeRevenue: {
        count: ownRevenue.length,
        taxBase: sum(ownRevenue),
        note:
          "Your own outgoing §13b turnover (taxRule 5, Feld 60): the customer owes the VAT — " +
          "report the base only.",
        vouchers: ownRevenue,
      },
      possiblyMissing: {
        count: suspected.length,
        taxBase: suspectedBase,
        wouldAddVat: round2((suspectedBase * rate) / 100),
        note:
          "These are booked as plain expenses with 0 % VAT and have a foreign-looking supplier. " +
          "Verify each one — the heuristic reads company suffixes, it does not know where a " +
          "supplier is established.",
        vouchers: suspected,
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* 3. duplicates & stuck drafts                                        */
/* ------------------------------------------------------------------ */

const findDuplicates: ToolDef = {
  name: "sevdesk_find_duplicates",
  title: "Find duplicate and stuck vouchers",
  description:
    "Detect vouchers booked twice (same document number, or same supplier + amount within a " +
    "few days) and vouchers left in Entwurf/offen status. Read-only.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      from: str("Start of period, dd.mm.yyyy or yyyy-mm-dd."),
      to: str("End of period, dd.mm.yyyy or yyyy-mm-dd."),
      dayWindow: int("How many days apart two same-amount vouchers may be to count as duplicates (default 7)."),
      maxVouchers: int("Safety cap (default 2000)."),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const period = readPeriod(args);
    const dayWindow = optNumber(args, "dayWindow") ?? 7;
    const vouchers = await fetchVouchers(ctx, period, optNumber(args, "maxVouchers") ?? 2000);

    const byNumber = new Map<string, Row[]>();
    for (const v of vouchers) {
      const n = String(v.description ?? "").trim().toLowerCase();
      if (!n) continue;
      byNumber.set(n, [...(byNumber.get(n) ?? []), v]);
    }

    const sameNumber = [...byNumber.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([number, rows]) => ({
        documentNumber: number,
        count: rows.length,
        vouchers: rows.map((v) => ({
          id: String(v.id ?? ""),
          label: voucherLabel(v),
          status: VOUCHER_STATUS[String(v.status)] ?? String(v.status),
        })),
      }));

    const sameAmount: Row[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < vouchers.length; i++) {
      for (let j = i + 1; j < vouchers.length; j++) {
        const a = vouchers[i] as Row;
        const b = vouchers[j] as Row;
        const ga = round2(num(a.sumGross));
        const gb = round2(num(b.sumGross));
        if (ga === 0 || ga !== gb) continue;
        if (supplierKey(a.supplierName) !== supplierKey(b.supplierName)) continue;
        const da = parseSevdeskDate(a.voucherDate);
        const db = parseSevdeskDate(b.voucherDate);
        if (!da || !db) continue;
        const days = Math.abs(da.getTime() - db.getTime()) / 86_400_000;
        if (days > dayWindow) continue;
        const key = [a.id, b.id].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        sameAmount.push({
          gross: ga,
          daysApart: Math.round(days),
          a: voucherLabel(a),
          b: voucherLabel(b),
          ids: [String(a.id ?? ""), String(b.id ?? "")],
        });
      }
    }

    const unfinished = vouchers
      .filter((v) => String(v.status) !== "1000")
      .map((v) => ({
        id: String(v.id ?? ""),
        label: voucherLabel(v),
        status: VOUCHER_STATUS[String(v.status)] ?? String(v.status),
      }));

    return {
      vouchersExamined: vouchers.length,
      duplicateDocumentNumbers: sameNumber,
      sameSupplierSameAmount: sameAmount,
      notYetBooked: unfinished,
      note:
        "A repeated document number is almost always a real duplicate. Same-amount matches can be " +
        "legitimate (two top-ups of the same size on the same day) — check before deleting anything.",
    };
  },
};

/* ------------------------------------------------------------------ */
/* 4. subscription cadence gaps                                        */
/* ------------------------------------------------------------------ */

const subscriptionGaps: ToolDef = {
  name: "sevdesk_subscription_gaps",
  title: "Find gaps in recurring supplier charges",
  description:
    "Detect suppliers that bill on a monthly cadence and report months with no voucher. " +
    "A subscription that appears in March, April and June but not May almost always means a " +
    "receipt was never entered. Read-only.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      from: str("Start of period, dd.mm.yyyy or yyyy-mm-dd."),
      to: str("End of period, dd.mm.yyyy or yyyy-mm-dd."),
      minMonths: int("How many distinct months a supplier needs before it counts as recurring (default 3)."),
      maxVouchers: int("Safety cap (default 2000)."),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const period = readPeriod(args);
    const minMonths = optNumber(args, "minMonths") ?? 3;
    const vouchers = await fetchVouchers(ctx, period, optNumber(args, "maxVouchers") ?? 2000);

    const bySupplier = new Map<string, { name: string; months: Map<string, number> }>();
    for (const v of vouchers) {
      const d = parseSevdeskDate(v.voucherDate);
      if (!d) continue;
      const name = String(v.supplierName ?? (v.supplier as Row | undefined)?.name ?? "unbekannt");
      const key = supplierKey(name) || name.toLowerCase();
      const entry = bySupplier.get(key) ?? { name, months: new Map<string, number>() };
      const m = monthKey(d);
      entry.months.set(m, (entry.months.get(m) ?? 0) + round2(num(v.sumGross)));
      bySupplier.set(key, entry);
    }

    const allMonths = [...new Set([...bySupplier.values()].flatMap((e) => [...e.months.keys()]))].sort();
    const results: Row[] = [];

    for (const entry of bySupplier.values()) {
      const months = [...entry.months.keys()].sort();
      if (months.length < minMonths) continue;

      const first = months[0]!;
      const last = months[months.length - 1]!;
      const span: string[] = [];
      const [y0, m0] = first.split("-").map(Number) as [number, number];
      const [y1, m1] = last.split("-").map(Number) as [number, number];
      for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (m = 1, y++) : m++) {
        span.push(`${y}-${String(m).padStart(2, "0")}`);
      }

      const missing = span.filter((m) => !entry.months.has(m));
      if (!missing.length) continue;

      const amounts = [...entry.months.values()];
      const typical = round2(amounts.reduce((a, b) => a + b, 0) / amounts.length);

      results.push({
        supplier: entry.name,
        monthsPresent: months,
        monthsMissing: missing,
        typicalMonthlyAmount: typical,
        estimatedMissingValue: round2(typical * missing.length),
      });
    }

    results.sort((a, b) => num(b.estimatedMissingValue) - num(a.estimatedMissingValue));

    return {
      period: {
        from: period.from ? ymd(period.from) : "beginning",
        to: period.to ? ymd(period.to) : "today",
      },
      monthsCovered: allMonths,
      recurringSuppliersWithGaps: results.length,
      estimatedTotalMissing: round2(results.reduce((s, r) => s + num(r.estimatedMissingValue), 0)),
      results,
      note:
        "Gaps are only a signal. A cancelled subscription produces the same pattern — check the " +
        "supplier before hunting for a receipt that does not exist.",
    };
  },
};

/* ------------------------------------------------------------------ */
/* 5. folder <-> sevDesk diff                                          */
/* ------------------------------------------------------------------ */

interface ParsedFile {
  file: string;
  date: Date | null;
  amount: number | null;
  reference: string | null;
}

/** Pull a date, an amount and a #reference out of a receipt filename. */
export function parseReceiptFilename(name: string): ParsedFile {
  const stem = basename(name, extname(name));

  let date: Date | null = null;
  const iso = /(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/.exec(stem);
  // Leading YYMMDD, e.g. "260626_Acme-Cloud_#INV-2043".
  // `\b` would fail here because "_" counts as a word character.
  const short = /^(\d{2})(\d{2})(\d{2})(?!\d)/.exec(stem);
  if (iso) {
    date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  } else if (short) {
    date = new Date(2000 + Number(short[1]), Number(short[2]) - 1, Number(short[3]));
  }
  if (date && Number.isNaN(date.getTime())) date = null;

  const ref = /#([A-Za-z0-9][A-Za-z0-9._/-]{2,})/.exec(stem);

  let amount: number | null = null;
  const amounts = [...stem.matchAll(/(\d+[.,]\d{2})(?!\d)/g)].map((m) => num(m[1]));
  if (amounts.length) amount = amounts[amounts.length - 1] ?? null;

  return { file: name, date, amount, reference: ref?.[1] ?? null };
}

const diffReceiptFolder: ToolDef = {
  name: "sevdesk_diff_receipt_folder",
  title: "Diff a receipt folder against sevDesk",
  description:
    "Compare a local folder of receipt PDFs against the vouchers booked in sevDesk and report " +
    "both directions: files that appear to have no voucher, and vouchers with no matching file. " +
    "Matching uses the #reference in the filename first, then date + amount. Filenames are " +
    "expected to look like '260626_Acme-Cloud_#INV-2043.pdf' or '2026-06-26_AcmeCloud_45.60.pdf'. " +
    "Reads the filesystem but never writes; sevDesk access is read-only.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      directory: str("Absolute path to the folder holding the receipt files."),
      recursive: bool("Descend into subdirectories (default false)."),
      from: str("Only consider vouchers from this date on."),
      to: str("Only consider vouchers up to this date."),
      dayTolerance: int("Days a file date may differ from the voucher date (default 5)."),
      extensions: {
        type: "array",
        items: { type: "string" },
        description: "File extensions to consider (default ['.pdf']).",
      },
    },
    required: ["directory"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const dir = optString(args, "directory");
    if (!dir || !isAbsolute(dir)) throw new Error("`directory` must be an absolute path.");
    const target = resolve(dir);

    const allow = ctx.config.allowedReceiptDirs;
    if (allow.length > 0) {
      const ok = allow.some((a) => target === resolve(a) || target.startsWith(resolve(a) + sep));
      if (!ok) {
        throw new Error(
          `Refused: ${target} is outside SEVDESK_RECEIPT_DIRS (${allow.join(", ")}).`,
        );
      }
    }

    const info = await stat(target).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`Not a directory: ${target}`);

    const exts = (Array.isArray(args.extensions) ? (args.extensions as string[]) : [".pdf"]).map((e) =>
      e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`,
    );
    const recursive = optBool(args, "recursive") ?? false;

    const files: string[] = [];
    const walk = async (d: string, depth: number): Promise<void> => {
      const entries = await readdir(d, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const full = resolve(d, e.name);
        if (e.isDirectory()) {
          if (recursive && depth < 5) await walk(full, depth + 1);
        } else if (exts.includes(extname(e.name).toLowerCase())) {
          files.push(full);
        }
      }
    };
    await walk(target, 0);

    const parsed = files.map((f) => parseReceiptFilename(f));
    const period = readPeriod(args);
    const tolerance = (optNumber(args, "dayTolerance") ?? 5) * 86_400_000;
    const vouchers = await fetchVouchers(ctx, period, 2000);

    const matchedVoucherIds = new Set<string>();
    const unmatchedFiles: Row[] = [];

    for (const p of parsed) {
      const hit = vouchers.find((v) => {
        const id = String(v.id ?? "");
        if (matchedVoucherIds.has(id)) return false;

        if (p.reference) {
          const desc = String(v.description ?? "").toLowerCase();
          const ref = p.reference.toLowerCase();
          if (desc && (desc.includes(ref) || ref.includes(desc))) return true;
        }
        if (p.date && p.amount !== null) {
          const vd = parseSevdeskDate(v.voucherDate);
          if (!vd) return false;
          const closeEnough = Math.abs(vd.getTime() - p.date.getTime()) <= tolerance;
          const gross = round2(num(v.sumGross));
          const net = round2(num(v.sumNet));
          const sameAmount =
            Math.abs(gross - p.amount) < 0.02 || Math.abs(net - p.amount) < 0.02;
          return closeEnough && sameAmount;
        }
        return false;
      });

      if (hit) {
        matchedVoucherIds.add(String(hit.id ?? ""));
      } else {
        unmatchedFiles.push({
          file: basename(p.file),
          parsedDate: p.date ? ymd(p.date) : null,
          parsedAmount: p.amount,
          parsedReference: p.reference,
          reason: !p.date && !p.reference ? "filename gave no date or reference to match on" : "no voucher matched",
        });
      }
    }

    const vouchersWithoutFile = vouchers
      .filter((v) => !matchedVoucherIds.has(String(v.id ?? "")))
      .map((v) => ({ id: String(v.id ?? ""), label: voucherLabel(v) }));

    return {
      directory: target,
      filesScanned: files.length,
      vouchersExamined: vouchers.length,
      matched: matchedVoucherIds.size,
      filesWithoutVoucher: { count: unmatchedFiles.length, items: unmatchedFiles },
      vouchersWithoutFile: { count: vouchersWithoutFile.length, items: vouchersWithoutFile },
      note:
        "Matching is filename-based. A file whose name carries neither a #reference nor a date " +
        "and amount cannot be matched and will always show up as unmatched.",
    };
  },
};

/* ------------------------------------------------------------------ */

export const auditTools: ToolDef[] = [
  auditVat,
  reverseChargeReport,
  findDuplicates,
  subscriptionGaps,
  diffReceiptFolder,
];
