// Native provider adapter. The legacy Headless/native CLI path in agent.ts is
// deliberately untouched: stdio RPC, deadlines and shutdown belong here.
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "./agent.js";
import {
  CODEX_MAX_MESSAGE_BYTES, CodexAppServerSession, codexAppServerBinary,
  codexAppServerSettings, codexTimeoutMs, findCodexAppServer,
  type CodexMessage,
} from "./codex-app-server.js";
import { headlessStdoutLogPath } from "./headless-log.js";
import { logInfo, logWarn, writeExternal } from "./log.js";
import { registerAgentPgid, deregisterAgentPgid } from "./registry.js";

// EOF -> TERM -> KILL, then close inherited pipes even if a descendant escaped
// the process group. This bounds client shutdown, not arbitrary OS processes.
const TERM_GRACE_MS = 1000;
const KILL_GRACE_MS = 6000;
const PIPE_GRACE_MS = 6500;

export async function invokeCodexAppServer(
  logPath: string,
  promptFile: string,
  workdir: string,
  config: AgentConfig & { signal?: AbortSignal },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (config.tmux) throw new Error("agent_invoke: --tmux is not supported for native codex-app-server invocation");
  if (process.platform === "win32") throw new Error("codex-app-server requires POSIX process groups; use WSL on Windows");
  const timeoutMs = codexTimeoutMs(config.timeoutSecs, "AGENT_INVOKE_TIMEOUT");
  const settings = codexAppServerSettings(env);
  if (config.effort && !["low", "medium", "high", "xhigh"].includes(config.effort)) {
    throw new Error("codex-app-server effort must be low, medium, high, or xhigh");
  }
  if (config.signal?.aborted) return 130;
  // Resolve now, not against the run directory after spawn. The same routine
  // is used by doctor, so a relative PATH cannot select a different executable.
  const command = findCodexAppServer(env);
  if (!command) throw new Error(`codex-app-server executable not found or not executable: ${codexAppServerBinary(env)} (set AUTOILLUSTRATE_CODEX_BIN)`);
  const cwd = fs.realpathSync(workdir);
  if (!fs.statSync(cwd).isDirectory()) throw new Error(`codex-app-server workdir is not a directory: ${workdir}`);
  const stat = fs.statSync(promptFile);
  if (!stat.isFile() || stat.size > CODEX_MAX_MESSAGE_BYTES) throw new Error("codex-app-server prompt must be a regular file no larger than 16 MiB");
  const prompt = fs.readFileSync(promptFile, "utf8");
  if (Buffer.byteLength(JSON.stringify(prompt)) > CODEX_MAX_MESSAGE_BYTES - 4096) {
    throw new Error("codex-app-server serialized prompt is too large for a 16 MiB RPC frame");
  }

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { mode: 0o600 });
  let logBroken = false;
  logStream.on("error", (err) => {
    if (!logBroken) logWarn("agent", `cannot write ${logPath}: ${err.message} — continuing with console output only`);
    logBroken = true;
  });
  const writeLog = async (chunk: Buffer): Promise<void> => {
    if (logBroken || logStream.destroyed) return;
    if (!logStream.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          logStream.off("drain", done); logStream.off("close", done); logStream.off("error", done);
          resolve();
        };
        logStream.once("drain", done); logStream.once("close", done); logStream.once("error", done);
      });
    }
  };
  const startedAt = Date.now();
  logInfo("agent", `launching native codex-app-server (model=${config.model || "default"}, effort=${config.effort || "default"}, timeout=${config.timeoutSecs}s) → ${logPath}`);
  const child = spawn(command, ["app-server"], {
    cwd, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
  });
  const pgid = child.pid;
  if (pgid) registerAgentPgid(pgid);
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (!pgid) return;
    try { process.kill(-pgid, signal); } catch { /* ESRCH: already gone. */ }
  };
  let closed = false;
  let rpcTimer: NodeJS.Timeout | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let termTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let pipeTimer: NodeJS.Timeout | undefined;
  let releaseHardStop!: () => void;
  const hardStop = new Promise<void>((resolve) => { releaseHardStop = resolve; });
  let writes = Promise.resolve();
  let queuedBytes = 0;
  let session!: CodexAppServerSession;
  const send = (message: CodexMessage): void => {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    if (bytes.length - 1 > CODEX_MAX_MESSAGE_BYTES || queuedBytes + bytes.length > 2 * CODEX_MAX_MESSAGE_BYTES) {
      throw new Error("app-server outbound message/queue exceeds its size limit");
    }
    queuedBytes += bytes.length;
    // Await each write callback before issuing the next frame. This honors
    // back-pressure and preserves interrupt/decline -> EOF ordering.
    writes = writes.then(() => new Promise<void>((resolve, reject) => {
      if (child.stdin.destroyed || child.stdin.writableEnded) { reject(new Error("app-server stdin is closed")); return; }
      child.stdin.write(bytes, (err) => err ? reject(err) : resolve());
    })).catch((err) => {
      session.fail(`app-server stdin: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => { queuedBytes -= bytes.length; });
  };
  session = new CodexAppServerSession(
    { prompt, cwd, model: config.model, effort: config.effort, networkAccess: settings.networkAccess },
    send,
    (result) => {
      clearTimeout(rpcTimer); clearTimeout(deadlineTimer);
      if (result.error) logWarn("agent", result.error);
      if (closed) return;
      void writes.then(() => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end(); });
      termTimer = setTimeout(() => signalGroup("SIGTERM"), TERM_GRACE_MS);
      killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
      pipeTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        child.unref();
        logWarn("agent", "app-server shutdown deadline reached; closing inherited pipes after process-group KILL");
        releaseHardStop();
      }, PIPE_GRACE_MS);
    },
    (method) => {
      clearTimeout(rpcTimer);
      if (method) rpcTimer = setTimeout(() => {
        session.cancel(`app-server TIMEOUT awaiting ${method} after ${settings.rpcTimeoutMs / 1000}s`, 124);
      }, settings.rpcTimeoutMs);
    },
  );
  const childClosed = new Promise<void>((resolve) => {
    child.once("close", () => { closed = true; resolve(); });
    child.once("error", (err) => session.fail(`cannot launch app-server: ${err.message}`));
  });
  child.stdin.on("error", (err) => session.fail(`app-server stdin: ${err.message}`));
  const consume = async (stream: NodeJS.ReadableStream, protocol: boolean): Promise<void> => {
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        // Terminal events must be processed before log/terminal back-pressure.
        if (protocol) session.push(buffer);
        await writeLog(buffer);
        if (config.debug || logBroken) {
          const dest = writeExternal(buffer);
          if (dest instanceof Writable && dest.writableNeedDrain) {
            let release!: () => void;
            const drained = new Promise<void>((resolve) => { release = resolve; });
            dest.once("drain", release); dest.once("close", release); dest.once("error", release);
            // A blocked debug terminal must not defeat the process watchdog.
            await Promise.race([drained, hardStop]);
            dest.off("drain", release); dest.off("close", release); dest.off("error", release);
          } else if (dest.writableNeedDrain && dest.once) {
            // Respect the narrower public OutStream interface for custom sinks.
            await Promise.race([new Promise<void>((resolve) => dest.once?.("drain", resolve)), hardStop]);
          }
        }
      }
    } catch (err) {
      session.fail(`app-server output stream failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (protocol) session.end();
    }
  };
  const outputDone = Promise.all([consume(child.stdout, true), consume(child.stderr, false)]);
  const abort = () => session.cancel("app-server invocation cancelled", 130);
  config.signal?.addEventListener("abort", abort, { once: true });
  deadlineTimer = setTimeout(() => session.cancel(`app-server TIMEOUT after ${config.timeoutSecs}s`, 124), timeoutMs);
  if (config.signal?.aborted) abort();
  else session.start();
  try {
    await Promise.race([childClosed, hardStop]);
    await outputDone;
    session.end();
  } finally {
    clearTimeout(rpcTimer); clearTimeout(deadlineTimer);
    clearTimeout(termTimer); clearTimeout(killTimer); clearTimeout(pipeTimer);
    config.signal?.removeEventListener("abort", abort);
    // Do not deregister before cleanup: the pipeline's interrupt handler must
    // continue to see this group until all in-group descendants are signalled.
    signalGroup("SIGKILL");
    if (pgid) deregisterAgentPgid(pgid);
    child.stdin.destroy();
    const footer = Buffer.from(`${JSON.stringify({ ...session.resultRecord(), durationMs: Date.now() - startedAt })}\n${JSON.stringify(session.usageRecord())}\n`);
    await writeLog(Buffer.concat([Buffer.from("\n"), footer]));
    await new Promise<void>((resolve) => {
      if (logStream.closed) { resolve(); return; }
      logStream.once("close", resolve); logStream.end();
    });
    // Flush the main log BEFORE publishing the telemetry sidecar. The metrics
    // reader rejects a sidecar whose mtime predates the main log. Keep only our
    // normalized records here, never server/tool-supplied usage-shaped text.
    const stdoutLog = headlessStdoutLogPath(logPath);
    const temp = `${stdoutLog}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.writeFile(temp, footer, { mode: 0o600 });
      await fs.promises.rename(temp, stdoutLog);
    } catch (err) {
      logWarn("agent", `cannot write ${stdoutLog}: ${err instanceof Error ? err.message : String(err)}`);
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
  }
  const rc = session.result?.code ?? 1;
  logInfo("agent", `native codex-app-server exited (rc=${rc}) after ${Math.round((Date.now() - startedAt) / 1000)}s`);
  return rc;
}
