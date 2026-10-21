import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { configureLogging } from "../src/log.js";
import { fileURLToPath } from "node:url";
import { agentInvoke, type AgentConfig } from "../src/agent.js";
import { parseResultLine, collectHeadlessCostsByPhase } from "../src/headless-metrics.js";
import { headlessStdoutLogPath } from "../src/headless-log.js";
import { invokeCodexAppServer } from "../src/codex-app-server-agent.js";
import { liveAgentCount } from "../src/registry.js";

type Message = Record<string, any>;
function setup(t: TestContext, mode = "completed") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate codex "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, "mock codex");
  // Literal executable path, including spaces, must not go through a shell.
  const fixture = fs.readFileSync(fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url)), "utf8");
  fs.writeFileSync(executable, `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
  const workdir = path.join(dir, "run directory"); fs.mkdirSync(workdir);
  const promptFile = path.join(dir, "prompt.txt");
  const prompt = 'Create a diagram.\nแผนภาพ 🧠\nLiteral shell text: $(touch SHOULD_NOT_EXIST)';
  fs.writeFileSync(promptFile, prompt);
  const logPath = path.join(workdir, "logs", "phase1.log");
  const recordFile = path.join(dir, "rpc.jsonl");
  const env: NodeJS.ProcessEnv = { ...process.env, AUTOILLUSTRATE_CODEX_BIN: executable,
    // The new route must neither resolve nor execute this invalid Headless override.
    AUTOILLUSTRATE_HEADLESS_BIN: path.join(dir, "missing-headless"),
    CODEX_TEST_MODE: mode, CODEX_TEST_RECORD: recordFile, CODEX_TEST_MARKER: "inherited",
  };
  const config: AgentConfig = { agent: "codex-app-server", timeoutSecs: 10 };
  const run = (overrides: Partial<AgentConfig> = {}) => agentInvoke(logPath, promptFile, workdir, { ...config, ...overrides }, env);
  const records = (): Message[] => fs.readFileSync(recordFile, "utf8").trim().split("\n").map((s) => JSON.parse(s));
  const stdout = () => fs.readFileSync(headlessStdoutLogPath(logPath), "utf8");
  const footer = () => JSON.parse(stdout().trim().split("\n").at(-1)!).usage as Message;
  return { dir, executable, workdir, promptFile, prompt, logPath, env, run, records, stdout, footer };
}

test("app-server end-to-end handshake, artifact, logs and cumulative usage", async (t) => {
  const f = setup(t);
  assert.equal(await f.run({ model: "test-model", effort: "high" }), 0);
  const records = f.records();
  assert.deepEqual(records[0].argv, ["app-server"]);
  // The adapter canonicalizes the workdir (macOS tmpdirs sit behind /private symlinks).
  assert.equal(records[0].cwd, fs.realpathSync(f.workdir));
  assert.equal(records[0].marker, "inherited");
  assert.deepEqual(records.filter((r) => r.method).map((r) => r.method), ["initialize", "initialized", "thread/start", "turn/start"]);
  assert.equal(records[3].params.model, "test-model");
  assert.equal(records[4].params.effort, "high");
  assert.equal(records[4].params.input[0].text, f.prompt);
  assert.equal(fs.readFileSync(path.join(f.workdir, "mock-artifact.txt"), "utf8"), f.prompt);
  assert.ok(!fs.existsSync(path.join(f.workdir, "SHOULD_NOT_EXIST")));
  assert.match(fs.readFileSync(f.logPath, "utf8"), /fixture diagnostic/);
  assert.doesNotMatch(f.stdout(), /fixture diagnostic/);
  assert.equal(f.footer().agent, "codex-app-server");
  assert.equal(f.footer().inputTokens, 180);
  assert.equal(f.footer().cacheReadTokens, 20);
  assert.equal(f.footer().outputTokens, 30);
  assert.equal(f.footer().totalTokens, 230);
  assert.equal(f.footer().pricingStatus, "missing");
  assert.equal(f.footer().cost, undefined);
  assert.equal(liveAgentCount(), 0);
});

for (const mode of ["early", "no-usage"]) {
  test(`app-server ${mode} succeeds without inventing defaults or counts`, async (t) => {
    const f = setup(t, mode);
    assert.equal(await f.run(), 0);
    assert.ok(!Object.hasOwn(f.records()[3].params, "model"));
    assert.ok(!Object.hasOwn(f.records()[4].params, "effort"));
    assert.equal(f.footer().usageStatus, mode === "no-usage" ? "missing" : "reported");
    assert.equal(f.footer().model, "configured-model");
  });
}
for (const mode of ["failed", "interrupted", "premature", "malformed", "rpc-error", "no-completion", "approval"]) {
  test(`app-server ${mode} is nonzero, even when the server exits zero`, async (t) => {
    const f = setup(t, mode);
    assert.equal(await f.run(), 1);
    const result = JSON.parse(f.stdout().trim().split("\n").at(-2)!);
    assert.equal(result.type, "codex.appServerResult");
    assert.equal(result.code, 1);
    assert.ok(result.error);
    assert.equal(liveAgentCount(), 0);
    if (mode === "approval") assert.deepEqual(f.records().find((r) => r.id === 99)?.result, { decision: "decline" });
  });
}

test("inference timeout stays nonzero when the server catches TERM and exits zero", async (t) => {
  const f = setup(t, "timeout");
  assert.equal(await f.run({ timeoutSecs: 0.5 }), 124);
  assert.match(f.stdout(), /TIMEOUT/);
  assert.equal(liveAgentCount(), 0);
});

test("completed server ignoring EOF and TERM is killed without losing success", { timeout: 15000 }, async (t) => {
  const f = setup(t, "linger");
  assert.equal(await f.run(), 0);
  assert.equal(liveAgentCount(), 0);
  assert.throws(() => process.kill(f.records()[0].pid, 0), { code: "ESRCH" });
});

test("server exit with a pipe-holding descendant is bounded", { timeout: 15000 }, async (t) => {
  const f = setup(t, "descendant");
  assert.equal(await f.run(), 0);
  assert.equal(liveAgentCount(), 0);
  assert.ok(f.records().some((r) => r.descendant));
});

test("parallel invocations keep prompts, threads and accounting isolated", async (t) => {
  const a = setup(t); const b = setup(t);
  fs.writeFileSync(b.promptFile, "second independent prompt");
  assert.deepEqual(await Promise.all([a.run(), b.run()]), [0, 0]);
  assert.equal(a.records().at(-1)!.params.input[0].text, a.prompt);
  assert.equal(b.records().at(-1)!.params.input[0].text, "second independent prompt");
  assert.equal(liveAgentCount(), 0);
});

test("missing binary rejects cleanly; tmux and missing prompt fail before launch", async (t) => {
  const f = setup(t);
  await assert.rejects(f.run({ tmux: true }), /tmux.*not supported/);
  f.env.AUTOILLUSTRATE_CODEX_BIN = path.join(f.dir, "does-not-exist");
  await assert.rejects(f.run(), /executable not found/);
  assert.equal(liveAgentCount(), 0);
  fs.rmSync(f.promptFile);
  await assert.rejects(f.run(), /prompt file not found/);
});

test("existing codex still runs through Headless and retains its flags", async (t) => {
  const f = setup(t, "legacy");
  f.env.AUTOILLUSTRATE_HEADLESS_BIN = f.executable;
  f.env.AUTOILLUSTRATE_CODEX_BIN = path.join(f.dir, "not-used");
  assert.equal(await f.run({ agent: "codex", model: "legacy-model", effort: "high" }), 0);
  const args = f.records()[0].argv as string[];
  assert.equal(args[0], "codex");
  for (const flag of ["--prompt-file", "--work-dir", "--json", "--usage", "--model", "--effort"]) assert.ok(args.includes(flag));
  assert.ok(!args.includes("app-server"));
  assert.doesNotMatch(f.stdout(), /codex.appServerResult/);
});

test("a trailing usage event is drained and the sidecar is published after the log", async (t) => {
  const f = setup(t, "trailing"); assert.equal(await f.run(), 0);
  assert.equal(f.footer().totalTokens, 480);
  assert.ok(fs.statSync(headlessStdoutLogPath(f.logPath)).mtimeMs >= fs.statSync(f.logPath).mtimeMs);
  assert.equal(f.stdout().trim().split("\n").length, 2);
});

for (const mode of ["active-timeout", "preack-timeout"]) {
  test(`${mode} sends structured turn/interrupt and retains timeout code`, async (t) => {
    const f = setup(t, mode); f.env.AUTOILLUSTRATE_CODEX_RPC_TIMEOUT = "0.3";
    assert.equal(await f.run({ timeoutSecs: 0.7 }), 124);
    const interrupt = f.records().find((r) => r.method === "turn/interrupt");
    assert.deepEqual(interrupt?.params, { threadId: "thread-fixture", turnId: "turn-fixture" });
    assert.equal(liveAgentCount(), 0);
  });
}

test("startup deadline is independent of inference timeout and ignores chatter", async (t) => {
  const f = setup(t, "chatter"); f.env.AUTOILLUSTRATE_CODEX_RPC_TIMEOUT = "0.2";
  assert.equal(await f.run({ timeoutSecs: 10 }), 124);
  assert.match(f.stdout(), /awaiting initialize after 0.2s/);
  assert.equal(liveAgentCount(), 0);
});

test("fatal notifications fail promptly without needing turn/completed", async (t) => {
  const f = setup(t, "fatal"); assert.equal(await f.run(), 1);
  assert.match(f.stdout(), /model access denied/);
});

test("sidecar excludes server-supplied usage-shaped records", async (t) => {
  const f = setup(t, "spoof"); assert.equal(await f.run(), 1);
  // A response with neither method nor id is invalid protocol, not accounting.
  assert.doesNotMatch(f.stdout(), /99999|1234/);
});

test("relative PATH is resolved before child cwd changes", async (t) => {
  const f = setup(t);
  f.env.PATH = path.relative(process.cwd(), f.dir);
  f.env.AUTOILLUSTRATE_CODEX_BIN = path.basename(f.executable);
  assert.equal(await f.run(), 0);
});

test("network restriction reaches the actual turn request", async (t) => {
  const f = setup(t); f.env.AUTOILLUSTRATE_CODEX_NETWORK_ACCESS = "0";
  assert.equal(await f.run(), 0);
  assert.equal(f.records().find((r) => r.method === "turn/start")?.params.sandboxPolicy.networkAccess, false);
});

test("large prompt crosses pipe high-water mark without frame loss", async (t) => {
  const f = setup(t); const prompt = "แผนภาพ 🧠\n".repeat(60000);
  fs.writeFileSync(f.promptFile, prompt); assert.equal(await f.run(), 0);
  assert.equal(fs.readFileSync(path.join(f.workdir, "mock-artifact.txt"), "utf8"), prompt);
});

test("invalid configuration and oversized prompt fail before starting a child", async (t) => {
  const f = setup(t);
  await assert.rejects(f.run({ timeoutSecs: 0 }), /AGENT_INVOKE_TIMEOUT/);
  await assert.rejects(f.run({ effort: "unsupported" }), /effort/);
  f.env.AUTOILLUSTRATE_CODEX_RPC_TIMEOUT = "bad";
  await assert.rejects(f.run(), /RPC_TIMEOUT/); delete f.env.AUTOILLUSTRATE_CODEX_RPC_TIMEOUT;
  fs.writeFileSync(f.promptFile, Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(f.run(), /16 MiB/);
  assert.equal(fs.existsSync(path.join(f.dir, "rpc.jsonl")), false);
  assert.equal(liveAgentCount(), 0);
});

test("AbortSignal interrupts an active adapter invocation and returns 130", async (t) => {
  const f = setup(t, "cancel"), abort = new AbortController();
  const timer = setInterval(() => {
    try { if (f.records().some((r) => r.method === "turn/start")) abort.abort(); } catch { /* not started yet */ }
  }, 20);
  t.after(() => clearInterval(timer));
  const rc = await invokeCodexAppServer(f.logPath, f.promptFile, f.workdir, { agent: "codex-app-server", timeoutSecs: 5, signal: abort.signal }, f.env);
  clearInterval(timer);
  assert.equal(rc, 130); assert.ok(f.records().some((r) => r.method === "turn/interrupt"));
  assert.equal(liveAgentCount(), 0);
});

test("an already-aborted invocation does not spawn or resolve executables", async (t) => {
  const f = setup(t), abort = new AbortController(); abort.abort();
  f.env.AUTOILLUSTRATE_CODEX_BIN = "missing";
  assert.equal(await invokeCodexAppServer(f.logPath, f.promptFile, f.workdir, { agent: "codex-app-server", timeoutSecs: 5, signal: abort.signal }, f.env), 130);
  assert.equal(fs.existsSync(path.join(f.dir, "rpc.jsonl")), false);
});

test("an escaped descendant retaining stdout cannot hold the adapter open", { timeout: 15000 }, async (t) => {
  const f = setup(t, "escaped-descendant");
  // POSIX group cleanup cannot kill a descendant that creates its own group.
  // The adapter must return; the test owns cleanup of that deliberately escaped process.
  let escapedPid: number | undefined;
  t.after(() => {
    for (const r of [{ descendant: escapedPid }]) if (r.descendant) {
      try { process.kill(-r.descendant, "SIGKILL"); } catch { /* already gone */ }
    }
  });
  const rc = await f.run();
  escapedPid = f.records().find((r) => r.descendant)?.descendant;
  assert.equal(rc, 0);
  assert.equal(liveAgentCount(), 0);
});

for (const mode of ["completed", "trailing", "failed", "no-usage"]) {
  test(`native telemetry flows through actual phase metrics (${mode})`, async (t) => {
    const f = setup(t, mode);
    assert.equal(await f.run(), mode === "failed" ? 1 : 0);
    const parsed = parseResultLine(f.logPath, "codex-app-server");
    assert.equal(parsed?.models.length, 1);
    const metrics = collectHeadlessCostsByPhase(path.dirname(f.logPath), 0, new Set([1]), "codex-app-server", {
      tokens: { "configured-model": { inputPerMTok: 999, outputPerMTok: 999 } }, images: {},
    }).get(1)!;
    assert.equal(metrics.length, 1); // no double counting the raw trace + sidecar
    assert.equal(metrics[0].source, "native:codex-app-server");
    assert.equal(metrics[0].costUsd, undefined); // configured list prices are NOT subscription billing
    assert.equal(metrics[0].pricingStatus, "missing");
    assert.equal(metrics[0].usageStatus, mode === "no-usage" ? "missing" : "reported");
    assert.equal(metrics[0].usage?.outputTokens, mode === "no-usage" ? undefined : mode === "trailing" ? 80 : 30);
    if (mode === "completed") {
      assert.equal(metrics[0].usage?.inputTokens, 180);
      assert.equal(metrics[0].usage?.cacheReadTokens, 20);
      // Legacy merged-log fallback agrees if the sidecar is absent.
      fs.unlinkSync(headlessStdoutLogPath(f.logPath));
      assert.deepEqual(parseResultLine(f.logPath, "codex-app-server"), parsed);
    }
  });
}

test("shared metrics collector preserves legacy source naming", (t) => {
  const f = setup(t); fs.mkdirSync(path.dirname(f.logPath), { recursive: true });
  fs.writeFileSync(f.logPath, JSON.stringify({ type: "result", total_cost_usd: 0.1, usage: { input_tokens: 10, output_tokens: 20 } }) + "\n");
  const result = collectHeadlessCostsByPhase(path.dirname(f.logPath), 0, new Set([1]), "claude", { tokens: {}, images: {} }).get(1)!;
  assert.equal(result[0].source, "headless:claude"); assert.equal(result[0].costUsd, 0.1);
});

test("a blocked debug sink cannot defeat the invocation deadline", { timeout: 15000 }, async (t) => {
  const f = setup(t);
  const blocked = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { /* never drains */ } });
  configureLogging({ stdout: blocked, stderr: blocked, heartbeatSeconds: 0 });
  t.after(() => { configureLogging({ stdout: process.stdout, stderr: process.stderr, format: "human" }); blocked.destroy(); });
  f.env.AUTOILLUSTRATE_CODEX_RPC_TIMEOUT = "0.2";
  const rc = await f.run({ debug: true, timeoutSecs: 0.5 });
  // Output chunking decides whether completion was received before the sink
  // blocked; either terminal outcome must return and release the child group.
  assert.ok(rc === 0 || rc === 124);
  assert.equal(liveAgentCount(), 0);
});
