# Changelog

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
