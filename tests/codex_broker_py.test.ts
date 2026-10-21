// The Python side of the Codex broker: scripts/_codex_broker.py and the
// `codex-app-server` backends of inspect_panel.py / verify.py / enhance.py,
// driven end-to-end through a real broker in front of the fake app-server.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { CODEX_BROKER_FILE } from "../src/codex-broker.js";
import { startFakeBroker, type Message } from "./fixtures/broker-harness.js";

const PYTHON = process.env.AUTOILLUSTRATE_PYTHON ?? "python3";
// Async on purpose: the broker answers on this process's event loop.
function python(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(PYTHON, args, { cwd: process.cwd(), env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}
const snippet = (body: string) => `import sys\nsys.path.insert(0, "scripts")\n${body}`;
const PNG_SNIPPET = `
import io
from PIL import Image
def png(color="red", size=(64, 48)):
    buf = io.BytesIO(); Image.new("RGB", size, color).save(buf, format="PNG"); return buf.getvalue()
`;
const ledger = (workdir: string): Message[] => {
  const file = path.join(workdir, "metrics", "api_usage.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};
const writePng = async (target: string, env: NodeJS.ProcessEnv, color = "red") => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const r = await python(["-c", `${PNG_SNIPPET}\nopen(${JSON.stringify(target)}, "wb").write(png(${JSON.stringify(color)}))`], env);
  assert.equal(r.code, 0, r.stderr);
};

test("ask_vision sends ordered text/image parts, returns the text, and records subscription usage", async (t) => {
  const f = await startFakeBroker(t);
  // A hostile proxy setting must not capture loopback broker traffic.
  const env = { ...f.env, HTTP_PROXY: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9" };
  const r = await python(["-c", snippet(`${PNG_SNIPPET}
import json, _codex_broker as cb
text = cb.ask_vision(${JSON.stringify(f.workdir)}, parts=["A", png(), "B", b"\\xff\\xd8\\xff\\xe0jpeg"],
                     instructions="SYS", schema={"type": "object"}, effort="low", phase=3)
print(text)
`)], env);
  assert.equal(r.code, 0, r.stderr);
  const echoed = JSON.parse(r.stdout.trim());
  assert.deepEqual(echoed.texts, ["A", "B"]);
  assert.deepEqual(echoed.images, ["data:image/png;base64,", "data:image/jpeg;base64,"]);
  assert.deepEqual(echoed.schema, { type: "object" });
  assert.equal(echoed.effort, "low");
  assert.equal(f.records().find((m) => m.method === "thread/start")!.params.developerInstructions, "SYS");
  const [record] = ledger(f.workdir);
  assert.equal(record.phase, 3);
  assert.equal(record.source, "codex-app-server-vision");
  assert.equal(record.basis, "subscription");
  assert.equal(record.model, "fake-vision (codex app-server)");
  assert.equal(record.input_tokens, 100); // uncached 60 + cached 40, like prompt_tokens
  assert.equal(record.output_tokens, 7);
});

test("generate_image returns PNG bytes; broker failures and a missing descriptor raise CodexBrokerError", async (t) => {
  const f = await startFakeBroker(t);
  const r = await python(["-c", snippet(`
import _codex_broker as cb
out = cb.generate_image(${JSON.stringify(f.workdir)}, prompt="IMAGE please", image=b"\\x89PNG\\r\\n\\x1a\\nfake", phase=5)
assert out[:4] == b"\\x89PNG", out[:8]
try:
    cb.generate_image(${JSON.stringify(f.workdir)}, prompt="no image", image=None, phase=5)
    raise SystemExit("expected failure")
except cb.CodexBrokerError as exc:
    assert "no image" in str(exc), exc
try:
    cb.ask_vision(${JSON.stringify(f.dir)}, parts=["x"], phase=3)
    raise SystemExit("expected failure")
except cb.CodexBrokerError as exc:
    assert "${CODEX_BROKER_FILE}" in str(exc) and "codex-app-server" in str(exc), exc
print("ok")
`)], f.env);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(ledger(f.workdir).filter((x) => x.source === "codex-app-server-image").length, 1);
});

test("inspect_panel.py --audit-vlm codex-app-server runs all three passes through the broker", async (t) => {
  const verdict = JSON.stringify({ has_defects: false, issues: [{ location: "top", element: "box", description: "slightly tight", severity: "minor" }], summary: "fine" });
  const f = await startFakeBroker(t, "ok", { CODEX_TEST_REPLIES: JSON.stringify({ has_defects: verdict }) });
  await writePng(path.join(f.workdir, "panels", "p1.png"), f.env);
  fs.writeFileSync(path.join(f.workdir, "p1.plan.md"), "# plan\nA box.");
  fs.writeFileSync(path.join(f.workdir, "methods.md"), "# methods\nThe method.");
  const env = { ...f.env, OPENAI_API_KEY: "", GEMINI_API_KEY: "" };
  const r = await python(["scripts/inspect_panel.py", "--workdir", f.workdir, "--panel-id", "p1", "--audit-vlm", "codex-app-server"], env);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const out = JSON.parse(fs.readFileSync(path.join(f.workdir, "panels", "p1.inspect.json"), "utf8"));
  assert.equal(out.has_defects, false);
  assert.deepEqual(out.issues.map((i: Message) => i.check), ["rendering", "truth", "detail"]);
  const turns = f.records().filter((m) => m.method === "turn/start");
  assert.equal(turns.length, 3);
  for (const turn of turns) {
    assert.equal(turn.params.outputSchema.required[0], "has_defects");
    assert.equal(turn.params.effort, "high");
    assert.equal(turn.params.input.filter((i: Message) => i.type === "image").length, 1);
  }
  const threads = f.records().filter((m) => m.method === "thread/start");
  assert.match(threads[0].params.developerInstructions, /rendering/i);
  assert.equal(ledger(f.workdir).filter((x) => x.phase === 3 && x.source === "codex-app-server-vision").length, 3);
});

test("verify.py Stage A and auto Stage B both run through the broker without any API key", async (t) => {
  const verdict = JSON.stringify({ has_wrong_content: false, issues: [], summary: "matches methods" });
  const answers = JSON.stringify({ answers: [{ id: 0, answer: "yes", rationale: "arrow visible" }, { id: 1, answer: "yes", rationale: "label present" }] });
  const f = await startFakeBroker(t, "ok", { CODEX_TEST_REPLIES: JSON.stringify({ has_wrong_content: verdict, answers }) });
  await writePng(path.join(f.workdir, "figures", "full_figure.png"), f.env, "white");
  await writePng(path.join(f.workdir, "figures", "full_figure_enhanced.png"), f.env, "blue");
  fs.writeFileSync(path.join(f.workdir, "methods.md"), "# methods\nThe method.");
  fs.writeFileSync(path.join(f.workdir, "unit_test_inspections_p1.jsonl"),
    `${JSON.stringify({ question: "Is the arrow visible?", expected_answer: "yes" })}\n${JSON.stringify({ question: "Is raw LaTeX visible?", expected_answer: "no" })}\n`);
  const env = { ...f.env, OPENAI_API_KEY: "", GEMINI_API_KEY: "", AUDIT_VLM: "codex-app-server", UNIT_TEST_VLM: "auto" };
  const figures = path.join(f.workdir, "figures");
  const r = await python(["scripts/verify.py", "--workdir", f.workdir, "--reference", path.join(figures, "full_figure.png"),
    "--candidate", path.join(figures, "full_figure_enhanced.png"), "--out", path.join(figures, "verify.json")], env);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const out = JSON.parse(fs.readFileSync(path.join(f.workdir, "figures", "verify.json"), "utf8"));
  assert.equal(out.unit_tests.n_total, 2);
  assert.equal(out.unit_tests.n_pass, 1);
  assert.equal(out.unit_tests.n_fail, 1);
  // The failed probe is promoted to a critical issue, as for every backend.
  assert.equal(out.has_wrong_content, true);
  const turns = f.records().filter((m) => m.method === "turn/start");
  assert.deepEqual(turns.map((m) => m.params.outputSchema.required[0]), ["has_wrong_content", "answers"]);
  // Stage A sees REFERENCE then CANDIDATE; Stage B sees the candidate once.
  assert.equal(turns[0].params.input.filter((i: Message) => i.type === "image").length, 2);
  assert.equal(turns[1].params.input.filter((i: Message) => i.type === "image").length, 1);
  assert.equal(ledger(f.workdir).filter((x) => x.phase === 6).length, 2);
});

test("enhance.py --model codex-app-server restyles through the broker image route", async (t) => {
  const f = await startFakeBroker(t);
  await writePng(path.join(f.workdir, "figures", "full_figure.png"), f.env, "white");
  const env = { ...f.env, OPENAI_API_KEY: "", GEMINI_API_KEY: "" };
  // The prompt must reach the image turn; the fake only draws when it sees IMAGE.
  fs.writeFileSync(path.join(f.workdir, "figure_summary.md"), "IMAGE summary");
  const figures = path.join(f.workdir, "figures");
  const r = await python(["scripts/enhance.py", "--workdir", f.workdir, "--model", "codex-app-server", "--placement", "full-width", "--no-protect-mpl",
    "--input", path.join(figures, "full_figure.png"), "--out", path.join(figures, "full_figure_enhanced.png")], env);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const out = fs.readFileSync(path.join(f.workdir, "figures", "full_figure_enhanced.png"));
  assert.equal(out.subarray(1, 4).toString(), "PNG");
  const turn = f.records().find((m) => m.method === "turn/start")!;
  assert.equal(turn.params.input[1].type, "image");
  assert.ok(f.records().some((m) => m.argv && !m.argv.includes("image_generation")));
  const [record] = ledger(f.workdir);
  assert.equal(record.source, "codex-app-server-image");
  assert.equal(record.phase, 5);
});

test("verify.py single-call driver maps ids, skips malformed entries, retries once and marks missing answers", async () => {
  const r = await python(["-c", snippet(`
import verify
qs = [{"panel_id": "p", "question": f"q{i}", "expected_answer": e, "source_file": "f", "line": i}
      for i, e in enumerate(["yes", "no", "yes"])]
calls = []
def call(user_text):
    calls.append(user_text)
    if len(calls) == 1:
        raise RuntimeError("transient")
    return '{"answers": [{"id": 0, "answer": " YES ", "rationale": "r0"}, {"id": 1, "answer": "maybe"}, "junk", {"id": 2, "answer": "no", "rationale": "r2"}]}'
results, cached = verify._run_unit_tests_single(label="m", questions=qs, call=call)
assert cached is False
assert len(calls) == 2 and "0. q0" in calls[0] and "2. q2" in calls[0], calls
assert [(x["actual_answer"], x["pass"], x["error"]) for x in results] == [("yes", True, False), (None, False, True), ("no", False, False)], results
assert results[1]["rationale"].startswith("FAILED: no answer returned for question 1"), results[1]
none, _ = verify._run_unit_tests_single(label="m", questions=qs[:1], call=lambda _t: "not json", max_retries=1)
assert none[0]["error"] is True and "JSONDecodeError" in none[0]["rationale"], none
print("ok")
`)], process.env);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.stdout.trim().split("\n").at(-1), "ok");
});
