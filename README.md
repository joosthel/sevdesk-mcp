# sevdesk-mcp

An MCP server for the [sevDesk](https://sevdesk.de) accounting API — **complete API coverage plus a bookkeeping audit layer**.

Most API wrappers stop at CRUD. This one also knows what a *wrong* booking looks like: a US supplier booked as domestic 0 % instead of Reverse Charge §13b, a net amount typed into a gross field, the same supplier booked three different ways, a subscription that silently stopped appearing in March.

> **Status: v0.2.0.** Builds, typechecks, passes its unit tests, and the audit tools have been validated against a live sevDesk account (bookkeeping system 2.0) — where they found exactly the class of mis-booking they were built for.

## Why

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

(Rules 18–21 — One Stop Shop and §18b — exist on invoices but are not accepted on vouchers; the audit flags them if they appear anyway.)

The classic mis-booking: a subscription from a supplier established abroad, booked as a plain domestic expense (`taxRule 9`) with a 0 % position. It looks harmless — reverse charge nets to zero for anyone with input-tax deduction — but it silently drops the §13b tax base out of your VAT return. The correct booking is `taxRule 12` (or 13/14, depending on your situation). A CSV export cannot show you the difference, because it only carries the *rate*, not the *rule*. `sevdesk_audit_vat` finds it.

## Tools

**16 tools cover all 151 API operations.**

### Audit (the reason this exists)

| Tool | What it does |
|---|---|
| `sevdesk_audit_vat` | Flags reverse-charge mis-bookings, rules from the wrong side of the books, rates that contradict the tax rule, sums that don't add up, suppliers booked inconsistently |
| `sevdesk_reverse_charge_report` | Totals the §13b tax base for a period — split into nets-to-zero (rule 12/14), actually payable (rule 13) and own revenue (rule 5) — and lists vouchers that look like they belong in it but aren't |
| `sevdesk_find_duplicates` | Repeated document numbers, same supplier + amount within N days, vouchers stuck in Entwurf |
| `sevdesk_subscription_gaps` | Detects monthly cadences per supplier and reports the missing months |
| `sevdesk_diff_receipt_folder` | Diffs a local folder of receipt PDFs against booked vouchers, both directions |

### Everyday

`sevdesk_ping` · `sevdesk_list_vouchers` · `sevdesk_get_voucher` · `sevdesk_list_invoices` · `sevdesk_list_contacts` · `sevdesk_list_transactions` · `sevdesk_upload_voucher_file` · `sevdesk_create_voucher`

### Full coverage

`sevdesk_list_operations` · `sevdesk_describe_operation` · `sevdesk_call`

Rather than registering 151 tools and swamping the client's tool list, the server ships a searchable catalogue generated from sevDesk's OpenAPI document. Search for what you need, read its signature, call it. Every endpoint is reachable.

## Install

```bash
git clone https://github.com/joosthel/sevdesk-mcp
cd sevdesk-mcp
npm install
npm run build
```

Add to your MCP client configuration:

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

Get the token from sevDesk under **Settings → Users → your user → API**.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SEVDESK_API_TOKEN` | *(required)* | Your sevDesk API token |
| `SEVDESK_READ_ONLY` | `false` | Hide write tools; `sevdesk_call` stays listed but refuses mutating operations at call time |
| `SEVDESK_DRY_RUN` | `false` | Show what a write *would* send, without sending it |
| `SEVDESK_RECEIPT_DIRS` | *(unset)* | Colon-separated allowlist of directories the file tools may touch |
| `SEVDESK_BASE_URL` | `https://my.sevdesk.de/api/v1` | Override the API host |
| `SEVDESK_TIMEOUT_MS` | `30000` | Per-request timeout |
| `SEVDESK_MAX_RETRIES` | `3` | Retries on 429/5xx, with backoff and `Retry-After` |

**A sevDesk API token has no scopes — it can do everything your login can.** Start with `SEVDESK_READ_ONLY=true` and only relax it once you trust the setup. `sevdesk_create_voucher` defaults to status `50` (Entwurf) so nothing is booked without you looking at it.

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
- [ ] `looksForeign()` is a legal-suffix heuristic and misses foreign suppliers without one (e.g. a bare "Org"); use the contact's country or VAT ID where present
- [ ] Remote hosting via the Streamable HTTP transport with a per-request token — server assembly is already factored out of the stdio entry point (`src/server.ts`)
- [ ] Publish to npm for `npx` installs
- [ ] Integration tests against a sevDesk sandbox
- [ ] Cache the voucher list within a session — the audit tools each re-fetch
- [ ] Export helpers for the annual VAT return (Kz 46 / 47)

## Prior art

[`nikolausm/mcp-sevdesk`](https://github.com/nikolausm/mcp-sevdesk) covers the CRUD surface with hand-written tools. This project differs in two ways: complete endpoint coverage through a generated catalogue instead of a curated subset, and the audit layer above.

## License

MIT
