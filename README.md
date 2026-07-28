# sevdesk-mcp

An MCP server for the [sevDesk](https://sevdesk.de) accounting API — **complete API coverage plus a bookkeeping audit layer**.

Most API wrappers stop at CRUD. This one also knows what a *wrong* booking looks like: a US supplier booked as domestic 0 % instead of Reverse Charge §13b, a net amount typed into a gross field, the same supplier booked three different ways, a subscription that silently stopped appearing in March.

> **Status: work in progress (v0.1.0).** Builds, typechecks and passes its unit tests. The audit tools have **not yet been run against a live sevDesk account** — see [Roadmap](#roadmap).

## Why

sevDesk models VAT through `taxRule` (API 2.0) or the older `taxType` (API 1.0):

| taxRule | Meaning | Rates | Legacy `taxType` |
|---|---|---|---|
| `1` | Umsatzsteuerpflichtige Umsätze | 0 / 7 / 19 % | `default` |
| `2` | Ausfuhren | 0 % | — |
| `3` | Innergemeinschaftliche Lieferungen | 0 / 7 / 19 % | `eu` |
| `4` | Steuerfreie Umsätze §4 UStG | 0 % | — |
| `5` | **Reverse Charge gem. §13b UStG** | 0 % | `noteu` |
| `11` | Steuer nicht erhoben nach §19 UStG | 0 % | `ss` |

A voucher from a supplier established abroad sitting at `taxRule 1` with a 0 % position is almost always a mis-booking. It costs no tax — reverse charge nets to zero — but it silently drops the §13b turnover out of your VAT return. A CSV export cannot show you this, because it only carries the *rate*, not the *rule*. `sevdesk_audit_vat` finds it.

## Tools

**16 tools cover all 151 API operations.**

### Audit (the reason this exists)

| Tool | What it does |
|---|---|
| `sevdesk_audit_vat` | Flags reverse-charge mis-bookings, rates that contradict the tax rule, sums that don't add up, suppliers booked inconsistently |
| `sevdesk_reverse_charge_report` | Totals the §13b tax base for a period and lists vouchers that look like they belong in it but aren't |
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
git clone https://github.com/YOUR-USER/sevdesk-mcp
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
| `SEVDESK_READ_ONLY` | `false` | Hide and refuse every write tool |
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

- [ ] Validate every audit tool against a live account (**not yet done**)
- [ ] Confirm `/VoucherPos` bulk filtering; currently one request per voucher, capped at 5 concurrent
- [ ] Integration tests against a sevDesk sandbox
- [ ] Cache the voucher list within a session — the audit tools each re-fetch
- [ ] Export helpers for the annual VAT return (Kz 46 / 47)
- [ ] `looksForeign()` is a legal-suffix heuristic; use the contact's country or VAT ID where present

## Prior art

[`nikolausm/mcp-sevdesk`](https://github.com/nikolausm/mcp-sevdesk) covers the CRUD surface with hand-written tools. This project differs in two ways: complete endpoint coverage through a generated catalogue instead of a curated subset, and the audit layer above.

## License

MIT
