# sevdesk-mcp

An MCP server for the [sevDesk](https://sevdesk.de) accounting API — **complete API coverage plus a bookkeeping audit layer**.

Most API wrappers stop at CRUD. This one also knows what a *wrong* booking looks like: a US supplier booked as domestic 0 % instead of Reverse Charge §13b, a tax rule the booking account doesn't allow, a net amount typed into a gross field, the same supplier booked three different ways, a bank payment with no receipt behind it.

> **Status: v0.3.1.** Builds, typechecks, passes its unit tests, and validated against a live sevDesk account (bookkeeping system 2.0) — where it found exactly the class of mis-booking it was built for. See [CHANGELOG.md](CHANGELOG.md).

## Quick start

**You need:** [Node.js](https://nodejs.org) ≥ 20, a sevDesk account, and an MCP client (Claude Code, Claude Desktop, or any other).

**1. Install**

```bash
git clone https://github.com/joosthel/sevdesk-mcp
cd sevdesk-mcp
npm install
npm run build
```

**2. Get your API token**

In sevDesk: **Settings → Users → your user → API**. The token is a 32-character hex string.

> ⚠️ A sevDesk API token has **no scopes** — it can do everything your login can. Treat it like your password, and start in read-only mode.

**3. Connect your MCP client**

*Claude Code* — one command, then put your real token into the config it writes (`~/.claude.json`):

```bash
claude mcp add --scope user sevdesk \
  --env SEVDESK_API_TOKEN=REPLACE_ME \
  --env SEVDESK_READ_ONLY=true \
  -- node /absolute/path/to/sevdesk-mcp/dist/index.js
```

*Claude Desktop* — add to `claude_desktop_config.json` (**Settings → Developer → Edit Config**):

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "node",
      "args": ["/absolute/path/to/sevdesk-mcp/dist/index.js"],
      "env": {
        "SEVDESK_API_TOKEN": "your-token",
        "SEVDESK_READ_ONLY": "true"
      }
    }
  }
}
```

Any other MCP client works the same way: stdio transport, `node dist/index.js`, config via environment variables.

**4. First run**

Restart your client and ask it to run `sevdesk_ping`. You should see `ok: true`, your bookkeeping system version (2.0 = `taxRule`, 1.0 = legacy `taxType`) and the mode (`READ-ONLY`). Then start asking:

- *"Run a VAT audit for this year and explain every high-severity finding."*
- *"Are my US software subscriptions booked as reverse charge? What's my §13b base this quarter?"*
- *"Which bank payments have no receipt yet?"*
- *"Which booking accounts allow taxRule 12?"*
- *"Find duplicate bookings and drafts I forgot."*
- *"Call the sevDesk API: get the last 10 orders."* — the generic catalogue covers everything the curated tools don't.

**5. Enabling writes (optional, later)**

Once you trust the setup, set `SEVDESK_READ_ONLY` to `"false"` and restart the client. Prefer `SEVDESK_DRY_RUN=true` (or per-call `dryRun`) the first time — it shows exactly what would be sent without sending it. See [Write safety](#write-safety).

## Tools

**19 tools cover all 151 API operations.**

### Audit (the reason this exists)

| Tool | What it does |
|---|---|
| `sevdesk_audit_vat` | Flags reverse-charge mis-bookings, rules from the wrong side of the books, tax rules the booking account doesn't allow, rates that contradict the tax rule, sums that don't add up, suppliers booked inconsistently. Uses the supplier contact's country where available; falls back to a name heuristic |
| `sevdesk_reverse_charge_report` | Totals the §13b tax base for a period — split into nets-to-zero (rule 12/14), actually payable (rule 13) and own revenue (rule 5) — and lists vouchers that look like they belong in it but aren't |
| `sevdesk_find_duplicates` | Repeated document numbers, same supplier + amount within N days, vouchers stuck in Entwurf |
| `sevdesk_subscription_gaps` | Detects monthly cadences per supplier and reports the missing months |
| `sevdesk_diff_receipt_folder` | Diffs a local folder of receipt PDFs against booked vouchers, both directions (requires `SEVDESK_RECEIPT_DIRS`) |
| `sevdesk_reconcile_transactions` | Matches bank transactions against vouchers by amount and date proximity: payments without a receipt, vouchers without a payment |

### Everyday

`sevdesk_ping` · `sevdesk_list_vouchers` · `sevdesk_get_voucher` · `sevdesk_list_invoices` · `sevdesk_list_contacts` · `sevdesk_list_transactions` · `sevdesk_receipt_guidance` · `sevdesk_upload_voucher_file` · `sevdesk_create_voucher` · `sevdesk_set_tax_rule`

`sevdesk_receipt_guidance` answers "which booking account / tax rule / rate combinations does sevDesk actually accept" from sevDesk's own validation table. `sevdesk_set_tax_rule` rebooks a **draft** voucher onto a different VAT rule with guardrails — see [Write safety](#write-safety) for why it deliberately stops at drafts.

### Full coverage

`sevdesk_list_operations` · `sevdesk_describe_operation` · `sevdesk_call`

Rather than registering 151 tools and swamping the client's tool list, the server ships a searchable catalogue generated from sevDesk's OpenAPI document. Search for what you need, read its signature, call it. Every endpoint is reachable.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SEVDESK_API_TOKEN` | *(required)* | Your sevDesk API token |
| `SEVDESK_READ_ONLY` | `false` | Hide write tools; `sevdesk_call` stays listed but refuses mutating operations at call time |
| `SEVDESK_DRY_RUN` | `false` | Show what a write *would* send, without sending it |
| `SEVDESK_RECEIPT_DIRS` | *(unset — file tools disabled)* | Colon-separated allowlist of directories the receipt file tools may read |
| `SEVDESK_BASE_URL` | `https://my.sevdesk.de/api/v1` | Override the API host |
| `SEVDESK_TIMEOUT_MS` | `30000` | Per-request timeout |
| `SEVDESK_MAX_RETRIES` | `3` | Retries on 429/5xx, with backoff and `Retry-After` |

The threat model, guarantees and vulnerability reporting are documented in [SECURITY.md](SECURITY.md).

## Write safety

Read-only mode is enforced twice: write tools are hidden from the tool list *and* every mutating request is refused inside the HTTP client. With writes enabled:

- `sevdesk_create_voucher` defaults to status `50` (Entwurf) — nothing is booked without you looking at it.
- `sevdesk_set_tax_rule` refuses enshrined vouchers and wrong-side rules, and verifies its change by reading the voucher back.
- **Booked and paid vouchers are deliberately out of scope for API rebooking.** The sevDesk API only updates drafts, and resetting a paid foreign-currency voucher recalculates its EUR amounts at today's exchange rate — silently changing historical values. Correct booked vouchers in the sevDesk UI, where the original amounts stay visible against the receipt.

## Why: the tax model

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

## Regenerating the catalogue

The operation catalogue is generated at build time from `openapi/sevdesk-openapi.yaml`. When sevDesk publishes a new spec, drop it in and rebuild — no code changes:

```bash
npm run build:catalog
```

## Development

```bash
npm run dev        # run from source
npm test           # unit tests
npm run typecheck  # tsc --noEmit
```

## Roadmap

- [x] Validate every audit tool against a live account (done, bookkeeping system 2.0, 2026-07)
- [x] Confirm `/VoucherPos` filtering by voucher id (works; one request per voucher, capped at 5 concurrent)
- [x] Use the contact's country where present instead of the name-suffix heuristic (done; the heuristic remains the fallback for suppliers without a contact record)
- [ ] Remote hosting via the Streamable HTTP transport with a per-request token — server assembly is already factored out of the stdio entry point (`src/server.ts`)
- [ ] Publish to npm for `npx` installs
- [ ] Integration tests against a sevDesk sandbox
- [ ] Cache the voucher list within a session — the audit tools each re-fetch
- [ ] Export helpers for the annual VAT return (Kz 46 / 47)

## Prior art

[`nikolausm/mcp-sevdesk`](https://github.com/nikolausm/mcp-sevdesk) covers the CRUD surface with hand-written tools. This project differs in two ways: complete endpoint coverage through a generated catalogue instead of a curated subset, and the audit layer above.

## License

MIT
