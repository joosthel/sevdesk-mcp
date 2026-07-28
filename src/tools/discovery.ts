import {
  briefOperation,
  catalog,
  describeOperation,
  findOperation,
  searchOperations,
} from "../catalog.js";
import { SevdeskClient } from "../client.js";
import { ReadOnlyError } from "../config.js";
import { bool, obj, optNumber, optString, requireString, str, type ToolDef } from "../lib/tool.js";

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
    `API ${catalog.apiVersion}). Use this to find the operationId for anything ` +
    `not covered by a dedicated tool, then call sevdesk_describe_operation for its ` +
    `parameters and sevdesk_call to execute it. ` +
    `Available tags: ${catalog.tags.join(", ")}.`,
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
      limit: optNumber(args, "limit") ?? 60,
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
    "SEVDESK_DRY_RUN=true or `dryRun` is passed.",
  mutating: true, // conservatively declared; the handler checks per operation
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
    const body = args.body;

    if (op.mutating && ctx.config.readOnly) throw new ReadOnlyError(op.operationId);

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

    const filledPath = SevdeskClient.fillPath(op.path, params);
    const query: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (!pathParamNames.has(k)) query[k] = v;
    }

    const dryRun = args.dryRun === true || ctx.config.dryRun;
    if (dryRun && op.mutating) {
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
      mutating: op.mutating,
    });
    return { status: result.status, data: result.data };
  },
};

export const discoveryTools: ToolDef[] = [
  listOperations,
  describeOperationTool,
  callOperation,
];
