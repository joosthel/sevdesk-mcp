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
  tool output. Error messages carry the HTTP status, method, path and response
  body — never request headers.
- **Read-only by default is enforced twice.** With `SEVDESK_READ_ONLY=true`,
  write tools are hidden from the tool list *and* every mutating request is
  refused inside the HTTP client — a hallucinated tool call cannot bypass it.
- **Writes are guarded even when enabled.** `sevdesk_create_voucher` defaults
  to draft status (nothing is booked silently), `sevdesk_set_tax_rule` refuses
  enshrined vouchers and wrong-side rules and verifies its own result, and
  `SEVDESK_DRY_RUN=true` (or a per-call `dryRun`) previews any payload without
  sending it.
- **No filesystem access unless you grant it.** The receipt file tools are
  disabled until `SEVDESK_RECEIPT_DIRS` names an explicit directory allowlist;
  paths outside it are refused.
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
