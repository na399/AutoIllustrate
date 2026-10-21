// Multi-thread fake of `codex app-server` (stdio JSON-RPC) for broker tests.
// Each turn answers with a JSON summary of what it received, so tests can
// assert the exact request shapes. CODEX_TEST_MODE selects failure modes.
import fs from "node:fs";

const mode = process.env.CODEX_TEST_MODE ?? "ok";
// Like real Codex: `features list` prints the known flags, and an unknown
// `--disable <name>` is a fatal usage error (exit 2). This fake does not know
// `sleep_tool`, so the broker must not pass it.
const KNOWN = ["shell_tool", "unified_exec", "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external",
  "in_app_browser", "computer_use", "memories", "multi_agent", "hooks", "goals", "tool_suggest", "skill_search",
  "skill_mcp_dependency_install", "image_generation", "code_mode_host"];
if (process.argv[2] === "features" && process.argv[3] === "list") {
  for (const name of KNOWN) process.stdout.write(`${name.padEnd(40)} stable             true\n`);
  process.exit(0);
}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--disable" && !KNOWN.includes(process.argv[i + 1])) {
    process.stderr.write(`error: unknown feature ${process.argv[i + 1]}\n`);
    process.exit(2);
  }
}
const recordFile = process.env.CODEX_TEST_RECORD;
const record = (value) => { if (recordFile) fs.appendFileSync(recordFile, `${JSON.stringify(value)}\n`); };
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const imageEnabled = !process.argv.includes("image_generation");
record({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });

// 1x1 transparent PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
let threads = 0;
let turns = 0;
const threadCwd = new Map();
const pendingInterrupts = new Map();
const waitingApproval = new Map();

function finishTurn(threadId, turnId, input, params) {
  const texts = input.filter((i) => i.type === "text").map((i) => i.text);
  const images = input.filter((i) => i.type === "image");
  send({ method: "item/completed", params: { threadId, turnId, item: { type: "userMessage", id: `u-${turnId}`, content: [] } } });
  if (imageEnabled && texts.some((t) => t.includes("IMAGE"))) {
    send({ method: "item/completed", params: { threadId, turnId, item: {
      type: "imageGeneration", id: `ig-${turnId}`, status: "completed", revisedPrompt: "revised", result: PNG_B64, failure: null,
    } } });
  }
  const answer = { texts, images: images.map((i) => i.url.slice(0, i.url.indexOf(",") + 1)), schema: params.outputSchema ?? null, effort: params.effort ?? null };
  // CODEX_TEST_REPLIES maps an output schema's first required key to a canned
  // reply, so script-level tests get a well-formed verdict for each call shape.
  const replies = JSON.parse(process.env.CODEX_TEST_REPLIES ?? "{}");
  const key = params.outputSchema?.required?.[0];
  const text = key && replies[key] !== undefined ? replies[key] : JSON.stringify(answer);
  send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: `m-${turnId}`, text, phase: "final_answer" } } });
  send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: {
    total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 7, reasoningOutputTokens: 2, totalTokens: 107 },
    last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 7, reasoningOutputTokens: 2, totalTokens: 107 },
  } } });
  record({ sent: "turn/completed", turnId });
  send({ method: "turn/completed", params: { threadId, turn: mode === "fail"
    ? { id: turnId, status: "failed", error: { message: "model exploded" }, items: [] }
    : { id: turnId, status: "completed", error: null, items: [] } } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
    const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    record(msg);
    if (msg.method === undefined && waitingApproval.has(msg.id)) {
      // Our approval request was answered; end the turn as Codex would.
      const { threadId, turnId } = waitingApproval.get(msg.id); waitingApproval.delete(msg.id);
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error: { message: "declined" }, items: [] } } });
      continue;
    }
    if (msg.method === "initialize") {
      if (mode === "hang-init") continue; // never answer
      if (mode === "init-error") send({ id: msg.id, error: { code: -32000, message: "not logged in" } });
      else send({ id: msg.id, result: { userAgent: "fake/1.0", platformOs: "macos" } });
    } else if (msg.method === "thread/start") {
      if (mode === "hang-thread") continue; // never answer
      const id = `thr-${++threads}`;
      threadCwd.set(id, msg.params.cwd);
      send({ method: "thread/started", params: { thread: { id } } });
      send({ id: msg.id, result: {
        thread: { id, ephemeral: msg.params.ephemeral },
        approvalPolicy: msg.params.approvalPolicy,
        sandbox: mode === "bad-sandbox" ? { type: "dangerFullAccess" } : { type: "readOnly", networkAccess: false },
        cwd: msg.params.cwd, model: "fake-vision", modelProvider: "openai",
      } });
    } else if (msg.method === "turn/start") {
      const { threadId, input } = msg.params;
      const turnId = `turn-${++turns}`;
      send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
      send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
      if (mode === "approval") {
        const reqId = 9000 + turns;
        waitingApproval.set(reqId, { threadId, turnId });
        send({ id: reqId, method: "item/commandExecution/requestApproval", params: { threadId, turnId, itemId: "x", command: "cat ~/.ssh/id_rsa" } });
      } else if (mode === "slow" || input.some((i) => i.type === "text" && i.text.includes("SLOW"))) {
        pendingInterrupts.set(turnId, threadId);
        const delay = Number(process.env.CODEX_TEST_DELAY_MS ?? 60000);
        setTimeout(() => { if (pendingInterrupts.delete(turnId)) finishTurn(threadId, turnId, input, msg.params); }, delay);
      } else {
        // Answer asynchronously so concurrent turns genuinely interleave.
        setTimeout(() => finishTurn(threadId, turnId, input, msg.params), 20);
      }
    } else if (msg.method === "turn/interrupt") {
      const { threadId, turnId } = msg.params;
      send({ id: msg.id, result: {} });
      if (pendingInterrupts.delete(turnId)) {
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", error: null, items: [] } } });
      }
    } else if (msg.id !== undefined && msg.method) {
      send({ id: msg.id, result: {} });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
