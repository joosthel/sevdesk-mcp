# Contributing

Contributions are welcome — bug reports with the failing request shape are the most valuable kind.

## Setup

```bash
git clone https://github.com/joosthel/sevdesk-mcp
cd sevdesk-mcp
npm install
npm run build     # regenerates src/generated/catalog.ts and compiles to dist/
npm test          # vitest, no API token needed — everything runs against stubs
npm run typecheck
```

To run the server against a real account, copy `.env.example` to `.env` and put your
token in it — `npm run dev` and `node dist/index.js` read it automatically, so the token
stays out of your shell history:

```bash
cp .env.example .env   # then fill in SEVDESK_API_TOKEN; .env is gitignored
npm run dev
```

The file is read from the package root (never the working directory), and real
environment variables always win over it — so an MCP client's `env` block keeps
overriding a stale `.env`. Inline variables still work if you prefer:
`SEVDESK_API_TOKEN=... SEVDESK_READ_ONLY=true npm run dev`.

## Ground rules

- **Tests first.** Every behavior change comes with a test that fails before the change. The suites stub the HTTP client — no network, no token.
- **Safety is not negotiable.** Write tools stay behind the read-only gate, accept `dryRun`, default to drafts, and verify their changes by reading back. New tools that touch the filesystem go through the `SEVDESK_RECEIPT_DIRS` allowlist.
- **Domain facts need a source.** Tax-rule changes cite the sevDesk OpenAPI document (`openapi/sevdesk-openapi.yaml`) or observed live behavior — never assumption.
- **Keep it lean.** No new runtime dependencies without a strong reason; match the existing style.

## Updating the API catalogue

When sevDesk publishes a new OpenAPI document, replace `openapi/sevdesk-openapi.yaml` and run `npm run build:catalog` — the operation catalogue regenerates without code changes.

## Releases

Maintainer-only: bump the version in `package.json` and `src/server.ts`, update `CHANGELOG.md`, tag `vX.Y.Z`, push the tag — the release workflow publishes to npm and attaches the MCPB bundle.
