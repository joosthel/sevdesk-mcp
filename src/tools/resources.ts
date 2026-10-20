import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

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
  assertAllowedDir,
  assertAllowedPath,
  bool,
  getAllCapped,
  truncationFields,
  int,
  isDryRun,
  isPlainObject,
  obj,
  optId,
  optLimit,
  optNumber,
  optRuleId,
  optString,
  positionObjects,
  requireId,
  requireString,
  str,
  type ToolContext,
  type ToolDef,
} from "../lib/tool.js";

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
    "2.0 taxRule). Run this first.",
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

    return {
      ok: status === 200,
      baseUrl: ctx.config.baseUrl,
      bookkeepingSystemVersion: version,
      mode: ctx.config.readOnly ? "READ-ONLY" : ctx.config.dryRun ? "DRY-RUN" : "read/write",
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
      limit: int("Maximum rows to return (default 200).", { minimum: 1, maximum: 1000 }),
      maxItems: int("Fetch cap: how many records are read from sevDesk before filtering (default 2000).", { minimum: 1, maximum: 20000 }),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const p = period(args);
    const supplier = optString(args, "supplier")?.toLowerCase();
    const wanted = optString(args, "status");
    const limit = optLimit(args, "limit", 200, 1000);

    const maxItems = optLimit(args, "maxItems", 2000, 20_000);
    const { rows: all, truncated } = await getAllCapped<Row>(ctx, "/Voucher", { embed: "supplier,taxRule" }, maxItems);

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

    return {
      total: rows.length,
      returned: Math.min(rows.length, limit),
      ...truncationFields(truncated, { what: "vouchers", cap: maxItems, param: "maxItems" }),
      vouchers: rows.slice(0, limit),
    };
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
    const id = requireId(args, "voucherId");
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
      limit: int("Maximum rows (default 200).", { minimum: 1, maximum: 1000 }),
      maxItems: int("Fetch cap: how many records are read from sevDesk before filtering (default 2000).", { minimum: 1, maximum: 20000 }),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const p = period(args);
    const limit = optLimit(args, "limit", 200, 1000);
    const maxItems = optLimit(args, "maxItems", 2000, 20_000);
    const { rows: all, truncated } = await getAllCapped<Row>(ctx, "/Invoice", { embed: "contact,taxRule" }, maxItems);
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
    return { total: rows.length, returned: Math.min(rows.length, limit), ...truncationFields(truncated, { what: "invoices", cap: maxItems, param: "maxItems" }), invoices: rows.slice(0, limit) };
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
        { minimum: 1, maximum: 1000 },
      ),
      maxItems: int("Fetch cap: how many records are read from sevDesk before filtering (default 10000).", { minimum: 1, maximum: 20000 }),
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
    const maxGroups = optLimit(args, "maxGroups", 40, 1000);

    const MAX_ITEMS = optLimit(args, "maxItems", 10_000, 20_000);
    const { rows, truncated } =
      kind === "invoices"
        ? await getAllCapped<Row>(ctx, "/Invoice", { embed: "contact" }, MAX_ITEMS)
        : await getAllCapped<Row>(ctx, "/Voucher", { embed: "supplier" }, MAX_ITEMS);

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
        ? truncationFields(true, { what: kind, cap: MAX_ITEMS, param: "maxItems" })
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
      limit: int("Maximum rows (default 200).", { minimum: 1, maximum: 1000 }),
      maxItems: int("Fetch cap: how many records are read from sevDesk before filtering (default 5000).", { minimum: 1, maximum: 20000 }),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const search = optString(args, "search")?.toLowerCase();
    const limit = optLimit(args, "limit", 200, 1000);
    const maxItems = optLimit(args, "maxItems", 5000, 20_000);
    const { rows: all, truncated } = await getAllCapped<Row>(ctx, "/Contact", {}, maxItems);
    const rows = all
      .map((c) => ({
        id: String(c.id ?? ""),
        name: c.name ?? [c.surename, c.familyname].filter(Boolean).join(" "),
        customerNumber: c.customerNumber ?? null,
        vatNumber: c.vatNumber ?? null,
        taxNumber: c.taxNumber ?? null,
      }))
      .filter((c) => !search || String(c.name).toLowerCase().includes(search));
    return { total: rows.length, returned: Math.min(rows.length, limit), ...truncationFields(truncated, { what: "contacts", cap: maxItems, param: "maxItems" }), contacts: rows.slice(0, limit) };
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
      limit: int("Maximum rows (default 200).", { minimum: 1, maximum: 1000 }),
      maxItems: int("Fetch cap: how many records are read from sevDesk before filtering (default 5000).", { minimum: 1, maximum: 20000 }),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const p = period(args);
    const accountId = optId(args, "checkAccountId");
    const limit = optLimit(args, "limit", 200, 1000);
    const query: Record<string, unknown> = {};
    if (accountId) {
      query["checkAccount[id]"] = accountId;
      query["checkAccount[objectName]"] = "CheckAccount";
    }
    const maxItems = optLimit(args, "maxItems", 5000, 20_000);
    const { rows: all, truncated } = await getAllCapped<Row>(ctx, "/CheckAccountTransaction", query, maxItems);
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
    return { total: rows.length, returned: Math.min(rows.length, limit), ...truncationFields(truncated, { what: "transactions", cap: maxItems, param: "maxItems" }), transactions: rows.slice(0, limit) };
  },
};

/* ---------------------------- writes ------------------------------ */

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".xml": "application/xml",
};

const uploadVoucherFile: ToolDef = {
  name: "sevdesk_upload_voucher_file",
  title: "Upload a receipt file to sevDesk",
  description:
    "Upload a local PDF/image/XML e-invoice to sevDesk's temporary voucher storage and return the filename " +
    "token you pass to sevdesk_create_voucher. WRITE operation — refused under SEVDESK_READ_ONLY.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      filePath: str("Absolute path to the receipt file on this machine."),
      mimeType: str("Content type; required for extensions other than .pdf, .png, .jpg, .jpeg, .xml."),
      dryRun: bool("Preview the request without sending it."),
    },
    required: ["filePath"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const rawPath = requireString(args, "filePath");
    // Before resolve(): a relative path would otherwise be anchored to the cwd and pass.
    if (!isAbsolute(rawPath)) throw new Error("File path must be absolute.");
    const requested = resolve(rawPath);
    // Containment and I/O use the real path; the name and content type come
    // from what the caller asked for, so an allowlisted alias.pdf link works.
    const path = await assertAllowedPath(ctx, requested);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error(`Not a file: ${path}`);
    if (info.size > 20 * 1024 * 1024) throw new Error("File is larger than 20 MB.");

    // XML covers XRechnung / ZUGFeRD e-invoices. No fallback type: a wrong
    // guess is stored as-is, so an unknown extension must be stated explicitly.
    const guessed = MIME_BY_EXT[extname(requested).toLowerCase()];
    const mime = optString(args, "mimeType") ?? guessed;
    if (!mime) {
      throw new Error(
        `Refused: cannot tell the content type of '${basename(requested)}'. Known extensions: ` +
          `${Object.keys(MIME_BY_EXT).join(", ")} — or pass mimeType explicitly.`,
      );
    }

    if (isDryRun(args, ctx)) {
      return {
        dryRun: true,
        wouldSend: { method: "POST", path: "/Voucher/Factory/uploadTempFile", file: requested, bytes: info.size, mime },
      };
    }

    const bytes = await readFile(path);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), basename(requested));

    const { data } = await ctx.client.request<Row>({
      method: "POST",
      path: "/Voucher/Factory/uploadTempFile",
      form,
      mutating: true,
    });
    // sevDesk echoes a rendered preview of the upload back in `content` —
    // tens of thousands of base64 characters that are worthless to a caller
    // who needs the filename token. Keep the metadata, drop the blob.
    const objects = (data as Row | undefined)?.objects;
    const scrub = (o: unknown): unknown => {
      if (!o || typeof o !== "object" || Array.isArray(o)) return o;
      const meta: Row = { ...(o as Row) };
      delete meta.content;
      return meta;
    };
    let response: unknown = data;
    if (Array.isArray(objects)) response = { ...(data as Row), objects: objects.map(scrub) };
    else if (objects && typeof objects === "object") response = { ...(data as Row), objects: scrub(objects) };
    return { uploaded: basename(requested), bytes: info.size, response };
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
      taxRuleId: str(
        `VAT regulation id — every rule sevDesk accepts on a voucher, both sides. ` +
          `Required — never guessed. sevdesk_receipt_guidance lists the ones the booking ` +
          `account actually allows. Expense rules go with creditDebit C, revenue rules with D.`,
        { enum: VOUCHER_RULE_IDS },
      ),
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
            accountingTypeId: { type: "string", description: "sevDesk accounting type id (legacy bookkeeping only)." },
            accountDatevId: {
              type: "string",
              description:
                "Booking account id for sevdesk-Update 2.0 (accountDatevId from sevdesk_receipt_guidance). Replaces accountingTypeId.",
            },
          },
        },
      },
      fileName: str("Filename token returned by sevdesk_upload_voucher_file."),
      extra: obj("Additional top-level voucher fields merged into the payload verbatim."),
      dryRun: bool("Show the payload instead of sending it."),
    },
    required: ["supplierName", "voucherDate", "taxRuleId", "positions"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const positionsIn = positionObjects(args);
    if (!positionsIn.length) throw new Error("At least one position is required.");

    const statusRaw = typeof args.status === "number" ? String(args.status) : optString(args, "status");
    if (statusRaw !== undefined && !["50", "100", "1000"].includes(statusRaw)) {
      throw new Error(`status must be 50 (Entwurf), 100 (offen) or 1000 (bezahlt), not '${statusRaw}'.`);
    }
    const status = statusRaw ?? "50";
    const cdRaw = optString(args, "creditDebit");
    if (cdRaw !== undefined && cdRaw !== "C" && cdRaw !== "D") {
      throw new Error(`creditDebit must be "C" or "D", not "${cdRaw}".`);
    }
    const creditDebit = cdRaw ?? "C";
    const taxRuleId = optRuleId(args);
    if (!taxRuleId) {
      throw new Error(
        "taxRuleId is required: the server does not guess a tax treatment. " +
          "sevdesk_receipt_guidance lists the rules the booking account allows.",
      );
    }
    const rule = TAX_RULES[taxRuleId as TaxRuleId];
    if (!rule || !rule.usableInVouchers) {
      throw new Error(`taxRuleId '${taxRuleId}' is not usable on a voucher (${VOUCHER_RULE_IDS.join(", ")}).`);
    }
    // C = expense, D = revenue: a rule from the other side books the voucher wrongly.
    if (rule.side !== (creditDebit === "C" ? "expense" : "revenue")) {
      throw new Error(
        `taxRuleId ${taxRuleId} ("${rule.label}") is a ${rule.side} rule, but creditDebit ` +
          `${creditDebit} is ${creditDebit === "C" ? "an expense" : "a revenue"} voucher.`,
      );
    }

    const base: Row = {
      objectName: "Voucher",
      mapAll: true,
      voucherDate: requireString(args, "voucherDate"),
      supplierName: requireString(args, "supplierName"),
      description: optString(args, "description"),
      status,
      taxRule: { id: taxRuleId, objectName: "TaxRule" },
      creditDebit,
      voucherType: "VOU",
      ...(optString(args, "payDate") ? { payDate: optString(args, "payDate") } : {}),
    };
    // `extra` is for genuinely additional fields; it must not silently
    // override what the tool's own arguments and guards decided.
    if (args.extra !== undefined && !isPlainObject(args.extra)) {
      throw new Error("extra must be an object of additional voucher fields.");
    }
    const extra = (args.extra ?? {}) as Row;
    // taxType / taxSet are legacy tax fields that would contradict taxRule.
    if ("fileName" in extra || "filename" in extra) {
      throw new Error("Refused: pass the receipt via the top-level fileName argument, not extra.");
    }
    const collisions = Object.keys(extra).filter(
      (k) => base[k] !== undefined || k === "taxType" || k === "taxSet",
    );
    if (collisions.length) {
      throw new Error(
        `Refused: extra would override field(s) this tool sets itself: ${collisions.join(", ")}. ` +
          "Use the dedicated arguments instead.",
      );
    }
    const voucher: Row = { ...base, ...extra };

    const netFlags = new Set(positionsIn.map((p) => p.sumNet !== undefined && p.sumNet !== null));
    if (netFlags.size > 1) {
      throw new Error("Refused: positions mix sumNet and sumGross — a voucher is either all net or all gross.");
    }

    const voucherPosSave = positionsIn.map((p, i) => {
      const at = `Position ${i + 1}`;
      // No silent coercion: a missing rate must not become 0 %, a missing sum a 0 EUR position.
      if (typeof p.taxRate !== "number" || !Number.isFinite(p.taxRate)) {
        throw new Error(`${at}: taxRate must be a number.`);
      }
      if (rule.allowedRates !== null && !(rule.allowedRates as readonly number[]).includes(p.taxRate)) {
        throw new Error(
          `${at}: taxRate ${p.taxRate} is not allowed with rule ${taxRuleId} ("${rule.label}") — ` +
            `allowed: ${rule.allowedRates.join(", ")}.`,
        );
      }
      const given = (v: unknown) => v !== undefined && v !== null;
      if (given(p.sumNet) === given(p.sumGross)) {
        throw new Error(`${at}: give exactly one of sumNet or sumGross.`);
      }
      const sum = given(p.sumNet) ? p.sumNet : p.sumGross;
      if (typeof sum !== "number" || !Number.isFinite(sum)) {
        throw new Error(`${at}: ${given(p.sumNet) ? "sumNet" : "sumGross"} must be a finite number.`);
      }
      const hasNet = given(p.sumNet);
      const accountingTypeId = optId(p, "accountingTypeId");
      const accountDatevId = optId(p, "accountDatevId");
      return {
        objectName: "VoucherPos",
        mapAll: true,
        accountingType: accountingTypeId ? { id: accountingTypeId, objectName: "AccountingType" } : undefined,
        accountDatev: accountDatevId ? { id: accountDatevId, objectName: "AccountDatev" } : undefined,
        taxRate: p.taxRate,
        net: hasNet,
        sumNet: hasNet ? sum : undefined,
        sumGross: !hasNet ? sum : undefined,
        comment: p.comment,
      };
    });

    // sevDesk takes the uploaded receipt as a TOP-LEVEL `filename` on the
    // saveVoucher payload (schema `saveVoucher`), not as a voucher field —
    // put in the wrong place it is silently ignored and the voucher is
    // created without its document.
    const attachment = optString(args, "fileName");
    const payload = {
      voucher,
      voucherPosSave,
      voucherPosDelete: null,
      ...(attachment ? { filename: attachment } : {}),
    };

    if (isDryRun(args, ctx)) {
      return { dryRun: true, wouldSend: { method: "POST", path: "/Voucher/Factory/saveVoucher", body: payload } };
    }

    const { data } = await ctx.client.request<Row>({
      method: "POST",
      path: "/Voucher/Factory/saveVoucher",
      body: payload,
      mutating: true,
    });
    // sevDesk echoes the full voucher with the whole sevClient (bank data, tax
    // number, settings) embedded twice — thousands of tokens. Hand back what a
    // caller needs to continue.
    const objects = (data as Row | undefined)?.objects as Row | undefined;
    const saved = objects?.voucher as Row | undefined;
    if (!saved) return { created: true, statusUsed: status, response: data };
    const posOut = Array.isArray(objects?.voucherPos) ? (objects.voucherPos as Row[]) : [];
    return {
      created: true,
      statusUsed: status,
      voucher: {
        id: String(saved.id ?? ""),
        status: VOUCHER_STATUS[String(saved.status)] ?? String(saved.status ?? ""),
        voucherDate: saved.voucherDate ?? null,
        supplierName: saved.supplierName ?? null,
        description: saved.description ?? null,
        sumGross: round2(num(saved.sumGross)),
        taxRule: (saved.taxRule as Row | undefined)?.id ?? null,
        documentId: (saved.document as Row | undefined)?.id ?? null,
      },
      positions: posOut.map((p) => ({
        id: String(p.id ?? ""),
        accountDatevId: (p.accountDatev as Row | undefined)?.id ?? null,
        accountingTypeId: (p.accountingType as Row | undefined)?.id ?? null,
        sumGross: round2(num(p.sumGross)),
        comment: p.comment ?? null,
      })),
    };
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
      limit: int("Maximum accounts to return (default 20).", { minimum: 1, maximum: 1000 }),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const side = optString(args, "side") ?? "expense";
    const query = optString(args, "query")?.toLowerCase();
    const accountNumber = optString(args, "accountNumber");
    const taxRuleId = optString(args, "taxRuleId");
    const limit = optLimit(args, "limit", 20, 1000);

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
    const id = requireId(args, "voucherId");
    const target = (optRuleId(args) ?? requireString(args, "taxRuleId")) as TaxRuleId;
    if (!VOUCHER_RULE_IDS.includes(target)) {
      throw new Error(
        `taxRule '${target}' cannot be used on vouchers. Usable rules: ${VOUCHER_RULE_IDS.join(", ")}.`,
      );
    }
    const rule = TAX_RULES[target];

    const v = await fetchUnenshrined(ctx, "Voucher", id);
    // Learned on live data: the API only updates drafts, and resetting a paid
    // foreign-currency voucher recalculates its EUR amounts at today's rate.
    if (String(v.status) !== "50") {
      throw new Error(
        `Refused: voucher ${id} is ${VOUCHER_STATUS[String(v.status)] ?? `status ${v.status}`}, not a ` +
          "draft (Entwurf). Change the tax rule of booked or paid vouchers in the sevDesk UI.",
      );
    }
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
      taxRuleId: str("Revenue tax rule id — required, never guessed. 1 taxable domestic, 2 export, 3 intra-EU supply, 4 §4 exempt, 5 §13b, 11 §19 UStG (no VAT shown), 17 not taxable domestically, 18-20 One Stop Shop (per-position taxRate required), 21 §18b.", {
        // Model_Invoice.taxRule per the sevDesk spec — invoices accept the OSS
        // and §18b rules that vouchers refuse, and not the guidance-only 22.
        enum: ["1", "2", "3", "4", "5", "11", "17", "18", "19", "20", "21"],
      }),
      currency: str("Currency (default EUR)."),
      dryRun: bool("Preview the request without sending it."),
    },
    required: ["contactId", "taxRuleId", "positions"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const contactId = requireId(args, "contactId");
    const positions = positionObjects(args);
    if (positions.length === 0) throw new Error("At least one position is required.");

    const ruleId = optRuleId(args);
    if (!ruleId) {
      throw new Error(
        "taxRuleId is required: the server does not guess a tax treatment. " +
          "Rules: 1 taxable domestic, 2 export, 3 intra-EU supply, 4 §4 exempt, 5 §13b, " +
          "11 §19 UStG, 17 not taxable domestically, 18-20 One Stop Shop, 21 §18b.",
      );
    }
    const rule = TAX_RULES[ruleId as TaxRuleId];
    if (!rule || rule.side !== "revenue" || ruleId === "22") {
      throw new Error(`taxRuleId '${ruleId}' is not a usable invoice revenue rule.`);
    }
    // The rule dictates the default rate. OSS rules have destination-dependent rates — no default is safe.
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
      if (typeof p.name !== "string" || p.name.trim() === "") {
        throw new Error(`Position ${i + 1}: name must be a non-empty string.`);
      }
      if (typeof p.price !== "number" || !Number.isFinite(p.price)) {
        throw new Error(`Position ${i + 1}: price must be a finite number.`);
      }
      const taxRate = typeof p.taxRate === "number" ? p.taxRate : (defaultRate as number);
      if (rule.allowedRates !== null && !(rule.allowedRates as readonly number[]).includes(taxRate)) {
        throw new Error(
          `Position ${i + 1}: taxRate ${taxRate} is not allowed with rule ${ruleId} ("${rule.label}") — ` +
            `allowed: ${rule.allowedRates.join(", ")}.`,
        );
      }
      return {
        objectName: "InvoicePos",
        mapAll: true,
        name: p.name,
        quantity,
        price: p.price,
        taxRate,
        unity: { id: 1, objectName: "Unity" },
      };
    });

    // The invoice-level rate/text follow the positions when they agree. When
    // they differ no single percentage is true, so keep the rule's default
    // rate and use the rule's label as text rather than state one rate.
    const rates = new Set(invoicePosSave.map((p) => p.taxRate));
    const uniformRate = rates.size === 1 ? invoicePosSave[0]!.taxRate : null;

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
        taxRate: uniformRate ?? defaultRate ?? num(invoicePosSave[0]?.taxRate),
        taxText:
          ruleId === "11"
            ? "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."
            : uniformRate !== null && uniformRate > 0
              ? `Umsatzsteuer ${uniformRate}%`
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
    const id = requireId(args, "invoiceId");
    // Checked before the network call: no point fetching a PDF we cannot write.
    const dir = await assertAllowedDir(ctx, requireString(args, "directory"));

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
    let filename = basename(String(meta?.filename ?? ""));
    if (!/^[\p{L}\p{N}_.\- ]+\.pdf$/iu.test(filename) || filename.startsWith("..")) filename = `invoice-${id}.pdf`;
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
    const id = requireId(args, "invoiceId");
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

/** sevDesk's CheckAccountTransaction status codes. */
const TRANSACTION_STATUS: Record<string, string> = {
  "100": "offen",
  "200": "verknüpft",
  "300": "privat",
  "350": "automatisch verbucht",
  "400": "gebucht",
};

const linkTransaction: ToolDef = {
  name: "sevdesk_link_transaction",
  title: "Link a voucher to an existing bank transaction",
  description:
    "Book a voucher against an EXISTING bank transaction (PUT /Voucher/{id}/bookAmount with " +
    "checkAccountTransaction) — the same as assigning the receipt to the transaction in the " +
    "sevDesk UI. Amount defaults to the voucher's open amount, date and bank account are taken " +
    "from the transaction. Refuses enshrined vouchers, booked/private transactions, a sign " +
    "mismatch (expense voucher vs. incoming money) and amounts above the transaction. One " +
    "transaction can be linked to several vouchers (split payments). WRITE operation.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      voucherId: str("Numeric voucher id."),
      transactionId: str("Numeric CheckAccountTransaction id (sevdesk_list_transactions)."),
      amount: {
        type: "number",
        description: "Amount to book (positive). Defaults to the voucher's open amount.",
      },
      dryRun: bool("Preview the request without sending it."),
    },
    required: ["voucherId", "transactionId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const voucherId = requireId(args, "voucherId");
    const transactionId = requireId(args, "transactionId");

    const voucher = await fetchUnenshrined(ctx, "Voucher", voucherId);
    const { data: tData } = await ctx.client.request<{ objects?: Row[] }>({
      method: "GET",
      path: `/CheckAccountTransaction/${encodeURIComponent(transactionId)}`,
    });
    const tx = tData?.objects?.[0];
    if (!tx) throw new Error(`No bank transaction with id ${transactionId}.`);

    const txStatus = String(tx.status ?? "");
    if (txStatus !== "100" && txStatus !== "200") {
      throw new Error(
        `Transaction ${transactionId} is ${TRANSACTION_STATUS[txStatus] ?? txStatus} — ` +
          "only open or partially linked transactions can take a voucher.",
      );
    }
    const voucherStatus = String(voucher.status ?? "");
    if (voucherStatus === "50") {
      throw new Error(`Voucher ${voucherId} is still a draft (Entwurf) — set it to open (100) first.`);
    }
    if (voucherStatus === "1000") throw new Error(`Voucher ${voucherId} is already paid.`);

    const txAmount = round2(num(tx.amount));
    const expense = voucher.creditDebit !== "D";
    if (expense ? txAmount > 0 : txAmount < 0) {
      throw new Error(
        `Sign mismatch: ${expense ? "expense" : "revenue"} voucher ${voucherId} vs. transaction ` +
          `amount ${txAmount}.`,
      );
    }

    const open = round2(num(voucher.sumGross) - num(voucher.paidAmount));
    if (open <= 0) throw new Error(`Voucher ${voucherId} has nothing left to pay (open ${open}).`);
    const amount = round2(optNumber(args, "amount") ?? open);
    if (amount <= 0) throw new Error("Amount must be positive.");
    if (amount > open) throw new Error(`Amount ${amount} exceeds the voucher's open amount ${open}.`);
    if (amount > Math.abs(txAmount)) {
      throw new Error(`Amount ${amount} exceeds the transaction amount ${Math.abs(txAmount)}.`);
    }

    const txDate = parseSevdeskDate(tx.valueDate ?? tx.entryDate);
    if (!txDate) throw new Error(`Transaction ${transactionId} has no date.`);
    const accountId = String((tx.checkAccount as Row | undefined)?.id ?? "");
    if (!accountId) throw new Error(`Transaction ${transactionId} has no bank account.`);

    // "N" is sevDesk's PARTIAL booking (status 750 teilbezahlt) — a payment
    // that settles the voucher must be FULL_PAYMENT. The amount carries the
    // bank transaction's sign: a positive amount on an expense voucher is
    // booked as money coming back (paidAmount goes negative, 750).
    const body = {
      amount: expense ? -amount : amount,
      date: ymd(txDate),
      type: amount === open ? "FULL_PAYMENT" : "N",
      checkAccount: { id: Number(accountId), objectName: "CheckAccount" },
      checkAccountTransaction: { id: Number(transactionId), objectName: "CheckAccountTransaction" },
      createFeed: false,
    };
    const path = `/Voucher/${encodeURIComponent(voucherId)}/bookAmount`;
    if (isDryRun(args, ctx)) {
      return { dryRun: true, wouldSend: { method: "PUT", path, body } };
    }

    await ctx.client.request({ method: "PUT", path, body, mutating: true });

    // Read both sides back instead of trusting the PUT response.
    const [{ data: vCheck }, { data: tCheck }] = await Promise.all([
      ctx.client.request<{ objects?: Row[] }>({
        method: "GET",
        path: `/Voucher/${encodeURIComponent(voucherId)}`,
      }),
      ctx.client.request<{ objects?: Row[] }>({
        method: "GET",
        path: `/CheckAccountTransaction/${encodeURIComponent(transactionId)}`,
      }),
    ]);
    const v = vCheck?.objects?.[0] ?? {};
    const t = tCheck?.objects?.[0] ?? {};
    return {
      linked: true,
      voucherId,
      transactionId,
      amount,
      date: body.date,
      voucher: {
        status: VOUCHER_STATUS[String(v.status)] ?? String(v.status ?? ""),
        paidAmount: round2(num(v.paidAmount)),
      },
      transaction: {
        status: TRANSACTION_STATUS[String(t.status)] ?? String(t.status ?? ""),
      },
    };
  },
};

const resetVoucherToOpen: ToolDef = {
  name: "sevdesk_reset_voucher_to_open",
  title: "Undo a voucher's payments",
  description:
    "Reset a paid or partially paid voucher to open (PUT /Voucher/{id}/resetToOpen): sevDesk " +
    "unlinks every payment/bank transaction booked on it, the transactions become open again. " +
    "The undo for sevdesk_link_transaction. Refuses enshrined vouchers and drafts. WRITE operation.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      voucherId: str("Numeric voucher id."),
      dryRun: bool("Preview the request without sending it."),
    },
    required: ["voucherId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const voucherId = requireId(args, "voucherId");
    const voucher = await fetchUnenshrined(ctx, "Voucher", voucherId);
    const status = String(voucher.status ?? "");
    if (status === "50") throw new Error(`Voucher ${voucherId} is a draft — nothing to reset.`);
    if (status === "100") return { voucherId, status: "offen", changed: false };

    const path = `/Voucher/${encodeURIComponent(voucherId)}/resetToOpen`;
    if (isDryRun(args, ctx)) return { dryRun: true, wouldSend: { method: "PUT", path } };

    await ctx.client.request({ method: "PUT", path, mutating: true });
    const { data } = await ctx.client.request<{ objects?: Row[] }>({
      method: "GET",
      path: `/Voucher/${encodeURIComponent(voucherId)}`,
    });
    const v = data?.objects?.[0] ?? {};
    return {
      voucherId,
      changed: true,
      status: VOUCHER_STATUS[String(v.status)] ?? String(v.status ?? ""),
      paidAmount: round2(num(v.paidAmount)),
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
  linkTransaction,
  resetVoucherToOpen,
  receiptGuidance,
  setTaxRule,
  createInvoice,
  getInvoicePdf,
  markInvoiceSent,
];
