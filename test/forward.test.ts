import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  JpverifyClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream
 * implementing the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, no live call — the real Hojincheck
 * endpoint is never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/hojincheck-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"candidates\":[],\"count\":0}" }],
  structuredContent: { count: 0 },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-xyz" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "hojincheck", version: "0.1.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new JpverifyClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 6 tools, deep-equal", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 6);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 6 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, [
      "resolve_company",
      "verify_company",
      "verify_invoice_number",
      "get_company_profile",
      "normalize_address",
      "jp_calendar",
    ]);
  });

  it("carries a title key on every tool, as captured", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].title, fixture.tools[i].title);
      assert.deepEqual(Object.keys(TOOL_DEFS[i]).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("serves the Japanese descriptions byte-exactly", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
      assert.equal(
        Buffer.from(TOOL_DEFS[i].description, "utf-8").toString("hex"),
        Buffer.from(fixture.tools[i].description, "utf-8").toString("hex"),
      );
    }
  });

  it("carries exactly the fixture's required fields per tool", () => {
    const required = new Map(
      TOOL_DEFS.map((t) => [
        t.name,
        (t.inputSchema as { required?: string[] }).required ?? [],
      ]),
    );
    assert.deepEqual(required.get("resolve_company"), ["name"]);
    assert.deepEqual(required.get("verify_company"), ["corporate_number"]);
    assert.deepEqual(required.get("verify_invoice_number"), [
      "registration_number",
    ]);
    assert.deepEqual(required.get("get_company_profile"), ["corporate_number"]);
    assert.deepEqual(required.get("normalize_address"), ["address"]);
    assert.deepEqual(required.get("jp_calendar"), ["op"]);
  });

  it("carries every fixture property, in order, per tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < fixture.tools.length; i++) {
      const served = Object.keys(
        (TOOL_DEFS[i].inputSchema as { properties: object }).properties,
      );
      const expected = Object.keys(
        (fixture.tools[i].inputSchema as { properties: object }).properties,
      );
      assert.deepEqual(served, expected);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool("resolve_company", { name: "Example K.K." });
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://hojincheck.com/mcp");

    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, {
      name: "jpverify",
      version: VERSION,
    });
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(
        call.headers["Accept"],
        "application/json, text/event-stream",
      );
    }
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-xyz");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-xyz");
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("verify_company", { corporate_number: "1234567890123" });
    await c.callTool("jp_calendar", { op: "list_holidays", from: "2026-01-01", to: "2026-01-31" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-xyz");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool("verify_company", {
      corporate_number: "1234567890123",
    });
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the HOJINCHECK_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new JpverifyClient({
      fetchFn: upstream.fetchFn,
      env: { HOJINCHECK_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool("verify_company", { corporate_number: "1234567890123" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool("verify_company", { corporate_number: "1234567890123" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("upstream key header", () => {
  it("sends Authorization: Bearer <key> on every request when HOJINCHECK_API_KEY is set", async () => {
    const upstream = makeUpstream();
    const c = new JpverifyClient({
      fetchFn: upstream.fetchFn,
      env: { HOJINCHECK_API_KEY: "hojin-key-42" },
    });
    await c.callTool("verify_company", { corporate_number: "1234567890123" });
    assert.equal(upstream.calls.length, 3);
    assert.ok(
      upstream.calls.every(
        (call) => call.headers["Authorization"] === "Bearer hojin-key-42",
      ),
    );
  });

  it("sends no Authorization header when HOJINCHECK_API_KEY is unset", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("verify_company", { corporate_number: "1234567890123" });
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards resolve_company arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      name: "Example K.K.",
      address: "13",
      include_closed: false,
      limit: 5,
    };
    await c.callTool("resolve_company", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "resolve_company");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards verify_company arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { corporate_number: "1234567890123", include_history: true };
    await c.callTool("verify_company", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "verify_company");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards verify_invoice_number arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      registration_number: "T1234567890123",
      on_date: "2026-01-01",
      include_history: true,
    };
    await c.callTool("verify_invoice_number", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "verify_invoice_number");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards get_company_profile arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { corporate_number: "1234567890123" };
    await c.callTool("get_company_profile", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "get_company_profile");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards normalize_address arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { address: "Tokyo address example", postal_code: "100-0001" };
    await c.callTool("normalize_address", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "normalize_address");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards jp_calendar arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      op: "add_business_days",
      date: "2026-01-05",
      days: 3,
      year_end_as_holiday: true,
    };
    await c.callTool("jp_calendar", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "jp_calendar");
    assert.deepEqual(params.arguments, args);
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool("resolve_company", { name: "Example K.K." });
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "company not found" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool("verify_company", {
      corporate_number: "0000000000000",
    });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool("get_company_profile", {
      corporate_number: "1234567890123",
    });
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      "normalize_address",
      { address: "Tokyo address example" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "normalize_address");
    assert.deepEqual(params.arguments, { address: "Tokyo address example" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as jpverify error text", () => {
  it("maps a JSON-RPC error to `jpverify error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "company not found" },
    });
    const out = await c.callTool("verify_company", {
      corporate_number: "0000000000000",
    });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "jpverify error: company not found");
  });

  it("maps an initialize JSON-RPC error to jpverify error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool("verify_company", {
      corporate_number: "1234567890123",
    });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "jpverify error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool("verify_company", {
      corporate_number: "1234567890123",
    });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "jpverify error: malformed response");
  });

  it("maps a non-2xx upstream status to jpverify error text", async () => {
    const { client: c } = stubClient({
      callBodyText: "internal error",
      callStatus: 500,
    });
    const out = await c.callTool("verify_company", {
      corporate_number: "1234567890123",
    });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "jpverify error: HTTP 500");
  });

  it("maps a throwing fetch to jpverify error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool("verify_company", {
      corporate_number: "1234567890123",
    });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^jpverify error: /);
  });

  it("maps a throwing initialize fetch to jpverify error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool("verify_company", {
      corporate_number: "1234567890123",
    });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "jpverify error: socket hang up");
  });

  it("maps a timed-out call to jpverify error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool("verify_company", {
      corporate_number: "1234567890123",
    });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^jpverify error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) => err instanceof McpError,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects non-object arguments before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "resolve_company", ["nope"]),
      (err: unknown) => err instanceof McpError,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, "jp_calendar", {
      op: "is_business_day",
      date: "2026-01-01",
    });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {
      op: "is_business_day",
      date: "2026-01-01",
    });
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli(["resolve_company", "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli(["resolve_company", "[]"]);
    assert.equal(res.status, 2);
  });
});
