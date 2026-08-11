# Changelog

## Unreleased

- Generalized VAT-regime handling: `SEVDESK_VAT_REGIME`
  (`regular` / `kleinunternehmer` / `auto`, default `auto`) replaces the
  Kleinunternehmer boolean. `auto` infers the regime from the newest
  invoices (taxRule 11 / `smallSettlement` / §19 taxText — works on both
  bookkeeping generations); `sevdesk_ping` reports the verdict with
  evidence. `SEVDESK_KLEINUNTERNEHMER` stays honored, marked deprecated.
- Hardened against misconfiguration: an explicit regime that contradicts
  the ledger becomes a `vat_regime_mismatch` audit finding (config still
  wins — loudly). With the regime unknown, `sevdesk_create_invoice`
  refuses to guess a tax rule instead of silently defaulting; audit
  suggestions carry both labeled branches.
- Invoice tax defaults now follow the chosen *rule*, not the regime: 0 %
  rules (Ausfuhr, §4, §13b …) no longer get a silent 19 % default, and
  OSS rules require explicit per-position rates.
- Server `instructions` (MCP-native usage guidance for every client) and
  a shipped Agent Skill (`skills/sevdesk-bookkeeping`) with the
  bookkeeping workflows — monthly close, receipt triage, §13b checks.

- MCP protocol revision 2026-07-28: migrated from `@modelcontextprotocol/sdk`
  1.x to the v2 SDK (`@modelcontextprotocol/server` 2.0). Modern clients get
  stateless per-request envelopes and a cacheable tool listing
  (`ttlMs` 1 h, scope private); 2025-era clients are still served through
  the classic initialize handshake — same server instance, negotiated per
  connection by `serveStdio`.
- `server.json`: registry schema pointer bumped 2025-09-29 → 2025-12-11
  (validated; no field changes needed).
- Node.js 20 reached end-of-life (April 2026): minimum engine is now
  Node 22, CI tests on 22 and 24, GitHub Actions bumped to current
  releases (still SHA-pinned).
- Privacy policy (PRIVACY.md), linked from the READMEs and declared in
  the MCPB manifest.

## 0.4.0 — 2026-07-28

- `sevdesk_invoice_aging`: receivables aging — open invoices bucketed by
  days overdue, partially paid remainders, never-sent drafts.
- Three guarded invoice tools: `sevdesk_create_invoice` (always drafts,
  Kleinunternehmer-aware defaults), `sevdesk_get_invoice_pdf` (never touches
  the send state, never overwrites files), `sevdesk_mark_invoice_sent`
  (non-email send types only, verifies by re-read). Deliberately no
  email-send tool.
- `SEVDESK_KLEINUNTERNEHMER`: audit suggestions and invoice defaults follow
  the §19 rule set.
- Consistency pass across the write layer: every write tool accepts a
  per-call `dryRun` with a uniform `wouldSend` preview; the read-only gate
  moved into the server dispatcher (three enforcement layers now); the
  receipt-dir allowlist has a single implementation.
- Docs: README restructured (English + German), CONTRIBUTING.md, sample
  audit output.
- Distribution: published to npm (`npx sevdesk-mcp`), listed in the official
  MCP registry, MCPB one-click bundle for Claude Desktop attached to
  releases.

## 0.3.1 — 2026-07-28

- README restructured around step-by-step setup instructions (Claude Code,
  Claude Desktop, generic MCP clients) and a documented write-safety model.
- `sevdesk_set_tax_rule` documents its deliberate draft-only scope: the
  sevDesk API refuses updates on booked vouchers, and resetting a paid
  foreign-currency voucher recalculates its EUR amounts at today's exchange
  rate — booked vouchers belong in the sevDesk UI. Found the hard way on
  live data; the tool description now warns about it.

## 0.3.0 — 2026-07-28

- `sevdesk_receipt_guidance`: query sevDesk's booking-account guidance —
  which DATEV/SKR accounts allow which tax rules and rates.
- `sevdesk_audit_vat` now checks positions against that guidance
  (`account_rule_mismatch`) and prefers the supplier contact's registered
  country over the name-suffix heuristic when judging reverse-charge
  candidates; a German contact downgrades the finding (§19 suppliers).
- `sevdesk_set_tax_rule`: guarded rebooking of a voucher onto a different
  VAT rule — refuses enshrined vouchers and wrong-side rules, supports
  `dryRun`, verifies the result by reading the voucher back.
- `sevdesk_reconcile_transactions`: match bank transactions against vouchers
  by amount and date proximity; reports missing receipts and unpaid vouchers.
- Tax rules 16 and 22 ("nicht steuerbar"), which the live ReceiptGuidance
  exposes but the spec tables omit.
- Hardening: receipt file tools now refuse to run without an explicit
  `SEVDESK_RECEIPT_DIRS` allowlist (previously unrestricted); GitHub Actions
  pinned to commit SHAs; dependencies upgraded to clear all `npm audit`
  findings (runtime and dev); `SECURITY.md` documents the threat model.

## 0.2.0 — 2026-07-28

- Full sevdesk-Update 2.0 tax-rule model: revenue and expense rule sets,
  side detection via `creditDebit`, side-mismatch and not-usable-on-vouchers
  findings. Corrects `noteu` → rule 17 (not 5) and rule 3 (not reverse charge).
- `sevdesk_reverse_charge_report` splits §13b amounts by meaning:
  deductible (12/14), non-deductible (13), own revenue (5).
- `sevdesk_ping` reports the account's bookkeeping system version.
- Voucher dates no longer shift a day through timezone conversion.
- Failed position fetches surface as warnings instead of being swallowed.
- Server assembly factored out of the stdio entry point (`src/server.ts`).
- Validated against a live sevDesk account (bookkeeping system 2.0).

## 0.1.0

- Initial skeleton: 16 tools, generated 151-operation catalogue, safety flags
  (`SEVDESK_READ_ONLY`, `SEVDESK_DRY_RUN`, `SEVDESK_RECEIPT_DIRS`).
