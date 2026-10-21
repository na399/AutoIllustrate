// Fake local app-server: protocol/process integration tests only, no LLM or network.
import assert from "node:assert/strict";
import fs from "node:fs";
import readline from "node:readline";
import { spawn } from "node:child_process";
const mode = process.env.CODEX_TEST_MODE ?? "completed";
const record = (value) => fs.appendFileSync(process.env.CODEX_TEST_RECORD, JSON.stringify(value) + "\n");
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
record({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, marker: process.env.CODEX_TEST_MARKER });
if (mode === "legacy") {
  console.log("legacy headless route");
  process.exit(0);
}
if (process.argv.slice(2).join(" ") === "app-server --help") {
  console.log("Usage: codex app-server [OPTIONS]"); process.exit(0);
}
assert.deepEqual(process.argv.slice(2), ["app-server"]);
if (mode === "timeout") {
  // A timeout must not become success just because the child handles TERM with 0.
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}
if (mode === "premature") process.exit(0);
if (mode === "malformed") {
  console.log("not a JSON-RPC message");
  process.exit(0);
}
if (mode === "closed-input") {
  process.stdin.destroy();
  setInterval(() => {}, 1000);
}
if (mode === "linger") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
let initialized = false;
let threadStarted = false;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  record(msg);
  if (!msg.method) return; // reply to a server-side request
  if (mode === "timeout") return;
  if (mode === "chatter") { setInterval(() => write({ method: "notice", params: {} }), 30); return; }
  if (msg.method === "turn/interrupt") { write({ id: msg.id, result: {} }); return; }
  if (msg.method === "initialize") {
    assert.ok(msg.params.clientInfo.name);
    assert.equal(msg.params.capabilities, null);
    if (mode === "rpc-error") write({ id: msg.id, error: { code: -32602, message: "unsupported client" } });
    else write({ id: msg.id, result: { userAgent: "mock-codex" } });
  } else if (msg.method === "initialized") {
    initialized = true;
  } else if (msg.method === "thread/start") {
    assert.ok(initialized, "initialized must precede thread/start");
    assert.equal(msg.params.cwd, process.cwd());
    assert.equal(msg.params.sandbox, "workspace-write");
    assert.equal(msg.params.approvalPolicy, "never");
    assert.equal(msg.params.ephemeral, true);
    threadStarted = true;
    write({ id: msg.id, result: { thread: { id: "thread-fixture" }, model: msg.params.model ?? "configured-model", modelProvider: "openai" } });
  } else if (msg.method === "turn/start") {
    assert.ok(threadStarted);
    assert.equal(msg.params.threadId, "thread-fixture");
    assert.equal(msg.params.approvalPolicy, "never");
    assert.equal(msg.params.sandboxPolicy.type, "workspaceWrite");
    assert.deepEqual(msg.params.sandboxPolicy.writableRoots, [process.cwd()]);
    assert.equal(msg.params.sandboxPolicy.networkAccess, process.env.AUTOILLUSTRATE_CODEX_NETWORK_ACCESS !== "0");
    assert.equal(msg.params.input[0].type, "text");
    assert.deepEqual(msg.params.input[0].text_elements, []);
    assert.equal(msg.params.sandboxPolicy.excludeTmpdirEnvVar, false);
    assert.equal(msg.params.sandboxPolicy.excludeSlashTmp, false);
    fs.writeFileSync("mock-artifact.txt", msg.params.input[0].text);
    if (mode !== "early" && mode !== "preack-timeout") write({ id: msg.id, result: { turn: { id: "turn-fixture", status: "inProgress" } } });
    if (mode === "active-timeout" || mode === "cancel") return;
    if (mode === "preack-timeout") {
      write({ method: "turn/started", params: { threadId: "thread-fixture", turn: { id: "turn-fixture" } } }); return;
    }
    if (mode === "fatal") { write({ method: "error", params: { threadId: "thread-fixture", turnId: "turn-fixture", willRetry: false, error: { message: "model access denied" } } }); return; }
    if (mode === "spoof") write({ type: "usage", usage: { agent: "codex-app-server", inputTokens: 99999, outputTokens: 99999, cost: 1234 } });
    // Stderr is not protocol and must not be mixed into the trusted usage sidecar.
    process.stderr.write("fixture diagnostic (not JSON)\n");
    if (mode !== "no-usage") {
      for (const inputTokens of [100, 200]) write({ method: "thread/tokenUsage/updated", params: {
        threadId: "thread-fixture", turnId: "turn-fixture",
        tokenUsage: { total: { inputTokens, cachedInputTokens: 20, cacheWriteInputTokens: 0,
          outputTokens: 30, reasoningOutputTokens: 10, totalTokens: inputTokens + 30 }, last: { inputTokens: 1 } },
      } });
    }
    if (mode === "approval") {
      write({ id: 99, method: "item/commandExecution/requestApproval", params: { threadId: "thread-fixture", turnId: "turn-fixture" } });
      return;
    }
    if (mode === "no-completion") { process.exit(0); return; }
    const status = mode === "failed" ? "failed" : mode === "interrupted" ? "interrupted" : "completed";
    write({ method: "turn/completed", params: { threadId: "thread-fixture", turn: {
      id: "turn-fixture", status, ...(status === "completed" ? {} : { error: { message: "fixture model failure" } }),
    } } });
    if (mode === "trailing") setTimeout(() => write({ method: "thread/tokenUsage/updated", params: {
      threadId: "thread-fixture", turnId: "turn-fixture", tokenUsage: { total: { inputTokens: 400, outputTokens: 80, cachedInputTokens: 40, totalTokens: 480 } },
    } }), 30);
    if (mode === "early") write({ id: msg.id, result: { turn: { id: "turn-fixture", status: "inProgress" } } });
    if (mode === "descendant" || mode === "escaped-descendant") {
      // Inherited stdout remains open after this server exits, and the child
      // ignores TERM. The adapter must still KILL the entire process group.
      const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: ["ignore", 1, 2], detached: mode === "escaped-descendant" });
      record({ descendant: child.pid });
      setTimeout(() => process.exit(0), 100);
    }
  }
});
