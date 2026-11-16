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
import {
  bool,
  getAllCapped,
  isDryRun,
  optId,
  optRuleId,
  optString,
  positionObjects,
  requireId,
  str,
  strictBool,
  type ToolContext,
  type ToolDef,
} from "../lib/tool.js";
import {
  TRANSACTION_STATUS,
  assertRuleFitsVoucher,
  fetchTransaction,
  fetchUnenshrined,
  type Row,
} from "./resources.js";

/*
 * Narrow write tools for cleaning up a ledger: delete a duplicate draft, mark a
 * private payment, correct a draft, attach a receipt sent inline. Each one
 * checks the object's state first, refuses enshrined (festgeschrieben) objects,
 * accepts dryRun, and reads the object back afterwards to verify the change —
 * the alternative for these jobs is the generic sevdesk_call. Booking a
 * voucher against a bank transaction is sevdesk_link_transaction.
 */

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Positions read back for a rewrite; more than this is refused rather than half-rewritten. */
const MAX_POSITIONS = 500;

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

/** Null when the voucher does not exist (the delete's read-back relies on it). */
const getVoucher = (ctx: ToolContext, id: string) =>
  getOne(ctx, `/Voucher/${id}`, { embed: "supplier" });

async function getPositions(ctx: ToolContext, voucherId: string): Promise<Row[]> {
  const { rows, truncated } = await getAllCapped(
    ctx,
    "/VoucherPos",
    { "voucher[id]": voucherId, "voucher[objectName]": "Voucher" },
    MAX_POSITIONS,
  );
  if (truncated) {
    throw new Error(`Voucher ${voucherId} has more than ${MAX_POSITIONS} positions; change it in the sevDesk UI.`);
  }
  return rows;
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
    status: `${t.status} ${TRANSACTION_STATUS[String(t.status)] ?? ""}`.trim(),
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
    "dryRun first to see what would be deleted. Cannot be undone. Needs SEVDESK_ALLOW_BOOKING=true.",
  mutating: true,
  destructive: true,
  booking: true,
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
    const id = requireId(args, "voucherId");
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
    "Verifies the new status. Undo in the sevDesk web app. Needs SEVDESK_ALLOW_BOOKING=true, " +
    "because sevDesk books the transaction as a private withdrawal or deposit.",
  mutating: true,
  booking: true,
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
    const id = requireId(args, "transactionId");
    const t = await fetchTransaction(ctx, id);
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
    const after = await fetchTransaction(ctx, id);
    if (String(after.status) !== "300") {
      throw new Error(`sevDesk accepted the change, but transaction ${id} now has status ${after.status}.`);
    }
    return { changed: true, verified: true, transaction: transactionSummary(after) };
  },
};

/* --------------------------- inline upload --------------------------- */

const startsWith = (magic: Buffer) => (bytes: Buffer) => bytes.subarray(0, magic.length).equals(magic);

/**
 * UTF-8 text that starts with `<`, ends with `>` and has an element in it —
 * enough to tell an XRechnung / ZUGFeRD XML from a renamed binary. sevDesk
 * parses the document itself; this is no schema validation.
 */
function looksLikeXml(bytes: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  text = text.replace(/^\uFEFF/, "").trim();
  return text.startsWith("<") && text.endsWith(">") && !text.includes("\0") && /<[A-Za-z_][^<>]*>/.test(text);
}

const FILE_TYPES = [
  { ext: ["pdf"], mimeType: "application/pdf", detect: startsWith(Buffer.from("%PDF-")) },
  {
    ext: ["png"],
    mimeType: "image/png",
    detect: startsWith(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { ext: ["jpg", "jpeg"], mimeType: "image/jpeg", detect: startsWith(Buffer.from([0xff, 0xd8, 0xff])) },
  { ext: ["xml"], mimeType: "application/xml", detect: looksLikeXml },
];

const uploadVoucherFileContent: ToolDef = {
  name: "sevdesk_upload_voucher_file_content",
  title: "Upload a receipt file (inline)",
  description:
    "Upload a receipt sent inline as base64 (e.g. an e-mail attachment) to sevDesk's temporary " +
    "voucher storage — for hosted clients that cannot use sevdesk_upload_voucher_file's local " +
    "path. Returns fileName, the token sevdesk_create_voucher attaches to a new voucher. PDF, " +
    "PNG, JPG and XML (XRechnung / ZUGFeRD e-invoice) only, checked by content and not only " +
    "the name, at most " +
    `${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Accepts standard and URL-safe base64 and data: URLs. ` +
    "Creates no voucher by itself.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      fileName: str("Original file name with extension .pdf, .png, .jpg, .jpeg or .xml."),
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
    if (!type) throw new Error("fileName must end in .pdf, .png, .jpg, .jpeg or .xml.");

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
    const actual = FILE_TYPES.find((t) => t.detect(bytes));
    if (!actual) throw new Error("The content is not a PDF, PNG, JPG or XML file.");
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

/**
 * VoucherPos `net` as sevDesk returns it: the strings "0" / "1" (live), or a
 * real boolean. Anything else is refused rather than guessed, because reading
 * a gross-entered position as net shifts it by a cent.
 */
function entryIsNet(p: Row): boolean {
  const v = typeof p.net === "string" ? p.net.trim().toLowerCase() : p.net;
  if (v === true || v === 1 || v === "1" || v === "true") return true;
  if (v === false || v === 0 || v === "0" || v === "false") return false;
  throw new Error(
    `Refused: position ${String(p.id)} reports net=${JSON.stringify(p.net)}, so it is unclear whether it was ` +
      "entered as net or gross. Correct the voucher in the sevDesk UI.",
  );
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
    "Positions you do not replace are sent back as they were entered, net or gross. A new " +
    "taxRuleId is checked against the voucher's side (expense or revenue) and its position rates. " +
    "finalize=true also sets the voucher to open (100), needed before sevdesk_link_transaction; " +
    "every position then needs a booking account. finalize is refused unless the server runs " +
    "with SEVDESK_ALLOW_BOOKING=true; without it the draft can still be corrected. Refuses open, " +
    "paid and enshrined vouchers; keeps the attached file; verifies sums and status afterwards.",
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
      finalize: bool(
        "Also set the voucher from draft (50) to open (100). Refused unless the server runs with SEVDESK_ALLOW_BOOKING=true.",
      ),
      dryRun: bool("Show the request without sending it."),
    },
    required: ["voucherId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = requireId(args, "voucherId");
    const finalize = strictBool(args, "finalize") === true;
    // Open vouchers can be booked, so the step out of draft is gated like the booking tools.
    if (finalize && ctx.config.allowBooking !== true) {
      throw new Error(
        "Refused: finalize=true sets the voucher open (100), which makes it bookable. That is off " +
          "unless the server runs with SEVDESK_ALLOW_BOOKING=true. Leave finalize out to correct the draft, " +
          "or set the voucher open in the sevDesk UI.",
      );
    }
    const v = await getVoucher(ctx, id);
    if (!v) throw new Error(`No voucher with id ${id}.`);
    refuseEnshrined("Voucher", id, v);
    if (String(v.status) !== "50") {
      throw new Error(`Refused: voucher ${id} has status ${v.status}; only drafts (50) can be changed.`);
    }
    const before = voucherSummary(v);
    const oldPositions = await getPositions(ctx, id);

    const newRuleId = optRuleId(args);
    const taxRuleId = newRuleId ?? String(sub(v.taxRule)?.id ?? "");
    const positionsGiven = args.positions !== undefined;
    if (positionsGiven && !Array.isArray(args.positions)) throw new Error("positions must be an array.");
    const list = positionsGiven ? positionObjects(args) : [];
    if (positionsGiven && !list.length) throw new Error("positions must contain at least one position.");
    list.forEach((p, i) => {
      if (typeof p.taxRate !== "number" || !(p.taxRate >= 0)) {
        throw new Error(`Position ${i + 1}: taxRate must be a number.`);
      }
    });

    // The rule must fit the voucher's side and the rates that end up on it:
    // the new positions' rates, else the existing ones. An unchanged rule is
    // only re-checked when positions are replaced.
    const rule = taxRuleId in TAX_RULES ? TAX_RULES[taxRuleId as TaxRuleId] : undefined;
    if (newRuleId || (positionsGiven && rule?.usableInVouchers)) {
      const rates = positionsGiven ? list.map((p) => p.taxRate as number) : oldPositions.map((p) => num(p.taxRate));
      assertRuleFitsVoucher(taxRuleId, v, id, rates);
    }

    const supplier = sub(v.supplier);
    const supplierName = optString(args, "supplierName");
    const description = optString(args, "description");
    const voucher: Row = {
      id: Number(id),
      objectName: "Voucher",
      mapAll: true,
      voucherDate: args.voucherDate ? isoDate(args.voucherDate, "voucherDate") : date(v.voucherDate),
      ...(supplier?.id ? { supplier: { id: Number(supplier.id), objectName: "Contact" } } : {}),
      supplierName: supplierName ?? v.supplierName,
      description: description ?? v.description,
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
    if (positionsGiven) {
      const net = typeof list[0]!.sumNet === "number";
      // Rounded per position, then summed, like sevDesk's own totals.
      let sumNet = 0;
      let sumGross = 0;
      voucherPosSave = list.map((p, i) => {
        const n = `Position ${i + 1}`;
        const taxRate = p.taxRate as number;
        const amount = net ? p.sumNet : p.sumGross;
        if (typeof amount !== "number" || (net ? p.sumGross !== undefined : p.sumNet !== undefined)) {
          throw new Error(`${n}: give ${net ? "sumNet" : "sumGross"} (all positions must use the same one).`);
        }
        if (net) {
          sumNet += round2(amount);
          sumGross += round2(round2(amount) + round2((amount * taxRate) / 100));
        } else {
          const gross = round2(amount);
          sumGross += gross;
          sumNet += round2(gross / (1 + taxRate / 100));
        }
        const old = oldPositions[i];
        const newAccount = optId(p, "accountDatevId");
        const accountDatev = newAccount
          ? { id: Number(newAccount), objectName: "AccountDatev" }
          : ref(old?.accountDatev);
        return {
          ...(old ? { id: Number(old.id) } : {}),
          objectName: "VoucherPos",
          mapAll: true,
          ...(accountDatev ? { accountDatev } : {}),
          ...(!accountDatev && old?.accountingType ? { accountingType: ref(old.accountingType) } : {}),
          taxRate,
          net,
          ...(net ? { sumNet: amount } : { sumGross: amount }),
          comment: typeof p.comment === "string" ? p.comment : (old?.comment ?? null),
        };
      });
      const extra = oldPositions.slice(list.length).map((p) => ({ id: Number(p.id), objectName: "VoucherPos" }));
      voucherPosDelete = extra.length ? extra : null;
      expected = { net: round2(sumNet), gross: round2(sumGross) };
    } else {
      if (!args.voucherDate && !description && !supplierName && !newRuleId && !finalize) {
        throw new Error(
          "Nothing to change: give at least one of voucherDate, description, supplierName, taxRuleId, positions, finalize.",
        );
      }
      // saveVoucher replaces the positions, so send the old ones back in the
      // form they were entered (VoucherPos `net`): a gross-entered position
      // re-sent as net could shift by a cent.
      voucherPosSave = oldPositions.map((p) => {
        const isNet = entryIsNet(p);
        return {
          id: Number(p.id),
          objectName: "VoucherPos",
          mapAll: true,
          ...(p.accountDatev ? { accountDatev: ref(p.accountDatev) } : {}),
          ...(!p.accountDatev && p.accountingType ? { accountingType: ref(p.accountingType) } : {}),
          taxRate: num(p.taxRate),
          net: isNet,
          ...(isNet ? { sumNet: num(p.sumNet) } : { sumGross: num(p.sumGross) }),
          comment: p.comment ?? null,
        };
      });
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

export const cleanupTools: ToolDef[] = [
  deleteVoucher,
  setTransactionPrivate,
  uploadVoucherFileContent,
  updateDraftVoucher,
];
