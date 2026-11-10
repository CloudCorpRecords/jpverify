# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Hojincheck MCP server, serving all 6 captured tools locally for tools/list and forwarding every tools/call upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when issued).
- Tools: `resolve_company`, `verify_company`, `verify_invoice_number`, `get_company_profile`, `normalize_address`, `jp_calendar`. The captured tool titles and descriptions are in Japanese and are served verbatim.
- Upstream results pass through verbatim; upstream failures surface as `jpverify error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). Upstream endpoint overridable via `HOJINCHECK_MCP_URL`; when `HOJINCHECK_API_KEY` is set it is sent as an `Authorization: Bearer <value>` header on every upstream request.
