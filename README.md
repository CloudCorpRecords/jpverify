# jpverify

jpverify is a small local bridge to the hosted
Hojincheck MCP server, which verifies Japanese
companies against Japanese government open data. Give
it a company name and it returns corporate-number
candidates; give it a 13-digit corporate number and it
checks that the company exists, reads its profile, or
verifies a qualified-invoice registration number. It
also normalizes Japanese addresses and answers
Japanese holiday and business-day questions.

The bridge keeps no register data of its own. It
serves the upstream server's tool list locally,
exactly as captured from the live endpoint (the tool
titles and descriptions are in Japanese and are
served verbatim), and forwards each tool call
upstream, returning the result untouched. The surface
covers public business-register data only: there is
no personal-data screening tool in it.

## Tools

- `resolve_company` — resolve a company name to
  corporate-number candidates, with a confidence score
  and reason label per candidate. Required: `name`.
  Optional: `address` (prefecture or municipality code
  filter), `include_closed` (defaults to true) and
  `limit` (defaults to 10, max 50). Source: the
  National Tax Agency corporate-number system.
- `verify_company` — verify a 13-digit corporate
  number (check-digit validated) and return existence,
  trade name, head-office address, entity type and
  closed status. Required: `corporate_number`.
  Optional: `include_history` (defaults to false).
- `verify_invoice_number` — verify a qualified-invoice
  issuer registration number (T + 13 digits) and
  return registration status, registration date and
  any cancellation or expiry. Required:
  `registration_number`. Optional: `on_date`
  (YYYY-MM-DD validity check) and `include_history`
  (defaults to false).
- `get_company_profile` — read a company profile from
  gBizINFO for a corporate number, with per-field
  source and last-fetched metadata. Required:
  `corporate_number`.
- `normalize_address` — normalize a Japanese address,
  split it into prefecture, municipality and town
  components, resolve the town identifier, and check
  it against the postal code. Required: `address`.
  Optional: `postal_code`.
- `jp_calendar` — Japanese holiday and business-day
  calculation. Required: `op`, one of
  `is_business_day`, `next_business_day`,
  `prev_business_day`, `add_business_days` and
  `list_holidays`. The other arguments (`date`,
  `days`, `from`, `to`, `year_end_as_holiday`) depend
  on the operation.

## Configuration

- `HOJINCHECK_MCP_URL` (optional) — override the
  upstream endpoint. Defaults to
  `https://hojincheck.com/mcp`. (The override hook is
  this rebuild's own labelled reconstruction.)
- `HOJINCHECK_API_KEY` (optional) — when set, every
  upstream request carries an
  `Authorization: Bearer <key>` header, for the
  caller's own Hojincheck key (a free key from the
  service). When it is not set, no key header is sent.
  (The header name and Bearer form are pinned by the
  original's registry record; forwarding the key from
  this env var is a labelled reconstruction — the
  original surface was captured keyless.)

### Forwarding mechanics

On the first tool call the client opens a streamable
HTTP session with the upstream: a JSON-RPC
`initialize` request (protocolVersion `2025-03-26`,
clientInfo name `jpverify`), then a
`notifications/initialized` notification, then the
`tools/call` request carrying the caller's arguments
unchanged. When the upstream answers `initialize`
with an `Mcp-Session-Id` header, that value rides on
every later request of the session, which is reused
for the life of the process. Replies may arrive as
plain JSON or as server-sent events; both are read.

Successful upstream results pass through verbatim,
including any `isError` flag the upstream sets.
Failures — a JSON-RPC error, a non-2xx status, an
unreadable response, or a request that cannot be
completed — come back as an `isError` result whose
text starts with `jpverify error:` (this rendering is
this rebuild's own labelled reconstruction).

## CLI

Each tool is also a subcommand taking one JSON
argument string:

```bash
npx @reneturcios/jpverify resolve_company '{"name":"Example K.K."}'
npx @reneturcios/jpverify verify_company '{"corporate_number":"1234567890123"}'
npx @reneturcios/jpverify jp_calendar '{"op":"is_business_day","date":"2026-01-01"}'
npx @reneturcios/jpverify --version
```

Exit codes: `0` on success, `1` on an `isError`
result, `2` on a usage error.

## MCP server

```bash
npx -y @reneturcios/jpverify mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "jpverify": {
      "command": "npx",
      "args": ["-y", "@reneturcios/jpverify", "mcp"]
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/jpverify
docker run --rm ghcr.io/cloudcorprecords/jpverify --version
```

The container's default command is `mcp`, so the first
form is a stdio MCP server; any other arguments reach
the CLI normally.

## Development

```bash
npm install
npm run build
npm test
npm run dev
```

The test suite runs entirely against a stubbed
JSON-RPC upstream — no live network calls.

## License

MIT — see `LICENSE`.
