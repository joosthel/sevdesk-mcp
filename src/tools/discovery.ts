import {
  BODY_DEPENDENT_BOOKING_OPERATIONS,
  bookingField,
  bookingReason,
  briefOperation,
  catalog,
  describeOperation,
  findOperation,
  searchOperations,
} from "../catalog.js";
import { SevdeskClient } from "../client.js";
import { ReadOnlyError } from "../config.js";
import { bool, isDryRun, obj, optLimit, optString, requireString, str, strictBool, type ToolDef } from "../lib/tool.js";

/**
 * Three tools that together expose the *entire* sevDesk API.
 *
 * Registering 151 individual tools would swamp the client's tool list and most
 * of them would never be used. Discovery + a validated generic caller gives
 * complete coverage at a fraction of the context cost.
 */

const listOperations: ToolDef = {
  name: "sevdesk_list_operations",
  title: "List sevDesk API operations",
  description:
    `Search the sevDesk API catalogue (${catalog.operationCount} operations, ` +
    `API ${catalog.apiVersion}) for the operationId of anything not covered by a ` +
    `dedicated tool. Available tags: ${catalog.tags.join(", ")}.`,
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      query: str("Free-text search over operationId, path, tags and summary, e.g. 'voucher pdf'."),
      tag: str("Restrict to one resource tag, e.g. 'Voucher' or 'Invoice'.", {
        enum: catalog.tags,
      }),
      kind: str("Filter by effect: read (GET), write (POST/PUT/DELETE), or all.", {
        enum: ["read", "write", "all"],
      }),
      limit: { type: "integer", description: "Maximum results (default 60).", minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const kindRaw = optString(args, "kind");
    const kind = kindRaw === "read" || kindRaw === "write" ? kindRaw : "all";
    const ops = searchOperations({
      query: optString(args, "query"),
      tag: optString(args, "tag"),
      kind,
      limit: optLimit(args, "limit", 60, 200),
    });
    if (ops.length === 0) {
      return {
        matches: 0,
        hint: `No operation matched. Known tags: ${catalog.tags.join(", ")}`,
      };
    }
    return {
      matches: ops.length,
      operations: ops.map(briefOperation),
    };
  },
};

const describeOperationTool: ToolDef = {
  name: "sevdesk_describe_operation",
  title: "Describe a sevDesk API operation",
  description:
    "Show the full parameter list, request-body shape and an example call for one " +
    "operationId. Always do this before sevdesk_call on an operation you have not used before.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      operationId: str("Exact operationId, as returned by sevdesk_list_operations."),
    },
    required: ["operationId"],
    additionalProperties: false,
  },
  async handler(args) {
    const id = requireString(args, "operationId");
    const op = findOperation(id);
    if (!op) {
      const near = searchOperations({ query: id, limit: 8 }).map((o) => o.operationId);
      throw new Error(
        `Unknown operationId '${id}'.` + (near.length ? ` Did you mean: ${near.join(", ")}?` : ""),
      );
    }
    return describeOperation(op);
  },
};

const callOperation: ToolDef = {
  name: "sevdesk_call",
  title: "Call any sevDesk API operation",
  description:
    "Execute any operation from the catalogue. Path parameters are taken from `params` " +
    "by name; remaining `params` entries become query parameters. Nested objects are " +
    "encoded in sevDesk's bracket syntax (a[b]=c). Mutating operations are refused when " +
    "the server runs with SEVDESK_READ_ONLY=true, and are only described (not sent) when " +
    "SEVDESK_DRY_RUN=true or `dryRun` is passed. Operations with a `preventSendBy` query " +
    "parameter (the *GetPdf reads) default it to true so a read does not mark the document as sent. " +
    "GETs that change state (sendByWithRender, enshrine flags, preventSendBy=false) count as writes. " +
    "Booking operations (bookVoucher, bookInvoice, bookCreditNote, their resetToOpen and resetToDraft, " +
    "createPrivateTransactionRule) and writes that set a transaction status or move a voucher out of " +
    "draft or mark it paid (updateCheckAccountTransaction, updateVoucher, voucherFactorySaveVoucher) are " +
    "refused unless SEVDESK_ALLOW_BOOKING=true; prefer sevdesk_link_transaction for vouchers. " +
    "Can call DELETE operations, which are irreversible.",
  mutating: true,
  destructive: true, // conservatively declared; the handler checks per operation
  listInReadOnly: true, // covers reads too — writes are refused per call below
  inputSchema: {
    type: "object",
    properties: {
      operationId: str("Exact operationId from sevdesk_list_operations."),
      params: obj("Path and query parameters, keyed by parameter name."),
      body: obj("JSON request body, for POST/PUT operations."),
      dryRun: bool("Describe the request that would be sent instead of sending it."),
    },
    required: ["operationId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = requireString(args, "operationId");
    const op = findOperation(id);
    if (!op) {
      const near = searchOperations({ query: id, limit: 8 }).map((o) => o.operationId);
      throw new Error(
        `Unknown operationId '${id}'.` + (near.length ? ` Did you mean: ${near.join(", ")}?` : ""),
      );
    }

    const params = (args.params ?? {}) as Record<string, unknown>;
    // null / {} carry nothing; treat them as "no body" so a harmless filler
    // value does not fail a GET.
    // Only on GETs: a write keeps its body verbatim (`{}` is a meaningful payload).
    const emptyBody =
      !op.mutating &&
      (args.body === null ||
        (typeof args.body === "object" && Object.keys(args.body as object).length === 0));
    const body = emptyBody ? undefined : args.body;

    if (op.mutating && ctx.config.readOnly) throw new ReadOnlyError(op.operationId);
    // The booking rules inspect the body as an object; a string would slip past them.
    if (op.mutating && body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body))) {
      throw new Error(`Refused: the body of ${op.operationId} must be a JSON object.`);
    }
    let reason = ctx.config.allowBooking === true ? null : bookingReason(op, body);
    // Non-path params go to the query string, and sevDesk reads fields from it
    // on writes too, so `status` there would bypass the body rules.
    if (!reason && ctx.config.allowBooking !== true && op.mutating) {
      const pathNames = new Set(op.params.filter((p) => p.in === "path").map((p) => p.name));
      const extra = Object.keys(params).filter((k) => !pathNames.has(k));
      const field = bookingField(Object.fromEntries(extra.map((k) => [k, params[k]])));
      if (field) {
        reason = `sets ${field} in the query string, which records a payment or marks a document paid`;
      } else if (extra.length && BODY_DEPENDENT_BOOKING_OPERATIONS.has(op.operationId)) {
        reason = `takes its fields in the body; query parameters (${extra.join(", ")}) could set a booking status`;
      }
    }
    if (reason) {
      throw new Error(
        `Refused: ${op.operationId} ${reason}. Booking is off unless the server runs with ` +
          "SEVDESK_ALLOW_BOOKING=true.",
      );
    }

    const pathParamNames = new Set(
      op.params.filter((p) => p.in === "path").map((p) => p.name),
    );
    const missing = [...pathParamNames].filter(
      (n) => params[n] === undefined || params[n] === null || params[n] === "",
    );
    if (missing.length) {
      throw new Error(
        `Missing path parameter(s) ${missing.join(", ")} for ${op.operationId}. ` +
          `Run sevdesk_describe_operation for the full signature.`,
      );
    }

    // Every path parameter in the sevDesk spec is an id. Anything but digits
    // could retarget the request ("..", "1/../x", "1?x").
    for (const p of op.params) {
      if (p.in !== "path") continue;
      const v = params[p.name];
      if (!(typeof v === "number" ? Number.isSafeInteger(v) && v >= 0 : /^\d+$/.test(String(v)))) {
        throw new Error(`Refused: path parameter '${p.name}' of ${op.operationId} must be a numeric id.`);
      }
    }

    if (body !== undefined && !op.mutating) {
      throw new Error(`Refused: ${op.operationId} is a ${op.method} operation and takes no request body.`);
    }

    const filledPath = SevdeskClient.fillPath(op.path, params);
    const query: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (!pathParamNames.has(k)) query[k] = v;
    }

    // sevDesk answers HTTP 400 to a `limit` that is not an integer from 1 to
    // 1000 (tech.sevdesk.com, 2025-03-11 "API pagination limits"). Refuse it
    // here with the same rule instead of spending a request on the error.
    if (query.limit !== undefined && query.limit !== null) {
      const raw = query.limit;
      const n = typeof raw === "number" ? raw : /^\d+$/.test(String(raw)) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        throw new Error(
          `Refused: limit must be an integer from 1 to 1000 (sevDesk rejects anything else with HTTP 400). ` +
            "Page through larger collections with limit and offset.",
        );
      }
    }

    // Some GETs change state, and the catalog calls every GET a read. Without
    // this, SEVDESK_READ_ONLY and dryRun would let them through:
    //  - *GetPdf marks the document as sent unless preventSendBy is true, so
    //    default it on (absent or null) and send a literal true;
    //  - sendByWithRender sends/marks a document;
    //  - enshrine* flags (Festschreibung) are irreversible when truthy. Only
    //    flags that start with "enshrine" count: includeEnshrined and
    //    withEnshrinedDocuments are read filters.
    let effectiveMutating = op.mutating;
    if (op.params.some((p) => p.in === "query" && p.name === "preventSendBy")) {
      // Normalized to a literal boolean; an unparseable value is refused, not forwarded.
      const flag = strictBool(query, "preventSendBy") ?? true;
      query.preventSendBy = flag;
      if (!flag) effectiveMutating = true; // explicitly turned off: the document gets marked as sent
    }
    if (op.path.endsWith("/sendByWithRender")) effectiveMutating = true;
    for (const p of op.params) {
      if (p.in !== "query" || !/^enshrine/i.test(p.name)) continue;
      const flag = strictBool(params, p.name);
      if (flag === undefined) continue;
      query[p.name] = flag;
      if (flag) effectiveMutating = true;
    }
    if (effectiveMutating && ctx.config.readOnly) throw new ReadOnlyError(op.operationId);

    if (isDryRun(args, ctx) && effectiveMutating) {
      return {
        dryRun: true,
        wouldSend: {
          method: op.method,
          url: `${ctx.config.baseUrl}${filledPath}`,
          query,
          body: body ?? null,
        },
        note: "Nothing was sent. Call again without dryRun to execute.",
      };
    }

    const result = await ctx.client.request({
      method: op.method,
      path: filledPath,
      query: Object.keys(query).length ? query : undefined,
      body,
      mutating: effectiveMutating,
    });
    return { status: result.status, data: result.data };
  },
};

export const discoveryTools: ToolDef[] = [
  listOperations,
  describeOperationTool,
  callOperation,
];
