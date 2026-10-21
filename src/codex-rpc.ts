// Multiplexed JSON-RPC connection to one long-lived `codex app-server` stdio
// child. Unlike CodexAppServerSession (one thread/turn per process), many
// threads share this connection; notifications are routed by threadId.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { CODEX_MAX_MESSAGE_BYTES, CodexLineDecoder, type CodexMessage } from "./codex-app-server.js";
import { deregisterAgentPgid, registerAgentPgid } from "./registry.js";

const TERM_GRACE_MS = 1000;
const KILL_GRACE_MS = 5000;
// Notifications may precede the response that names their thread. Keep a
// small bounded backlog per unknown thread so a subscriber can replay them.
const MAX_BACKLOG_THREADS = 64;
const MAX_BACKLOG_MESSAGES = 256;

const object = (value: unknown): CodexMessage | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as CodexMessage : undefined;

export type ThreadHandler = (message: CodexMessage) => void;

export class CodexRpcConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: CodexLineDecoder;
  private readonly pending = new Map<number, { resolve: (r: CodexMessage) => void; reject: (e: Error) => void; method: string }>();
  private readonly handlers = new Map<string, ThreadHandler>();
  private readonly backlog = new Map<string, CodexMessage[]>();
  // Threads whose subscriber left: late traffic for them is dropped, not kept.
  private readonly retired = new Set<string>();
  private nextId = 1;
  private writes = Promise.resolve();
  private queuedBytes = 0;
  private failure?: Error;
  readonly closed: Promise<void>;

  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const pgid = this.child.pid;
    if (pgid) registerAgentPgid(pgid);
    this.lines = new CodexLineDecoder((line) => this.line(line), (error) => this.fail(new Error(error)));
    this.child.stdout.on("data", (chunk: Buffer) => this.lines.push(chunk));
    this.child.stdout.on("end", () => this.lines.end());
    // stderr is diagnostic chatter (warnings, logs); drain it so it never blocks.
    this.child.stderr.resume();
    this.child.stdin.on("error", (err) => this.fail(err));
    this.closed = new Promise<void>((resolve) => {
      this.child.once("error", (err) => { this.fail(new Error(`cannot launch app-server: ${err.message}`)); resolve(); });
      this.child.once("close", (code, signal) => {
        if (pgid) {
          try { process.kill(-pgid, "SIGKILL"); } catch { /* group already gone */ }
          deregisterAgentPgid(pgid);
        }
        this.fail(new Error(`app-server exited (code=${code ?? "none"}, signal=${signal ?? "none"})`));
        resolve();
      });
    });
  }

  get alive(): boolean { return this.failure === undefined; }

  request(method: string, params: CodexMessage): Promise<CodexMessage> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    // Codex intentionally omits the jsonrpc field on its JSON-RPC transport.
    const frame = this.frame({ id, method, params });
    // An oversized request fails alone; it must not take down sibling turns.
    if (typeof frame === "string") return Promise.reject(new Error(`${method}: ${frame}`));
    return new Promise<CodexMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.enqueue(frame);
    });
  }

  notify(method: string, params: CodexMessage): void { this.write({ method, params }); }

  // Route this thread's notifications and server requests to `handler`,
  // replaying anything that arrived before the thread id was known.
  subscribe(threadId: string, handler: ThreadHandler): () => void {
    this.handlers.set(threadId, handler);
    const early = this.backlog.get(threadId) ?? [];
    this.backlog.delete(threadId);
    for (const message of early) handler(message);
    return () => {
      this.handlers.delete(threadId);
      this.retired.add(threadId);
      if (this.retired.size > 4096) this.retired.delete(this.retired.values().next().value!);
    };
  }

  respond(id: unknown, payload: { result?: CodexMessage; error?: CodexMessage }): void { this.write({ id, ...payload }); }

  // EOF first, then escalate. Bounded even if the child ignores its stdin.
  async close(): Promise<void> {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    const pgid = this.child.pid;
    const signal = (s: NodeJS.Signals) => { if (pgid) try { process.kill(-pgid, s); } catch { /* gone */ } };
    const term = setTimeout(() => signal("SIGTERM"), TERM_GRACE_MS);
    const kill = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
    try { await this.closed; } finally { clearTimeout(term); clearTimeout(kill); }
  }

  private frame(message: CodexMessage): Buffer | string {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    if (bytes.length - 1 > CODEX_MAX_MESSAGE_BYTES) return "message exceeds the 16 MiB frame limit";
    if (this.queuedBytes + bytes.length > 4 * CODEX_MAX_MESSAGE_BYTES) return "outbound queue is full";
    return bytes;
  }

  // Notifications and responses: on overflow there is no caller to tell, so
  // the connection fails (they are small; this only trips on a wedged child).
  private write(message: CodexMessage): void {
    const frame = this.frame(message);
    if (typeof frame === "string") { this.fail(new Error(`app-server ${frame}`)); return; }
    this.enqueue(frame);
  }

  private enqueue(bytes: Buffer): void {
    this.queuedBytes += bytes.length;
    this.writes = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.child.stdin.destroyed || this.child.stdin.writableEnded) { reject(new Error("app-server stdin is closed")); return; }
      this.child.stdin.write(bytes, (err) => err ? reject(err) : resolve());
    })).catch((err) => this.fail(err instanceof Error ? err : new Error(String(err))))
      .finally(() => { this.queuedBytes -= bytes.length; });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    // Wake every in-flight turn so it fails instead of waiting for a deadline.
    for (const handler of this.handlers.values()) handler({ method: "connection/failed", params: { error: { message: error.message } } });
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    // A failed connection is dead: do not rely on the child honouring EOF.
    const pgid = this.child.pid;
    if (pgid && this.child.exitCode === null && this.child.signalCode === null) {
      try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }, KILL_GRACE_MS).unref();
    }
  }

  private line(line: string): void {
    if (!line.trim()) return;
    let message: CodexMessage | undefined;
    try { message = object(JSON.parse(line)); } catch { /* handled below */ }
    if (!message) { this.fail(new Error("invalid JSON-RPC frame on app-server stdout")); this.lines.stop(); return; }
    if (typeof message.method !== "string") {
      const entry = this.pending.get(message.id as number);
      if (!entry) return;
      this.pending.delete(message.id as number);
      const error = object(message.error);
      const result = object(message.result);
      if (error) entry.reject(new Error(`${entry.method}: ${typeof error.message === "string" ? error.message : "JSON-RPC error"}`));
      else if (result) entry.resolve(result);
      else entry.reject(new Error(`${entry.method}: missing or invalid result`));
      return;
    }
    const threadId = object(message.params)?.threadId;
    if (typeof threadId !== "string") {
      // Connection-scoped server requests have no thread to answer them.
      if (Object.hasOwn(message, "id")) this.respond(message.id, { error: { code: -32601, message: "Unsupported noninteractive app-server request" } });
      return;
    }
    const handler = this.handlers.get(threadId);
    if (handler) { handler(message); return; }
    if (this.retired.has(threadId)) {
      if (Object.hasOwn(message, "id")) this.respond(message.id, { error: { code: -32601, message: "Thread is no longer attended" } });
      return;
    }
    let early = this.backlog.get(threadId);
    if (!early) {
      if (this.backlog.size >= MAX_BACKLOG_THREADS) this.backlog.delete(this.backlog.keys().next().value!);
      early = []; this.backlog.set(threadId, early);
    }
    if (early.length < MAX_BACKLOG_MESSAGES) early.push(message);
  }
}
