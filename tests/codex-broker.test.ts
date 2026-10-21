import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CODEX_BROKER_DISABLED_FEATURES, CODEX_BROKER_FILE, CODEX_BROKER_VISION_ONLY_DISABLED } from "../src/codex-broker.js";
import { liveAgentCount } from "../src/registry.js";
import { startFakeBroker as setup, type Message } from "./fixtures/broker-harness.js";

const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");

const vision = { instructions: "You audit figures.", input: [
  { type: "text", text: "REFERENCE" }, { type: "image", mime: "image/jpeg", data: JPEG_B64 },
  { type: "text", text: "CANDIDATE" }, { type: "image", mime: "image/png", data: JPEG_B64 },
], schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };

test("broker publishes a private loopback descriptor and requires the capability token", async (t) => {
  const f = await setup(t);
  const stat = fs.statSync(path.join(f.workdir, CODEX_BROKER_FILE));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.match(f.descriptor.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(f.descriptor.token.length >= 32);
  assert.equal((await f.call("/v1/vision", vision, null)).status, 401);
  assert.equal((await f.call("/v1/vision", vision, "wrong")).status, 401);
  assert.equal((await f.call("/v1/nope", vision)).status, 404);
  // No app-server is spawned until a request actually needs one.
  assert.equal(f.records().length, 0);
});

test("vision request runs an ephemeral read-only no-tool thread and returns text + usage", async (t) => {
  const f = await setup(t);
  const res = await f.call("/v1/vision", vision);
  assert.equal(res.status, 200);
  const body = await res.json() as Message;
  const answer = JSON.parse(body.text);
  assert.deepEqual(answer.texts, ["REFERENCE", "CANDIDATE"]);
  assert.deepEqual(answer.images, ["data:image/jpeg;base64,", "data:image/png;base64,"]);
  assert.deepEqual(answer.schema, vision.schema);
  assert.equal(answer.effort, "high");
  assert.equal(body.model, "fake-vision");
  assert.deepEqual(body.usage, { inputTokens: 60, cacheReadTokens: 40, outputTokens: 7, reasoningOutputTokens: 2, totalTokens: 107 });

  const records = f.records();
  const spawn = records[0];
  // Names the binary does not know are skipped (it would exit 2 on them).
  assert.ok(!spawn.argv.includes("sleep_tool"));
  assert.ok(spawn.argv.includes("tools.view_image=false"));
  for (const feature of CODEX_BROKER_DISABLED_FEATURES.filter((f) => f !== "sleep_tool")) {
    assert.ok(spawn.argv.join(" ").includes(`--disable ${feature}`), `vision profile must disable ${feature}`);
  }
  for (const feature of CODEX_BROKER_VISION_ONLY_DISABLED) {
    assert.ok(spawn.argv.join(" ").includes(`--disable ${feature}`), `vision profile must disable ${feature}`);
  }
  assert.ok(spawn.argv.includes("mcp_servers={}"));
  // The app-server runs in a private scratch dir, never the run workdir.
  assert.notEqual(fs.realpathSync(spawn.cwd), fs.realpathSync(f.workdir));
  const thread = records.find((r) => r.method === "thread/start")!;
  assert.equal(thread.params.approvalPolicy, "never");
  assert.equal(thread.params.sandbox, "read-only");
  assert.equal(thread.params.ephemeral, true);
  assert.equal(thread.params.developerInstructions, "You audit figures.");
  assert.equal(thread.params.cwd, spawn.cwd);
  const turn = records.find((r) => r.method === "turn/start")!;
  assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(turn.params.approvalPolicy, "never");
  assert.equal(turn.params.input[1].url, `data:image/jpeg;base64,${JPEG_B64}`);
  // The ephemeral thread is released once its turn is done.
  assert.deepEqual(records.find((r) => r.method === "thread/unsubscribe")?.params, { threadId: turn.params.threadId });
});

test("maxConcurrency bounds in-flight turns; queued requests start only when a slot frees", async (t) => {
  const f = await setup(t, "slow", { CODEX_TEST_DELAY_MS: "300" }, { maxConcurrency: 1 });
  const statuses = await Promise.all([0, 1].map(async (i) => (await f.call("/v1/vision", { input: [{ type: "text", text: `q${i}` }] })).status));
  assert.deepEqual(statuses, [200, 200]);
  const log = f.records();
  const starts = log.flatMap((r, i) => (r.method === "turn/start" ? [i] : []));
  const firstDone = log.findIndex((r) => r.sent === "turn/completed");
  assert.equal(starts.length, 2);
  assert.ok(firstDone > starts[0] && starts[1] > firstDone, "second turn started before the first completed");
});

test("concurrent requests share one app-server process and are matched to their own turns", async (t) => {
  const f = await setup(t);
  const bodies = await Promise.all([0, 1, 2, 3, 4].map(async (i) => {
    const res = await f.call("/v1/vision", { input: [{ type: "text", text: `q${i}` }] });
    assert.equal(res.status, 200);
    return JSON.parse(((await res.json()) as Message).text).texts[0];
  }));
  assert.deepEqual(bodies, ["q0", "q1", "q2", "q3", "q4"]);
  assert.equal(f.records().filter((r) => r.argv).length, 1);
  assert.equal(f.records().filter((r) => r.method === "initialize").length, 1);
});

test("image request uses a separate profile with image generation enabled and returns the PNG", async (t) => {
  const f = await setup(t);
  const res = await f.call("/v1/image", { prompt: "IMAGE: restyle", image: { mime: "image/jpeg", data: JPEG_B64 } });
  assert.equal(res.status, 200);
  const body = await res.json() as Message;
  assert.equal(Buffer.from(body.png, "base64").subarray(1, 4).toString(), "PNG");
  assert.equal(body.revisedPrompt, "revised");
  const spawn = f.records().find((r) => r.argv)!;
  // Codex exposes image generation through the code-mode host; shell stays off.
  for (const feature of CODEX_BROKER_VISION_ONLY_DISABLED) assert.ok(!spawn.argv.includes(feature), `image profile must keep ${feature}`);
  assert.ok(spawn.argv.join(" ").includes("--disable shell_tool"));
  const turn = f.records().find((r) => r.method === "turn/start")!;
  assert.equal(turn.params.input[0].text, "IMAGE: restyle");
  assert.equal(turn.params.input[1].type, "image");
});

test("an image turn that produces no image is an upstream failure", async (t) => {
  const f = await setup(t);
  const res = await f.call("/v1/image", { prompt: "no generation here" });
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as Message).error, /no image/);
});

test("malformed requests are rejected before reaching app-server", async (t) => {
  const f = await setup(t);
  assert.equal((await f.call("/v1/vision", "{not json")).status, 400);
  assert.equal((await f.call("/v1/vision", { input: [] })).status, 400);
  assert.equal((await f.call("/v1/vision", { input: [{ type: "image", mime: "image/gif", data: JPEG_B64 }] })).status, 400);
  assert.equal((await f.call("/v1/vision", { input: [{ type: "text", text: "x" }], effort: "ludicrous" })).status, 400);
  assert.equal((await f.call("/v1/image", { prompt: "" })).status, 400);
  assert.equal(f.records().length, 0);
});

test("failed turns, approval requests and widened sandboxes fail the request", async (t) => {
  const failed = await setup(t, "fail");
  const res = await failed.call("/v1/vision", vision);
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as Message).error, /model exploded/);

  const approval = await setup(t, "approval");
  const res2 = await approval.call("/v1/vision", vision);
  assert.equal(res2.status, 502);
  assert.match(((await res2.json()) as Message).error, /requestApproval/);
  const reply = approval.records().find((r) => r.id === 9001 && r.method === undefined)!;
  assert.deepEqual(reply.result, { decision: "decline" });

  const widened = await setup(t, "bad-sandbox");
  const res3 = await widened.call("/v1/vision", vision);
  assert.equal(res3.status, 502);
  assert.match(((await res3.json()) as Message).error, /sandbox/);
  assert.equal(widened.records().filter((r) => r.method === "turn/start").length, 0);
});

test("initialize errors surface and the next request retries with a fresh process", async (t) => {
  const f = await setup(t, "init-error");
  const res = await f.call("/v1/vision", vision);
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as Message).error, /not logged in/);
  assert.equal((await f.call("/v1/vision", vision)).status, 502);
  assert.equal(f.records().filter((r) => r.argv).length, 2);
});

test("a request past its deadline is interrupted and reported as a timeout", async (t) => {
  const f = await setup(t, "slow");
  const started = Date.now();
  // setup() configures a 5 s request deadline; the fake would take 60 s.
  const res = await f.call("/v1/vision", vision);
  assert.equal(res.status, 504);
  assert.ok(Date.now() - started < 15000);
  assert.ok(f.records().some((r) => r.method === "turn/interrupt"));
});

test("close() terminates app-server children, deregisters them and removes the descriptor", async (t) => {
  const f = await setup(t);
  assert.equal((await f.call("/v1/vision", vision)).status, 200);
  assert.equal(liveAgentCount(), 1);
  const pid = f.records().find((r) => r.argv)!.pid as number;
  await f.broker.close();
  assert.equal(liveAgentCount(), 0);
  assert.ok(!fs.existsSync(path.join(f.workdir, CODEX_BROKER_FILE)));
  assert.throws(() => process.kill(pid, 0));
  await assert.rejects(f.call("/v1/vision", vision));
  await f.broker.close(); // idempotent
});

test("export route runs the injected exporter for workdir-confined .drawio → .png paths only", async (t) => {
  const calls: Message[] = [];
  const f = await setup(t, "ok", {}, { exportDrawio: async (req) => {
    calls.push(req);
    if (req.drawioPath.endsWith("boom.drawio")) throw new Error("drawio exploded");
    fs.writeFileSync(req.pngOut, "png");
  } });
  const wd = fs.realpathSync(f.workdir);
  fs.writeFileSync(path.join(wd, "a.drawio"), "<mxfile/>");
  fs.writeFileSync(path.join(wd, "boom.drawio"), "<mxfile/>");
  fs.mkdirSync(path.join(wd, "panels"));
  const outside = fs.mkdtempSync(path.join(path.dirname(wd), "outside-"));
  fs.writeFileSync(path.join(outside, "secret.drawio"), "<mxfile/>");
  fs.symlinkSync(path.join(outside, "secret.drawio"), path.join(wd, "link.drawio"));
  fs.symlinkSync(outside, path.join(wd, "escape"));

  const ok = await f.call("/v1/export", { input: path.join(wd, "a.drawio"), output: path.join(wd, "panels", "a.png"), scale: 2 });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual(calls[0], { drawioPath: path.join(wd, "a.drawio"), pngOut: path.join(wd, "panels", "a.png"), scale: 2 });
  assert.equal(fs.readFileSync(path.join(wd, "panels", "a.png"), "utf8"), "png");

  const rejected = [
    { input: path.join(outside, "secret.drawio"), output: path.join(wd, "x.png") }, // input outside
    { input: path.join(wd, "link.drawio"), output: path.join(wd, "x.png") }, // symlink escape
    { input: path.join(wd, "a.drawio"), output: path.join(wd, "escape", "x.png") }, // output dir escapes
    { input: path.join(wd, "a.drawio"), output: path.join(wd, "x.txt") }, // not a png
    { input: "a.drawio", output: path.join(wd, "x.png") }, // relative
    { input: path.join(wd, "a.drawio"), output: path.join(wd, "x.png"), scale: 2, widthPx: 100 }, // both sizes
    { input: path.join(wd, "a.drawio"), output: path.join(wd, "x.png"), scale: -1 },
  ];
  for (const body of rejected) assert.equal((await f.call("/v1/export", body)).status, 400, JSON.stringify(body));
  assert.equal(calls.length, 1);
  assert.ok(!fs.existsSync(path.join(outside, "x.png")));

  const failed = await f.call("/v1/export", { input: path.join(wd, "boom.drawio"), output: path.join(wd, "boom.png"), widthPx: 640 });
  assert.equal(failed.status, 502);
  assert.match(((await failed.json()) as Message).error, /drawio exploded/);
  // No codex process is ever needed for exports.
  assert.equal(f.records().length, 0);
});

test("without an exporter the export route does not exist", async (t) => {
  const f = await setup(t);
  assert.equal((await f.call("/v1/export", { input: "/x.drawio", output: "/x.png" })).status, 404);
});

test("a hung initialize or thread/start is bounded, and the wedged child is replaced", async (t) => {
  const init = await setup(t, "hang-init", { AUTOILLUSTRATE_CODEX_RPC_TIMEOUT: "1" });
  let started = Date.now();
  const r1 = await init.call("/v1/vision", vision);
  assert.equal(r1.status, 502);
  assert.match(((await r1.json()) as Message).error, /initialize/);
  assert.ok(Date.now() - started < 4000);
  assert.equal((await init.call("/v1/vision", vision)).status, 502);
  assert.equal(init.records().filter((r) => r.argv).length, 2);

  const thread = await setup(t, "hang-thread");
  started = Date.now();
  // setup() configures a 5 s request deadline.
  assert.equal((await thread.call("/v1/vision", vision)).status, 504);
  assert.ok(Date.now() - started < 9000);
  assert.equal((await thread.call("/v1/vision", vision)).status, 504);
  assert.equal(thread.records().filter((r) => r.argv).length, 2, "a deadline before the turn exists evicts the child");
});

test("oversized image payloads are rejected with 413 before any app-server work", async (t) => {
  const f = await setup(t);
  // Over one 16 MiB app-server frame, under the 64 MiB body limit.
  const big = "A".repeat(17 * 1024 * 1024);
  const res = await f.call("/v1/vision", { input: [{ type: "image", mime: "image/png", data: big }] });
  assert.equal(res.status, 413);
  assert.equal(f.records().length, 0);
});

test("a client that disconnects interrupts its turn and frees the slot", async (t) => {
  const f = await setup(t, "ok", {}, { maxConcurrency: 1 });
  const abort = new AbortController();
  const slow = fetch(`${f.descriptor.url}/v1/vision`, {
    method: "POST", signal: abort.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${f.descriptor.token}` },
    body: JSON.stringify({ input: [{ type: "text", text: "SLOW" }] }),
  }).catch(() => "aborted");
  for (const until = Date.now() + 5000; !f.records().some((r) => r.method === "turn/start");) {
    assert.ok(Date.now() < until, "the slow turn never started");
    await new Promise((r) => setTimeout(r, 20));
  }
  abort.abort();
  assert.equal(await slow, "aborted");
  const started = Date.now();
  const next = await f.call("/v1/vision", { input: [{ type: "text", text: "fast" }] });
  assert.equal(next.status, 200);
  assert.ok(Date.now() - started < 3000, "the aborted turn must not hold the only slot");
  assert.ok(f.records().some((r) => r.method === "turn/interrupt"));
});

test("broker scratch lives outside the agent-writable temp roots; the descriptor never follows a planted symlink", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-broker-sym-"));
  const victim = path.join(dir, "victim.txt"); fs.writeFileSync(victim, "keep");
  const workdir = path.join(dir, "wd"); fs.mkdirSync(workdir);
  fs.symlinkSync(victim, path.join(workdir, CODEX_BROKER_FILE));
  for (let pid = process.pid; pid < process.pid + 1; pid++) fs.symlinkSync(victim, path.join(workdir, `${CODEX_BROKER_FILE}.${pid}.tmp`));
  const f = await setup(t, "ok", {}, { workdir });
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
  assert.ok(!fs.lstatSync(path.join(workdir, CODEX_BROKER_FILE)).isSymbolicLink());
  assert.equal((await f.call("/v1/vision", vision)).status, 200);
  const cwd = fs.realpathSync(f.records().find((r) => r.argv)!.cwd);
  for (const root of [os.tmpdir(), "/tmp", process.env.TMPDIR ?? os.tmpdir()]) {
    assert.ok(!cwd.startsWith(fs.realpathSync(root) + path.sep), `${cwd} is under ${root}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("process exit (e.g. Ctrl-C teardown) still removes the descriptor and scratch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-broker-exit-"));
  const script = path.join(dir, "exit.mts");
  fs.writeFileSync(script, `import { startCodexBroker } from ${JSON.stringify(path.resolve("src/codex-broker.ts"))};
const b = await startCodexBroker({ workdir: ${JSON.stringify(dir)} });
console.log(JSON.stringify({ descriptor: b.descriptorPath, scratch: b.scratchDir }));
process.exit(130);
`);
  const { execFileSync } = await import("node:child_process");
  let out = "";
  try { execFileSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8" }); } catch (err: any) { out = err.stdout; }
  const { descriptor, scratch } = JSON.parse(out.trim().split("\n").at(-1)!);
  assert.ok(!fs.existsSync(descriptor));
  assert.ok(!fs.existsSync(scratch));
  fs.rmSync(dir, { recursive: true, force: true });
});
