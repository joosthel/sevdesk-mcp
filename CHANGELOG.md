# Changelog

## Unreleased

**Added**

- `sevdesk_link_transaction` books vouchers against an existing open bank
  transaction (`bookAmount` with `checkAccountTransaction`), the same as
  assigning receipts in the sevDesk UI. A split payment is booked in one
  call (`allocations`). Every voucher and the total are checked before the
  first booking; transactions that are already partly linked are refused,
  because the API does not report what is left on them.
- `sevdesk_reset_voucher_to_open` removes all payments from a voucher. It is
  marked destructive. Both tools refuse foreign-currency vouchers.
- `SEVDESK_ALLOW_BOOKING` (default `false`): the two booking tools are hidden
  and refused without it. It does not restrict `sevdesk_call`.
- `sevdesk_create_voucher` takes `accountDatevId` per position, the booking
  account on sevdesk-Update 2.0.
- Voucher status 750 is reported as `teilbezahlt`.

**Changed**

- `sevdesk_create_voucher` returns a compact summary of the saved voucher
  instead of sevDesk's full echo.

Thanks to @TheOriginal92 (#7).

## 0.5.0 — 2026-10-19

**Breaking**

- `SEVDESK_KLEINUNTERNEHMER` (0.4.0) is no longer read — a startup notice
  is printed if it is still set. The server no longer applies
  Kleinunternehmer-aware defaults to invoices or audit suggestions, so
  reverse-charge advice is the same for every account.
- `taxRuleId` is required on `sevdesk_create_invoice` and
  `sevdesk_create_voucher`; the server does not guess a tax treatment.
  `sevdesk_create_voucher` also refuses a rule from the wrong side (an
  expense rule needs `creditDebit` C, a revenue rule D).
- `sevdesk_set_tax_rule` now enforces its documented draft-only scope: open
  and paid vouchers are refused before anything is sent (dry runs included)
  instead of relying on the API to reject the update. Found in a live
  read-only/dry-run check, where a paid voucher still got a preview.

**Security / hardening**

Behaviour changes that can break existing callers are marked **(breaking)**.

- **(breaking)** `SEVDESK_BASE_URL` must be `https://`; `http://` is accepted
  only for `localhost`, `127.0.0.1` and `[::1]`. The server refuses to start
  otherwise — the token is sent as a header.
- **(breaking)** `SEVDESK_RECEIPT_DIRS` is split on the platform path
  delimiter (`;` on Windows, so `C:\…` works) and relative entries are
  refused at startup.
- Redirects are no longer followed (`redirect: "manual"`); a 3xx becomes a
  non-retried `SevdeskApiError`, since following it would replay a write to
  an unconfigured URL.
- A GET/HEAD with a body is refused up front instead of being retried as a
  network error; `sevdesk_call` also refuses a `body` on GET operations.
- **(breaking)** Ids (`voucherId`, `invoiceId`, `contactId`, `checkAccountId`,
  position `accountingTypeId`) must be numeric (number or digit string), and
  `sevdesk_call` requires numeric path parameters. `.` and `..` are refused
  as path parameters.
- `limit`, `maxVouchers`, `maxItems`, `maxGroups` are floored and clamped to
  `[1, max]` (list limits 1000, `sevdesk_list_operations` 200,
  `maxVouchers`/`maxItems` 20,000); the schemas now publish the `maximum`.
  `sevdesk_list_invoices`, `_contacts` and `_transactions` also report `returned`. A negative
  or huge value no longer slices off the wrong rows or walks the whole ledger.
- The receipt allowlist resolves symlinks on both sides and returns the real
  path; the target must exist.
- `sevdesk_call` is annotated `destructiveHint: true` (new `ToolDef.destructive`);
  all other tools stay `false`.
- **(breaking)** `sevdesk_call` classifies state-changing GETs as writes:
  `sendByWithRender` (`sendCreditNoteByPrinting`) and a truthy `enshrine*`
  flag (`exportDatevCSV` `enshrineDocuments`, `exportDatevDepricated`
  `enshrine`) are refused under `SEVDESK_READ_ONLY=true`, only previewed
  under `dryRun`, and sent as mutating requests. `body: null` / `{}` on a
  GET is ignored.
- `sevdesk_call` defaults `preventSendBy` (absent or null) to true on `invoiceGetPdf`,
  `creditNoteGetPdf` and `orderGetPdf` (derived from the catalog), and refuses
  `preventSendBy=false` under `SEVDESK_READ_ONLY=true` (elsewhere it counts as a
  write for `dryRun`); truthy strings are sent as a literal `true`.
- **(breaking)** `sevdesk_create_voucher` requires a numeric `taxRate` and
  exactly one of `sumNet` / `sumGross` per position, checks the rate against
  the tax rule's allowed rates, and refuses `extra` keys that collide with
  fields the tool sets (`status`, `taxRule`, `creditDebit`, `voucherDate`,
  `supplierName`, `objectName`, `mapAll`, `voucherType`, `taxType`, `taxSet`,
  and `description` / `payDate` when given). Positions must be all net or all
  gross, and `creditDebit` must be `C` or `D` (anything else used to become `C`).
- **(breaking)** `sevdesk_create_invoice` requires a finite numeric `price` and
  a non-empty position `name`.
- **(breaking)** `sevdesk_upload_voucher_file` maps `.xml` (XRechnung /
  ZUGFeRD) to `application/xml` and `.jpg`/`.jpeg` to `image/jpeg`; other
  extensions are refused unless `mimeType` is passed (it used to guess JPEG).
- **(breaking)** `SEVDESK_BASE_URL` with a query string, fragment or
  credentials is refused at startup.
- Audit numeric arguments are clamped and their schemas publish the range:
  `dayWindow` / `dayTolerance` 0-366, `minMonths` 1-120, `rate` 0-100. A
  negative value no longer silently yields "no match". `extensions` entries
  must be strings.
- `sevdesk_diff_receipt_folder` takes `maxVouchers` (default 2000, max 20,000)
  and reports `truncated` plus a warning when the cap was hit, instead of
  listing the unfetched vouchers as missing their file.
- `sevdesk_call`: a write keeps `body: {}` as sent; on a GET `null`, `{}` and
  `[]` count as no body. `extra` and each `positions` entry must be objects.
  `sevdesk_get_invoice_pdf` checks the target directory before fetching.
- Every audit that fetches vouchers (and `sevdesk_reconcile_transactions` for
  transactions) reports `truncated` and a warning when `maxVouchers` /
  `maxItems` cut the ledger before the date filter; an exact fit is not flagged.
- `sevdesk_create_voucher` refuses `fileName`/`filename` in `extra`;
  `taxRuleId` may be given as a number. `sevdesk_get_invoice_pdf` falls back to
  `invoice-<id>.pdf` for an empty or dot-only API filename. The base URL is
  rebuilt from the parsed URL (a bare `?`/`#` is dropped).
- Release workflow verifies the pinned `mcp-publisher` checksum before `npm publish`.
- **(breaking)** `SEVDESK_READ_ONLY`, `SEVDESK_DRY_RUN` and `SEVDESK_DEBUG`
  accept `1/true/yes/on` and `0/false/no/off` (trimmed, any case; empty = default)
  and **refuse to start** on anything else, instead of silently reading it as
  false. `SEVDESK_MAX_RETRIES=0` now means no retries (it used to fall back to
  3); invalid numbers in `SEVDESK_MAX_RETRIES`, `SEVDESK_TIMEOUT_MS` and
  `SEVDESK_RATE_LIMIT` also fail at startup.
- **(breaking)** An unparseable per-call `dryRun` (e.g. `"dry"`, `2`) is refused
  with "dryRun must be true or false." instead of becoming a real write;
  `1`, `0` and `" TRUE "` are understood. `sevdesk_call` likewise refuses
  unparseable `preventSendBy` / `enshrine*` values and sends literal booleans.
- **(breaking)** `sevdesk_upload_voucher_file` again refuses relative paths
  (the check now runs before the path is resolved).
- `sevdesk_create_invoice` validates explicit position rates against the tax
  rule (rule 11 with 19 % is refused). The invoice-level rate and text follow
  the positions when they agree (`Umsatzsteuer 7%`); when they differ the rule
  default rate stays and the text is the rule label, since no single
  percentage would be true.
- The `sevdesk_list_*` tools, `sevdesk_summarize`, invoice aging and the contact
  lookup behind the reverse-charge checks report `truncated` plus a warning
  naming the right noun and the argument to raise. Voucher positions are
  paged instead of cut at 200.
- `sevdesk_get_invoice_pdf` only keeps API filenames that look like plain
  `.pdf` names, else `invoice-<id>.pdf`.
- Release workflow keeps `mcp-publisher` outside the checkout so it cannot end
  up in the MCPB bundle (also listed in `.mcpbignore`).
- `sevdesk_list_vouchers`, `_invoices`, `_contacts`, `_transactions` and
  `sevdesk_summarize` take a `maxItems` fetch cap (max 20,000), and their
  truncation warning names it — the from/to and status filters run after the
  cap, so narrowing them never reached the missing rows.
- `sevdesk_create_voucher` accepts only status 50, 100 or 1000 (numbers too).
- `sevdesk_get_invoice_pdf` keeps Unicode filenames (`Rechnung_Müller.pdf`).
- A `SEVDESK_RECEIPT_DIRS` entry that does not exist is named in the refusal
  instead of reporting the target as "outside" the list; a fractional or
  negative numeric `taxRuleId` gets its own error; the upload response scrub
  also handles an array `objects`; the receipt-folder diff reports truncation
  once.
- Tool output is capped at 200,000 characters, with a closing line saying how
  much was cut.

**Fixed** (thanks @TheOriginal92, PR #2)

- `sevdesk_create_voucher` attaches the uploaded receipt via the
  top-level `filename` of `saveVoucher`, where sevDesk reads it.
- `sevdesk_upload_voucher_file` no longer returns sevDesk's base64
  preview in its result.
- `sevdesk_create_voucher` accepts the expense-side tax rules.

- Optional `.env` support for runs outside an MCP client: a `.env` beside
  `package.json` is read at startup, so `npm run dev` and
  `node dist/index.js` no longer need the token pasted onto the command
  line (and into shell history). Read from the package root, never the
  working directory — an npx-launched server inherits the client's cwd,
  and absorbing a stray `.env` from there would be a footgun. Real
  environment variables always win, so a client's `env` block can never be
  shadowed by a stale file. `.env.example` documents every variable.

- Duplicate-write protection: a 5xx or network failure on a write is no
  longer retried — the request may already have reached sevDesk, so a
  replay could create a duplicate draft. A 429 stays retryable for every
  method (a throttled call never executed). `Retry-After` is now clamped
  to 250 ms–30 s (and understood in HTTP-date form), backoff is jittered
  and capped.
- Client-side rate limiter (token bucket, `SEVDESK_RATE_LIMIT`
  requests/second, default 4, `0` disables): bursty audit fan-outs are
  paced instead of colliding with sevDesk's throttle.
- `sevdesk_summarize`: aggregate invoices or vouchers over a period
  without returning rows — counts plus net/tax/gross sums grouped by
  month, status, contact or nothing, bounded output however large the
  ledger (groups beyond `maxGroups` fold into one "(andere)" entry).
- API errors now carry a `kind` (validation / auth / not_found /
  rate_limited / upstream / network) and surface sevDesk's own error
  message instead of a raw JSON dump.
- Tool listing carries standard MCP annotations
  (`readOnlyHint`/`destructiveHint`/`openWorldHint`) so clients can
  shape their confirmation UX.
- `SEVDESK_DEBUG=true` logs method/path/status to stderr — never query
  strings, bodies or the token.

- Invoice tax defaults follow the chosen *rule*: 0 %
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
