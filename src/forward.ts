/**
 * jpverify core: a forwarding client for the hosted
 * Hojincheck MCP server.
 *
 * Nothing is computed locally. tools/list is answered
 * from the literal tool definitions below, taken verbatim
 * from a live capture of the upstream server (name, title,
 * description and inputSchema exactly as captured; the
 * titles and descriptions are in Japanese and are served
 * byte-for-byte as captured). A tools/call is forwarded
 * over a streamable-HTTP JSON-RPC session: an initialize
 * POST, a notifications/initialized POST, then the
 * tools/call POST, honouring the Mcp-Session-Id response
 * header when the upstream issues one. The session is
 * established lazily on the first forwarded call and
 * reused for the lifetime of the client.
 *
 * The upstream endpoint is pinned to
 * https://hojincheck.com/mcp and can be overridden with
 * the HOJINCHECK_MCP_URL environment variable (that
 * override is a labelled reconstruction). When
 * HOJINCHECK_API_KEY is set in the environment, every
 * upstream request carries an
 * `Authorization: Bearer <key>` header (the Authorization
 * header name and Bearer form are pinned by the registry
 * record's own example; forwarding the key from this env
 * var is a labelled reconstruction — the capture itself
 * was taken keyless). When the variable is unset, no
 * key header is sent.
 *
 * Upstream results pass through verbatim, including any
 * isError flag and any extra result fields. Failures — a
 * JSON-RPC error from the upstream, a non-2xx status, an
 * unparseable response, or a fetch that throws or times
 * out — surface as an isError result whose text starts
 * with `jpverify error:` (that rendering is a labelled
 * reconstruction). Responses may be plain JSON or SSE
 * (data: lines); the JSON-RPC message with the matching
 * id wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://hojincheck.com/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/hojincheck-tools-original.json)         */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "resolve_company",
    "title": "法人名から法人番号を解決",
    "description": "法人名（表記ゆれ・かな/カナ対応）から法人番号の候補と確度（0〜1＋根拠ラベル）を返します。データ源: 国税庁法人番号システムWeb-API。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100,
          "description": "法人名（(株)等の略記・全半角・かな/カナ・旧字体の表記ゆれ可）"
        },
        "address": {
          "type": "string",
          "pattern": "^\\d{2}(\\d{3})?$",
          "description": "所在地で絞り込み: 都道府県コード2桁（JIS X 0401）または+市区町村コード3桁の計5桁"
        },
        "include_closed": {
          "type": "boolean",
          "default": true,
          "description": "閉鎖法人を候補に含める（既定true）"
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50,
          "default": 10,
          "description": "返却する候補数の上限（既定10）"
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "verify_company",
    "title": "法人番号の実在検証",
    "description": "法人番号（13桁・チェックディジット検証つき）から実在・商号・本店所在地・法人種別・閉鎖ステータスを返します。include_history=trueで商号変更等の履歴も返します。データ源: 国税庁法人番号システムWeb-API。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "corporate_number": {
          "type": "string",
          "minLength": 1,
          "maxLength": 30,
          "description": "法人番号13桁（全角・ハイフン・空白は吸収）"
        },
        "include_history": {
          "type": "boolean",
          "default": false,
          "description": "商号変更等の履歴を含める（既定false）"
        }
      },
      "required": [
        "corporate_number"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "verify_invoice_number",
    "title": "適格請求書発行事業者登録番号の検証",
    "description": "適格請求書発行事業者の登録番号（T+13桁）から登録有無・登録年月日・取消/失効を返します。on_dateで基準日時点の有効性判定、include_history=trueで公表履歴も返します。入力は登録番号のみ（氏名等による検索は提供しません）。データ源: 国税庁適格請求書発行事業者公表システムWeb-API。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "registration_number": {
          "type": "string",
          "minLength": 1,
          "maxLength": 30,
          "description": "適格請求書発行事業者登録番号（T+13桁。Tなし13桁・全角・ハイフン空白は吸収）"
        },
        "on_date": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
          "description": "基準日 YYYY-MM-DD（指定時はその日時点で登録が有効だったかを as_of で返す）"
        },
        "include_history": {
          "type": "boolean",
          "default": false,
          "description": "公表履歴（新規登録・変更・取消・失効）を含める（既定false）"
        }
      },
      "required": [
        "registration_number"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "get_company_profile",
    "title": "法人プロファイル取得（gBizINFO）",
    "description": "法人番号（13桁・チェックディジット検証つき）からgBizINFOの法人プロファイル（所在地・代表者・資本金・従業員数等）を、項目別の出典・最終取得日メタとあわせて返します。データ源: Gビズインフォ REST API v2（経済産業省）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "corporate_number": {
          "type": "string",
          "minLength": 1,
          "maxLength": 30,
          "description": "法人番号13桁（全角・ハイフン・空白は吸収。チェックディジット検証あり）"
        }
      },
      "required": [
        "corporate_number"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "normalize_address",
    "title": "日本住所の正規化・要素分解・郵便番号照合",
    "description": "日本の住所を正規化し、都道府県／市区町村／町字（大字・町名＋丁目）に分解して町字ID（アドレス・ベース・レジストリ）を解決し、郵便番号と照合します（不一致は不一致として明示）。【v1の粒度と限界】分解は町字（大字・丁目）まで。街区符号・住居番号・地番・小字・京都の通り名は解析対象外で、未解析部分は残余文字列としてそのまま返します（推測補完なし）。データ源: アドレス・ベース・レジストリ町字マスター（デジタル庁）＋日本郵便郵便番号データ（ローカルマスター駆動・政府API停止の影響なし）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "address": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "日本の住所文字列（郵便番号含み可。全半角・漢数字/算用数字・旧字体の表記ゆれ可）"
        },
        "postal_code": {
          "type": "string",
          "pattern": "^\\d{3}-?\\d{4}$",
          "description": "郵便番号を別引数で渡す場合に指定（住所文字列内の記載より優先して照合）"
        }
      },
      "required": [
        "address"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "jp_calendar",
    "title": "日本の祝日・営業日計算",
    "description": "日本の祝日判定と営業日計算（内閣府「国民の祝日」CSV準拠）。営業日=土日・祝日以外。year_end_as_holiday=trueで12/29〜1/3も非営業日扱い。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "op": {
          "type": "string",
          "enum": [
            "is_business_day",
            "next_business_day",
            "prev_business_day",
            "add_business_days",
            "list_holidays"
          ],
          "description": "操作種別"
        },
        "date": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
          "description": "基準日 YYYY-MM-DD（list_holidays以外で必須）"
        },
        "days": {
          "type": "integer",
          "minimum": -1000,
          "maximum": 1000,
          "description": "加算する営業日数（add_business_daysで必須。負数=遡り、0=基準日をそのまま返す）"
        },
        "from": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
          "description": "期間開始日（list_holidaysで必須）"
        },
        "to": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
          "description": "期間終了日（list_holidaysで必須）"
        },
        "year_end_as_holiday": {
          "type": "boolean",
          "default": false,
          "description": "12/29〜1/3を非営業日として扱う（官公庁・銀行休業の慣行。既定false=祝日法と土日のみ）"
        }
      },
      "required": [
        "op"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  }
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` is one of the captured tools. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `jpverify error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Parse a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * one is present, else the last parseable message, else
 * null when nothing parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not JSON; ignore this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding one upstream session. The
 * session is established lazily on the first forwarded
 * call and reused for the lifetime of the client (the
 * process lifetime when the client is the MCP server's
 * or a one-shot client for the CLI).
 */
export class JpverifyClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).HOJINCHECK_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private apiKey(): string | null {
    const raw = (this.deps.env ?? process.env).HOJINCHECK_API_KEY;
    if (raw && raw.trim() !== "") return raw.trim();
    return null;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const key = this.apiKey();
    if (key !== null) headers["Authorization"] = `Bearer ${key}`;
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "jpverify", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // The notification response body carries nothing we need.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Pass the upstream result through verbatim.
    return result;
  }
}

/** Create a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): JpverifyClient {
  return new JpverifyClient(deps);
}

/** One-shot helper: a fresh client per call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new JpverifyClient(deps).callTool(name, args);
}
