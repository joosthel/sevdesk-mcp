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

1. `sevdesk_ping` — verifies the token and returns two facts that
   change how you should work:
   - `mode`: READ-ONLY / DRY-RUN / read-write.
   - `bookkeepingSystemVersion`: 1.0 books with `taxType`, 2.0 with
     `taxRule`. Old documents may carry either; the tools decode both.
2. The server never guesses a tax rule: `sevdesk_create_invoice` and
   `sevdesk_create_voucher` require `taxRuleId`. Ask the user which
   treatment applies (regular VAT, §19 UStG, reverse charge…), and for
   vouchers read the allowed rules from `sevdesk_receipt_guidance`.

## Monthly close

Run in this order; each step's output feeds the next conversation turn:

1. `sevdesk_find_duplicates` for the month — resolve duplicates first,
   they distort every later number.
2. `sevdesk_audit_vat` with `from`/`to` for the month. Work findings by
   severity.
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

## Linking receipts to bank payments

Needs `SEVDESK_ALLOW_BOOKING=true` (check `sevdesk_ping`). The voucher must
be open (100), not a draft.

1. `sevdesk_reconcile_transactions` or `sevdesk_list_transactions` to find
   the matching open transaction.
2. `sevdesk_link_transaction` with `dryRun: true`; show the user the
   bookings, then repeat without dryRun once confirmed.
3. One payment covering several receipts: pass all of them as
   `allocations` in one call. A transaction that is already partly linked
   is refused; finish it in the sevDesk UI.
4. Wrong link? `sevdesk_reset_voucher_to_open` removes ALL payments from
   the voucher, not just this one. Check the voucher first.

## §13b reverse-charge check (foreign supplier, 0 % VAT)

1. Is the supplier established abroad? The contact's country is
   authoritative; the name suffix (Inc, Ltd, SARL…) is only a hint.
2. Service from abroad → Reverse Charge. Which rule depends on
   whether the user can deduct input tax — ask, and confirm against
   `sevdesk_receipt_guidance`:
   - with input-tax deduction: rule 12 (§13b Abs. 2) or 14 (§13b Abs. 1
     EU) — output tax and input tax cancel, but both must be declared;
     rule 8 for intra-EU goods.
   - without input-tax deduction (e.g. a §19 UStG business): rule 13 —
     the VAT is genuinely payable. This is the finding users most often
     disbelieve; point them to §19 Abs. 1 UStG.
3. Domestic 0 % expense → rule 10, not a reverse-charge rule.
4. `sevdesk_set_tax_rule` fixes drafts only — booked vouchers must be
   corrected in the sevDesk UI (resetting a paid foreign-currency
   voucher re-converts at today's rate; the tool description warns).

## Interpreting audit findings

- `zero_rate_booked_as_domestic` — the classic missed reverse charge;
  severity encodes the evidence (contact country > name heuristic).
- `reverse_charge_with_vat` — §13b rule but positions carry VAT; one of
  the two is wrong.
- `rule_not_usable_in_vouchers` — OSS/§18b rules exist only on invoices;
  the API will reject the voucher on booking.
- Sum mismatches — usually rounding or a missing position; fetch the
  voucher with `sevdesk_get_voucher` before proposing a fix.

## Token discipline

- For totals ("revenue in Q2", "expenses by supplier", "how many open
  invoices") use `sevdesk_summarize` — it aggregates server-side and
  returns groups, never rows. Reach for the list tools only when you
  need the individual documents.
- Always pass `from`/`to` periods and `limit` — unbounded sweeps are the
  main token sink.
- `sevdesk_list_operations` / `sevdesk_describe_operation` before
  `sevdesk_call`: discover precisely, then call once.
- Audit tools return complete result objects — summarize for the user
  instead of re-fetching what they already contain.
