// One isolated Codex app-server v2 thread/turn per pipeline sub-agent.
// Process ownership is in codex-app-server-agent.ts; this is a transport-free
// state machine. https://developers.openai.com/codex/app-server
import path from "node:path";
import fs from "node:fs";

export const CODEX_APP_SERVER_AGENT = "codex-app-server";
export const CODEX_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export type CodexMessage = Record<string, unknown>;
export interface CodexSessionOptions {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  networkAccess?: boolean;
}
export interface CodexSessionResult {
  code: 0 | 1 | 124 | 130;
  error?: string;
}
const object = (value: unknown): CodexMessage | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as CodexMessage : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const reason = (value: unknown): string | undefined => text(object(value)?.message)?.slice(0, 4096);
const MAX_TIMER_MS = 2_147_483_647;

export function codexTimeoutMs(seconds: number, name: string): number {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > MAX_TIMER_MS) {
    throw new Error(`${name} must be positive and no greater than ${MAX_TIMER_MS / 1000} seconds`);
  }
  return Math.max(1, Math.ceil(seconds * 1000));
}
export function codexAppServerSettings(env: NodeJS.ProcessEnv = process.env): { rpcTimeoutMs: number; networkAccess: boolean } {
  const network = env.AUTOILLUSTRATE_CODEX_NETWORK_ACCESS;
  if (network !== undefined && network !== "0" && network !== "1") {
    throw new Error("AUTOILLUSTRATE_CODEX_NETWORK_ACCESS must be 0 or 1");
  }
  return {
    rpcTimeoutMs: codexTimeoutMs(Number(env.AUTOILLUSTRATE_CODEX_RPC_TIMEOUT ?? 30), "AUTOILLUSTRATE_CODEX_RPC_TIMEOUT"),
    networkAccess: network !== "0",
  };
}

// Resolve before spawn changes cwd. Doctor and runtime use the SAME lookup,
// including relative PATH entries. Never interpret an override as shell argv.
export function codexAppServerBinary(env: NodeJS.ProcessEnv = process.env): string {
  const binary = env.AUTOILLUSTRATE_CODEX_BIN || "codex";
  return binary.includes(path.sep) ? path.resolve(binary) : binary;
}
export function findCodexAppServer(env: NodeJS.ProcessEnv = process.env): string | null {
  const binary = codexAppServerBinary(env);
  const candidates = path.isAbsolute(binary) ? [binary]
    : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir, binary));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // No fallback to a different executable when an override is invalid.
    }
  }
  return null;
}
function packageVersion(): string {
  try {
    return text(object(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")))?.version) ?? "unknown";
  } catch {
    return "unknown";
  }
}
const CLIENT_VERSION = packageVersion();
const usageKeys = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
export function usageTotals(value: unknown): CodexMessage | undefined {
  const total = object(object(value)?.total);
  if (!total) return undefined;
  if (usageKeys.some((key) => Object.hasOwn(total, key) && count(total[key]) === undefined)) return undefined;
  const entries = usageKeys.map((key) => [key, count(total[key])] as const).filter(([, value]) => value !== undefined);
  // A malformed/empty update must not erase previously reported accounting.
  return entries.length ? Object.fromEntries(entries) : undefined;
}
// Cumulative app-server totals -> AutoIllustrate's accounting fields. Codex
// counts cached input inside inputTokens; report the uncached remainder.
export function normalizeCodexUsage(total: CodexMessage | undefined): CodexMessage {
  const input = count(total?.inputTokens), cached = count(total?.cachedInputTokens), output = count(total?.outputTokens);
  return {
    inputTokens: input !== undefined && cached !== undefined && cached <= input ? input - cached : input,
    cacheReadTokens: cached !== undefined && (input === undefined || cached <= input) ? cached : undefined,
    cacheWriteTokens: count(total?.cacheWriteInputTokens), outputTokens: output,
    reasoningOutputTokens: count(total?.reasoningOutputTokens), totalTokens: count(total?.totalTokens),
  };
}

// Bounded newline framing with strict UTF-8, shared by every app-server client
// (this single-turn session and the multiplexed broker connection).
export class CodexLineDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private lineBuffer: Buffer = Buffer.alloc(0);
  private lineBytes = 0;
  private ended = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onError: (error: string) => void,
  ) {}

  get closed(): boolean { return this.ended; }

  push(chunk: Buffer): void {
    if (this.ended) return;
    let offset = 0;
    while (offset < chunk.length && !this.ended) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (this.lineBytes + segment.length > CODEX_MAX_MESSAGE_BYTES) {
        this.onError("app-server message exceeds 16 MiB");
        this.stop();
        return;
      }
      if (segment.length) {
        const needed = this.lineBytes + segment.length;
        if (needed > this.lineBuffer.length) {
          // Geometric growth bounds memory even if every chunk is one byte;
          // retaining millions of Buffer slices would not be a byte bound.
          const grown = Buffer.allocUnsafe(Math.min(CODEX_MAX_MESSAGE_BYTES,
            Math.max(65536, this.lineBuffer.length * 2, needed)));
          this.lineBuffer.copy(grown, 0, 0, this.lineBytes);
          this.lineBuffer = grown;
        }
        segment.copy(this.lineBuffer, this.lineBytes);
        this.lineBytes = needed;
      }
      if (newline < 0) break;
      this.flushLine();
      offset = newline + 1;
    }
  }
  private flushLine(): void {
    const bytes = this.lineBuffer.subarray(0, this.lineBytes);
    this.lineBytes = 0;
    let line: string;
    try { line = this.decoder.decode(bytes); }
    catch {
      this.onError("invalid UTF-8 on app-server stdout");
      this.stop();
      return;
    }
    this.onLine(line);
  }
  // Flush a final unterminated line, then stop accepting input.
  end(): void {
    if (this.ended) return;
    if (this.lineBytes) this.flushLine();
    this.stop();
  }
  stop(): void {
    this.ended = true;
    this.lineBuffer = Buffer.alloc(0); this.lineBytes = 0;
  }
}

export class CodexAppServerSession {
  private readonly lines = new CodexLineDecoder((line) => this.line(line), (error) => this.fail(error));
  private pending?: { id: number; method: string };
  private nextId = 1;
  private started = false;
  private threadId?: string;
  private turnId?: string;
  private announcedTurnId?: string;
  private earlyEvents: CodexMessage[] = [];
  private tokenUsage?: CodexMessage;
  private model?: string;
  private provider?: string;
  result?: CodexSessionResult;

  constructor(
    private readonly options: CodexSessionOptions,
    private readonly send: (message: CodexMessage) => void,
    private readonly onFinish: (result: CodexSessionResult) => void,
    // Only requests arm the per-RPC deadline. Notification chatter cannot keep
    // a hung handshake alive. Undefined clears it after a response or finish.
    private readonly onPending: (method?: string) => void = () => {},
  ) {
    this.model = options.model;
  }

  get pendingMethod(): string | undefined { return this.pending?.method; }

  start(): void {
    if (this.started || this.result) return;
    this.started = true;
    this.request("initialize", {
      clientInfo: { name: "autoillustrate", title: "AutoIllustrate", version: CLIENT_VERSION },
      capabilities: null,
    });
  }
  private write(message: CodexMessage): void {
    try { this.send(message); }
    catch (err) { this.fail(`cannot write to app-server: ${err instanceof Error ? err.message : String(err)}`); }
  }
  private request(method: string, params: CodexMessage): void {
    if (this.result) return;
    const id = this.nextId++;
    this.pending = { id, method };
    this.onPending(method);
    // Codex intentionally omits the jsonrpc field on its JSON-RPC transport.
    this.write({ id, method, params });
  }

  push(chunk: Buffer): void { this.lines.push(chunk); }
  private stopInput(): void { this.lines.stop(); }
  end(): void {
    if (this.lines.closed) return;
    this.lines.end();
    if (!this.result) this.fail("app-server closed stdout before the requested turn completed");
  }
  fail(error: string): void { this.finish({ code: 1, error: error.slice(0, 4096) }); }

  cancel(error: string, code: 124 | 130 = 130): void {
    if (this.result) return;
    const turnId = this.turnId ?? this.announcedTurnId;
    // Best effort: preserve timeout/cancellation even if the pipe is broken.
    // The process owner bounds shutdown; an interrupt response is not required.
    if (this.threadId && turnId) {
      try {
        this.send({ id: this.nextId++, method: "turn/interrupt", params: { threadId: this.threadId, turnId } });
      } catch { /* Process-group termination is the fallback. */ }
    }
    this.finish({ code, error: error.slice(0, 4096) });
  }
  private finish(result: CodexSessionResult): void {
    if (this.result) return;
    this.result = result;
    this.pending = undefined;
    this.onPending();
    this.onFinish(result);
    // Do NOT discard buffered frames: final usage can follow turn/completed in
    // the same chunk or while stdout drains. Only telemetry is accepted then.
  }

  private line(line: string): void {
    if (!line.trim()) return;
    let message: CodexMessage | undefined;
    try { message = object(JSON.parse(line)); }
    catch {
      this.fail("invalid JSON on app-server stdout");
      this.stopInput();
      return;
    }
    if (!message) { this.fail("app-server message must be a JSON object"); return; }
    if (this.result) {
      if (message.method === "thread/tokenUsage/updated" && !Object.hasOwn(message, "id")) this.notification(message);
      return;
    }
    if (typeof message.method === "string") {
      if (Object.hasOwn(message, "id")) this.serverRequest(message);
      else this.notification(message);
      return;
    }
    if (!Object.hasOwn(message, "id")) { this.fail("app-server response has neither a method nor an id"); return; }
    if (!this.pending || message.id !== this.pending.id) return;
    const method = this.pending.method;
    this.pending = undefined; this.onPending();
    if (Object.hasOwn(message, "error")) { this.fail(`${method}: ${reason(message.error) ?? "JSON-RPC error"}`); return; }
    const result = object(message.result);
    if (!result) { this.fail(`${method}: missing or invalid result`); return; }
    if (method === "initialize") {
      this.write({ method: "initialized", params: {} });
      this.request("thread/start", {
        cwd: path.resolve(this.options.cwd), approvalPolicy: "never",
        sandbox: "workspace-write", ephemeral: true,
        ...(this.options.model ? { model: this.options.model } : {}),
      });
    } else if (method === "thread/start") {
      const thread = object(result.thread);
      this.threadId = text(thread?.id);
      if (!this.threadId) { this.fail("thread/start: missing thread id"); return; }
      // Older builds may omit effective policy fields. Reject explicitly
      // conflicting policies rather than silently running unrestricted.
      if ((result.approvalPolicy !== undefined && result.approvalPolicy !== "never")
        || (object(result.sandbox)?.type !== undefined && object(result.sandbox)?.type !== "workspaceWrite")
        || (typeof result.cwd === "string" && path.resolve(result.cwd) !== path.resolve(this.options.cwd))) {
        this.fail("thread/start: effective cwd/permissions differ from the requested workspace-write, never-approve policy");
        return;
      }
      this.model = text(result.model) ?? this.model;
      this.provider = text(result.modelProvider) ?? text(thread?.modelProvider);
      this.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: this.options.prompt, text_elements: [] }],
        cwd: path.resolve(this.options.cwd), approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite", writableRoots: [path.resolve(this.options.cwd)],
          networkAccess: this.options.networkAccess ?? true,
          excludeTmpdirEnvVar: false, excludeSlashTmp: false,
        },
        ...(this.options.effort ? { effort: this.options.effort } : {}),
      });
    } else if (method === "turn/start") {
      const turn = object(result.turn);
      this.turnId = text(turn?.id);
      if (!this.turnId) { this.fail("turn/start: missing turn id"); return; }
      const early = this.earlyEvents; this.earlyEvents = [];
      for (const event of early) {
        if (!this.result || event.method === "thread/tokenUsage/updated") this.notification(event);
      }
      if (turn?.status === "failed" || turn?.status === "interrupted") {
        this.fail(`Codex turn ${turn.status}${reason(turn.error) ? `: ${reason(turn.error)}` : ""}`);
      }
      // Even a completed start acknowledgement is NOT success by itself.
    }
  }

  private serverRequest(message: CodexMessage): void {
    const method = String(message.method);
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.write({ id: message.id, result: { decision: "decline" } });
    } else if (method === "item/permissions/requestApproval") {
      this.write({ id: message.id, result: { permissions: {}, scope: "turn" } });
    } else if (method === "mcpServer/elicitation/request") {
      this.write({ id: message.id, result: { action: "decline", content: null } });
    } else if (method === "item/tool/requestUserInput") {
      this.write({ id: message.id, result: { answers: {} } });
    } else {
      this.write({ id: message.id, error: { code: -32601, message: "Unsupported noninteractive app-server request" } });
    }
    this.fail(`app-server requested ${method}; unattended invocation cannot provide approval or input`);
  }

  private notification(message: CodexMessage): void {
    const params = object(message.params);
    if (!params || !this.threadId || params.threadId !== this.threadId) return;
    if (message.method === "turn/started" && !this.result) {
      this.announcedTurnId = text(object(params.turn)?.id);
      return;
    }
    if (!["turn/completed", "thread/tokenUsage/updated", "error"].includes(String(message.method))) return;
    if (!this.turnId) {
      if (this.result) return;
      if (this.earlyEvents.length >= 64) { this.fail("too many app-server notifications before turn/start response"); return; }
      const turn = object(params.turn);
      this.earlyEvents.push({ method: message.method, params: {
        threadId: params.threadId, turnId: params.turnId,
        turn: turn ? { id: text(turn.id), status: text(turn.status), error: { message: reason(turn.error) } } : undefined,
        tokenUsage: message.method === "thread/tokenUsage/updated" ? { total: usageTotals(params.tokenUsage) } : undefined,
        willRetry: params.willRetry, error: { message: reason(params.error) },
      } });
      return;
    }
    if (message.method === "thread/tokenUsage/updated") {
      if (params.turnId === this.turnId) {
        const total = usageTotals(params.tokenUsage);
        if (total) this.tokenUsage = total; // cumulative total, not last iteration
      }
      return;
    }
    if (this.result) return;
    if (message.method === "error") {
      if (params.turnId === this.turnId && params.willRetry === false) this.fail(`Codex: ${reason(params.error) ?? "non-retryable turn error"}`);
      return;
    }
    const turn = object(params.turn);
    if (!turn || turn.id !== this.turnId) return;
    if (turn.status === "completed") this.finish({ code: 0 });
    else this.fail(`Codex turn ${String(turn.status ?? "unknown")}${reason(turn.error) ? `: ${reason(turn.error)}` : ""}`);
  }

  resultRecord(): CodexMessage {
    return { type: "codex.appServerResult", ...this.result, threadId: this.threadId,
      turnId: this.turnId ?? this.announcedTurnId, model: this.model, provider: this.provider };
  }
  usageRecord(): CodexMessage {
    const total = this.tokenUsage;
    return { type: "usage", usage: {
      agent: CODEX_APP_SERVER_AGENT, model: this.model, provider: this.provider,
      usageStatus: total && usageKeys.some((key) => count(total[key]) !== undefined) ? "reported" : "missing",
      pricingStatus: "missing",
      ...normalizeCodexUsage(total),
    } };
  }
}
