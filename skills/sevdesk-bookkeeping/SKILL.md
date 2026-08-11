---
name: sevdesk-bookkeeping
description: Workflows for German SMB bookkeeping through the sevdesk-mcp server — monthly close, receipt triage, VAT audit interpretation, and §13b reverse-charge investigation. Use when working with sevDesk accounting data via the sevdesk_* tools.
---

# sevDesk bookkeeping workflows

Procedural knowledge for driving the `sevdesk-mcp` server well. The
server's own guardrails (drafts-only writes, read-only mode, dryRun)
hold regardless of this skill — this file is about doing the work in the
right order with few tokens, not about safety.

## Orientation (once per session)

1. `sevdesk_ping` — verifies the token and returns three facts that
   change how you should work:
   - `mode`: READ-ONLY / DRY-RUN / read-write.
   - `bookkeepingSystemVersion`: 1.0 books with `taxType`, 2.0 with
     `taxRule`. Old documents may carry either; the tools decode both.
   - `vatProfile`: the account's VAT regime (`regular` vs
     `kleinunternehmer` §19 UStG) with the evidence for the verdict.
     If it carries a `warning`, the configuration contradicts the
     ledger — surface that to the user before trusting tax advice.
2. If the regime is `unknown`, ask the user (regular VAT or §19?) before
   creating invoices — `sevdesk_create_invoice` will refuse to guess.

## Monthly close

Run in this order; each step's output feeds the next conversation turn:

1. `sevdesk_find_duplicates` for the month — resolve duplicates first,
   they distort every later number.
2. `sevdesk_audit_vat` with `from`/`to` for the month. Work findings by
   severity; `vat_regime_mismatch` first if present (it biases the rest).
3. `sevdesk_reverse_charge_report` for the month — give the user the
   §13b bases for the VAT return (deductible nets to zero but must be
   declared; rule 13 VAT is actually payable).
4. `sevdesk_diff_receipt_folder` if a receipt directory is allowlisted —
   unbooked receipts and unmatched bookings.
5. `sevdesk_invoice_aging` — open receivables, never-sent drafts.
6. `sevdesk_subscription_gaps` — expected recurring costs that are
   missing (a missing AWS invoice surfaces here, not in the audits).

## Receipt triage (new expense documents)

1. `sevdesk_receipt_guidance` for the expense type — it returns the
   booking accounts and tax rules the account's own configuration allows.
2. `sevdesk_upload_voucher_file` then `sevdesk_create_voucher` with
   `dryRun: true` first; show the user the preview, then repeat without
   dryRun once confirmed.
3. Foreign supplier without VAT? Do the §13b check below before booking.

## §13b reverse-charge check (foreign supplier, 0 % VAT)

1. Is the supplier established abroad? The contact's country is
   authoritative; the name suffix (Inc, Ltd, SARL…) is only a hint.
2. Service from abroad → Reverse Charge. Which rule depends on the
   regime `sevdesk_ping` reported:
   - regular VAT: rule 12 (§13b Abs. 2) or 14 (§13b Abs. 1 EU) — output
     tax and input tax cancel, but both must be declared; rule 8 for
     intra-EU goods.
   - Kleinunternehmer: rule 13 — no input-tax deduction, the VAT is
     genuinely payable. This is the finding users most often disbelieve;
     point them to §19 Abs. 1 UStG.
3. Domestic 0 % expense → rule 10, not a reverse-charge rule.
4. `sevdesk_set_tax_rule` fixes drafts only — booked vouchers must be
   corrected in the sevDesk UI (resetting a paid foreign-currency
   voucher re-converts at today's rate; the tool description warns).

## Interpreting audit findings

- `vat_regime_mismatch` — configuration vs ledger contradiction; resolve
  before acting on any other tax suggestion.
- `zero_rate_booked_as_domestic` — the classic missed reverse charge;
  severity encodes the evidence (contact country > name heuristic).
- `reverse_charge_with_vat` — §13b rule but positions carry VAT; one of
  the two is wrong.
- `rule_not_usable_in_vouchers` — OSS/§18b rules exist only on invoices;
  the API will reject the voucher on booking.
- Sum mismatches — usually rounding or a missing position; fetch the
  voucher with `sevdesk_get_voucher` before proposing a fix.

## Token discipline

- Always pass `from`/`to` periods and `limit` — unbounded sweeps are the
  main token sink.
- `sevdesk_list_operations` / `sevdesk_describe_operation` before
  `sevdesk_call`: discover precisely, then call once.
- Audit tools return complete result objects — summarize for the user
  instead of re-fetching what they already contain.
