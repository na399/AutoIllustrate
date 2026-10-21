import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_MAX_MESSAGE_BYTES, CodexAppServerSession,
  codexAppServerBinary, findCodexAppServer, codexAppServerSettings, codexTimeoutMs,
  type CodexSessionOptions, type CodexSessionResult,
} from "../src/codex-app-server.js";

type Message = Record<string, any>;
function harness(overrides: Partial<CodexSessionOptions> = {}) {
  const sent: Message[] = [];
  const done: CodexSessionResult[] = [];
  const options = { prompt: "Create an editable figure.\nแผนภาพ 🧠", cwd: process.cwd(), ...overrides };
  const session = new CodexAppServerSession(options, (msg) => sent.push(msg), (result) => done.push(result));
  const receive = (message: Message) => session.push(Buffer.from(`${JSON.stringify(message)}\n`));
  const reply = (result: Message) => receive({ id: sent.at(-1)!.id, result });
  const thread = () => {
    session.start();
    reply({ userAgent: "codex-test" });
    reply({ thread: { id: "thr-1", modelProvider: "openai" }, model: "configured-model" });
  };
  const turn = () => { thread(); reply({ turn: { id: "turn-1", status: "inProgress" } }); };
  const complete = (status = "completed", extras: Message = {}) => receive({
    method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status, ...extras } },
  });
  return { session, sent, done, options, receive, reply, thread, turn, complete };
}

test("Codex handshake waits for initialize response and sends one isolated thread/turn", () => {
  const h = harness({ model: "requested-model", effort: "high" });
  h.session.start(); h.session.start();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].method, "initialize");
  assert.equal(h.sent[0].jsonrpc, undefined);
  assert.equal(h.sent[0].params.capabilities, null);
  h.reply({ userAgent: "test" });
  assert.deepEqual(h.sent.slice(1).map((msg) => msg.method), ["initialized", "thread/start"]);
  assert.deepEqual(h.sent[2].params, {
    cwd: process.cwd(), approvalPolicy: "never", sandbox: "workspace-write",
    ephemeral: true, model: "requested-model",
  });
  h.reply({ thread: { id: "thr-1" } });
  assert.deepEqual(h.sent[3].params, {
    threadId: "thr-1", input: [{ type: "text", text: h.options.prompt, text_elements: [] }],
    cwd: process.cwd(), approvalPolicy: "never", effort: "high",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  });
  h.reply({ turn: { id: "turn-1", status: "inProgress" } });
  assert.equal(h.done.length, 0);
  h.complete();
  assert.deepEqual(h.done, [{ code: 0 }]);
});

test("Codex keeps configured model/effort defaults when overrides are absent", () => {
  const h = harness(); h.thread();
  assert.ok(!Object.hasOwn(h.sent[2].params, "model"));
  assert.ok(!Object.hasOwn(h.sent[3].params, "effort"));
  assert.equal(h.session.usageRecord().usage && (h.session.usageRecord().usage as Message).model, "configured-model");
});

test("UTF-8 and newline framing survive every byte arriving separately", () => {
  const h = harness(); h.session.start();
  const bytes = Buffer.from(JSON.stringify({ id: 1, result: { userAgent: "แผนภาพ 🧠" } }) + "\r\n");
  for (const byte of bytes) h.session.push(Buffer.from([byte]));
  assert.equal(h.sent.at(-1)!.method, "thread/start");
  assert.equal(h.done.length, 0);
});

test("multiple messages per chunk, blank lines and unknown notifications are harmless", () => {
  const h = harness(); h.turn();
  h.session.push(Buffer.from('\n' + JSON.stringify({ method: "future/notification", params: { threadId: "thr-1" } }) + '\n' + JSON.stringify({ method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } } }) + '\n'));
  assert.deepEqual(h.done, [{ code: 0 }]);
});

test("notifications for other threads/turns never complete the requested turn", () => {
  const h = harness(); h.turn();
  for (const [threadId, turnId] of [["other", "turn-1"], ["thr-1", "other"]]) {
    h.receive({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  }
  assert.equal(h.done.length, 0);
  h.complete(); assert.equal(h.session.result!.code, 0);
});

test("completion before turn/start response is buffered and matched to returned id", () => {
  const h = harness(); h.thread(); h.complete();
  assert.equal(h.done.length, 0);
  h.reply({ turn: { id: "turn-1", status: "inProgress" } });
  assert.deepEqual(h.done, [{ code: 0 }]);
});

test("foreign early completion cannot mask failure of the actual turn", () => {
  const h = harness(); h.thread();
  h.receive({ method: "turn/completed", params: { threadId: "thr-1", turn: { id: "foreign", status: "completed" } } });
  h.reply({ turn: { id: "turn-1", status: "inProgress" } });
  assert.equal(h.done.length, 0);
  h.complete("failed", { error: { message: "model unavailable" } });
  assert.match(h.session.result!.error!, /model unavailable/);
});

for (const status of ["failed", "interrupted", "unknown", undefined]) {
  test(`terminal status ${String(status)} is not success`, () => {
    const h = harness(); h.turn();
    h.receive({ method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status, error: { message: "failure reason" } } } });
    assert.equal(h.session.result!.code, 1);
    assert.match(h.session.result!.error!, /failure reason/);
  });
}

for (const method of ["initialize", "thread/start", "turn/start"]) {
  test(`JSON-RPC ${method} error is actionable`, () => {
    const h = harness();
    h.session.start();
    if (method !== "initialize") h.reply({});
    if (method === "turn/start") h.reply({ thread: { id: "thr-1" } });
    h.receive({ id: h.sent.at(-1)!.id, error: { code: -32602, message: "rejected by policy" } });
    assert.deepEqual(h.done, [{ code: 1, error: `${method}: rejected by policy` }]);
  });
}

for (const [phase, result] of [["initialize", null], ["thread/start", {}], ["turn/start", {}]] as const) {
  test(`malformed ${phase} result fails`, () => {
    const h = harness(); h.session.start();
    if (phase !== "initialize") h.reply({});
    if (phase === "turn/start") h.reply({ thread: { id: "thr-1" } });
    h.receive({ id: h.sent.at(-1)!.id, result });
    assert.equal(h.session.result!.code, 1);
  });
}

for (const payload of ["not JSON\n", "null\n", "[]\n", "42\n", "{}\n"]) {
  test(`malformed stdout ${payload.trim()} fails without echoing it`, () => {
    const h = harness(); h.session.start(); h.session.push(Buffer.from(payload));
    assert.equal(h.session.result!.code, 1);
    assert.doesNotMatch(h.session.result!.error!, /not JSON/);
  });
}

test("unmatched response ids do not advance initialization", () => {
  const h = harness(); h.session.start(); h.receive({ id: "foreign", result: {} });
  assert.equal(h.sent.length, 1); assert.equal(h.done.length, 0);
  h.reply({}); assert.equal(h.sent.at(-1)!.method, "thread/start");
});

test("premature EOF is failure even after turn/start reports completed", () => {
  const h = harness(); h.thread(); h.reply({ turn: { id: "turn-1", status: "completed" } });
  h.session.end(); assert.equal(h.session.result!.code, 1);
  assert.match(h.session.result!.error!, /before.*turn completed/);
});

test("a final complete JSON message without a newline is processed on EOF", () => {
  const h = harness(); h.turn();
  h.session.push(Buffer.from(JSON.stringify({ method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } } })));
  h.session.end(); assert.equal(h.session.result!.code, 0);
});

test("retryable errors are not confused with a failed terminal turn", () => {
  const h = harness(); h.turn();
  h.receive({ method: "error", params: { threadId: "thr-1", turnId: "turn-1", willRetry: true, error: { message: "retrying" } } });
  assert.equal(h.done.length, 0); h.complete(); assert.equal(h.session.result!.code, 0);
});

for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput", "account/chatgptAuthTokens/refresh", "unknown/request"]) {
  test(`unattended ${method} is refused rather than hanging or auto-approved`, () => {
    const h = harness(); h.turn(); h.receive({ id: "server-1", method, params: {} });
    const response = h.sent.at(-1)!;
    assert.equal(response.id, "server-1");
    if (method.endsWith("requestApproval")) assert.deepEqual(response.result, { decision: "decline" });
    else if (method.endsWith("requestUserInput")) assert.deepEqual(response.result, { answers: {} });
    else assert.equal(response.error.code, -32601);
    assert.equal(h.session.result!.code, 1);
  });
}

test("terminal result and finish callback are settled only once", () => {
  const h = harness(); h.turn(); h.complete(); h.session.end(); h.session.fail("late error"); h.complete("failed");
  assert.deepEqual(h.done, [{ code: 0 }]);
});

test("synchronous transport failure is handled", () => {
  const done: CodexSessionResult[] = [];
  const s = new CodexAppServerSession({ cwd: process.cwd(), prompt: "x" }, () => { throw new Error("broken pipe"); }, (r) => done.push(r));
  s.start(); assert.match(done[0].error!, /broken pipe/);
});

test("message and pre-response queue sizes are bounded", () => {
  const h = harness(); h.session.start(); h.session.push(Buffer.alloc(CODEX_MAX_MESSAGE_BYTES + 1, 120));
  assert.match(h.session.result!.error!, /16 MiB/);
  const q = harness(); q.thread();
  for (let i = 0; i < 65; i++) q.complete();
  assert.match(q.session.result!.error!, /too many.*notifications/);
});

test("oversized complete JSON lines are rejected too", () => {
  const h = harness(); h.session.start();
  h.session.push(Buffer.from(JSON.stringify({ method: "notice", params: { data: "x".repeat(CODEX_MAX_MESSAGE_BYTES) } }) + "\n"));
  assert.match(h.session.result!.error!, /16 MiB/);
});

const usage = (inputTokens: number, outputTokens: number) => ({
  method: "thread/tokenUsage/updated", params: {
    threadId: "thr-1", turnId: "turn-1", tokenUsage: {
      total: { inputTokens, outputTokens, cachedInputTokens: 25, cacheWriteInputTokens: 0, reasoningOutputTokens: 4, totalTokens: inputTokens + outputTokens },
      last: { inputTokens: 1, outputTokens: 1 },
    },
  },
});
test("usage uses the last cumulative snapshot, not sum of snapshots or last inference", () => {
  const h = harness(); h.turn(); h.receive(usage(100, 10)); h.receive(usage(200, 50)); h.complete();
  assert.deepEqual(h.session.usageRecord(), { type: "usage", usage: {
    agent: "codex-app-server", model: "configured-model", provider: "openai",
    usageStatus: "reported", pricingStatus: "missing", inputTokens: 175,
    cacheReadTokens: 25, cacheWriteTokens: 0, outputTokens: 50,
    reasoningOutputTokens: 4, totalTokens: 250,
  } });
  assert.equal((h.session.usageRecord().usage as Message).cost, undefined);
});

test("early usage and completion notifications retain accounting", () => {
  const h = harness(); h.thread(); h.receive(usage(100, 20)); h.complete();
  h.reply({ turn: { id: "turn-1" } });
  assert.equal((h.session.usageRecord().usage as Message).outputTokens, 20);
});

test("foreign usage is ignored and absent counts are not invented", () => {
  const h = harness(); h.turn();
  const u = usage(100, 20); u.params.turnId = "foreign"; h.receive(u); h.complete();
  const record = h.session.usageRecord().usage as Message;
  assert.equal(record.usageStatus, "missing"); assert.equal(record.outputTokens, undefined);
});

test("invalid and negative token counts are not reported", () => {
  const h = harness(); h.turn();
  const u = usage(-1, -5); h.receive(u); h.complete();
  const record = h.session.usageRecord().usage as Message;
  assert.equal(record.usageStatus, "missing"); assert.equal(record.inputTokens, undefined);
});

test("custom executable paths are literal, absolute and validated", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-codex-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, "codex with spaces");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(codexAppServerBinary({}), "codex");
  assert.equal(codexAppServerBinary({ AUTOILLUSTRATE_CODEX_BIN: "./local/codex" }), path.resolve("local/codex"));
  assert.equal(findCodexAppServer({ AUTOILLUSTRATE_CODEX_BIN: executable, PATH: "" }), executable);
  assert.equal(findCodexAppServer({ AUTOILLUSTRATE_CODEX_BIN: "codex with spaces", PATH: dir }), executable);
  assert.equal(findCodexAppServer({ AUTOILLUSTRATE_CODEX_BIN: dir }), null);
  assert.equal(findCodexAppServer({ AUTOILLUSTRATE_CODEX_BIN: "codex --flag", PATH: dir }), null);
  assert.equal(findCodexAppServer({ PATH: "" }), null);
});

for (const ordering of ["same-chunk", "later-chunk", "before-ack"]) {
  test(`final usage survives completion (${ordering}) without changing the result`, () => {
    const h = harness();
    if (ordering === "before-ack") h.thread(); else h.turn();
    const complete = { method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } } };
    if (ordering === "same-chunk") h.session.push(Buffer.from(`${JSON.stringify(complete)}\n${JSON.stringify(usage(300, 80))}\n`));
    else { h.receive(complete); h.receive(usage(300, 80)); }
    if (ordering === "before-ack") h.reply({ turn: { id: "turn-1", status: "inProgress" } });
    h.session.end();
    assert.deepEqual(h.done, [{ code: 0 }]);
    assert.equal((h.session.usageRecord().usage as Message).totalTokens, 380);
  });
}

test("a malformed later snapshot cannot erase valid usage", () => {
  const h = harness(); h.turn(); h.receive(usage(100, 20)); h.receive(usage(-1, 0)); h.complete();
  assert.equal((h.session.usageRecord().usage as Message).totalTokens, 120);
});

for (const early of [false, true]) {
  test(`fatal error notification ends the invocation (early=${early})`, () => {
    const h = harness(); if (early) h.thread(); else h.turn();
    h.receive({ method: "error", params: { threadId: "thr-1", turnId: "turn-1", willRetry: false, error: { message: "authentication failed" } } });
    if (early) h.reply({ turn: { id: "turn-1", status: "inProgress" } });
    assert.equal(h.session.result?.code, 1);
    assert.match(h.session.result?.error ?? "", /authentication failed/);
  });
}

for (const status of ["failed", "interrupted"]) {
  test(`turn/start ${status} acknowledgement cannot hang waiting for notification`, () => {
    const h = harness(); h.thread(); h.reply({ turn: { id: "turn-1", status, error: { message: "rejected" } } });
    assert.equal(h.session.result?.code, 1);
    assert.match(h.session.result?.error ?? "", /rejected/);
  });
}

for (const [method, response] of [
  ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
  ["mcpServer/elicitation/request", { action: "decline", content: null }],
] as const) {
  test(`${method} receives its own protocol-correct denial shape`, () => {
    const h = harness(); h.turn(); h.receive({ id: 91, method, params: {} });
    assert.deepEqual(h.sent.at(-1), { id: 91, result: response });
    assert.equal(h.session.result?.code, 1);
  });
}

for (const early of [false, true]) {
  test(`cancellation sends turn/interrupt before finishing (early=${early})`, () => {
    const h = harness(); if (early) {
      h.thread(); h.receive({ method: "turn/started", params: { threadId: "thr-1", turn: { id: "turn-1" } } });
    } else h.turn();
    h.session.cancel("deadline", 124);
    assert.equal(h.sent.at(-1)?.method, "turn/interrupt");
    assert.deepEqual(h.sent.at(-1)?.params, { threadId: "thr-1", turnId: "turn-1" });
    h.complete(); h.session.cancel("user", 130);
    assert.deepEqual(h.done, [{ code: 124, error: "deadline" }]);
  });
}

test("cancellation before thread creation sends no invalid interrupt", () => {
  const h = harness(); h.session.start(); h.session.cancel("cancelled");
  assert.equal(h.sent.length, 1); assert.equal(h.session.result?.code, 130);
});

test("network access can be disabled without changing sandbox or approval policy", () => {
  const h = harness({ networkAccess: false }); h.thread();
  assert.equal(h.sent.at(-1)?.params.sandboxPolicy.networkAccess, false);
  assert.equal(h.sent.at(-1)?.params.approvalPolicy, "never");
});

for (const conflict of [{ cwd: "/wrong-workspace" }, { approvalPolicy: "on-request" }, { sandbox: { type: "dangerFullAccess" } }]) {
  test(`effective thread policy mismatch fails closed: ${JSON.stringify(conflict)}`, () => {
    const h = harness(); h.session.start(); h.reply({});
    h.reply({ thread: { id: "thr-1" }, ...conflict });
    assert.equal(h.session.result?.code, 1);
    assert.ok(!h.sent.some((m) => m.method === "turn/start"));
  });
}

test("invalid UTF-8 is not silently replaced in JSON protocol frames", () => {
  const h = harness(); h.session.start();
  h.session.push(Buffer.concat([Buffer.from('{"id":1,"result":{"userAgent":"'), Buffer.from([0xff]), Buffer.from('"}}\n')]));
  assert.match(h.session.result?.error ?? "", /invalid UTF-8/);
});

test("only pending requests control the handshake deadline, not notifications", () => {
  const methods: (string | undefined)[] = [], sent: Message[] = [];
  const s = new CodexAppServerSession({ cwd: process.cwd(), prompt: "x" }, (m) => sent.push(m), () => {}, (m) => methods.push(m));
  s.start();
  s.push(Buffer.from('{"method":"notice","params":{}}\n'));
  assert.deepEqual(methods, ["initialize"]);
  s.push(Buffer.from('{"id":1,"result":{}}\n'));
  assert.deepEqual(methods, ["initialize", undefined, "thread/start"]);
  s.cancel("stop");
  assert.equal(methods.at(-1), undefined);
});

test("settings reject invalid or overflowing timers and ambiguous network values", () => {
  assert.deepEqual(codexAppServerSettings({}), { rpcTimeoutMs: 30000, networkAccess: true });
  assert.deepEqual(codexAppServerSettings({ AUTOILLUSTRATE_CODEX_RPC_TIMEOUT: "0.5", AUTOILLUSTRATE_CODEX_NETWORK_ACCESS: "0" }), { rpcTimeoutMs: 500, networkAccess: false });
  for (const value of ["0", "-1", "NaN", "Infinity", "3000000", ""]) {
    assert.throws(() => codexAppServerSettings({ AUTOILLUSTRATE_CODEX_RPC_TIMEOUT: value }), /must be positive/);
  }
  for (const value of ["true", "false", "yes", ""]) assert.throws(() => codexAppServerSettings({ AUTOILLUSTRATE_CODEX_NETWORK_ACCESS: value }), /must be 0 or 1/);
  assert.throws(() => codexTimeoutMs(0, "timeout"), /timeout/);
  assert.equal(codexTimeoutMs(0.0001, "timeout"), 1);
});

test("large single-byte fragments remain frameable", () => {
  const h = harness(); h.session.start();
  const bytes = Buffer.from(JSON.stringify({ id: 1, result: { userAgent: "x".repeat(150000) } }) + "\n");
  for (const byte of bytes) h.session.push(Buffer.from([byte]));
  assert.equal(h.session.pendingMethod, "thread/start"); assert.equal(h.done.length, 0);
});
