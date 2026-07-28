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

export function describeOperation(op: Operation): string {
  const lines: string[] = [
    `${op.operationId}`,
    `${op.method} ${op.path}`,
    `tags: ${op.tags.join(", ") || "—"}`,
    `mutating: ${op.mutating ? "yes — changes data in sevDesk" : "no"}`,
  ];
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
