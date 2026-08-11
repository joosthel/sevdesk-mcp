# Spec: Generalized VAT-profile opinionation for sevdesk-mcp

Version: v1 (draft) → refined twice below (see Refinement Log).

**Status: implemented and conformance-checked.** Every commitment below
is in the code (`src/lib/profile.ts` and its call sites); acceptance
criteria 1–5 are executable as `tests/personas.test.ts` plus
`tests/profile.test.ts`. The §5 description-slimming pass additionally
removed a misleading tax-rule shorthand from `sevdesk_create_voucher`
(it suggested revenue rule 5 for §13b on what are mostly expense
vouchers; expense-side reverse charge is 12/13/14 — the description now
points to `sevdesk_receipt_guidance` instead).

## Problem

The server's tax-regime opinionation is a single boolean
(`SEVDESK_KLEINUNTERNEHMER`) that only serves one user group. Everyone
else gets defaults silently tuned for regular VAT, and nobody gets told
when their configuration contradicts their ledger. Guidance for using
the server lives entirely in verbose tool descriptions (paid every
session in every client).

## Goals

1. Serve every sevDesk user group with correct tax-regime behavior,
   detected rather than assumed where possible.
2. Harden against misconfiguration: contradictions between configuration
   and ledger are surfaced, never silently trusted.
3. Reduce per-session token cost: server `instructions`, slimmer tool
   descriptions, procedural knowledge in an optional shipped skill.
4. Zero regression for existing users (`SEVDESK_KLEINUNTERNEHMER` keeps
   working).

## Non-goals

- No configurable rules engine. The profile is a typed object; audit
  logic stays hard-coded.
- No change to the safety layer (drafts-only, read-only gate, dryRun,
  receipt-dir allowlist). It is universal and stays fixed.
- No Ist-/Soll-Versteuerung axis: no current audit computes VAT timing,
  so the axis would be dead config (YAGNI). Documented for the future.
- No multi-account support: one token = one sevDesk client; advisors run
  one server per mandate.

## Personas

- **P1 — Solo-Kleinunternehmerin** (§19 UStG freelance designer).
  Invoices without VAT (taxRule 11, 0 %, §19 taxText). Wants drafts that
  are correct §19 documents and audit advice that knows she cannot
  deduct input tax (§13b → rule 13, VAT actually payable).
- **P2 — Regular-VAT GmbH** (agency, 19 %, foreign SaaS subscriptions).
  Wants 19 %/rule-1 invoice defaults and reverse-charge audits pointing
  to rules 12/14 (with input-tax deduction). Never wants §19 defaults.
- **P3 — Advisor / Steuerberater** reviewing a client account.
  Read-only mode, audit tools at scale, often voucher-heavy accounts
  with few or no outgoing invoices. Wants the server to say what it
  knows about the account rather than assume.

## Design

### 1. VatProfile

```ts
type VatRegime = "regular" | "kleinunternehmer" | "unknown";
interface VatProfile {
  regime: VatRegime;
  source: "env" | "legacy-env" | "ledger" | "unresolved";
  evidence: string;           // human-readable, shown by sevdesk_ping
}
```

Carried on `ToolContext` as a lazy accessor `getProfile(): Promise<VatProfile>`,
resolved at most once per process, cached on success. Failure to resolve
(API error) yields `unknown`/`unresolved` for that call and retries on
the next call — a profile lookup must never break a tool call.

### 2. Resolution ladder

1. `SEVDESK_VAT_REGIME` = `kleinunternehmer` | `regular` | `auto`
   (default `auto`). Explicit values win outright.
2. Legacy `SEVDESK_KLEINUNTERNEHMER=true` → `kleinunternehmer`
   (source `legacy-env`; ping notes the deprecation).
3. `auto`: infer from the ledger — fetch recent outgoing invoices
   (~25, newest first) and count §19 signals (taxRule 11 /
   `smallSettlement` truthy / §19 taxText) vs regular signals
   (taxRule 1/2/3, taxRate > 0). Majority wins; evidence records the
   counts. **API note (verified): sevDesk exposes no readable
   company-settings endpoint** — the only `/SevClient` route is
   `updateExportConfig` — so the ledger IS the detection source.
4. No invoices at all → `unknown`/`unresolved`.

### 3. Behavior per site

| Site | regular | kleinunternehmer | unknown |
|---|---|---|---|
| `create_invoice` default taxRule/rate/taxText | 1 / 19 % / "Umsatzsteuer 19%" | 11 / 0 % / §19 text | see Refinement 1 |
| `audit_vat` zero-rate suggestion | rules 12/14/13 (deduction first) | rule 13 only (no deduction, VAT payable) | both branches, labeled |
| `reverse_charge_report` note | as today (non-KU) | KU note (rule 13, payable) | both branches, labeled |
| `sevdesk_ping` | reports profile + evidence | same | same + how to set `SEVDESK_VAT_REGIME` |

### 4. Mismatch hardening

If an explicit env regime contradicts the ledger majority signal, ping
and `audit_vat` emit a `vat_regime_mismatch` warning (never auto-switch:
explicit config wins, but loudly).

### 5. Token-cost layer

- `ServerOptions.instructions`: run ping first; prefer curated tools
  over `sevdesk_call`; writes are drafts; dryRun exists; profile is
  detected and reported by ping.
- Tool descriptions: strip workflow narrative, keep point-of-use hazard
  warnings. Descriptions stay **profile-independent** (constraint: the
  tools/list result is cached for 1 h — it must not vary by profile).
- `skills/sevdesk-bookkeeping/SKILL.md` shipped in the npm package
  (`files` entry) with workflows: monthly close, receipt triage, audit
  interpretation, §13b investigation. Documented in README; not loaded
  by the server itself.

### 6. Compatibility

`config.kleinunternehmer` is removed from `Config`; the env var remains
honored via the ladder. CHANGELOG documents the migration
(`SEVDESK_VAT_REGIME=kleinunternehmer` is the new spelling).

## Testing

- Unit tests for the inference function over fixture invoice rows: pure
  KU ledger, pure regular ledger, mixed (threshold-crossing), empty,
  malformed rows.
- Ladder tests: env beats legacy beats ledger; failure → unresolved.
- Persona walkthroughs (P1/P2/P3) against the built server (stdio smoke
  with mocked config where network is involved; documented results).

## Refinement Log

### Pass 1 — personas & edge cases (decisions)

**P1, empty account (first invoice ever).** Any silent default under
`unknown` is wrong for someone (19 % wrongs P1, §19 wrongs P2).
DECISION: `create_invoice` with regime `unknown` and no explicit
`taxRuleId` **refuses** with an actionable error naming both options and
`SEVDESK_VAT_REGIME`. Applies to dryRun too (a preview embedding a
guessed rule is the same wrong document). One-time onboarding friction
beats a wrong legal draft — users do send drafts.
Explicit arguments always beat profile defaults (unchanged today).

**P1, §19-threshold crossing mid-year.** Ledger shows mixed signals.
DECISION: inference = majority over the ~25 newest invoices; if the
minority share exceeds 25 %, evidence flags "mixed signals — the account
may be switching regimes" (shown by ping). Regime stays the majority.
Prefer non-draft invoices as evidence; fall back to drafts only when
nothing else exists (evidence says so).

**P2, signal definition bug found.** 0 % alone is NOT a regular/KU
discriminator — export (rule 2) and intra-EU (rule 3) invoices are 0 %
under the regular regime. DECISION: KU signal = taxRule 11 OR truthy
`smallSettlement` OR §19 taxText (`/§\s*19\s*UStG/i`); regular signal =
any other known revenue taxRule (1,2,3,4,5,17–21). Works on both
bookkeeping generations (1.0 uses smallSettlement/taxText, 2.0 taxRule).

**P2, stale legacy env.** `SEVDESK_KLEINUNTERNEHMER=true` pasted into a
regular-VAT account's config: env still wins (explicit beats inferred),
but the mismatch warning fires in ping and `audit_vat`
(`vat_regime_mismatch`). Mismatch is checked ONLY when an explicit env
regime exists and the ledger majority contradicts it.

**P3, voucher-only account.** No invoices → `unknown`; audit suggestions
carry both branches, labeled "Regular VAT: … / Kleinunternehmer: …";
ping explains how to sharpen with `SEVDESK_VAT_REGIME`. Profile lookup
is a read — permitted in read-only mode.

**Concurrency.** Two tool calls racing the first resolution must not
double-fetch: cache the in-flight promise, not just the result.

### Pass 2 — API & code reality (decisions)

**Reuse `readTaxTreatment`.** It already decodes both API generations
(taxRule id, legacy taxType incl. `ss`→11 mapping). Inference signals:
KU = `effectiveRuleId === "11"` OR truthy `smallSettlement` OR
§19 taxText. Regular = effectiveRuleId in {1,2,3,4,5,17,18,19,20,21}.
Rule 22 ("Nicht steuerbar (Einnahme)") and undecodable rows are neutral
— they count for neither side.

**Fetch order is not guaranteed.** `getAll` walks offsets in API default
order. DECISION: fetch up to 100 invoices (`embed=taxRule`, one page),
sort by `invoiceDate` desc client-side, evaluate the newest 25.

**Pre-existing bug folded in (hardening).** `create_invoice` defaults
the tax *rate* from the regime even when an explicit rule is passed:
`taxRuleId: "2"` (Ausfuhren, allows only 0 %) without per-position rates
gets 19 % today. DECISION: the default rate follows the chosen RULE, not
the regime — rules allowing [0] default to 0; rule 1/3 default to 19;
OSS rules (allowedRates null) require explicit per-position rates
(refuse otherwise). The regime only selects the default RULE (1 vs 11).
taxText likewise follows the rule: 11 → §19 sentence, rate > 0 →
"Umsatzsteuer X%", else the rule's label.

**Profile shape (final).** Resolver computes the ledger verdict even
when env wins, so the mismatch check costs nothing extra:

```ts
interface VatProfile {
  regime: VatRegime;                     // what the server acts on
  source: "env" | "legacy-env" | "ledger" | "unresolved";
  evidence: string;
  ledger: { regime: VatRegime; kuSignals: number;
            regularSignals: number; mixed: boolean } | null;
}
```

`getProfile(): Promise<VatProfile>` on ToolContext; in-flight promise
cached; on fetch failure with env set → env regime with `ledger: null`;
without env → `unknown`/`unresolved`, retried on next call.

**Wiring sites (verified against code).** config.ts (drop
`kleinunternehmer`, add `vatRegime: "regular"|"kleinunternehmer"|"auto"`),
new src/lib/profile.ts, index.ts (build resolver into ctx),
resources.ts: create_invoice defaults + ping report,
audit.ts: zero-rate suggestion + reverse_charge_report note +
`vat_regime_mismatch` finding. Tests: ctxWith helper gains a
getProfile stub; new tests/profile.test.ts for the inference ladder.

**Instructions & skill.** `buildServer` sets `ServerOptions.instructions`
(includes the runtime mode line — config is known at construction).
Skill ships as `skills/sevdesk-bookkeeping/SKILL.md`, added to
package.json `files`, linked from README; the server never loads it.

## Final acceptance criteria

1. P1 zero-config: §19 ledger → KU defaults, evidence visible in ping.
2. P2 zero-config: regular ledger → 19 %/rule-1 defaults; stale
   `SEVDESK_KLEINUNTERNEHMER=true` triggers `vat_regime_mismatch`.
3. P3 voucher-only: `unknown` regime → create_invoice refuses without
   explicit rule; audit suggestions carry both labeled branches.
4. Explicit args beat profile; explicit env beats ledger; failure never
   breaks a tool call.
5. Full suite green; both wire eras still serve; tool descriptions
   remain profile-independent (listing cache stays valid).
