import { createHash } from "node:crypto";

import { SevdeskApiError } from "../client.js";
import {
  TAX_RULES,
  VOUCHER_STATUS,
  type TaxRuleId,
  num,
  parseSevdeskDate,
  round2,
  ymd,
} from "../lib/vat.js";
import { bool, isDryRun, str, type ToolContext, type ToolDef } from "../lib/tool.js";

/*
 * Narrow write tools for cleaning up a ledger: delete a duplicate draft, mark a
 * private payment, correct a draft, attach a receipt sent inline, book a
 * voucher against its bank transaction. Each one checks the object's state
 * first, refuses enshrined (festgeschrieben) objects, accepts dryRun, and reads
 * the object back afterwards to verify the change — the alternative for these
 * jobs is the unguarded sevdesk_call.
 */

type Row = Record<string, unknown>;

/** CheckAccountTransaction.status, per the spec's Model_CheckAccountTransaction. */
const TX_STATUS: Record<string, string> = {
  "100": "open (not linked)",
  "200": "linked",
  "300": "private",
  "350": "auto-booked",
  "400": "booked",
};
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const CENT = 0.005;

function numericId(args: Row, key: string): string {
  const v = String(args[key] ?? "").trim();
  if (!/^\d+$/.test(v)) throw new Error(`${key} must be a numeric id.`);
  return v;
}

/** yyyy-mm-dd from yyyy-mm-dd or dd.mm.yyyy; throws on anything else. */
function isoDate(value: unknown, key: string): string {
  const d = parseSevdeskDate(value);
  if (!d || !/^(\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})$/.test(String(value).trim())) {
    throw new Error(`${key} must be a date as yyyy-mm-dd or dd.mm.yyyy.`);
  }
  return ymd(d);
}

function date(value: unknown): string | null {
  const d = parseSevdeskDate(value);
  return d ? ymd(d) : null;
}

const sub = (o: unknown): Row | undefined =>
  o && typeof o === "object" ? (o as Row) : undefined;

/** A `{id, objectName}` reference copied from an embedded object, or undefined. */
function ref(o: unknown): Row | undefined {
  const r = sub(o);
  return r?.id ? { id: Number(r.id), objectName: r.objectName } : undefined;
}

/** GET one object; null when sevDesk says it does not exist (400/404). */
async function getOne(ctx: ToolContext, path: string, query?: Record<string, unknown>): Promise<Row | null> {
  try {
    const { data } = await ctx.client.request<{ objects?: Row[] }>({ method: "GET", path, query });
    return data?.objects?.[0] ?? null;
  } catch (err) {
    if (err instanceof SevdeskApiError && (err.status === 400 || err.status === 404)) return null;
    throw err;
  }
}

const getVoucher = (ctx: ToolContext, id: string) =>
  getOne(ctx, `/Voucher/${id}`, { embed: "supplier" });
const getTransaction = (ctx: ToolContext, id: string) =>
  getOne(ctx, `/CheckAccountTransaction/${id}`);

async function getPositions(ctx: ToolContext, voucherId: string): Promise<Row[]> {
  const { data } = await ctx.client.request<{ objects?: Row[] }>({
    method: "GET",
    path: "/VoucherPos",
    query: { "voucher[id]": voucherId, "voucher[objectName]": "Voucher", limit: 200 },
  });
  return data?.objects ?? [];
}

function voucherSummary(v: Row) {
  return {
    voucherId: String(v.id),
    date: date(v.voucherDate),
    supplier: (sub(v.supplier)?.name as string | undefined) ?? (v.supplierName as string | undefined) ?? null,
    documentNumber: (v.description as string | undefined) ?? null,
    net: round2(num(v.sumNet)),
    tax: round2(num(v.sumTax)),
    gross: round2(num(v.sumGross)),
    paidAmount: round2(num(v.paidAmount)),
    currency: (v.currency as string | undefined) ?? null,
    status: `${v.status} ${VOUCHER_STATUS[String(v.status)] ?? ""}`.trim(),
    taxRuleId: sub(v.taxRule)?.id ? String(sub(v.taxRule)!.id) : null,
    hasFile: Boolean(sub(v.document)?.id),
  };
}

function transactionSummary(t: Row) {
  return {
    transactionId: String(t.id),
    date: date(t.valueDate ?? t.entryDate),
    payeePayerName: (t.payeePayerName as string | undefined) ?? null,
    purpose: (t.paymtPurpose as string | undefined) ?? null,
    amount: round2(num(t.amount)),
    checkAccountId: sub(t.checkAccount)?.id ? String(sub(t.checkAccount)!.id) : null,
    status: `${t.status} ${TX_STATUS[String(t.status)] ?? ""}`.trim(),
  };
}

function refuseEnshrined(kind: string, id: string, obj: Row): void {
  if (obj.enshrined) {
    throw new Error(
      `Refused: ${kind} ${id} is enshrined (festgeschrieben) since ${obj.enshrined}; sevDesk forbids changing it.`,
    );
  }
}

/* --------------------------- delete draft ---------------------------- */

const deleteVoucher: ToolDef = {
  name: "sevdesk_delete_voucher",
  title: "Delete a draft voucher",
  description:
    "Delete one voucher (Beleg) that is still a draft (status 50, Entwurf), e.g. a duplicate. " +
    "Refuses open, paid and enshrined vouchers and drafts with payments. Returns what was " +
    "deleted (date, supplier, amounts, document number) and verifies the voucher is gone. Use " +
    "dryRun first to see what would be deleted. Cannot be undone.",
  mutating: true,
  destructive: true,
  inputSchema: {
    type: "object",
    properties: {
      voucherId: str("Numeric voucher id."),
      dryRun: bool("Show what would be deleted without deleting it."),
    },
    required: ["voucherId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = numericId(args, "voucherId");
    const v = await getVoucher(ctx, id);
    if (!v) throw new Error(`No voucher with id ${id}.`);
    refuseEnshrined("Voucher", id, v);
    const voucher = voucherSummary(v);
    if (String(v.status) !== "50") {
      throw new Error(`Refused: voucher ${id} has status ${voucher.status}; only drafts (50) can be deleted.`);
    }
    if (num(v.paidAmount) > 0) {
      throw new Error(`Refused: voucher ${id} has payments (${voucher.paidAmount}).`);
    }
    if (isDryRun(args, ctx)) {
      return { dryRun: true, wouldDelete: voucher, wouldSend: { method: "DELETE", path: `/Voucher/${id}` } };
    }
    // DELETE /Voucher/{id} is missing from the OpenAPI document but works
    // (observed live: the voucher answers 404 afterwards).
    await ctx.client.request({ method: "DELETE", path: `/Voucher/${id}`, mutating: true });
    const after = await getVoucher(ctx, id);
    if (after) {
      throw new Error(`sevDesk accepted the delete, but voucher ${id} still exists (status ${after.status}).`);
    }
    return { deleted: true, verified: true, voucher };
  },
};

/* ------------------------ private transaction ------------------------ */

const setTransactionPrivate: ToolDef = {
  name: "sevdesk_set_transaction_private",
  title: "Mark a bank transaction as private",
  description:
    "Mark one bank transaction (CheckAccountTransaction) as private (status 300, Privat), e.g. " +
    "a private payment from the business account. Only for transactions that are still open " +
    "(status 100: not linked to a voucher/invoice and not booked); refuses enshrined ones. " +
    "Verifies the new status. Undo in the sevDesk web app.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      transactionId: str("Numeric transaction id (from sevdesk_list_transactions)."),
      dryRun: bool("Show the change without sending it."),
    },
    required: ["transactionId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = numericId(args, "transactionId");
    const t = await getTransaction(ctx, id);
    if (!t) throw new Error(`No bank transaction with id ${id}.`);
    refuseEnshrined("Transaction", id, t);
    const transaction = transactionSummary(t);
    if (String(t.status) === "300") return { changed: false, note: "Already private.", transaction };
    if (String(t.status) !== "100") {
      throw new Error(
        `Refused: transaction ${id} has status ${transaction.status}; only open transactions (100) can be marked private.`,
      );
    }
    const body = { status: 300 };
    if (isDryRun(args, ctx)) {
      return { dryRun: true, transaction, wouldSend: { method: "PUT", path: `/CheckAccountTransaction/${id}`, body } };
    }
    await ctx.client.request({ method: "PUT", path: `/CheckAccountTransaction/${id}`, body, mutating: true });
    const after = await getTransaction(ctx, id);
    if (String(after?.status) !== "300") {
      throw new Error(`sevDesk accepted the change, but transaction ${id} now has status ${after?.status}.`);
    }
    return { changed: true, verified: true, transaction: transactionSummary(after!) };
  },
};

/* --------------------------- inline upload --------------------------- */

const FILE_TYPES = [
  { ext: ["pdf"], mimeType: "application/pdf", magic: Buffer.from("%PDF-") },
  { ext: ["png"], mimeType: "image/png", magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { ext: ["jpg", "jpeg"], mimeType: "image/jpeg", magic: Buffer.from([0xff, 0xd8, 0xff]) },
];

const uploadVoucherFileContent: ToolDef = {
  name: "sevdesk_upload_voucher_file_content",
  title: "Upload a receipt file (inline)",
  description:
    "Upload a receipt sent inline as base64 (e.g. an e-mail attachment) to sevDesk's temporary " +
    "voucher storage — for hosted clients that cannot use sevdesk_upload_voucher_file's local " +
    "path. Returns fileName, the token sevdesk_create_voucher attaches to a new voucher. PDF, " +
    "PNG and JPG only (checked by content, not only the name), at most " +
    `${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Accepts standard and URL-safe base64 and data: URLs. ` +
    "Creates no voucher by itself.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      fileName: str("Original file name with extension .pdf, .png, .jpg or .jpeg."),
      base64Content: str("The file content, base64 encoded."),
      dryRun: bool("Check the file without uploading it."),
    },
    required: ["fileName", "base64Content"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const name = (String(args.fileName ?? "").split(/[\\/]/).pop() ?? "")
      .replace(/[^\w.\- ]/g, "_")
      .slice(-120);
    const ext = /\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
    const type = FILE_TYPES.find((t) => t.ext.includes(ext));
    if (!type) throw new Error("fileName must end in .pdf, .png, .jpg or .jpeg.");

    let b64 = String(args.base64Content ?? "")
      .replace(/^data:[^,]*;base64,/, "")
      .replace(/\s+/g, "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1) {
      throw new Error("base64Content is not valid base64.");
    }
    // Refuse before decoding, so an oversized payload is never held twice.
    if (Math.floor((b64.length * 3) / 4) > MAX_UPLOAD_BYTES + 3) {
      throw new Error(`The file is larger than ${MAX_UPLOAD_BYTES} bytes.`);
    }
    b64 = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) {
      throw new Error(`The file must be 1 to ${MAX_UPLOAD_BYTES} bytes; it is ${bytes.length}.`);
    }
    const actual = FILE_TYPES.find((t) => bytes.subarray(0, t.magic.length).equals(t.magic));
    if (!actual) throw new Error("The content is not a PDF, PNG or JPG file.");
    if (actual !== type) throw new Error(`The content is ${actual.mimeType}, but the name ends in .${ext}.`);

    const file = {
      name,
      mimeType: type.mimeType,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    if (isDryRun(args, ctx)) {
      return { dryRun: true, file, wouldSend: { method: "POST", path: "/Voucher/Factory/uploadTempFile" } };
    }

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: type.mimeType }), name);
    const { data } = await ctx.client.request<{ objects?: Row }>({
      method: "POST",
      path: "/Voucher/Factory/uploadTempFile",
      form,
      mutating: true,
    });
    // Return the token only: sevDesk also echoes a base64 preview in
    // objects.content that would flood the caller's context.
    const token = data?.objects?.filename;
    if (!token) throw new Error(`sevDesk returned no filename: ${JSON.stringify(data).slice(0, 300)}`);
    return {
      fileName: String(token),
      file,
      pages: data?.objects?.pages ?? null,
      next: "Pass fileName to sevdesk_create_voucher (field fileName) to attach the file to a new voucher.",
    };
  },
};

/* ------------------------ correct a draft voucher ------------------------ */

const positionSchema = {
  type: "object",
  properties: {
    sumNet: { type: "number", description: "Net amount. Give sumNet or sumGross, the same for all positions." },
    sumGross: { type: "number", description: "Gross amount. Give sumNet or sumGross, the same for all positions." },
    taxRate: { type: "number", description: "VAT rate in percent, e.g. 19, 7 or 0." },
    comment: { type: "string", description: "Text of the position (default: keep the old one)." },
    accountDatevId: {
      type: "string",
      description: "Booking account (AccountDatev) id; default: keep the old one (see sevdesk_receipt_guidance).",
    },
  },
  required: ["taxRate"],
  additionalProperties: false,
};

interface PositionIn {
  sumNet?: unknown;
  sumGross?: unknown;
  taxRate?: unknown;
  comment?: unknown;
  accountDatevId?: unknown;
}

const updateDraftVoucher: ToolDef = {
  name: "sevdesk_update_draft_voucher",
  title: "Correct a draft voucher",
  description:
    "Correct a draft voucher (status 50, Entwurf): date, document number, supplier name, tax rule " +
    "and the positions (amounts, tax rate, booking account). positions replaces all positions: " +
    "give the full new list; existing positions are reused in order (they keep their booking " +
    "account unless accountDatevId is given), extra old ones are deleted. Example: gross 214.20 " +
    "booked at 0 % -> positions [{sumNet: 180, taxRate: 19}] gives 180.00 + 34.20 VAT = 214.20. " +
    "finalize=true also sets the voucher to open (100), needed before sevdesk_book_voucher; " +
    "every position then needs a booking account. Refuses open, paid and enshrined vouchers; " +
    "keeps the attached file; verifies sums and status afterwards.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      voucherId: str("Numeric voucher id."),
      voucherDate: str("New voucher date, yyyy-mm-dd or dd.mm.yyyy."),
      description: str("New document number (Belegnummer)."),
      supplierName: str("New supplier name."),
      taxRuleId: str("New tax rule id, e.g. 9 (Vorsteuerabziehbare Aufwendungen)."),
      positions: { type: "array", description: "The complete new list of positions.", items: positionSchema },
      finalize: bool("Also set the voucher from draft (50) to open (100)."),
      dryRun: bool("Show the request without sending it."),
    },
    required: ["voucherId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = numericId(args, "voucherId");
    const v = await getVoucher(ctx, id);
    if (!v) throw new Error(`No voucher with id ${id}.`);
    refuseEnshrined("Voucher", id, v);
    if (String(v.status) !== "50") {
      throw new Error(`Refused: voucher ${id} has status ${v.status}; only drafts (50) can be changed.`);
    }
    const before = voucherSummary(v);
    const oldPositions = await getPositions(ctx, id);
    const finalize = args.finalize === true;

    const taxRuleId = args.taxRuleId ? String(args.taxRuleId).trim() : String(sub(v.taxRule)?.id ?? "");
    const rule = taxRuleId in TAX_RULES ? TAX_RULES[taxRuleId as TaxRuleId] : undefined;
    if (args.taxRuleId && (!rule || !rule.usableInVouchers)) {
      throw new Error(`taxRule ${taxRuleId} cannot be used on vouchers.`);
    }

    const supplier = sub(v.supplier);
    const voucher: Row = {
      id: Number(id),
      objectName: "Voucher",
      mapAll: true,
      voucherDate: args.voucherDate ? isoDate(args.voucherDate, "voucherDate") : date(v.voucherDate),
      ...(supplier?.id ? { supplier: { id: Number(supplier.id), objectName: "Contact" } } : {}),
      supplierName: args.supplierName ? String(args.supplierName).trim() : v.supplierName,
      description: args.description ? String(args.description).trim() : v.description,
      status: finalize ? 100 : 50,
      taxRule: { id: taxRuleId, objectName: "TaxRule" },
      creditDebit: v.creditDebit,
      voucherType: v.voucherType,
      currency: v.currency,
      ...(v.deliveryDate ? { deliveryDate: date(v.deliveryDate) } : {}),
    };

    let voucherPosSave: Row[];
    let voucherPosDelete: Row[] | null = null;
    let expected: { net: number; gross: number };
    if (args.positions !== undefined) {
      const list = (Array.isArray(args.positions) ? args.positions : []) as PositionIn[];
      if (!list.length) throw new Error("positions must contain at least one position.");
      const net = typeof list[0]!.sumNet === "number";
      let sumNet = 0;
      let sumGross = 0;
      voucherPosSave = list.map((p, i) => {
        const n = `Position ${i + 1}`;
        if (typeof p.taxRate !== "number" || p.taxRate < 0) throw new Error(`${n}: taxRate must be a number.`);
        const allowed: readonly number[] | null | undefined = rule?.allowedRates;
        if (allowed && !allowed.includes(p.taxRate)) {
          throw new Error(`${n}: tax rule ${taxRuleId} allows only ${allowed.join(", ")} %.`);
        }
        const amount = net ? p.sumNet : p.sumGross;
        if (typeof amount !== "number" || (net ? p.sumGross !== undefined : p.sumNet !== undefined)) {
          throw new Error(`${n}: give ${net ? "sumNet" : "sumGross"} (all positions must use the same one).`);
        }
        sumNet += net ? amount : amount / (1 + p.taxRate / 100);
        sumGross += net ? amount * (1 + p.taxRate / 100) : amount;
        const old = oldPositions[i];
        const accountDatev = p.accountDatevId
          ? { id: Number(p.accountDatevId), objectName: "AccountDatev" }
          : ref(old?.accountDatev);
        return {
          ...(old ? { id: Number(old.id) } : {}),
          objectName: "VoucherPos",
          mapAll: true,
          ...(accountDatev ? { accountDatev } : {}),
          ...(!accountDatev && old?.accountingType ? { accountingType: ref(old.accountingType) } : {}),
          taxRate: p.taxRate,
          net,
          ...(net ? { sumNet: amount } : { sumGross: amount }),
          comment: p.comment ?? old?.comment ?? null,
        };
      });
      const extra = oldPositions.slice(list.length).map((p) => ({ id: Number(p.id), objectName: "VoucherPos" }));
      voucherPosDelete = extra.length ? extra : null;
      expected = { net: round2(sumNet), gross: round2(sumGross) };
    } else {
      if (!args.voucherDate && !args.description && !args.supplierName && !args.taxRuleId && !finalize) {
        throw new Error(
          "Nothing to change: give at least one of voucherDate, description, supplierName, taxRuleId, positions, finalize.",
        );
      }
      // saveVoucher replaces the positions, so send the old ones unchanged.
      voucherPosSave = oldPositions.map((p) => ({
        id: Number(p.id),
        objectName: "VoucherPos",
        mapAll: true,
        ...(p.accountDatev ? { accountDatev: ref(p.accountDatev) } : {}),
        ...(!p.accountDatev && p.accountingType ? { accountingType: ref(p.accountingType) } : {}),
        taxRate: num(p.taxRate),
        net: true,
        sumNet: num(p.sumNet),
        comment: p.comment ?? null,
      }));
      expected = { net: before.net, gross: before.gross };
    }

    if (finalize) {
      // Observed live (bookkeeping 2.0): saveVoucher answers 422 "Valid
      // accountDatev must be given" for an open voucher whose positions lack one.
      const missing = voucherPosSave.findIndex((p) => !p.accountDatev && !p.accountingType);
      if (missing >= 0) {
        throw new Error(
          `Refused: position ${missing + 1} has no booking account; an open voucher needs one. ` +
            "Give positions with accountDatevId (see sevdesk_receipt_guidance).",
        );
      }
    }

    const body = { voucher, voucherPosSave, voucherPosDelete };
    if (isDryRun(args, ctx)) {
      return { dryRun: true, before, expected, wouldSend: { method: "POST", path: "/Voucher/Factory/saveVoucher", body } };
    }
    await ctx.client.request({ method: "POST", path: "/Voucher/Factory/saveVoucher", body, mutating: true });

    const afterRow = await getVoucher(ctx, id);
    if (!afterRow) throw new Error(`Voucher ${id} is gone after the update.`);
    const after = voucherSummary(afterRow);
    const positions = (await getPositions(ctx, id)).map((p) => ({
      id: String(p.id),
      net: round2(num(p.sumNet)),
      taxRate: num(p.taxRate),
      tax: round2(num(p.sumTax)),
      gross: round2(num(p.sumGross)),
      comment: p.comment ?? null,
    }));
    const checks = {
      sums: Math.abs(after.net - expected.net) <= 0.01 && Math.abs(after.gross - expected.gross) <= 0.01,
      status: String(afterRow.status) === (finalize ? "100" : "50"),
      fileKept: before.hasFile ? after.hasFile : true,
      positionCount: positions.length === voucherPosSave.length,
    };
    return { changed: true, verified: Object.values(checks).every(Boolean), checks, before, after, positions };
  },
};

/* ---------------------------- book voucher ---------------------------- */

const BOOK_TYPES = ["FULL_PAYMENT", "N", "CB", "O", "OF", "MTC"];

const bookVoucher: ToolDef = {
  name: "sevdesk_book_voucher",
  title: "Mark a voucher paid by a bank transaction",
  description:
    "Link an open voucher (status 100) to one bank transaction and book the payment " +
    "(Voucher/{id}/bookAmount), so the voucher counts as paid. Checks: voucher not enshrined and " +
    "in EUR; transaction open (status 100, not linked/booked/private) and not enshrined; the " +
    "direction fits (expense voucher <-> outgoing money); amount <= open amount and <= " +
    "transaction amount. Without amount, the transaction amount must equal the open amount. " +
    "type defaults to FULL_PAYMENT when the amount equals the open amount, else N (partial). " +
    "Use CB for skonto, O/MTC for other reduced amounts. date defaults to the transaction date. " +
    "Drafts must be finalized first (sevdesk_update_draft_voucher with finalize=true). " +
    "Warns when the bank text does not mention the supplier. Verifies the paid amount and the " +
    "transaction status afterwards.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      voucherId: str("Numeric voucher id."),
      transactionId: str("Numeric bank transaction id (from sevdesk_list_transactions)."),
      amount: { type: "number", description: "Amount to book, positive, in EUR (default: the open amount)." },
      date: str("Payment date, yyyy-mm-dd or dd.mm.yyyy (default: transaction date)."),
      type: str("Booking type (default FULL_PAYMENT or N, see description).", { enum: BOOK_TYPES }),
      dryRun: bool("Show the checks and the request without sending it."),
    },
    required: ["voucherId", "transactionId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const voucherId = numericId(args, "voucherId");
    const transactionId = numericId(args, "transactionId");
    const v = await getVoucher(ctx, voucherId);
    if (!v) throw new Error(`No voucher with id ${voucherId}.`);
    refuseEnshrined("Voucher", voucherId, v);
    const voucher = voucherSummary(v);
    const status = String(v.status);
    if (status === "50") {
      throw new Error(
        `Refused: voucher ${voucherId} is a draft. Finalize it first (sevdesk_update_draft_voucher with finalize=true).`,
      );
    }
    if (status !== "100") {
      throw new Error(`Refused: voucher ${voucherId} has status ${voucher.status}; only open vouchers (100) can be booked.`);
    }
    if (v.currency && v.currency !== "EUR") {
      throw new Error(`Refused: voucher ${voucherId} is in ${v.currency}; only EUR vouchers.`);
    }
    const paidBefore = num(v.paidAmount);
    const open = round2(num(v.sumGross) - paidBefore);
    if (open <= 0) {
      throw new Error(
        `Refused: voucher ${voucherId} has no open amount (gross ${voucher.gross}, paid ${voucher.paidAmount}).`,
      );
    }

    const t = await getTransaction(ctx, transactionId);
    if (!t) throw new Error(`No bank transaction with id ${transactionId}.`);
    refuseEnshrined("Transaction", transactionId, t);
    const transaction = transactionSummary(t);
    if (String(t.status) !== "100") {
      throw new Error(
        `Refused: transaction ${transactionId} has status ${transaction.status}; only open transactions (100) can be used.`,
      );
    }
    const txAmount = num(t.amount);
    const expense = v.creditDebit === "C";
    if (expense ? txAmount >= 0 : txAmount <= 0) {
      throw new Error(
        `Refused: voucher ${voucherId} is ${expense ? "an expense (money out)" : "revenue (money in)"}, ` +
          `but transaction ${transactionId} is ${txAmount >= 0 ? "incoming" : "outgoing"} (${transaction.amount}).`,
      );
    }
    const available = round2(Math.abs(txAmount));
    let amount: number;
    if (args.amount !== undefined) {
      amount = round2(num(args.amount));
      if (!(amount > 0)) throw new Error("amount must be a positive number.");
      if (amount > open + CENT) throw new Error(`Refused: amount ${amount} is more than the open amount ${open}.`);
      if (amount > available + CENT) {
        throw new Error(`Refused: amount ${amount} is more than the transaction amount ${available}.`);
      }
    } else {
      if (Math.abs(available - open) > CENT) {
        throw new Error(
          `Refused: the transaction amount (${available}) differs from the open amount (${open}). ` +
            "Give amount (and type, e.g. N for partial, CB for skonto) explicitly.",
        );
      }
      amount = open;
    }
    const full = Math.abs(amount - open) <= CENT;
    const type = args.type ? String(args.type) : full ? "FULL_PAYMENT" : "N";
    if (!BOOK_TYPES.includes(type)) throw new Error(`type must be one of ${BOOK_TYPES.join(", ")}.`);
    if (type === "FULL_PAYMENT" && !full) {
      throw new Error(`type FULL_PAYMENT needs the full open amount ${open}; use N, CB, O or MTC.`);
    }
    const payDate = args.date ? isoDate(args.date, "date") : date(t.valueDate ?? t.entryDate);
    const checkAccount = sub(t.checkAccount);
    if (!checkAccount?.id) throw new Error(`Transaction ${transactionId} has no bank account.`);
    // The spec's bookAmount examples send a positive amount for both sides.
    const body = {
      amount,
      date: payDate,
      type,
      checkAccount: { id: Number(checkAccount.id), objectName: "CheckAccount" },
      checkAccountTransaction: { id: Number(transactionId), objectName: "CheckAccountTransaction" },
      createFeed: true,
    };

    // Not a refusal (bank texts vary a lot), but worth a second look.
    const warnings: string[] = [];
    const word = String(voucher.supplier ?? "").toLowerCase().match(/[a-zäöüß0-9]{3,}/)?.[0];
    const bankText = `${t.payeePayerName ?? ""} ${t.paymtPurpose ?? ""}`.toLowerCase();
    if (word && !bankText.includes(word)) {
      warnings.push(
        `The transaction text does not mention "${word}" (supplier ${voucher.supplier}). Check that it is the right payment.`,
      );
    }

    if (isDryRun(args, ctx)) {
      return {
        dryRun: true,
        warnings,
        voucher,
        openAmount: open,
        transaction,
        wouldSend: { method: "PUT", path: `/Voucher/${voucherId}/bookAmount`, body },
      };
    }
    await ctx.client.request({ method: "PUT", path: `/Voucher/${voucherId}/bookAmount`, body, mutating: true });

    const v2 = await getVoucher(ctx, voucherId);
    const t2 = await getTransaction(ctx, transactionId);
    const after = { voucher: v2 ? voucherSummary(v2) : null, transaction: t2 ? transactionSummary(t2) : null };
    const paidNow = round2(num(v2?.paidAmount) - paidBefore);
    const checks = {
      paidAmountIncreased: Math.abs(paidNow - amount) <= 0.01 || (type !== "N" && String(v2?.status) === "1000"),
      voucherPaidIfFull: type === "N" ? true : String(v2?.status) === "1000",
      transactionLinked: t2 !== null && String(t2.status) !== "100",
    };
    return {
      booked: true,
      verified: Object.values(checks).every(Boolean),
      checks,
      warnings,
      amount,
      type,
      date: payDate,
      before: { voucher, transaction },
      after,
    };
  },
};

export const cleanupTools: ToolDef[] = [
  deleteVoucher,
  setTransactionPrivate,
  uploadVoucherFileContent,
  updateDraftVoucher,
  bookVoucher,
];
