// Codex vision/image broker. The Python audit and enhance scripts run inside
// the coding agent's sandbox (Phases 3/6), where a nested `codex exec` cannot
// start, and they must not hold OAuth credentials. The orchestrator therefore
// owns app-server children OUTSIDE that sandbox and exposes exactly two narrow
// operations on a loopback HTTP endpoint guarded by a capability token:
//
//   POST /v1/vision  {instructions?, input: [text|image], schema?, effort?}
//   POST /v1/image   {prompt, image?}
//   POST /v1/export  {input, output, widthPx? | scale?}   (when an exporter is given)
//
// The export route exists because draw.io (Electron) aborts inside the Codex
// agent's Seatbelt sandbox; the orchestrator runs the hardened exporter for
// .drawio -> .png paths confined to the run workdir.
//
// Every request is one ephemeral, read-only, no-network, never-approve thread
// whose app-server was started with its tools disabled, so a prompt-injected
// figure cannot turn an audit into file access. The endpoint and token are
// published in <workdir>/.codex-broker.json (mode 0600) for the scripts.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  CODEX_MAX_MESSAGE_BYTES, codexAppServerBinary, codexAppServerSettings, findCodexAppServer,
  normalizeCodexUsage, usageTotals, type CodexMessage,
} from "./codex-app-server.js";
import { CodexRpcConnection } from "./codex-rpc.js";
import { logInfo } from "./log.js";

export const CODEX_BROKER_FILE = ".codex-broker.json";
// Tool surfaces an audit or restyle turn never needs. Disabled per process,
// before any model output exists, so a turn cannot re-enable them.
export const CODEX_BROKER_DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "apps", "plugins", "remote_plugin",
  "browser_use", "browser_use_external", "in_app_browser", "computer_use",
  "memories", "multi_agent", "hooks", "goals", "tool_suggest", "skill_search",
  "skill_mcp_dependency_install", "sleep_tool",
];
// Vision turns get no tools at all. Image turns need image generation, which
// Codex (0.163) exposes through the code-mode host; shell stays disabled there.
export const CODEX_BROKER_VISION_ONLY_DISABLED = ["image_generation", "code_mode_host"];
const CONFIG_OVERRIDES = ["mcp_servers={}", 'web_search="disabled"', "tools.view_image=false", "project_doc_max_bytes=0"];

// Codex rejects `--disable <name>` for a name it does not know (exit 2), and
// feature names change between releases. Disable only the names this binary
// lists: a feature it does not know cannot expose a tool. If the listing
// fails, pass the full list and let startup fail loudly rather than run open.
function knownFeatures(command: string, env: NodeJS.ProcessEnv): Promise<Set<string> | undefined> {
  return new Promise((resolve) => {
    execFile(command, ["features", "list"], { env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? undefined : new Set(stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean))));
  });
}
const EFFORTS = ["low", "medium", "high", "xhigh"];
const IMAGE_MIMES = ["image/jpeg", "image/png"];
const MAX_BODY_BYTES = 64 * 1024 * 1024;
// One turn's input must fit a single app-server frame, with headroom for the
// envelope; larger payloads are rejected (413) before they reach a child.
const MAX_TURN_INPUT_BYTES = CODEX_MAX_MESSAGE_BYTES - 1024 * 1024;
// Requests admitted at once, counted BEFORE their bodies are read, so a flood
// of large uploads cannot exhaust memory while waiting for a turn slot.
const MAX_ADMITTED = 64;
const MAX_INPUT_ITEMS = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_CONCURRENCY = 8; // matches verify.py's unit-test fan-out default
const EXPORT_CONCURRENCY = 4; // each export is a full Electron (or Chrome) process
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type Profile = "vision" | "image";
export interface BrokerExportRequest {
  drawioPath: string;
  pngOut: string;
  widthPx?: number;
  scale?: number;
}
export interface CodexBrokerOptions {
  workdir: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maxConcurrency?: number;
  // Serves /v1/export when set; the pipeline passes the hardened exporter.
  exportDrawio?: (req: BrokerExportRequest) => Promise<void>;
}
export interface CodexBroker {
  url: string;
  descriptorPath: string;
  scratchDir: string;
  close(): Promise<void>;
}

class BrokerError extends Error {
  // `wedged`: the child never answered a request in time; evict it.
  constructor(readonly status: number, message: string, readonly wedged = false) { super(message); }
}
const object = (value: unknown): CodexMessage | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as CodexMessage : undefined;
const reason = (value: unknown): string | undefined => {
  const message = object(value)?.message;
  return typeof message === "string" && message ? message.slice(0, 4096) : undefined;
};

function imageItem(value: unknown, where: string): CodexMessage {
  const item = object(value);
  if (!item || typeof item.mime !== "string" || !IMAGE_MIMES.includes(item.mime)) throw new BrokerError(400, `${where}: mime must be one of ${IMAGE_MIMES.join(", ")}`);
  if (typeof item.data !== "string" || !item.data || item.data.length % 4 !== 0 || !BASE64.test(item.data)) throw new BrokerError(400, `${where}: data must be base64`);
  return { type: "image", url: `data:${item.mime};base64,${item.data}` };
}
function effortOf(body: CodexMessage, fallback?: string): string | undefined {
  if (body.effort === undefined || body.effort === null) return fallback;
  if (typeof body.effort !== "string" || !EFFORTS.includes(body.effort)) throw new BrokerError(400, `effort must be one of ${EFFORTS.join(", ")}`);
  return body.effort;
}
function textItem(text: string): CodexMessage { return { type: "text", text, text_elements: [] }; }

function parseVision(body: CodexMessage): TurnRequest {
  const input = body.input;
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_INPUT_ITEMS) throw new BrokerError(400, `input must be 1-${MAX_INPUT_ITEMS} items`);
  const items = input.map((raw, i) => {
    const item = object(raw);
    if (item?.type === "text" && typeof item.text === "string" && item.text) return textItem(item.text);
    if (item?.type === "image") return imageItem(item, `input[${i}]`);
    throw new BrokerError(400, `input[${i}] must be a non-empty text or an image`);
  });
  if (body.instructions !== undefined && typeof body.instructions !== "string") throw new BrokerError(400, "instructions must be a string");
  if (body.schema !== undefined && body.schema !== null && !object(body.schema)) throw new BrokerError(400, "schema must be a JSON object");
  checkInputSize(items);
  return { profile: "vision", input: items, instructions: body.instructions as string | undefined,
    schema: object(body.schema), effort: effortOf(body, "high") };
}
function checkInputSize(items: CodexMessage[]): void {
  if (Buffer.byteLength(JSON.stringify(items)) > MAX_TURN_INPUT_BYTES) {
    throw new BrokerError(413, `turn input exceeds ${Math.floor(MAX_TURN_INPUT_BYTES / (1024 * 1024))} MiB`);
  }
}
function parseImage(body: CodexMessage): TurnRequest {
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new BrokerError(400, "prompt must be a non-empty string");
  const input = [textItem(body.prompt)];
  if (body.image !== undefined && body.image !== null) input.push(imageItem(body.image, "image"));
  checkInputSize(input);
  return { profile: "image", input, effort: effortOf(body) };
}

// Both paths absolute and, after resolving symlinks, inside the run workdir:
// the exporter runs unsandboxed, so it must not read or write elsewhere.
function parseExport(body: CodexMessage, root: string): BrokerExportRequest {
  const inside = (real: string) => real === root || real.startsWith(root + path.sep);
  const { input, output } = body;
  if (typeof input !== "string" || !path.isAbsolute(input) || !input.endsWith(".drawio")) throw new BrokerError(400, "input must be an absolute .drawio path");
  if (typeof output !== "string" || !path.isAbsolute(output) || !output.endsWith(".png")) throw new BrokerError(400, "output must be an absolute .png path");
  let realInput: string, realOutDir: string;
  try { realInput = fs.realpathSync(input); realOutDir = fs.realpathSync(path.dirname(output)); }
  catch { throw new BrokerError(400, "input and the output directory must exist"); }
  if (realInput === root || !inside(realInput) || !fs.statSync(realInput).isFile()) throw new BrokerError(400, "input must be a regular file inside the run workdir");
  if (!inside(realOutDir)) throw new BrokerError(400, "output must be inside the run workdir");
  const pngOut = path.join(realOutDir, path.basename(output));
  if (fs.existsSync(pngOut) && fs.lstatSync(pngOut).isSymbolicLink()) throw new BrokerError(400, "output must not be a symlink");
  const size = (key: "widthPx" | "scale"): number | undefined => {
    const value = body[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new BrokerError(400, `${key} must be a positive number`);
    return value;
  };
  const widthPx = size("widthPx"), scale = size("scale");
  if (widthPx !== undefined && scale !== undefined) throw new BrokerError(400, "widthPx and scale are mutually exclusive");
  return { drawioPath: realInput, pngOut, ...(widthPx !== undefined ? { widthPx } : {}), ...(scale !== undefined ? { scale } : {}) };
}

interface TurnRequest {
  profile: Profile;
  input: CodexMessage[];
  instructions?: string;
  schema?: CodexMessage;
  effort?: string;
}
interface TurnResult { text: string; images: CodexMessage[]; model?: string; usage: CodexMessage | null }

// Decline exactly as the native adapter does; then fail the request — an
// unattended audit can neither approve nor answer questions.
function declineServerRequest(conn: CodexRpcConnection, message: CodexMessage): string {
  const method = String(message.method);
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") conn.respond(message.id, { result: { decision: "decline" } });
  else if (method === "item/permissions/requestApproval") conn.respond(message.id, { result: { permissions: {}, scope: "turn" } });
  else if (method === "mcpServer/elicitation/request") conn.respond(message.id, { result: { action: "decline", content: null } });
  else if (method === "item/tool/requestUserInput") conn.respond(message.id, { result: { answers: {} } });
  else conn.respond(message.id, { error: { code: -32601, message: "Unsupported noninteractive app-server request" } });
  return `app-server requested ${method}; the broker cannot provide approval or input`;
}

// One ephemeral thread + turn. A single deadline (and the client's abort
// signal) bounds EVERY awaited RPC, not just the turn: a child that never
// answers thread/start or turn/start cannot hold a slot forever.
async function runTurn(
  conn: CodexRpcConnection, cwd: string, req: TurnRequest, model: string | undefined,
  timeoutMs: number, signal: AbortSignal,
): Promise<TurnResult> {
  let threadId: string | undefined;
  let turnId: string | undefined;
  let stoppedBy: BrokerError | undefined;
  let rejectStopped!: (err: BrokerError) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  stopped.catch(() => undefined);
  const interrupt = (id: string) => { if (threadId) conn.request("turn/interrupt", { threadId, turnId: id }).catch(() => undefined); };
  const stop = (err: BrokerError) => {
    if (stoppedBy) return;
    stoppedBy = err;
    if (turnId) interrupt(turnId);
    rejectStopped(err);
  };
  const timer = setTimeout(() => stop(new BrokerError(504, `Codex turn exceeded ${Math.round(timeoutMs / 1000)}s`, turnId === undefined)), timeoutMs);
  const onAbort = () => stop(new BrokerError(499, "client disconnected"));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const race = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, stopped]);
  const items: CodexMessage[] = [];
  let usage: CodexMessage | undefined;
  let unsubscribe = () => {};
  try {
    const started = await race(conn.request("thread/start", {
      cwd, approvalPolicy: "never", sandbox: "read-only", ephemeral: true,
      ...(req.instructions ? { developerInstructions: req.instructions } : {}),
      ...(model ? { model } : {}),
    }));
    const id = object(started.thread)?.id;
    if (typeof id !== "string" || !id) throw new BrokerError(502, "thread/start: missing thread id");
    threadId = id;
    const sandbox = object(started.sandbox)?.type;
    if ((sandbox !== undefined && sandbox !== "readOnly") || (started.approvalPolicy !== undefined && started.approvalPolicy !== "never")) {
      throw new BrokerError(502, `thread/start: effective sandbox/approval (${String(sandbox)}/${String(started.approvalPolicy)}) is not read-only/never`);
    }
    const finished = new Promise<CodexMessage>((resolve, reject) => {
      unsubscribe = conn.subscribe(id, (message) => {
        const params = object(message.params) ?? {};
        if (message.method === "connection/failed") reject(new BrokerError(502, reason(params.error) ?? "app-server connection failed"));
        else if (Object.hasOwn(message, "id")) reject(new BrokerError(502, declineServerRequest(conn, message)));
        else if (message.method === "item/completed" && object(params.item)) items.push(params.item as CodexMessage);
        else if (message.method === "thread/tokenUsage/updated") usage = usageTotals(params.tokenUsage) ?? usage;
        else if (message.method === "error" && params.willRetry === false) reject(new BrokerError(502, `Codex: ${reason(params.error) ?? "non-retryable turn error"}`));
        else if (message.method === "turn/completed") {
          const turn = object(params.turn) ?? {};
          if (turn.status === "completed") resolve(turn);
          else reject(new BrokerError(502, `Codex turn ${String(turn.status ?? "unknown")}${reason(turn.error) ? `: ${reason(turn.error)}` : ""}`));
        }
      });
    });
    finished.catch(() => undefined); // observed below; avoid an unhandled rejection meanwhile
    const turnStart = conn.request("turn/start", {
      threadId: id, input: req.input, cwd, approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      ...(req.effort ? { effort: req.effort } : {}),
      ...(req.schema ? { outputSchema: req.schema } : {}),
    });
    // A turn acknowledged only after we stopped waiting must still be stopped.
    turnStart.then((r) => {
      const late = object(r.turn)?.id;
      if (stoppedBy && typeof late === "string" && !turnId) interrupt(late);
    }, () => undefined);
    const ack = await race(turnStart);
    const ackId = object(ack.turn)?.id;
    turnId = typeof ackId === "string" ? ackId : undefined;
    const turn = await race(finished);
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (object(item)?.type === "agentMessage" && !items.some((seen) => seen.id === object(item)!.id)) items.push(item as CodexMessage);
    }
    const messages = items.filter((item) => item.type === "agentMessage" && typeof item.text === "string");
    const final = messages.filter((item) => item.phase === "final_answer").at(-1) ?? messages.at(-1);
    return {
      text: (final?.text as string | undefined) ?? "",
      images: items.filter((item) => item.type === "imageGeneration"),
      model: typeof started.model === "string" ? started.model : model,
      usage: usage ? normalizeCodexUsage(usage) : null,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    unsubscribe();
    // Release the ephemeral thread server-side; best effort, never awaited.
    if (threadId) conn.request("thread/unsubscribe", { threadId }).catch(() => undefined);
  }
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  // A finishing task hands its slot straight to the next waiter, so `active`
  // never exceeds the limit even transiently.
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    if (signal?.aborted) { const next = this.waiting.shift(); if (next) next(); else this.active--; throw new BrokerError(499, "client disconnected"); }
    try { return await task(); } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<CodexMessage> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new BrokerError(413, "request body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (!body) throw new Error("not an object");
        resolve(body);
      } catch { reject(new BrokerError(400, "request body must be a JSON object")); }
    });
  });
}

function sameToken(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

export async function startCodexBroker(options: CodexBrokerOptions): Promise<CodexBroker> {
  const env = options.env ?? process.env;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const semaphore = new Semaphore(options.maxConcurrency ?? DEFAULT_CONCURRENCY);
  const exports = new Semaphore(EXPORT_CONCURRENCY);
  const workdirReal = fs.realpathSync(options.workdir);
  const visionModel = env.AUTOILLUSTRATE_CODEX_VISION_MODEL || undefined;
  const { rpcTimeoutMs } = codexAppServerSettings(env);
  const token = crypto.randomBytes(32).toString("base64url");
  // Private, empty working root for every broker thread: never the run dir,
  // and not under a temp root either — the agent's workspace-write sandbox can
  // write $TMPDIR and /tmp. Canonical, like the native adapter's cwd.
  const scratchRoot = path.join(os.homedir(), ".cache", "autoillustrate", "codex-broker");
  fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(scratchRoot, "run-")));
  fs.chmodSync(scratch, 0o700);
  let admitted = 0;
  const connections = new Map<Profile, Promise<CodexRpcConnection>>();
  let features: Promise<Set<string> | undefined> | undefined;
  const opened: CodexRpcConnection[] = [];
  let closing = false;

  const evict = (profile: Profile, pending: Promise<CodexRpcConnection>) => {
    if (connections.get(profile) === pending) connections.delete(profile);
  };
  const connect = async (profile: Profile): Promise<CodexRpcConnection> => {
    const cached = connections.get(profile);
    if (cached) {
      const conn = await cached.catch(() => undefined);
      if (conn?.alive) return conn;
      evict(profile, cached);
      if (connections.get(profile)) return connect(profile); // another request already replaced it
    }
    const pending = (async () => {
      const command = findCodexAppServer(env);
      if (!command) throw new BrokerError(502, `codex executable not found or not executable: ${codexAppServerBinary(env)}`);
      const known = await (features ??= knownFeatures(command, env));
      const disabled = (profile === "vision" ? [...CODEX_BROKER_DISABLED_FEATURES, ...CODEX_BROKER_VISION_ONLY_DISABLED] : CODEX_BROKER_DISABLED_FEATURES)
        .filter((feature) => !known || known.has(feature));
      const args = ["app-server", ...disabled.flatMap((f) => ["--disable", f]), ...CONFIG_OVERRIDES.flatMap((c) => ["-c", c])];
      const conn = new CodexRpcConnection(command, args, { cwd: scratch, env });
      opened.push(conn);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          conn.request("initialize", { clientInfo: { name: "autoillustrate-broker", title: "AutoIllustrate", version: "1" }, capabilities: null }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no response within ${rpcTimeoutMs / 1000}s`)), rpcTimeoutMs); }),
        ]);
        conn.notify("initialized", {});
      } catch (err) {
        await conn.close();
        throw new BrokerError(502, `app-server initialize failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }
      return conn;
    })();
    connections.set(profile, pending);
    pending.catch(() => evict(profile, pending));
    // A dead child is evicted so the next request starts a fresh one.
    void pending.then((conn) => conn.closed.then(() => evict(profile, pending)), () => undefined);
    return pending;
  };

  const handle = async (req: http.IncomingMessage, signal: AbortSignal): Promise<CodexMessage> => {
    if (!sameToken(req.headers.authorization, token)) throw new BrokerError(401, "missing or invalid broker token");
    if (admitted >= MAX_ADMITTED) throw new BrokerError(503, "broker is at capacity; retry later");
    admitted++;
    try { return await route(req, signal); } finally { admitted--; }
  };
  const route = async (req: http.IncomingMessage, signal: AbortSignal): Promise<CodexMessage> => {
    const exportDrawio = options.exportDrawio;
    if (req.url === "/v1/export" && exportDrawio) {
      if (req.method !== "POST") throw new BrokerError(405, "POST required");
      const exportRequest = parseExport(await readBody(req), workdirReal);
      return exports.run(async () => {
        if (closing) throw new BrokerError(503, "broker is shutting down");
        try { await exportDrawio(exportRequest); }
        catch (err) { throw new BrokerError(502, err instanceof Error ? err.message : String(err)); }
        return { output: exportRequest.pngOut };
      }, signal);
    }
    const parse = req.url === "/v1/vision" ? parseVision : req.url === "/v1/image" ? parseImage : undefined;
    if (!parse) throw new BrokerError(404, "unknown route");
    if (req.method !== "POST") throw new BrokerError(405, "POST required");
    const turnRequest = parse(await readBody(req));
    return semaphore.run(async () => {
      if (closing) throw new BrokerError(503, "broker is shutting down");
      const pending = connect(turnRequest.profile);
      const conn = await pending;
      try {
        const result = await runTurn(conn, scratch, turnRequest, turnRequest.profile === "vision" ? visionModel : undefined, timeoutMs, signal)
          .catch(async (err) => {
            // The child sat on thread/start or turn/start past the deadline.
            if (err instanceof BrokerError && err.wedged) await conn.close();
            throw err;
          });
        if (turnRequest.profile === "vision") return { text: result.text, model: result.model ?? null, usage: result.usage };
        const image = result.images.filter((item) => item.status === "completed" && typeof item.result === "string" && item.result).at(-1);
        if (!image) throw new BrokerError(502, "Codex turn completed but produced no image");
        return { png: image.result, revisedPrompt: image.revisedPrompt ?? null, model: result.model ?? null, usage: result.usage };
      } catch (err) {
        if (err instanceof BrokerError) throw err;
        throw new BrokerError(502, err instanceof Error ? err.message : String(err));
      }
    }, signal);
  };

  const server = http.createServer((req, res) => {
    // A client that hangs up mid-request aborts its turn and frees its slot.
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableFinished) controller.abort(); });
    handle(req, controller.signal).then(
      (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); },
      (err) => {
        const status = err instanceof BrokerError ? err.status : 500;
        if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      },
    );
  });
  server.requestTimeout = 0; // turns can legitimately run for many minutes
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const descriptorPath = path.join(options.workdir, CODEX_BROKER_FILE);
  // The workdir is agent-writable: create the temp file exclusively (never
  // through a planted symlink); rename replaces, not follows, a link.
  const temp = `${descriptorPath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, url, token })}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, descriptorPath);
  // An interrupt ends the process without running close(); children are
  // killed via the process-group registry, and this removes the files.
  const cleanupOnExit = () => {
    fs.rmSync(descriptorPath, { force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  };
  process.once("exit", cleanupOnExit);
  logInfo("broker", `codex vision/image broker listening on ${url} (descriptor ${descriptorPath})`);

  let closed: Promise<void> | undefined;
  return {
    url,
    descriptorPath,
    scratchDir: scratch,
    close: () => closed ??= (async () => {
      closing = true;
      process.off("exit", cleanupOnExit);
      fs.rmSync(descriptorPath, { force: true });
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(opened.map((conn) => conn.close()));
      fs.rmSync(scratch, { recursive: true, force: true });
    })(),
  };
}

// Client side of /v1/export for `autoillustrate export` running inside a
// sandboxed sub-agent. node:http (not fetch) so no proxy setting applies.
export async function requestBrokerExport(descriptorPath: string, req: BrokerExportRequest): Promise<void> {
  let url: URL, token: string;
  try {
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    url = new URL("/v1/export", descriptor.url); token = String(descriptor.token);
  } catch (err) {
    throw new Error(`no usable Codex broker descriptor at ${descriptorPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = JSON.stringify({ input: req.drawioPath, output: req.pngOut, widthPx: req.widthPx, scale: req.scale });
  const reply = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const r = http.request(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    r.on("error", (err) => reject(new Error(`Codex broker unreachable at ${url.origin}: ${err.message}`)));
    r.end(body);
  });
  if (reply.status !== 200) {
    let message = reply.text;
    try { message = JSON.parse(reply.text).error ?? message; } catch { /* raw text */ }
    throw new Error(`Codex broker export failed (HTTP ${reply.status}): ${message}`);
  }
}
