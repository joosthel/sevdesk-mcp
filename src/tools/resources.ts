import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  INVOICE_STATUS,
  TAX_RULES,
  VOUCHER_STATUS,
  type TaxRuleId,
  num,
  parseSevdeskDate,
  readTaxTreatment,
  round2,
  voucherSide,
  ymd,
} from "../lib/vat.js";
import {
  assertAllowedPath,
  bool,
  int,
  isDryRun,
  obj,
  optNumber,
  optString,
  requireString,
  str,
  type ToolContext,
  type ToolDef,
} from "../lib/tool.js";
import { regimeMismatch } from "../lib/profile.js";

/** Rule ids the sevDesk API accepts on vouchers — one source for schema enums and error texts. */
const VOUCHER_RULE_IDS = Object.entries(TAX_RULES)
  .filter(([, r]) => r.usableInVouchers)
  .map(([id]) => id as TaxRuleId);

/** Fetch a single document and refuse to hand it out for editing when it is enshrined. */
async function fetchUnenshrined(
  ctx: ToolContext,
  type: "Voucher" | "Invoice",
  id: string,
): Promise<Row> {
  const { data } = await ctx.client.request<{ objects?: Row[] }>({
    method: "GET",
    path: `/${type}/${encodeURIComponent(id)}`,
  });
  const doc = data?.objects?.[0];
  if (!doc) throw new Error(`No ${type.toLowerCase()} with id ${id}.`);
  if (doc.enshrined) {
    throw new Error(`${type} ${id} is enshrined (festgeschrieben) — sevDesk forbids changing it.`);
  }
  return doc;
}

type Row = Record<string, unknown>;

function period(args: Record<string, unknown>): { from?: Date; to?: Date } {
  const f = optString(args, "from");
  const t = optString(args, "to");
  return {
    from: f ? parseSevdeskDate(f) ?? undefined : undefined,
    to: t ? parseSevdeskDate(t) ?? undefined : undefined,
  };
}

function within(d: Date | null, p: { from?: Date; to?: Date }): boolean {
  if (!d) return true;
  if (p.from && d < p.from) return false;
  if (p.to && d > p.to) return false;
  return true;
}

/* ------------------------------------------------------------------ */

const ping: ToolDef = {
  name: "sevdesk_ping",
  title: "Check the sevDesk connection",
  description:
    "Verify the API token, report server mode, bookkeeping generation (1.0 taxType / " +
    "2.0 taxRule) and the account's detected VAT regime. Run this first.",
  mutating: false,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler(_args, ctx) {
    const { status } = await ctx.client.request({ method: "GET", path: "/Voucher", query: { limit: 1 } });

    // Which bookkeeping generation the account runs decides whether documents
    // carry taxRule (Update 2.0) or the deprecated taxType (1.0).
    let version: unknown = "unknown (endpoint not reachable)";
    try {
      const { data } = await ctx.client.request<{ objects?: { version?: unknown } }>({
        method: "GET",
        path: "/Tools/bookkeepingSystemVersion",
      });
      version = data?.objects?.version ?? data ?? version;
    } catch {
      // Some accounts may not expose the endpoint; the ping itself still counts.
    }

    const profile = await ctx.getProfile();
    const mismatch = regimeMismatch(profile);

    return {
      ok: status === 200,
      baseUrl: ctx.config.baseUrl,
      bookkeepingSystemVersion: version,
      mode: ctx.config.readOnly ? "READ-ONLY" : ctx.config.dryRun ? "DRY-RUN" : "read/write",
      vatProfile: {
        regime: profile.regime,
        source: profile.source,
        evidence: profile.evidence,
        ...(mismatch ? { warning: mismatch } : {}),
      },
      receiptDirsAllowed: ctx.config.allowedReceiptDirs.length
        ? ctx.config.allowedReceiptDirs
        : "file tools disabled (SEVDESK_RECEIPT_DIRS not set)",
    };
  },
};

const listVouchers: ToolDef = {
  name: "sevdesk_list_vouchers",
  title: "List vouchers (Belege)",
  description:
    "List incoming/outgoing vouchers with the fields that matter for bookkeeping: date, " +
    "supplier, gross/net/tax, status and the decoded VAT treatment. Read-only.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      from: str("Start date, dd.mm.yyyy or yyyy-mm-dd."),
      to: str("End date, dd.mm.yyyy or yyyy-mm-dd."),
      supplier: str("Case-insensitive substring of the supplier name."),
      status: str("Filter by status.", { enum: ["Entwurf", "offen", "bezahlt"] }),
      limit: int("Maximum rows to return (default 200)."),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const p = period(args);
    const supplier = optString(args, "supplier")?.toLowerCase();
    const wanted = optString(args, "status");
    const limit = optNumber(args, "limit") ?? 200;

    const all = await ctx.client.getAll<Row>("/Voucher", { embed: "supplier,taxRule" }, { maxItems: 2000 });

    const rows = all
      .filter((v) => within(parseSevdeskDate(v.voucherDate), p))
      .filter((v) => {
        if (!supplier) return true;
        const name = String(v.supplierName ?? (v.supplier as Row | undefined)?.name ?? "");
        return name.toLowerCase().includes(supplier);
      })
      .filter((v) => !wanted || (VOUCHER_STATUS[String(v.status)] ?? "") === wanted)
      .map((v) => {
        const tax = readTaxTreatment(v);
        const d = parseSevdeskDate(v.voucherDate);
        return {
          id: String(v.id ?? ""),
          date: d ? ymd(d) : null,
          documentNumber: v.description ?? null,
          supplier: v.supplierName ?? (v.supplier as Row | undefined)?.name ?? null,
          net: round2(num(v.sumNet)),
          tax: round2(num(v.sumTax)),
          gross: round2(num(v.sumGross)),
          status: VOUCHER_STATUS[String(v.status)] ?? String(v.status ?? ""),
          paidOn: v.payDate ? ymd(parseSevdeskDate(v.payDate) ?? new Date(0)) : null,
          taxTreatment: tax.label,
          taxRuleId: tax.ruleId,
          legacyTaxType: tax.legacyType,
          reverseCharge: tax.reverseCharge,
        };
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));

    return { total: rows.length, returned: Math.min(rows.length, limit), vouchers: rows.slice(0, limit) };
  },
};

const getVoucher: ToolDef = {
  name: "sevdesk_get_voucher",
  title: "Get one voucher with its positions",
  description:
    "Fetch a single voucher including its line items, with the VAT treatment and per-position " +
    "tax rates decoded. Read-only.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: { voucherId: str("Numeric voucher id.") },
    required: ["voucherId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = requireString(args, "voucherId");
    const { data } = await ctx.client.request<{ objects?: Row[] }>({
      method: "GET",
      path: `/Voucher/${encodeURIComponent(id)}`,
      query: { embed: "supplier,taxRule,document" },
    });
    const v = data?.objects?.[0];
    if (!v) throw new Error(`No voucher with id ${id}.`);

    const posRes = await ctx.client.request<{ objects?: Row[] }>({
      method: "GET",
      path: "/VoucherPos",
      query: { "voucher[id]": id, "voucher[objectName]": "Voucher", limit: 200, embed: "accountingType" },
    });

    const tax = readTaxTreatment(v);
    const d = parseSevdeskDate(v.voucherDate);

    return {
      id,
      date: d ? ymd(d) : null,
      documentNumber: v.description ?? null,
      supplier: v.supplierName ?? (v.supplier as Row | undefined)?.name ?? null,
      status: VOUCHER_STATUS[String(v.status)] ?? String(v.status ?? ""),
      net: round2(num(v.sumNet)),
      tax: round2(num(v.sumTax)),
      gross: round2(num(v.sumGross)),
      taxTreatment: { ...tax },
      positions: (posRes.data?.objects ?? []).map((p) => ({
        id: String(p.id ?? ""),
        comment: p.comment ?? null,
        accountingType:
          (p.accountingType as Row | undefined)?.name ??
          (p.accountDatev as Row | undefined)?.name ??
          null,
        taxRate: num(p.taxRate),
        net: round2(num(p.sumNet)),
        tax: round2(num(p.sumTax)),
        gross: round2(num(p.sumGross)),
      })),
      raw: v,
    };
  },
};

const listInvoices: ToolDef = {
  name: "sevdesk_list_invoices",
  title: "List outgoing invoices",
  description: "List invoices you issued, with number, customer, sums, status and dates. Read-only.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      from: str("Start date."),
      to: str("End date."),
      limit: int("Maximum rows (default 200)."),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const p = period(args);
    const limit = optNumber(args, "limit") ?? 200;
    const all = await ctx.client.getAll<Row>("/Invoice", { embed: "contact,taxRule" }, { maxItems: 2000 });
    const rows = all
      .filter((i) => within(parseSevdeskDate(i.invoiceDate), p))
      .map((i) => {
        const d = parseSevdeskDate(i.invoiceDate);
        const tax = readTaxTreatment(i);
        return {
          id: String(i.id ?? ""),
          invoiceNumber: i.invoiceNumber ?? null,
          date: d ? ymd(d) : null,
          customer: (i.contact as Row | undefined)?.name ?? i.addressName ?? null,
          net: round2(num(i.sumNet)),
          tax: round2(num(i.sumTax)),
          gross: round2(num(i.sumGross)),
          status: String(i.status ?? ""),
          taxTreatment: tax.label,
          reverseCharge: tax.reverseCharge,
        };
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { total: rows.length, invoices: rows.slice(0, limit) };
  },
};

const summarize: ToolDef = {
  name: "sevdesk_summarize",
  title: "Summarize invoices or vouchers (totals, not rows)",
  description:
    "Aggregate invoices or vouchers over a date range WITHOUT returning rows: counts plus " +
    "net/tax/gross sums, grouped by month, status, contact or nothing. Use this for totals " +
    "('revenue in Q2', 'expenses by supplier') instead of the list tools — the response stays " +
    "small however large the ledger is. Read-only.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      kind: str("What to aggregate.", { enum: ["invoices", "vouchers"] }),
      from: str("Start date, dd.mm.yyyy or yyyy-mm-dd."),
      to: str("End date."),
      groupBy: str("Grouping dimension (default month).", {
        enum: ["month", "status", "contact", "none"],
      }),
      side: str("Vouchers only: expense (money out), revenue (money in) or any (default).", {
        enum: ["expense", "revenue", "any"],
      }),
      maxGroups: int(
        "Cap on returned groups; the remainder is folded into one '(andere)' entry (default 40).",
      ),
    },
    required: ["kind"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const kind = requireString(args, "kind");
    if (kind !== "invoices" && kind !== "vouchers") {
      throw new Error(`kind must be 'invoices' or 'vouchers', not '${kind}'.`);
    }
    const p = period(args);
    const groupBy = optString(args, "groupBy") ?? "month";
    const side = optString(args, "side") ?? "any";
    const maxGroups = Math.max(1, optNumber(args, "maxGroups") ?? 40);

    const MAX_ITEMS = 10_000;
    const rows =
      kind === "invoices"
        ? await ctx.client.getAll<Row>("/Invoice", { embed: "contact" }, { maxItems: MAX_ITEMS })
        : await ctx.client.getAll<Row>("/Voucher", { embed: "supplier" }, { maxItems: MAX_ITEMS });
    const truncated = rows.length >= MAX_ITEMS;

    const statusMap = kind === "invoices" ? INVOICE_STATUS : VOUCHER_STATUS;
    const keyOf = (r: Row, d: Date | null): string => {
      switch (groupBy) {
        case "none":
          return "alle";
        case "status":
          return statusMap[String(r.status)] ?? String(r.status ?? "(unbekannt)");
        case "contact":
          return kind === "invoices"
            ? String((r.contact as Row | undefined)?.name ?? r.addressName ?? "(ohne Kontakt)")
            : String(r.supplierName ?? (r.supplier as Row | undefined)?.name ?? "(ohne Lieferant)");
        default:
          return d ? ymd(d).slice(0, 7) : "(ohne Datum)"; // YYYY-MM
      }
    };

    const groups = new Map<string, { count: number; net: number; tax: number; gross: number }>();
    let matched = 0;
    for (const r of rows) {
      const d = parseSevdeskDate(kind === "invoices" ? r.invoiceDate : r.voucherDate);
      if (!within(d, p)) continue;
      if (kind === "vouchers" && side !== "any" && voucherSide(r) !== side) continue;
      matched++;
      const g = groups.get(keyOf(r, d)) ?? { count: 0, net: 0, tax: 0, gross: 0 };
      g.count++;
      g.net += num(r.sumNet);
      g.tax += num(r.sumTax);
      g.gross += num(r.sumGross);
      groups.set(keyOf(r, d), g);
    }

    const sorted = [...groups.entries()]
      .map(([key, g]) => ({ key, count: g.count, net: g.net, tax: g.tax, gross: g.gross }))
      .sort((a, b) => (groupBy === "month" ? a.key.localeCompare(b.key) : b.gross - a.gross));
    // Bound the output: months keep the most recent, other dimensions the largest.
    const dropped =
      groupBy === "month" ? sorted.slice(0, -maxGroups) : sorted.slice(maxGroups);
    const kept =
      groupBy === "month"
        ? sorted.slice(Math.max(0, sorted.length - maxGroups))
        : sorted.slice(0, maxGroups);
    if (dropped.length > 0) {
      const other = { key: "(andere)", count: 0, net: 0, tax: 0, gross: 0 };
      for (const g of dropped) {
        other.count += g.count;
        other.net += g.net;
        other.tax += g.tax;
        other.gross += g.gross;
      }
      kept.push(other);
    }

    const total = { count: 0, net: 0, tax: 0, gross: 0 };
    for (const g of kept) {
      total.count += g.count;
      total.net += g.net;
      total.tax += g.tax;
      total.gross += g.gross;
    }

    return {
      kind,
      groupBy,
      ...(kind === "vouchers" ? { side } : {}),
      scanned: rows.length,
      matched,
      ...(truncated
        ? { truncated: true, note: `Only the first ${MAX_ITEMS} rows were scanned.` }
        : {}),
      total: {
        count: total.count,
        net: round2(total.net),
        tax: round2(total.tax),
        gross: round2(total.gross),
      },
      groups: kept.map((g) => ({
        key: g.key,
        count: g.count,
        net: round2(g.net),
        tax: round2(g.tax),
        gross: round2(g.gross),
      })),
    };
  },
};

const listContacts: ToolDef = {
  name: "sevdesk_list_contacts",
  title: "List contacts",
  description: "List customers and suppliers. Read-only.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      search: str("Case-insensitive substring of the contact name."),
      limit: int("Maximum rows (default 200)."),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const search = optString(args, "search")?.toLowerCase();
    const limit = optNumber(args, "limit") ?? 200;
    const all = await ctx.client.getAll<Row>("/Contact", {}, { maxItems: 5000 });
    const rows = all
      .map((c) => ({
        id: String(c.id ?? ""),
        name: c.name ?? [c.surename, c.familyname].filter(Boolean).join(" "),
        customerNumber: c.customerNumber ?? null,
        vatNumber: c.vatNumber ?? null,
        taxNumber: c.taxNumber ?? null,
      }))
      .filter((c) => !search || String(c.name).toLowerCase().includes(search));
    return { total: rows.length, contacts: rows.slice(0, limit) };
  },
};

const listTransactions: ToolDef = {
  name: "sevdesk_list_transactions",
  title: "List bank transactions",
  description: "List bank transactions, optionally for one account and period. Read-only.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      checkAccountId: str("Restrict to one bank account id."),
      from: str("Start date."),
      to: str("End date."),
      limit: int("Maximum rows (default 200)."),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const p = period(args);
    const accountId = optString(args, "checkAccountId");
    const limit = optNumber(args, "limit") ?? 200;
    const query: Record<string, unknown> = {};
    if (accountId) {
      query["checkAccount[id]"] = accountId;
      query["checkAccount[objectName]"] = "CheckAccount";
    }
    const all = await ctx.client.getAll<Row>("/CheckAccountTransaction", query, { maxItems: 5000 });
    const rows = all
      .filter((t) => within(parseSevdeskDate(t.valueDate ?? t.entryDate), p))
      .map((t) => {
        const d = parseSevdeskDate(t.valueDate ?? t.entryDate);
        return {
          id: String(t.id ?? ""),
          date: d ? ymd(d) : null,
          payeePayerName: t.payeePayerName ?? null,
          purpose: t.paymtPurpose ?? null,
          amount: round2(num(t.amount)),
          status: String(t.status ?? ""),
        };
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { total: rows.length, transactions: rows.slice(0, limit) };
  },
};

/* ---------------------------- writes ------------------------------ */

const uploadVoucherFile: ToolDef = {
  name: "sevdesk_upload_voucher_file",
  title: "Upload a receipt file to sevDesk",
  description:
    "Upload a local PDF/image to sevDesk's temporary voucher storage and return the filename " +
    "token you pass to sevdesk_create_voucher. WRITE operation — refused under SEVDESK_READ_ONLY.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      filePath: str("Absolute path to the receipt file on this machine."),
      mimeType: str("Override the content type (default guessed from the extension)."),
      dryRun: bool("Preview the request without sending it."),
    },
    required: ["filePath"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const path = assertAllowedPath(ctx, requireString(args, "filePath"));
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error(`Not a file: ${path}`);
    if (info.size > 20 * 1024 * 1024) throw new Error("File is larger than 20 MB.");

    const guessed = path.toLowerCase().endsWith(".pdf")
      ? "application/pdf"
      : path.toLowerCase().endsWith(".png")
        ? "image/png"
        : "image/jpeg";
    const mime = optString(args, "mimeType") ?? guessed;

    if (isDryRun(args, ctx)) {
      return {
        dryRun: true,
        wouldSend: { method: "POST", path: "/Voucher/Factory/uploadTempFile", file: path, bytes: info.size, mime },
      };
    }

    const bytes = await readFile(path);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), basename(path));

    const { data } = await ctx.client.request<Row>({
      method: "POST",
      path: "/Voucher/Factory/uploadTempFile",
      form,
      mutating: true,
    });
    return { uploaded: basename(path), bytes: info.size, response: data };
  },
};

const createVoucher: ToolDef = {
  name: "sevdesk_create_voucher",
  title: "Create a voucher",
  description:
    "Create a voucher via /Voucher/Factory/saveVoucher. Defaults to status 50 (Entwurf) so " +
    "nothing is booked without you reviewing it in sevDesk. Check sevdesk_receipt_guidance " +
    "for the account's allowed tax rules first — expense-side reverse charge is 12/13/14, " +
    "not 5. WRITE operation. For anything this wrapper does not cover, use sevdesk_call " +
    "with operationId 'voucherFactorySaveVoucher'.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      supplierName: str("Supplier name as it should appear on the voucher."),
      voucherDate: str("Voucher date, dd.mm.yyyy."),
      description: str("Document/invoice number."),
      taxRuleId: str("VAT regulation id.", { enum: ["1", "2", "3", "4", "5", "11"] }),
      creditDebit: str("C = credit, D = debit.", { enum: ["C", "D"] }),
      status: str("50 = Entwurf, 100 = offen, 1000 = bezahlt (default 50).", {
        enum: ["50", "100", "1000"],
      }),
      payDate: str("Payment date, dd.mm.yyyy — only with status 1000."),
      positions: {
        type: "array",
        description: "Line items.",
        items: {
          type: "object",
          properties: {
            sumNet: { type: "number", description: "Net amount of the position." },
            sumGross: { type: "number", description: "Gross amount of the position." },
            taxRate: { type: "number", description: "VAT rate in percent, e.g. 19 or 0." },
            comment: { type: "string", description: "Free-text description." },
            accountingTypeId: { type: "string", description: "sevDesk accounting type id." },
          },
        },
      },
      fileName: str("Filename token returned by sevdesk_upload_voucher_file."),
      extra: obj("Additional top-level voucher fields merged into the payload verbatim."),
      dryRun: bool("Show the payload instead of sending it."),
    },
    required: ["supplierName", "voucherDate", "positions"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const positionsIn = Array.isArray(args.positions) ? (args.positions as Row[]) : [];
    if (!positionsIn.length) throw new Error("At least one position is required.");

    const status = optString(args, "status") ?? "50";
    const taxRuleId = optString(args, "taxRuleId") ?? "1";

    const voucher: Row = {
      objectName: "Voucher",
      mapAll: true,
      voucherDate: requireString(args, "voucherDate"),
      supplierName: requireString(args, "supplierName"),
      description: optString(args, "description"),
      status,
      taxRule: { id: taxRuleId, objectName: "TaxRule" },
      creditDebit: optString(args, "creditDebit") ?? "C",
      voucherType: "VOU",
      ...(optString(args, "payDate") ? { payDate: optString(args, "payDate") } : {}),
      ...(optString(args, "fileName") ? { fileName: optString(args, "fileName") } : {}),
      ...((args.extra as Row | undefined) ?? {}),
    };

    const voucherPosSave = positionsIn.map((p) => {
      const hasNet = typeof p.sumNet === "number";
      return {
        objectName: "VoucherPos",
        mapAll: true,
        accountingType: p.accountingTypeId
          ? { id: String(p.accountingTypeId), objectName: "AccountingType" }
          : undefined,
        taxRate: num(p.taxRate),
        net: hasNet,
        sumNet: hasNet ? num(p.sumNet) : undefined,
        sumGross: !hasNet ? num(p.sumGross) : undefined,
        comment: p.comment,
      };
    });

    const payload = { voucher, voucherPosSave, voucherPosDelete: null };

    if (isDryRun(args, ctx)) {
      return { dryRun: true, wouldSend: { method: "POST", path: "/Voucher/Factory/saveVoucher", body: payload } };
    }

    const { data } = await ctx.client.request<Row>({
      method: "POST",
      path: "/Voucher/Factory/saveVoucher",
      body: payload,
      mutating: true,
    });
    return { created: true, statusUsed: status, response: data };
  },
};

/* ------------------------------------------------------------------ */

const RATE_WORD: Record<string, number> = { ZERO: 0, SEVEN: 7, NINETEEN: 19 };

const receiptGuidance: ToolDef = {
  name: "sevdesk_receipt_guidance",
  title: "Booking-account guidance",
  description:
    "sevDesk's own booking guidance: which DATEV/SKR accounts exist for expenses or revenue and " +
    "which tax rules and rates each of them allows — the table sevDesk validates against when a " +
    "voucher is booked. Filter by text, account number or tax rule; output is capped, never the " +
    "full account dump. Read-only.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      side: str("Which side to fetch guidance for (default expense).", {
        enum: ["expense", "revenue"],
      }),
      query: str("Case-insensitive substring over account number, name and description."),
      accountNumber: str("Exact SKR account number, e.g. '6837'."),
      taxRuleId: str("Only accounts that allow this tax rule id, e.g. '12'."),
      limit: int("Maximum accounts to return (default 20)."),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const side = optString(args, "side") ?? "expense";
    const query = optString(args, "query")?.toLowerCase();
    const accountNumber = optString(args, "accountNumber");
    const taxRuleId = optString(args, "taxRuleId");
    const limit = optNumber(args, "limit") ?? 20;

    const { data } = await ctx.client.request<{ objects?: Row[] }>({
      method: "GET",
      path: side === "revenue" ? "/ReceiptGuidance/forRevenue" : "/ReceiptGuidance/forExpense",
    });

    // Filter on the raw rows first — the endpoint returns hundreds of
    // accounts and only `limit` of them get shaped for output.
    const matching = (data?.objects ?? []).filter(
      (o) =>
        (!accountNumber || String(o.accountNumber ?? "") === accountNumber) &&
        (!taxRuleId ||
          ((o.allowedTaxRules as Row[] | undefined) ?? []).some(
            (r) => String(r.id ?? "") === taxRuleId,
          )) &&
        (!query ||
          `${o.accountNumber} ${o.accountName} ${o.description}`.toLowerCase().includes(query)),
    );

    const accounts = matching.slice(0, limit).map((o) => ({
      accountDatevId: String(o.accountDatevId ?? ""),
      accountNumber: String(o.accountNumber ?? ""),
      accountName: String(o.accountName ?? ""),
      description: String(o.description ?? ""),
      receiptTypes: (o.allowedReceiptTypes as string[] | undefined) ?? [],
      allowedTaxRules: ((o.allowedTaxRules as Row[] | undefined) ?? []).map((r) => ({
        id: String(r.id ?? ""),
        name: String(r.name ?? ""),
        rates: ((r.taxRates as string[] | undefined) ?? []).map((w) => RATE_WORD[w] ?? w),
      })),
    }));

    return { side, totalMatching: matching.length, returned: accounts.length, accounts };
  },
};

const setTaxRule: ToolDef = {
  name: "sevdesk_set_tax_rule",
  title: "Change a voucher's tax rule",
  description:
    "Rebook a voucher onto a different VAT rule (e.g. from 'Vorsteuerabziehbare Aufwendungen' " +
    "onto Reverse Charge §13b, taxRule 12) with guardrails: refuses enshrined vouchers and rules " +
    "from the wrong side of the books, verifies the result afterwards, and previews the request " +
    "with dryRun. The voucher's positions keep their rates. Only works on draft vouchers — the " +
    "sevDesk API refuses updates on booked/paid ones, and resetting a paid foreign-currency " +
    "voucher via the API recalculates its EUR amounts at today's rate. Correct paid vouchers in " +
    "the sevDesk UI instead.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      voucherId: str("Numeric voucher id."),
      taxRuleId: str("Target tax rule id.", { enum: VOUCHER_RULE_IDS }),
      dryRun: bool("Preview the request without sending it."),
    },
    required: ["voucherId", "taxRuleId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = requireString(args, "voucherId");
    const target = requireString(args, "taxRuleId") as TaxRuleId;
    if (!VOUCHER_RULE_IDS.includes(target)) {
      throw new Error(
        `taxRule '${target}' cannot be used on vouchers. Usable rules: ${VOUCHER_RULE_IDS.join(", ")}.`,
      );
    }
    const rule = TAX_RULES[target];

    const v = await fetchUnenshrined(ctx, "Voucher", id);
    const before = readTaxTreatment(v);
    const side = voucherSide(v) ?? rule.side;
    if (side !== rule.side) {
      throw new Error(
        `taxRule ${target} ("${rule.label}") is a ${rule.side} rule but voucher ${id} is ` +
          `${side === "expense" ? "an expense" : "a revenue"} document.`,
      );
    }

    if (before.ruleId === target) {
      return {
        voucherId: id,
        changed: false,
        note: `Voucher already uses taxRule ${target} ("${rule.label}").`,
      };
    }

    const body = { taxRule: { id: target, objectName: "TaxRule" } };
    if (isDryRun(args, ctx)) {
      return {
        dryRun: true,
        wouldSend: { method: "PUT", path: `/Voucher/${id}`, body },
        before: { ruleId: before.ruleId, label: before.label },
        target: { ruleId: target, label: rule.label },
      };
    }

    await ctx.client.request({
      method: "PUT",
      path: `/Voucher/${encodeURIComponent(id)}`,
      body,
      mutating: true,
    });

    // Trust nothing: read the voucher back and confirm the rule actually changed.
    const check = await ctx.client.request<{ objects?: Row[] }>({
      method: "GET",
      path: `/Voucher/${encodeURIComponent(id)}`,
    });
    const after = readTaxTreatment(check.data?.objects?.[0] ?? {});
    return {
      voucherId: id,
      changed: true,
      before: { ruleId: before.ruleId, label: before.label },
      after: { ruleId: after.ruleId, label: after.label },
      verified: after.ruleId === target,
    };
  },
};

/* ------------------------------------------------------------------ */

const createInvoice: ToolDef = {
  name: "sevdesk_create_invoice",
  title: "Create a draft invoice",
  description:
    "Create an outgoing invoice as a draft (status 50) — always a draft, so nothing reaches a " +
    "customer without review in sevDesk. Positions carry name, quantity, price and tax rate; " +
    "the contact's address is filled in automatically. Honors SEVDESK_DRY_RUN.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      contactId: str("Numeric id of the customer contact."),
      positions: {
        type: "array",
        description: "Invoice line items.",
        items: {
          type: "object",
          properties: {
            name: str("Position text."),
            quantity: { type: "number", description: "Quantity (default 1)." },
            price: { type: "number", description: "Unit price (net)." },
            taxRate: { type: "number", description: "VAT rate; defaults to what the tax rule allows (19 for rule 1, 0 for 0%-only rules). Required for OSS rules." },
          },
          required: ["name", "price"],
          additionalProperties: false,
        },
      },
      invoiceDate: str("Invoice date, yyyy-mm-dd (default today)."),
      header: str("Optional invoice header text."),
      taxRuleId: str("Revenue tax rule id. Default follows the account's VAT regime: 1 (regular) or 11 (§19 Kleinunternehmer); required if the regime cannot be detected.", {
        // Model_Invoice.taxRule per the sevDesk spec — invoices accept the OSS
        // and §18b rules that vouchers refuse, and not the guidance-only 22.
        enum: ["1", "2", "3", "4", "5", "11", "17", "18", "19", "20", "21"],
      }),
      currency: str("Currency (default EUR)."),
      dryRun: bool("Preview the request without sending it."),
    },
    required: ["contactId", "positions"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const contactId = requireString(args, "contactId");
    const positions = Array.isArray(args.positions) ? (args.positions as Row[]) : [];
    if (positions.length === 0) throw new Error("At least one position is required.");

    // The regime only chooses the default RULE; the rule then dictates the
    // default rate. An account whose regime cannot be detected gets no
    // silent default — a wrong guess is a wrong legal document either way.
    let ruleId = optString(args, "taxRuleId");
    if (!ruleId) {
      const profile = await ctx.getProfile();
      if (profile.regime === "unknown") {
        throw new Error(
          "Cannot choose a tax rule: the account's VAT regime is unknown " +
            `(${profile.evidence}). Pass taxRuleId explicitly — 1 for regular VAT, ` +
            "11 for §19 Kleinunternehmer — or set SEVDESK_VAT_REGIME.",
        );
      }
      ruleId = profile.regime === "kleinunternehmer" ? "11" : "1";
    }
    const rule = TAX_RULES[ruleId as TaxRuleId];
    if (!rule || rule.side !== "revenue" || ruleId === "22") {
      throw new Error(`taxRuleId '${ruleId}' is not a usable invoice revenue rule.`);
    }
    // OSS rules have destination-dependent rates — no default is safe.
    const defaultRate =
      rule.allowedRates === null ? null : (rule.allowedRates as readonly number[]).includes(19) ? 19 : 0;
    const date = optString(args, "invoiceDate") ?? ymd(new Date());

    const invoicePosSave = positions.map((p, i) => {
      const quantity = p.quantity === undefined ? 1 : num(p.quantity);
      if (!(quantity > 0)) throw new Error(`Position ${i + 1}: quantity must be a positive number.`);
      // No silent coercion for money-relevant fields — a null taxRate must not
      // become 0 % on a taxable invoice.
      if (p.taxRate !== undefined && typeof p.taxRate !== "number") {
        throw new Error(`Position ${i + 1}: taxRate must be a number when given.`);
      }
      if (p.taxRate === undefined && defaultRate === null) {
        throw new Error(
          `Position ${i + 1}: taxRate is required with rule ${ruleId} ("${rule.label}") — ` +
            "One Stop Shop rates depend on the destination country.",
        );
      }
      return {
        objectName: "InvoicePos",
        mapAll: true,
        name: String(p.name ?? ""),
        quantity,
        price: num(p.price),
        taxRate: typeof p.taxRate === "number" ? p.taxRate : (defaultRate as number),
        unity: { id: 1, objectName: "Unity" },
      };
    });

    const body = {
      invoice: {
        objectName: "Invoice",
        mapAll: true,
        invoiceDate: date,
        // Always a draft (invoice status 100): review happens in sevDesk, never silently.
        status: "100",
        invoiceType: "RE",
        currency: optString(args, "currency") ?? "EUR",
        contact: { id: Number(contactId), objectName: "Contact" },
        taxRule: { id: ruleId, objectName: "TaxRule" },
        taxRate: defaultRate ?? num(invoicePosSave[0]?.taxRate),
        taxText:
          ruleId === "11"
            ? "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."
            : defaultRate && defaultRate > 0
              ? `Umsatzsteuer ${defaultRate}%`
              : rule.label,
        discount: 0,
        ...(optString(args, "header") ? { header: optString(args, "header") } : {}),
      },
      invoicePosSave,
      // The Factory endpoint expects these four, in this order, on every call.
      invoicePosDelete: null,
      discountSave: null,
      discountDelete: null,
      takeDefaultAddress: true,
    };

    if (isDryRun(args, ctx)) {
      return { dryRun: true, wouldSend: { method: "POST", path: "/Invoice/Factory/saveInvoice", body } };
    }

    const { data } = await ctx.client.request<{ objects?: { invoice?: Row } }>({
      method: "POST",
      path: "/Invoice/Factory/saveInvoice",
      body,
      mutating: true,
    });
    const created = data?.objects?.invoice;
    return {
      invoiceId: String(created?.id ?? ""),
      invoiceNumber: created?.invoiceNumber ?? null,
      status: "Entwurf (draft)",
      note: "Review the draft in sevDesk before sending it to the customer.",
    };
  },
};

const getInvoicePdf: ToolDef = {
  name: "sevdesk_get_invoice_pdf",
  title: "Save an invoice PDF",
  description:
    "Fetch the rendered PDF of an invoice and save it into a directory from the " +
    "SEVDESK_RECEIPT_DIRS allowlist. Never changes the invoice's send state " +
    "(preventSendBy). Read-only towards sevDesk.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      invoiceId: str("Numeric invoice id."),
      directory: str("Absolute path of an allowlisted directory to save the PDF into."),
    },
    required: ["invoiceId", "directory"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = requireString(args, "invoiceId");
    const dir = assertAllowedPath(ctx, requireString(args, "directory"));

    const { data } = await ctx.client.request<Row>({
      method: "GET",
      path: `/Invoice/${encodeURIComponent(id)}/getPdf`,
      query: { preventSendBy: true },
    });

    // The spec documents the pdf payload at the top level; other endpoints
    // wrap responses in `objects` — accept both.
    const meta = ((data as Row | undefined)?.objects ?? data) as Row | undefined;
    const content = meta?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error(`sevDesk returned no PDF content for invoice ${id}.`);
    }
    if (meta?.base64encoded === false || meta?.base64Encoded === false) {
      throw new Error(`sevDesk returned non-base64 PDF content for invoice ${id} — not saved.`);
    }
    // The filename comes from the API — keep only its basename so it cannot
    // point outside the allowlisted directory.
    const filename = basename(String(meta?.filename ?? `invoice-${id}.pdf`));
    const target = join(dir, filename);
    const bytes = Buffer.from(content, "base64");
    // flag wx: never clobber an existing file in the user's receipt archive.
    await writeFile(target, bytes, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
      throw err.code === "EEXIST"
        ? new Error(`Refused: ${target} already exists — not overwriting the archive.`)
        : err;
    });
    return { saved: target, bytes: bytes.length };
  },
};

const markInvoiceSent: ToolDef = {
  name: "sevdesk_mark_invoice_sent",
  title: "Mark an invoice as sent",
  description:
    "Mark an invoice as sent without emailing anything (send types: PDF download, print, " +
    "postal — deliberately no email). Refuses enshrined invoices and verifies the result. " +
    "Honors SEVDESK_DRY_RUN.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      invoiceId: str("Numeric invoice id."),
      sendType: str("How the invoice left the house (default VPDF).", {
        enum: ["VPDF", "VPR", "VP"],
      }),
      dryRun: bool("Preview the request without sending it."),
    },
    required: ["invoiceId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = requireString(args, "invoiceId");
    const sendType = optString(args, "sendType") ?? "VPDF";

    await fetchUnenshrined(ctx, "Invoice", id);

    const body = { sendType, sendDraft: false };
    if (isDryRun(args, ctx)) {
      return { dryRun: true, wouldSend: { method: "PUT", path: `/Invoice/${id}/sendBy`, body } };
    }

    await ctx.client.request({
      method: "PUT",
      path: `/Invoice/${encodeURIComponent(id)}/sendBy`,
      body,
      mutating: true,
    });

    // Trust nothing: read the invoice back instead of parsing the PUT response.
    const { data: check } = await ctx.client.request<{ objects?: Row[] }>({
      method: "GET",
      path: `/Invoice/${encodeURIComponent(id)}`,
    });
    return {
      invoiceId: id,
      sendType,
      verified: check?.objects?.[0]?.sendType === sendType,
    };
  },
};

export const resourceTools: ToolDef[] = [
  ping,
  listVouchers,
  getVoucher,
  listInvoices,
  summarize,
  listContacts,
  listTransactions,
  uploadVoucherFile,
  createVoucher,
  receiptGuidance,
  setTaxRule,
  createInvoice,
  getInvoicePdf,
  markInvoiceSent,
];
