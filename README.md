# sevdesk-mcp

**English** · [Deutsch](README.de.md)

**The complete MCP server for [sevDesk](https://sevdesk.de): every API endpoint, guarded writes, and a built-in bookkeeping audit layer.**

Connect Claude (or any MCP client) to your sevDesk account: list and create vouchers and invoices, reconcile bank transactions, reach all 151 API operations — and run audits that know what a *wrong* booking looks like: a foreign supplier booked as domestic 0 % instead of Reverse Charge §13b, a tax rule the booking account doesn't allow, a payment with no receipt behind it.

> **Status: v0.4.0.** Live-validated against a real sevDesk account (bookkeeping system 2.0) — where the audit found exactly the class of mis-booking it was built for. See [CHANGELOG.md](CHANGELOG.md).

## Quick start

**You need:** [Node.js](https://nodejs.org) ≥ 22, a sevDesk account, and an MCP client (Claude Code, Claude Desktop, or any other).

**1. Get your API token**

In sevDesk: **Settings → Users → your user → API**. The token is a 32-character hex string.

> ⚠️ A sevDesk API token has **no scopes** — it can do everything your login can. Treat it like your password, and start in read-only mode.

**2. Connect your MCP client**

*Claude Code* — one command, then put your real token into the config it writes (`~/.claude.json`):

```bash
claude mcp add --scope user sevdesk \
  --env SEVDESK_API_TOKEN=REPLACE_ME \
  --env SEVDESK_READ_ONLY=true \
  -- npx -y sevdesk-mcp
```

*Claude Desktop* — add to `claude_desktop_config.json` (**Settings → Developer → Edit Config**):

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "sevdesk-mcp"],
      "env": {
        "SEVDESK_API_TOKEN": "your-token",
        "SEVDESK_READ_ONLY": "true"
      }
    }
  }
}
```

Any other MCP client works the same way: stdio transport, `npx -y sevdesk-mcp` (or `node dist/index.js` from a clone), config via environment variables. To run from source instead: `git clone https://github.com/joosthel/sevdesk-mcp && cd sevdesk-mcp && npm install && npm run build`.

**3. First run**

Restart your client and ask it to run `sevdesk_ping`. You should see `ok: true`, your bookkeeping system version (2.0 = `taxRule`, 1.0 = legacy `taxType`) and the mode (`READ-ONLY`). Then start asking:

- *"Run a VAT audit for this year and explain every high-severity finding."*
- *"Are my US software subscriptions booked as reverse charge? What's my §13b base this quarter?"*
- *"Which bank payments have no receipt yet?"*
- *"Draft an invoice for contact 1009: 3 days of consulting at 800 €."* (needs write mode)
- *"Which booking accounts allow taxRule 12?"*
- *"Call the sevDesk API: get the last 10 orders."* — the generic catalogue covers everything the curated tools don't.

**What a finding looks like:**

```json
{
  "severity": "high",
  "code": "zero_rate_booked_as_domestic",
  "voucher": "2026-06-24 · Acme Cloud, Inc. · 88.03 EUR · #INV-2043",
  "detail": "Booked as \"Vorsteuerabziehbare Aufwendungen\" (taxRule 9) but every position carries 0 % VAT, and the supplier's contact is registered in \"us\".",
  "suggestion": "If this is a service from a supplier established abroad, it is Reverse Charge: taxRule 12 (§13b Abs. 2, with input-tax deduction) …"
}
```

**4. Enabling writes (optional, later)**

Once you trust the setup, set `SEVDESK_READ_ONLY` to `"false"` and restart the client. Every write tool accepts `dryRun` (and honors the global `SEVDESK_DRY_RUN`) — it shows exactly what would be sent without sending it. See [Write safety](#write-safety).

## Tools

**23 tools cover all 151 API operations.**

### Audit

| Tool | What it does |
|---|---|
| `sevdesk_audit_vat` | Flags reverse-charge mis-bookings, rules from the wrong side of the books, tax rules the booking account doesn't allow, rates that contradict the tax rule, sums that don't add up, suppliers booked inconsistently. Uses the supplier contact's country where available |
| `sevdesk_reverse_charge_report` | Totals the §13b tax base for a period — split into nets-to-zero (rule 12/14), actually payable (rule 13) and own revenue (rule 5) |
| `sevdesk_find_duplicates` | Repeated document numbers, same supplier + amount within N days, vouchers stuck in Entwurf |
| `sevdesk_subscription_gaps` | Detects monthly cadences per supplier and reports the missing months |
| `sevdesk_diff_receipt_folder` | Diffs a local folder of receipt PDFs against booked vouchers, both directions (requires `SEVDESK_RECEIPT_DIRS`) |
| `sevdesk_reconcile_transactions` | Matches bank transactions against vouchers by amount and date proximity: payments without a receipt, vouchers without a payment |
| `sevdesk_invoice_aging` | Who owes you money and for how long: open invoices bucketed by days overdue, partially paid remainders, drafts never sent |

### Everyday

`sevdesk_ping` · `sevdesk_list_vouchers` · `sevdesk_get_voucher` · `sevdesk_list_invoices` · `sevdesk_list_contacts` · `sevdesk_list_transactions` · `sevdesk_receipt_guidance` · `sevdesk_upload_voucher_file` · `sevdesk_create_voucher` · `sevdesk_set_tax_rule` · `sevdesk_create_invoice` · `sevdesk_get_invoice_pdf` · `sevdesk_mark_invoice_sent`

Highlights: `sevdesk_receipt_guidance` answers "which booking account / tax rule / rate combinations does sevDesk actually accept" from sevDesk's own validation table. `sevdesk_set_tax_rule` rebooks a draft voucher onto a different VAT rule with guardrails. `sevdesk_create_invoice` always creates **drafts** — nothing reaches a customer without review. `sevdesk_get_invoice_pdf` saves the rendered PDF without touching the invoice's send state.

### Full coverage

`sevdesk_list_operations` · `sevdesk_describe_operation` · `sevdesk_call`

Rather than registering 151 tools and swamping the client's tool list, the server ships a searchable catalogue generated from sevDesk's OpenAPI document. Search for what you need, read its signature, call it. Every endpoint is reachable.

## Common workflows

The tools compose — these are everyday bookkeeping jobs, each a single prompt:

- **Month-end close:** *"Do a month-end check for June: pending drafts, bank payments without receipts, vouchers without payments, VAT findings, sums that don't add up."*
- **Chasing money:** *"Who owes me money? Show overdue invoices by age, and tell me which ones were never even marked as sent."*
- **Receipt discipline:** *"Compare my receipts folder with sevDesk and list what's missing on either side."* (needs `SEVDESK_RECEIPT_DIRS`)
- **Recurring costs:** *"Which subscriptions stopped appearing, and which suppliers am I booking inconsistently?"*
- **Before the VAT return:** *"Run the VAT audit and the §13b report for the quarter and summarize what my Steuerberater should know."*
- **Anything else:** *"Call the sevDesk API: …"* — orders, credit notes, exports, parts and every other endpoint are reachable through the catalogue.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SEVDESK_API_TOKEN` | *(required)* | Your sevDesk API token |
| `SEVDESK_READ_ONLY` | `false` | Hide write tools; `sevdesk_call` stays listed but refuses mutating operations at call time |
| `SEVDESK_DRY_RUN` | `false` | Show what a write *would* send, without sending it |
| `SEVDESK_KLEINUNTERNEHMER` | `false` | §19 UStG small-business scheme: audit suggestions point to the KU rule set (13/10/11), new invoices default to rule 11 at 0 % |
| `SEVDESK_RECEIPT_DIRS` | *(unset — file tools disabled)* | Colon-separated allowlist of directories the receipt file tools may read and write |
| `SEVDESK_BASE_URL` | `https://my.sevdesk.de/api/v1` | Override the API host |
| `SEVDESK_TIMEOUT_MS` | `30000` | Per-request timeout |
| `SEVDESK_MAX_RETRIES` | `3` | Retries on 429/5xx, with backoff and `Retry-After` |

The threat model, guarantees and vulnerability reporting are documented in [SECURITY.md](SECURITY.md).

## Privacy Policy

Everything runs locally: your token and accounting data flow only between your MCP client and the sevDesk API — no storage, no telemetry, no third parties. Full policy: [PRIVACY.md](PRIVACY.md).

## Write safety

Read-only mode is enforced three times: write tools are hidden from the tool list, the dispatcher refuses them, and the HTTP client refuses every mutating request independently. With writes enabled:

- Every write tool accepts a per-call `dryRun` and honors the global `SEVDESK_DRY_RUN`.
- `sevdesk_create_voucher` and `sevdesk_create_invoice` default to **drafts** — nothing is booked or sent silently.
- `sevdesk_set_tax_rule` and `sevdesk_mark_invoice_sent` refuse enshrined documents and verify their changes by reading the document back.
- There is deliberately **no email-send tool**, and `sevdesk_get_invoice_pdf` never overwrites an existing file.
- **Booked and paid vouchers are deliberately out of scope for API rebooking.** The sevDesk API only updates drafts, and resetting a paid foreign-currency voucher recalculates its EUR amounts at today's exchange rate — silently changing historical values. Correct booked vouchers in the sevDesk UI, where the original amounts stay visible against the receipt.

## The tax model

With sevdesk-Update 2.0, sevDesk models VAT through `taxRule` — split into a revenue set and an expense set. Older documents still carry the deprecated `taxType` string; the server understands both generations.

**Expense rules** (incoming vouchers, `creditDebit: "C"`):

| taxRule | Meaning | Rates | Legacy `taxType` |
|---|---|---|---|
| `8` | Innergemeinschaftliche Erwerbe | 0 / 7 / 19 % | — |
| `9` | Vorsteuerabziehbare Aufwendungen | 0 / 7 / 19 % | `default` |
| `10` | Nicht vorsteuerabziehbare Aufwendungen | 0 % | `ss` |
| `12` | **Reverse Charge §13b Abs. 2, mit Vorsteuerabzug** | 0 % | — |
| `13` | **Reverse Charge §13b, ohne Vorsteuerabzug** | 0 % | — |
| `14` | **Reverse Charge §13b Abs. 1, EU** | 0 % | — |
| `16` | Nicht steuerbar (Ausgabe) | 0 % | — |

**Revenue rules** (outgoing documents, `creditDebit: "D"`):

| taxRule | Meaning | Rates | Legacy `taxType` |
|---|---|---|---|
| `1` | Umsatzsteuerpflichtige Umsätze | 0 / 7 / 19 % | `default` |
| `2` | Ausfuhren | 0 % | — |
| `3` | Innergemeinschaftliche Lieferungen | 0 / 7 / 19 % | `eu` |
| `4` | Steuerfreie Umsätze §4 UStG | 0 % | — |
| `5` | **Reverse Charge §13b (Feld 60)** | 0 % | — |
| `11` | Steuer nicht erhoben nach §19 UStG | 0 % | `ss` |
| `17` | Nicht im Inland steuerbare Leistung | 0 % | `noteu` |
| `22` | Nicht steuerbar (Einnahme) | 0 % | — |

(Rules 18–21 — One Stop Shop and §18b — exist on invoices but are not accepted on vouchers; the audit flags them if they appear anyway.)

The classic mis-booking: a subscription from a supplier established abroad, booked as a plain domestic expense (`taxRule 9`) with a 0 % position. It looks harmless — reverse charge nets to zero for anyone with input-tax deduction — but it silently drops the §13b tax base out of your VAT return. The correct booking is `taxRule 12` (or 13/14, depending on your situation). A CSV export cannot show you the difference, because it only carries the *rate*, not the *rule*. `sevdesk_audit_vat` finds it.

## Development

```bash
npm run dev        # run from source
npm test           # unit tests
npm run typecheck  # tsc --noEmit
npm run build:catalog  # regenerate the operation catalogue from openapi/sevdesk-openapi.yaml
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- [x] Live validation against a real account (bookkeeping system 2.0)
- [x] Contact-country detection, booking-account guidance checks, bank reconciliation
- [x] Guarded invoice workflow (draft-only creation, PDF export, mark-as-sent)
- [ ] Remote hosting via the Streamable HTTP transport with a per-request token — server assembly is already transport-agnostic (`src/server.ts`)
- [ ] Compile-time endpoint types generated from the OpenAPI spec
- [ ] Integration tests against a sevDesk sandbox
- [ ] Export helpers for the annual VAT return (Kz 46 / 47)

## License

MIT
