import { catalog } from "./generated/catalog.js";
import type { Operation } from "./lib/catalog-types.js";

export { catalog };
export type { Operation };

const byId = new Map(catalog.operations.map((op) => [op.operationId.toLowerCase(), op]));

export function findOperation(operationId: string): Operation | undefined {
  return byId.get(operationId.trim().toLowerCase());
}

export interface SearchOptions {
  query?: string;
  tag?: string;
  /** "read" = GET only, "write" = everything else, "all" = no filter. */
  kind?: "read" | "write" | "all";
  limit?: number;
}

export function searchOperations(opts: SearchOptions = {}): Operation[] {
  const { query, tag, kind = "all", limit = 60 } = opts;
  const needles = (query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const scored: Array<{ op: Operation; score: number }> = [];

  for (const op of catalog.operations) {
    if (tag && !op.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    if (kind === "read" && op.mutating) continue;
    if (kind === "write" && !op.mutating) continue;

    if (needles.length === 0) {
      scored.push({ op, score: 0 });
      continue;
    }

    const haystack =
      `${op.operationId} ${op.path} ${op.tags.join(" ")} ${op.summary} ${op.description}`.toLowerCase();

    let score = 0;
    let matchedAll = true;
    for (const n of needles) {
      if (op.operationId.toLowerCase().includes(n)) score += 5;
      else if (op.tags.some((t) => t.toLowerCase().includes(n))) score += 4;
      else if (op.path.toLowerCase().includes(n)) score += 3;
      else if (haystack.includes(n)) score += 1;
      else matchedAll = false;
    }
    if (matchedAll) scored.push({ op, score });
  }

  scored.sort((a, b) => b.score - a.score || a.op.operationId.localeCompare(b.op.operationId));
  return scored.slice(0, limit).map((s) => s.op);
}

/** Compact one-line form used in list output. */
export function briefOperation(op: Operation): string {
  const flag = op.mutating ? "WRITE" : "read ";
  return `[${flag}] ${op.operationId} — ${op.method} ${op.path}${op.summary ? ` · ${op.summary}` : ""}`;
}

/**
 * Operations that book or remove payments. sevdesk_call refuses them unless
 * SEVDESK_ALLOW_BOOKING=true, the same opt-in as the curated booking tools.
 */
export const BOOKING_OPERATIONS: ReadonlySet<string> = new Set([
  "bookVoucher",
  "bookInvoice",
  "bookCreditNote",
  "voucherResetToOpen",
  "invoiceResetToOpen",
  "creditNoteResetToOpen",
  // Resetting to draft unlinks the payments booked on the document.
  "voucherResetToDraft",
  "invoiceResetToDraft",
  "creditNoteResetToDraft",
  // A rule marks future transactions private, i.e. books them automatically.
  "createPrivateTransactionRule",
]);

const present = (v: unknown) => v !== undefined && v !== null && v !== "";
/** paidAmount 0 records no payment. */
const pays = (v: unknown) => present(v) && Number(v) !== 0;
const isDraft = (v: unknown) => !present(v) || String(v).trim() === "50";
const asObject = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Generic writes that also book, depending on what the body sets. */
export const BODY_DEPENDENT_BOOKING_OPERATIONS: ReadonlySet<string> = new Set([
  "createTransaction",
  "updateCheckAccountTransaction",
  "updateVoucher",
  "voucherFactorySaveVoucher",
]);

/**
 * Why a call needs SEVDESK_ALLOW_BOOKING, or null when it does not. One rule
 * for sevdesk_call and sevdesk_describe_operation: the operations in
 * BOOKING_OPERATIONS always; the three generic writes only when the body
 * sets a transaction status (private), moves a voucher out of draft, or
 * carries paidAmount / payDate (marks it paid).
 */
/** Fields that record a payment or link a transfer, on any document. */
const PAYMENT_FIELDS = new Set(["paidamount", "paydate", "sourcetransaction", "targettransaction"]);

/** The first payment field anywhere in a write body or query, or null. */
function paymentField(v: unknown, depth = 0): string | null {
  if (depth > 8 || typeof v !== "object" || v === null) return null;
  for (const [k, val] of Object.entries(v)) {
    const key = k.toLowerCase();
    if (PAYMENT_FIELDS.has(key) && (key === "paidamount" ? pays(val) : present(val))) return k;
    const deeper = paymentField(val, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

const DOCUMENT_PATH = /^\/(Invoice|CreditNote|Voucher)(\/|$)/;

/**
 * What in a write body (or query) records a payment: a payment field
 * anywhere, or status 750 (teilbezahlt) / 1000 (bezahlt) on the invoice,
 * credit note or voucher itself. Only the document's own status counts; a
 * contact's status 1000 means "active", not paid.
 */
export function bookingField(op: { path?: string }, v: unknown): string | null {
  const field = paymentField(v);
  if (field) return field;
  if (!op.path || !DOCUMENT_PATH.test(op.path)) return null;
  const b = asObject(v);
  for (const [name, s] of [
    ["status", b.status],
    ["invoice.status", asObject(b.invoice).status],
    ["creditNote.status", asObject(b.creditNote).status],
    ["voucher.status", asObject(b.voucher).status],
  ] as const) {
    if (present(s) && Number(s) >= 750) return `${name} ${String(s)}`;
  }
  return null;
}

export function bookingReason(op: { operationId: string; path?: string }, body?: unknown): string | null {
  if (BOOKING_OPERATIONS.has(op.operationId)) {
    return "books or removes payments, or books transactions automatically";
  }
  const field = bookingField(op, body);
  if (field) return `sets ${field}, which records a payment or marks a document paid`;
  const b = asObject(body);
  switch (op.operationId) {
    case "createTransaction":
      return present(b.status) && String(b.status).trim() !== "100"
        ? "creates a transaction that is already linked, private or booked (status other than 100)"
        : null;
    case "updateCheckAccountTransaction":
      return present(b.status) ? "sets a transaction status (for example private), which books it" : null;
    case "updateVoucher":
      return !isDraft(b.status) || pays(b.paidAmount) || present(b.payDate)
        ? "sets a voucher open or paid (status, paidAmount or payDate in the body)"
        : null;
    case "voucherFactorySaveVoucher": {
      const v = asObject(b.voucher);
      return !isDraft(v.status) || pays(v.paidAmount) || present(v.payDate)
        ? "saves a voucher as open or paid (voucher.status, paidAmount or payDate in the body)"
        : null;
    }
    default:
      return null;
  }
}

export function describeOperation(op: Operation): string {
  const lines: string[] = [
    `${op.operationId}`,
    `${op.method} ${op.path}`,
    `tags: ${op.tags.join(", ") || "—"}`,
    `mutating: ${op.mutating ? "yes — changes data in sevDesk" : "no"}`,
  ];
  if (BOOKING_OPERATIONS.has(op.operationId)) {
    lines.push("booking: yes — books or removes payments, or books transactions automatically; needs SEVDESK_ALLOW_BOOKING=true");
  }
  if (BODY_DEPENDENT_BOOKING_OPERATIONS.has(op.operationId)) {
    lines.push(
      "booking: only when the body " +
        (op.operationId === "updateCheckAccountTransaction"
          ? "sets status (for example private)"
          : op.operationId === "createTransaction"
          ? "sets status other than 100"
          : "sets status other than 50, paidAmount or payDate" +
            (op.operationId === "voucherFactorySaveVoucher" ? " on voucher" : "")) +
        "; those calls need SEVDESK_ALLOW_BOOKING=true",
    );
  }
  if (op.summary) lines.push(`summary: ${op.summary}`);
  if (op.description) lines.push(`description: ${op.description}`);

  if (op.params.length) {
    lines.push("", "parameters:");
    for (const p of op.params) {
      lines.push(
        `  - ${p.name} (${p.in}${p.required ? ", required" : ""}): ${p.type}` +
          (p.description ? ` — ${p.description}` : ""),
      );
    }
  } else {
    lines.push("", "parameters: none");
  }

  if (op.body) {
    lines.push(
      "",
      `request body (${op.body.mime ?? "application/json"}${op.body.required ? ", required" : ""}):`,
      `  ${op.body.schema}`,
    );
  }

  lines.push(
    "",
    "Call it with sevdesk_call:",
    `  { "operationId": "${op.operationId}", "params": { ... }${op.body ? ', "body": { ... }' : ""} }`,
  );
  return lines.join("\n");
}
