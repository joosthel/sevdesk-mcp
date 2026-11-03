# Security

## Threat model in one paragraph

This server sits between an LLM client and your sevDesk account. The two assets
that matter are your **API token** (sevDesk tokens have no scopes — a token can
do everything your login can) and your **books** (an unwanted write is worse
than a failed read). The design treats the LLM as a fallible operator: every
guard lives in this server, not in the model's goodwill.

## Guarantees

- **The token stays in one place.** It is read from `SEVDESK_API_TOKEN`, sent
  only as the `Authorization` header to `SEVDESK_BASE_URL` (default
  `https://my.sevdesk.de/api/v1`), and appears in no log line, error message or
  tool output. The base URL must be `https://` (plain `http://` only for
  loopback), and redirects are never followed — a redirect would replay the
  request, token header included, to a URL nobody configured. Error messages carry the HTTP status, method, path and response
  body — never request headers.
- **Read-only is enforced three times.** With `SEVDESK_READ_ONLY=true`, write
  tools are hidden from the tool list, refused by the dispatcher if called
  anyway, and every mutating request is refused inside the HTTP client — a
  hallucinated tool call cannot bypass it. `sevdesk_call` classifies per call:
  besides every non-GET operation, the GETs that change state count as writes
  (`sendByWithRender`, a truthy `enshrine*` flag such as `enshrineDocuments`,
  and `preventSendBy` turned off), so they are refused in read-only mode and
  only previewed under `dryRun`.
- **Writes are guarded even when enabled.** `sevdesk_create_voucher` defaults
  to draft status (nothing is booked silently), `sevdesk_set_tax_rule` refuses
  enshrined vouchers and wrong-side rules and verifies its own result, and
  `SEVDESK_DRY_RUN=true` (or a per-call `dryRun`) previews any payload without
  sending it.
- **Curated booking is a separate opt-in.** The tools that book or remove
  payments (`sevdesk_link_transaction`, `sevdesk_reset_voucher_to_open`) are
  hidden and refused by the dispatcher unless `SEVDESK_ALLOW_BOOKING=true`.
  The flag does not restrict `sevdesk_call`, which can reach every endpoint
  whenever writes are enabled.
- **No filesystem access unless you grant it.** The receipt file tools are
  disabled until `SEVDESK_RECEIPT_DIRS` names an explicit allowlist of absolute
  directories; paths outside it are refused. Containment is checked on real
  paths, so a symlink inside an allowed directory cannot lead out of it.
- **Inputs are validated before they reach a URL.** Ids (`voucherId`,
  `invoiceId`, `contactId`, …) must be numeric, and `sevdesk_call` requires
  numeric path parameters (`.`/`..` are refused everywhere), so an argument
  cannot retarget a request. `limit`/`maxVouchers`/`maxItems` are clamped, and
  `sevdesk_create_voucher` refuses `extra` keys that would override its own
  guarded fields.
- **Reads stay reads.** `*GetPdf` operations called through `sevdesk_call`
  default `preventSendBy` to true (they would otherwise mark the document as
  sent); turning it off is refused under `SEVDESK_READ_ONLY=true`. A GET never
  carries a body.
- **`sevdesk_call` is flagged destructive.** It can reach any DELETE in the
  API, so it carries the MCP `destructiveHint`; the curated tools do not.
- **Bounded output.** A tool result is cut at 200,000 characters with a notice,
  so one broad list call cannot flood the model's context.
- **Minimal supply chain.** One runtime dependency
  (`@modelcontextprotocol/server`, the official MCP SDK), a committed lockfile,
  `npm ci` in CI, and GitHub Actions pinned to commit SHAs. No postinstall
  scripts, no telemetry, no network calls except to the sevDesk API.

## What this server cannot protect you from

- A compromised machine or MCP client config — the token lives in your client
  configuration; protect that file like a password.
- Prompt injection via your own bookkeeping data: supplier names and voucher
  descriptions flow into tool output that the LLM reads. Keep write mode off
  unless you are actively using it.

## Reporting a vulnerability

Open a [GitHub security advisory](https://github.com/joosthel/sevdesk-mcp/security/advisories/new)
or an issue (for non-sensitive reports). Please include the tool name, the
request that triggers the problem, and what you expected to happen.
