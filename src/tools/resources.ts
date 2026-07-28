import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import { ReadOnlyError } from "../config.js";
import {
  TAX_RULES,
  VOUCHER_STATUS,
  type TaxRule,
  num,
  parseSevdeskDate,
  readTaxTreatment,
  round2,
  voucherSide,
  ymd,
} from "../lib/vat.js";
import {
  bool,
  int,
  obj,
  optBool,
  optNumber,
  optString,
  requireString,
  str,
  type ToolContext,
  type ToolDef,
} from "../lib/tool.js";

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

function assertAllowedPath(ctx: ToolContext, filePath: string): string {
  if (!isAbsolute(filePath)) throw new Error("File path must be absolute.");
  const target = resolve(filePath);
  const allow = ctx.config.allowedReceiptDirs;
  if (allow.length === 0) {
    throw new Error(
      "Refused: filesystem access is disabled by default. Set SEVDESK_RECEIPT_DIRS to a " +
        "colon-separated allowlist of directories to enable the receipt file tools.",
    );
  }
  const ok = allow.some((a) => target === resolve(a) || target.startsWith(resolve(a) + sep));
  if (!ok) {
    throw new Error(`Refused: ${target} is outside SEVDESK_RECEIPT_DIRS (${allow.join(", ")}).`);
  }
  return target;
}

/* ------------------------------------------------------------------ */

const ping: ToolDef = {
  name: "sevdesk_ping",
  title: "Check the sevDesk connection",
  description:
    "Verify that the API token works, report the server mode (read-only / dry-run) and the " +
    "account's bookkeeping system version (1.0 uses taxType, 2.0 uses taxRule). " +
    "Run this first when something behaves unexpectedly.",
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
    },
    required: ["filePath"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (ctx.config.readOnly) throw new ReadOnlyError("sevdesk_upload_voucher_file");
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

    if (ctx.config.dryRun) {
      return { dryRun: true, wouldUpload: { path, bytes: info.size, mime } };
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
    "nothing is booked without you reviewing it in sevDesk. Set taxRule 5 for Reverse Charge " +
    "§13b, 1 for normal domestic VAT, 3 for intra-EU. WRITE operation. " +
    "For anything this wrapper does not cover, use sevdesk_call with operationId " +
    "'voucherFactorySaveVoucher'.",
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
    if (ctx.config.readOnly) throw new ReadOnlyError("sevdesk_create_voucher");

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

    if (args.dryRun === true || ctx.config.dryRun) {
      return { dryRun: true, wouldPost: { path: "/Voucher/Factory/saveVoucher", payload } };
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

    const accounts = (data?.objects ?? [])
      .map((o) => ({
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
      }))
      .filter(
        (a) =>
          (!accountNumber || a.accountNumber === accountNumber) &&
          (!taxRuleId || a.allowedTaxRules.some((r) => r.id === taxRuleId)) &&
          (!query ||
            `${a.accountNumber} ${a.accountName} ${a.description}`.toLowerCase().includes(query)),
      );

    return {
      side,
      totalMatching: accounts.length,
      returned: Math.min(accounts.length, limit),
      accounts: accounts.slice(0, limit),
    };
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
      taxRuleId: str("Target tax rule id.", {
        enum: Object.entries(TAX_RULES)
          .filter(([, r]) => (r as TaxRule).usableInVouchers)
          .map(([id]) => id),
      }),
      dryRun: bool("Preview the request without sending it."),
    },
    required: ["voucherId", "taxRuleId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = requireString(args, "voucherId");
    const target = requireString(args, "taxRuleId");
    const rule = (TAX_RULES as Record<string, TaxRule>)[target];
    if (!rule || !rule.usableInVouchers) {
      const usable = Object.entries(TAX_RULES)
        .filter(([, r]) => (r as TaxRule).usableInVouchers)
        .map(([rid]) => rid)
        .join(", ");
      throw new Error(`taxRule '${target}' cannot be used on vouchers. Usable rules: ${usable}.`);
    }

    const { data } = await ctx.client.request<{ objects?: Row[] }>({
      method: "GET",
      path: `/Voucher/${encodeURIComponent(id)}`,
    });
    const v = data?.objects?.[0];
    if (!v) throw new Error(`No voucher with id ${id}.`);
    if (v.enshrined) {
      throw new Error(
        `Voucher ${id} is enshrined (festgeschrieben) — sevDesk forbids changing it.`,
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
    if ((optBool(args, "dryRun") ?? false) || ctx.config.dryRun) {
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
            taxRate: { type: "number", description: "VAT rate; defaults to 19, or 0 for Kleinunternehmer." },
          },
          required: ["name", "price"],
          additionalProperties: false,
        },
      },
      invoiceDate: str("Invoice date, yyyy-mm-dd (default today)."),
      header: str("Optional invoice header text."),
      taxRuleId: str("Revenue tax rule id (default 1, or 11 for Kleinunternehmer).", {
        enum: ["1", "2", "3", "4", "5", "11", "17"],
      }),
      currency: str("Currency (default EUR)."),
    },
    required: ["contactId", "positions"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const contactId = requireString(args, "contactId");
    const positions = Array.isArray(args.positions) ? (args.positions as Row[]) : [];
    if (positions.length === 0) throw new Error("At least one position is required.");

    const ruleId =
      optString(args, "taxRuleId") ?? (ctx.config.kleinunternehmer ? "11" : "1");
    const defaultRate = ctx.config.kleinunternehmer ? 0 : 19;
    const date = optString(args, "invoiceDate") ?? ymd(new Date());

    const body = {
      invoice: {
        objectName: "Invoice",
        mapAll: true,
        invoiceDate: date,
        // Always a draft: review happens in sevDesk, never silently.
        status: "50",
        invoiceType: "RE",
        currency: optString(args, "currency") ?? "EUR",
        contact: { id: Number(contactId), objectName: "Contact" },
        taxRule: { id: ruleId, objectName: "TaxRule" },
        discount: 0,
        ...(optString(args, "header") ? { header: optString(args, "header") } : {}),
      },
      invoicePosSave: positions.map((p) => ({
        objectName: "InvoicePos",
        mapAll: true,
        name: String(p.name ?? ""),
        quantity: num(p.quantity) || 1,
        price: num(p.price),
        taxRate: p.taxRate === undefined ? defaultRate : num(p.taxRate),
        unity: { id: 1, objectName: "Unity" },
      })),
      invoicePosDelete: null,
    };

    if (ctx.config.dryRun) {
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

    const { data } = await ctx.client.request<{
      objects?: { filename?: unknown; content?: unknown; base64Encoded?: unknown };
    }>({
      method: "GET",
      path: `/Invoice/${encodeURIComponent(id)}/getPdf`,
      query: { preventSendBy: true, download: true },
    });

    const content = data?.objects?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error(`sevDesk returned no PDF content for invoice ${id}.`);
    }
    // The filename comes from the API — keep only its basename so it cannot
    // point outside the allowlisted directory.
    const filename = basename(String(data?.objects?.filename ?? `invoice-${id}.pdf`));
    const target = join(dir, filename);
    const bytes = Buffer.from(content, "base64");
    await writeFile(target, bytes);
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
    },
    required: ["invoiceId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = requireString(args, "invoiceId");
    const sendType = optString(args, "sendType") ?? "VPDF";

    const { data } = await ctx.client.request<{ objects?: Row[] }>({
      method: "GET",
      path: `/Invoice/${encodeURIComponent(id)}`,
    });
    const invoice = data?.objects?.[0];
    if (!invoice) throw new Error(`No invoice with id ${id}.`);
    if (invoice.enshrined) {
      throw new Error(`Invoice ${id} is enshrined (festgeschrieben) — sevDesk forbids changing it.`);
    }

    const body = { sendType, sendDraft: false };
    if (ctx.config.dryRun) {
      return { dryRun: true, wouldSend: { method: "PUT", path: `/Invoice/${id}/sendBy`, body } };
    }

    const { data: updated } = await ctx.client.request<{ objects?: Row }>({
      method: "PUT",
      path: `/Invoice/${encodeURIComponent(id)}/sendBy`,
      body,
      mutating: true,
    });
    return {
      invoiceId: id,
      sendType,
      verified: (updated?.objects as Row | undefined)?.sendType === sendType,
    };
  },
};

export const resourceTools: ToolDef[] = [
  ping,
  listVouchers,
  getVoucher,
  listInvoices,
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
