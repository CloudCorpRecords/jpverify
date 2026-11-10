# BUILD REPORT — jpverify

Rebuild of `com.hojincheck/hojincheck` v0.1.0 (remote-only, keyless capture)
as `@reneturcios/jpverify` 0.1.0 / `io.github.CloudCorpRecords/jpverify`.

## Fixture conflicts

**None.** The brief, the spec prose, and the fixture agree on all 6 tool
names and every required field. Required fields as served, taken from
the fixture (`harness/fixtures/hojincheck-tools-original.json`):

- `resolve_company` — required: `name`
- `verify_company` — required: `corporate_number`
- `verify_invoice_number` — required: `registration_number`
- `get_company_profile` — required: `corporate_number`
- `normalize_address` — required: `address`
- `jp_calendar` — required: `op`

The fixture's tool literals (name, title, description, inputSchema —
including every property description, the `jp_calendar` `op` enum, and
the Japanese titles and descriptions) are served verbatim from
`src/forward.ts`; this was verified by the registration-integrity test
(served tools/list deep-equals the fixture's 6 tool objects, in order,
with a separate byte-exact UTF-8 check on the Japanese descriptions)
and again by the parity harness. The capture carries a `title` key on
every tool — all six titles are served; a test asserts each served
tool carries exactly the keys `name`, `title`, `description`,
`inputSchema`. The `TOOL_DEFS` literals in `src/forward.ts` were
generated programmatically from the fixture JSON (parsed and
re-serialised with unescaped UTF-8) so the Japanese strings are
embedded byte-exactly, with no hand-transcription drift.

## What was built

All 19 factory files under `builds/jpverify/`:

- `package.json` (`@reneturcios/jpverify` 0.1.0, bin
  `jpverify` → `dist/cli.js`, deps exactly `@modelcontextprotocol/sdk ^1`
  + `zod ^3`; devDeps `@types/node ^20`, `tsx ^4`, `typescript ^5`)
- `server.json` (description exactly the prescribed 92-char string
  "Verify Japanese companies: corporate numbers, invoice registrations, profiles and addresses.";
  npm entry carries `"version": "0.1.0"`; OCI entry
  `ghcr.io/cloudcorprecords/jpverify:0.1.0` carries **no** version field)
- `Dockerfile` (node:20-alpine both stages; server-name label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/jpverify"`
  matches `server.json`)
- `tsconfig.json` (fleet-identical, 318 bytes), `.gitignore`,
  `package-lock.json`, `README.md` (fresh prose), `LICENSE` (MIT,
  Copyright (c) 2026 Rene Turcios), `CHANGELOG.md` (single 0.1.0 entry,
  2026-10-28)
- `src/index.ts`, `src/cli.ts`, `src/mcp.ts`, `src/types.ts`,
  `src/forward.ts` (core; exports `VERSION = "0.1.0"`)
- `test/forward.test.ts`
- `.github/workflows/{ci.yml, publish.yml, publish-container.yml,
  registry-publish.yml}` (container workflow: IMAGE
  `ghcr.io/cloudcorprecords/jpverify`, smoke assertion on server name
  `jpverify`)

Plus `BUILD-REPORT.md` (this file) and the `parity-out/` harness output.

## Design

- Forwarding client to `https://hojincheck.com/mcp` (pinned),
  overridable via `HOJINCHECK_MCP_URL` (labelled reconstruction).
  tools/call is forwarded as a streamable-HTTP JSON-RPC client:
  initialize (protocolVersion `2025-03-26`, clientInfo `jpverify`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; session established lazily and reused per client.
  Plain-JSON and SSE replies both parsed; the matching-id message
  wins; upstream results pass through verbatim (including `isError`
  and extra fields such as `structuredContent`).
- When `HOJINCHECK_API_KEY` is set, an `Authorization: Bearer <value>`
  header is sent on every upstream request (header name and Bearer
  form pinned by the registry record's own example; forwarding the key
  from this env var is a labelled reconstruction — the capture was
  keyless). When unset, no key header is sent. Both branches are
  covered by tests.
- Upstream failures (JSON-RPC error, non-2xx status, malformed body,
  throwing/timing-out fetch) surface as `jpverify error:` text
  results (labelled reconstruction).
- Registration via the MCP SDK **low-level** `Server` API
  (`ListToolsRequestSchema` / `CallToolRequestSchema` handlers) serving
  the fixture literals exactly; no `McpServer` + zod registration.
  `src/mcp.ts` also exports `createServer` / `startMcpServer` /
  `handleCallTool` so the MCP layer is testable without a transport;
  the CLI's `mcp` subcommand starts it over stdio.
- Core takes an injectable fetch (`ForwardDeps.fetchFn`), so all tests
  run against a stubbed JSON-RPC upstream. No live network calls in
  tests; no live call claimed anywhere. The captured surface is public
  business-register data (corporate numbers, invoice registrations,
  profiles, addresses, calendar); no personal-data screening or
  sending tool exists in the surface — none was added.

## Lockfile (Route 3, clean from birth)

Generated in a temp dir (`/tmp/jpverify-lock`) containing only the
new `package.json`: `npm install --package-lock-only --ignore-scripts
--offline`. Verified: parses, `name == @reneturcios/jpverify`,
**128 package entries**; placed into the build dir with matching
sha256 (`e25ffadc…c977` on both sides: full value
`e25ffadc951296027076088cfa32e6abb793a79e5e62bdb4c87c36cdee9fc977`).
Then `npm install --offline --ignore-scripts` in the build dir for
`node_modules`. No write-guard failure occurred; `dist/` was built
in-tree normally, so no /tmp dist staging was needed.

## Verification (all in the build dir unless noted)

- `npx tsc --noEmit` → exit 0
- `npm run build` → real `dist/` (cli.js 2293 B, forward.js 18262 B,
  mcp.js 2720 B, all non-empty, with `.d.ts` + source maps)
- `node dist/cli.js --version` → `0.1.0`; unknown subcommand → usage on
  stderr, exit 2
- `npm test` → **40 tests, 40 pass, 0 fail** (8 suites: registration
  integrity — served tools deep-equal the fixture's full 6 tool
  objects, names in order, title key on every tool, Japanese
  descriptions byte-exact, required fields and every property key in
  order per tool; session establishment/reuse/session-id handling;
  env URL override; Authorization Bearer header present on every
  request when the key is set / absent when unset; verbatim argument
  forwarding for all 6 tools; verbatim result pass-through incl.
  upstream isError and SSE; JSON-RPC/init/malformed/HTTP/throw/timeout
  failures → `jpverify error:`; parseRpcBody; MCP-layer validation;
  CLI --version / unknown exit 2 / bad-JSON exit 2)
- Parity: `python3 harness/parity.py --original
  harness/fixtures/hojincheck-tools-original.json --rebuild
  "stdio:node builds/jpverify/dist/cli.js mcp" --out
  builds/jpverify/parity-out` (run from `~/workspace/mcp-rebuild-100`)
  → **PASS, parity 100.0, 6/6 identical, no missing/extra/schema
  diffs** (see `parity-out/parity.json`)
- Consistency sweep: package.json version = server.json top-level =
  npm-entry version = OCI tag = core `VERSION` = CHANGELOG heading
  (0.1.0); package.json `mcpName` = server.json `name` = Dockerfile
  label; server.json description measured at 92 chars; OCI entry
  confirmed to have no `version` field.

Clean-room: all prose and code written fresh for jpverify; only the
mechanics were patterned on the sibling surveyloop build, and only the
fixture's tool literals are served verbatim.
