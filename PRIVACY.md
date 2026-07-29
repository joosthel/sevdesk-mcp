# Privacy Policy

**sevdesk-mcp** is a local tool. It runs entirely on your machine and has no backend of its own.

- **Your sevDesk API token** is provided by you via environment variables (or the extension's
  configuration screen), stays on your machine, and is sent exclusively as the authentication
  header of requests to the sevDesk API (`https://my.sevdesk.de/api/v1`, unless you override
  `SEVDESK_BASE_URL` yourself). It is never logged, stored elsewhere, or transmitted to any
  other party.
- **Your accounting data** flows only between your MCP client (e.g. Claude Desktop) and the
  sevDesk API. This server adds no storage, no analytics, no telemetry, and makes no network
  connections other than to the sevDesk API endpoint you configure.
- **Filesystem access** is disabled by default and limited to directories you explicitly
  allowlist via `SEVDESK_RECEIPT_DIRS`.
- **The authors of this project receive nothing**: no usage data, no crash reports, no
  identifiers.

Note that the content of tool responses (your accounting data) is visible to the MCP client
and the AI model you connect this server to — that is the point of the tool. Which model sees
it, and under which terms, is governed by your MCP client's own privacy policy, not by this
project.

Data processing by sevDesk itself is governed by sevDesk's privacy policy:
https://sevdesk.de/datenschutz/

Questions: open an issue at https://github.com/joosthel/sevdesk-mcp/issues
