/**
 * VAT-regime profile: which rule set this sevDesk account lives under.
 *
 * sevDesk has no readable company-settings endpoint (the only /SevClient
 * route is updateExportConfig), so the ledger itself is the detection
 * source: outgoing invoices carry the regime in their tax fields on both
 * API generations (taxRule 11 / smallSettlement / §19 taxText).
 *
 * Resolution ladder: explicit SEVDESK_VAT_REGIME → deprecated
 * SEVDESK_KLEINUNTERNEHMER → ledger inference → unknown. Explicit
 * configuration always wins, but a ledger that contradicts it is
 * reported (never silently trusted, never silently overridden).
 */

import type { SevdeskClient } from "../client.js";
import type { Config } from "../config.js";
import { parseSevdeskDate, readTaxTreatment } from "./vat.js";

export type VatRegime = "regular" | "kleinunternehmer" | "unknown";

export interface LedgerVerdict {
  regime: VatRegime;
  kuSignals: number;
  regularSignals: number;
  /** Both signal kinds present with a minority share above 25 % — the account may be switching regimes. */
  mixed: boolean;
  /** Only draft invoices existed to judge from. */
  draftsOnly: boolean;
}

export interface VatProfile {
  /** What the server acts on. */
  regime: VatRegime;
  source: "env" | "legacy-env" | "ledger" | "unresolved";
  /** Human-readable resolution story, surfaced by sevdesk_ping. */
  evidence: string;
  /** What the ledger says, independent of configuration. Null when the lookup failed. */
  ledger: LedgerVerdict | null;
}

/** Revenue rules that mark a regular-VAT account. Rule 11 is the §19 marker;
 * rule 22 (nicht steuerbar) is neutral — both regimes book those. */
const REGULAR_REVENUE_RULES = new Set([
  "1", "2", "3", "4", "5", "17", "18", "19", "20", "21",
]);

const KU_TAX_TEXT = /§\s*19\s*UStG/i;

type Row = Record<string, unknown>;

function isDraft(row: Row): boolean {
  return String(row.status ?? "") === "100";
}

/**
 * Judge the regime from invoice rows. Pure; evaluates the newest 25
 * non-draft invoices (drafts only as a last resort — they are unreviewed).
 */
export function inferFromInvoices(rows: unknown[], sampleSize = 25): LedgerVerdict {
  const usable = rows.filter((r): r is Row => !!r && typeof r === "object");
  const nonDrafts = usable.filter((r) => !isDraft(r));
  const draftsOnly = nonDrafts.length === 0 && usable.length > 0;
  const pool = (draftsOnly ? usable : nonDrafts)
    .slice()
    .sort((a, b) => {
      const da = parseSevdeskDate(a.invoiceDate)?.getTime() ?? 0;
      const db = parseSevdeskDate(b.invoiceDate)?.getTime() ?? 0;
      return db - da;
    })
    .slice(0, sampleSize);

  let ku = 0;
  let regular = 0;
  for (const row of pool) {
    const tax = readTaxTreatment(row);
    const kuSignal =
      tax.effectiveRuleId === "11" ||
      !!row.smallSettlement ||
      (typeof row.taxText === "string" && KU_TAX_TEXT.test(row.taxText));
    if (kuSignal) ku++;
    else if (tax.effectiveRuleId && REGULAR_REVENUE_RULES.has(tax.effectiveRuleId)) regular++;
    // everything else (rule 22, undecodable) is neutral
  }

  const total = ku + regular;
  const regime: VatRegime =
    total === 0 ? "unknown" : ku > regular ? "kleinunternehmer" : regular > ku ? "regular" : "unknown";
  const mixed = total > 0 && Math.min(ku, regular) / total > 0.25;
  return { regime, kuSignals: ku, regularSignals: regular, mixed, draftsOnly };
}

function ledgerEvidence(v: LedgerVerdict): string {
  const base =
    `inferred from the newest invoices: ${v.kuSignals} §19 signal(s), ` +
    `${v.regularSignals} regular-VAT signal(s)`;
  const notes = [
    v.draftsOnly ? "drafts only — nothing sent yet" : null,
    v.mixed ? "mixed signals — the account may be switching regimes" : null,
  ].filter(Boolean);
  return notes.length ? `${base} (${notes.join("; ")})` : base;
}

/**
 * Explicit configuration that contradicts the ledger majority — the one
 * misconfiguration this server refuses to hide. Null when consistent,
 * unconfigured, or undecidable.
 */
export function regimeMismatch(profile: VatProfile): string | null {
  if (profile.source !== "env" && profile.source !== "legacy-env") return null;
  const ledger = profile.ledger;
  if (!ledger || ledger.regime === "unknown" || ledger.regime === profile.regime) return null;
  return (
    `Configuration says '${profile.regime}' but the ledger looks '${ledger.regime}' ` +
    `(${ledger.kuSignals} §19 vs ${ledger.regularSignals} regular-VAT signals among recent ` +
    `invoices). The configuration wins — verify it, or fix it with SEVDESK_VAT_REGIME.`
  );
}

/**
 * Lazy, once-per-process profile resolution. The in-flight promise is
 * cached so racing tool calls share one lookup; an API failure is cached
 * only when explicit configuration already decided the regime (the fetch
 * merely feeds the mismatch check) — otherwise the next call retries.
 * A profile lookup must never break a tool call.
 */
export function createProfileResolver(
  client: Pick<SevdeskClient, "getAll">,
  config: Pick<Config, "vatRegime" | "vatRegimeSource">,
): () => Promise<VatProfile> {
  let cached: VatProfile | null = null;
  let inflight: Promise<VatProfile> | null = null;

  async function resolve(): Promise<VatProfile> {
    let ledger: LedgerVerdict | null = null;
    let fetchError: string | null = null;
    try {
      const rows = await client.getAll<Row>(
        "/Invoice",
        { embed: "taxRule" },
        { maxItems: 100, pageSize: 100 },
      );
      ledger = inferFromInvoices(rows);
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }

    if (config.vatRegime !== "auto") {
      const source = config.vatRegimeSource === "legacy-env" ? "legacy-env" : "env";
      const profile: VatProfile = {
        regime: config.vatRegime,
        source,
        evidence:
          source === "legacy-env"
            ? "SEVDESK_KLEINUNTERNEHMER=true (deprecated — use SEVDESK_VAT_REGIME=kleinunternehmer)"
            : `SEVDESK_VAT_REGIME=${config.vatRegime} (explicit configuration)`,
        ledger,
      };
      cached = profile; // env decided the regime; a failed ledger fetch only skips the mismatch check
      return profile;
    }

    if (ledger && ledger.regime !== "unknown") {
      const profile: VatProfile = {
        regime: ledger.regime,
        source: "ledger",
        evidence: ledgerEvidence(ledger),
        ledger,
      };
      cached = profile;
      return profile;
    }

    const profile: VatProfile = {
      regime: "unknown",
      source: "unresolved",
      evidence: fetchError
        ? `invoice lookup failed (${fetchError}) — set SEVDESK_VAT_REGIME=regular or =kleinunternehmer`
        : "no usable invoice signals to infer from — set SEVDESK_VAT_REGIME=regular or =kleinunternehmer",
      ledger,
    };
    // Cache the empty-ledger verdict (it will not change mid-session), but
    // let a transient API failure retry on the next call.
    if (!fetchError) cached = profile;
    return profile;
  }

  return () => {
    if (cached) return Promise.resolve(cached);
    if (!inflight) {
      inflight = resolve().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
}
