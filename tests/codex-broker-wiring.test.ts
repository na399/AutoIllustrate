// --agent codex-app-server defaults every model call to the ChatGPT
// subscription through the Codex broker, so no OPENAI_API_KEY is needed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseCli } from "../src/cli.js";
import { agentBackendDefaults, modelNeeds, resolveModelBackends } from "../src/context.js";
import { allChecks, preflight } from "../src/doctor.js";
import { runPipeline, type PipelineOptions } from "../src/pipeline.js";

const FULL = { runsInspect: true, runsVerify: true, runsEnhance: true };
const LIGHT = { runsInspect: false, runsVerify: false, runsEnhance: true };

test("codex-app-server agent defaults audits, unit tests and enhance to the broker", () => {
  assert.deepEqual(agentBackendDefaults("codex-app-server"), { enhanceModel: "codex-app-server", auditVlm: "codex-app-server", unitTestVlm: "auto" });
  assert.deepEqual(agentBackendDefaults("claude"), { enhanceModel: "gpt-image-2.5-sunburst", auditVlm: "gpt-6-astra", unitTestVlm: "openai-single" });

  const plan = resolveModelBackends("codex-app-server", {});
  assert.deepEqual([plan.enhanceBackend, plan.auditBackend, plan.unitTestBackend], ["codex-app-server", "codex-app-server", "codex-app-server"]);
  assert.deepEqual(modelNeeds(plan, FULL), { needsOpenai: false, needsGemini: false, needsCodexCli: false, needsCodexBroker: true, codexBrokerFromAgents: true });
  // light: only Phase 5 (run by the orchestrator itself) uses the broker.
  assert.deepEqual(modelNeeds(plan, LIGHT), { needsOpenai: false, needsGemini: false, needsCodexCli: false, needsCodexBroker: true, codexBrokerFromAgents: false });
  // --resume-from 6: no Phase 5, but the repair loop still re-enhances.
  assert.equal(modelNeeds(plan, { runsInspect: false, runsVerify: true, runsEnhance: false }).needsCodexBroker, true);
  assert.equal(modelNeeds(plan, { runsInspect: false, runsVerify: false, runsEnhance: false }).needsCodexBroker, false);
});

test("explicit choices win over the agent defaults, and the legacy defaults are unchanged", () => {
  // An exported AUDIT_VLM (or --audit-vlm) and --enhance-model override the agent default.
  const mixed = resolveModelBackends("codex-app-server", { AUDIT_VLM: "gpt-6-astra" }, "nanobanana");
  assert.equal(mixed.auditBackend, "openai");
  assert.equal(mixed.unitTestBackend, "openai"); // auto follows the audit backend
  assert.equal(mixed.enhanceBackend, "gemini");
  assert.deepEqual(modelNeeds(mixed, FULL), { needsOpenai: true, needsGemini: true, needsCodexCli: false, needsCodexBroker: false, codexBrokerFromAgents: false });

  const claude = resolveModelBackends("claude", {});
  assert.deepEqual(modelNeeds(claude, FULL), { needsOpenai: true, needsGemini: false, needsCodexCli: false, needsCodexBroker: false, codexBrokerFromAgents: false });
  // Any agent may opt into the broker per backend.
  const brokered = resolveModelBackends("claude", { AUDIT_VLM: "codex-app-server", UNIT_TEST_VLM: "codex-app-server" }, "codex-app-server");
  assert.deepEqual(modelNeeds(brokered, FULL), { needsOpenai: false, needsGemini: false, needsCodexCli: false, needsCodexBroker: true, codexBrokerFromAgents: true });
  assert.equal(resolveModelBackends("claude", {}, "codex").enhanceBackend, "codex");
});

test("CLI: codex-app-server picks the broker enhance model unless one is given; new choices validate", () => {
  const base = ["paper.tex", "--prompt", "p", "--skip-enhance"];
  const tex = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-cli-")), "paper.tex");
  fs.writeFileSync(tex, "x");
  base[0] = tex;
  const run = (args: string[]) => {
    const parsed = parseCli([...base, ...args]);
    assert.equal(parsed.command, "run");
    return parsed.command === "run" ? parsed.pipeline : undefined!;
  };
  assert.equal(run(["--agent", "codex-app-server"]).enhanceModel, "codex-app-server");
  assert.equal(run(["--agent", "codex-app-server", "--enhance-model", "gpt-image-2"]).enhanceModel, "gpt-image-2");
  assert.equal(run(["--agent", "claude"]).enhanceModel, "gpt-image-2.5-sunburst");
  assert.equal(run(["--audit-vlm", "codex-app-server", "--unit-test-vlm", "codex-app-server"]).env!.AUDIT_VLM, "codex-app-server");
});

test("doctor for codex-app-server does not demand OPENAI_API_KEY; other agents still do", () => {
  const env = { PATH: "/nonexistent", OPENAI_API_KEY: "" };
  assert.ok(!allChecks("codex-app-server", env).some((c) => c.name === "OPENAI_API_KEY"));
  assert.ok(allChecks("claude", env).some((c) => c.name === "OPENAI_API_KEY"));
});

function fakeCodex(dir: string, loggedIn = true): string {
  const bin = path.join(dir, "codex");
  fs.writeFileSync(bin, `#!/bin/sh
case "$1 $2" in
  "app-server --help") echo "Run the app server (app-server)"; exit 0 ;;
  "login status") ${loggedIn ? 'echo "Logged in using ChatGPT" >&2; exit 0' : 'echo "Not logged in" >&2; exit 1'} ;;
esac
exit 1
`, { mode: 0o755 });
  return bin;
}

test("preflight for broker backends checks the app-server executable and its ChatGPT login", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-preflight-"));
  const needs = { agent: "claude", needsAgentPhases: false, needsOpenai: false, needsCodexBroker: true };
  const base = { PATH: process.env.PATH, AUTOILLUSTRATE_SKIP_DRAWIO_SMOKE: "1", AUTOILLUSTRATE_PYTHON: process.env.AUTOILLUSTRATE_PYTHON };
  assert.equal(preflight(needs, { ...base, AUTOILLUSTRATE_CODEX_BIN: path.join(dir, "missing") }, dir), false);
  assert.equal(preflight(needs, { ...base, AUTOILLUSTRATE_CODEX_BIN: fakeCodex(path.join(dir), false) }, dir), false);
  const ok = fakeCodex(fs.mkdtempSync(path.join(dir, "ok-")));
  const drawio = path.join(dir, "drawio"); fs.writeFileSync(drawio, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const okEnv = { ...base, PATH: `${dir}${path.delimiter}${process.env.PATH}`, AUTOILLUSTRATE_CODEX_BIN: ok };
  assert.equal(preflight(needs, okEnv, dir), true);
  // A no-network Codex agent sandbox cannot reach the loopback broker.
  const sandboxed = { ...needs, agent: "codex-app-server", codexBrokerFromAgents: true };
  assert.equal(preflight(sandboxed, { ...okEnv, AUTOILLUSTRATE_CODEX_NETWORK_ACCESS: "0" }, dir), false);
  assert.equal(preflight({ ...sandboxed, codexBrokerFromAgents: false }, { ...okEnv, AUTOILLUSTRATE_CODEX_NETWORK_ACCESS: "0" }, dir), true);
  assert.equal(preflight(sandboxed, okEnv, dir), true);
});

test("pipeline runs the broker for the brokered phases and exports the resolved VLM choices", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ai-broker-pipeline-"));
  const bin = path.join(base, "bin"); fs.mkdirSync(bin);
  const seen = path.join(base, "seen.log");
  // Sub-agent stub: record the VLM env each phase sees, then fake the phase's outputs.
  const headless = path.join(bin, "headless-stub");
  fs.writeFileSync(headless, `#!/bin/sh
prompt=""; workdir=""; prev=""
for a in "$@"; do
  [ "$prev" = "--prompt-file" ] && prompt="$a"
  [ "$prev" = "--work-dir" ] && workdir="$a"
  prev="$a"
done
echo "agent AUDIT_VLM=$AUDIT_VLM UNIT_TEST_VLM=$UNIT_TEST_VLM ENHANCE_MODEL=$ENHANCE_MODEL export_via=[$AUTOILLUSTRATE_CODEX_BROKER] broker=$(test -f "$workdir/.codex-broker.json" && echo yes || echo no)" >> ${JSON.stringify(seen)}
case "$prompt" in
  *.phase1_prompt.md)
    printf '{"placement":"half-width","panels":[{"id":"a"}]}' > "$workdir/figure.json"
    echo methods > "$workdir/methods.md"; echo theme > "$workdir/theme.txt"
    printf '{"status":"ok","placement":"half-width","panel_ids":["a"]}' > "$workdir/phase1_report.json" ;;
  *.phase1b_prompt.md) echo '# style' > "$workdir/style.md"; printf '{"status":"ok"}' > "$workdir/style_report.json" ;;
  *.phase2_prompt_*)
    mkdir -p "$workdir/panels"; : > "$workdir/panels/a.png"
    printf 'def build_params(bypass_warnings=False):\\n    return {"page_w": 667, "page_h": 832}\\n' > "$workdir/generate_a.py"
    printf '{"panel_id":"a","status":"ok","residual_issues":[]}' > "$workdir/phase2_report_a.json" ;;
  *.phase3_prompt_*)
    printf '{"panel_id":"a","status":"ok","attempts_used":1,"residual_issues":[]}' > "$workdir/phase3_report_a.json"
    : > "$workdir/panels/a.inspect.json"; : > "$workdir/unit_test_inspections_a.jsonl" ;;
  *.phase6_prompt.md)
    printf '{"winner_attempt":1,"shipped":"enhanced","residual_critical":[],"residual_minor":[],"summary":"ok"}' > "$workdir/phase6_report.json" ;;
esac
exit 0
`, { mode: 0o755 });
  const python = path.join(bin, "python");
  fs.writeFileSync(python, `#!/bin/sh
if [ "$1" = "-c" ]; then case "$2" in *version_info*) echo "3.12" ;; *) echo "2560 1440" ;; esac; exit 0; fi
case "$1" in
  */generate_composite.py) dir=$(dirname "$1"); mkdir -p "$dir/figures"; : > "$dir/figures/full_figure.drawio" ;;
  */enhance.py)
    out=""; wd=""; prev=""
    for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; [ "$prev" = "--workdir" ] && wd="$a"; prev="$a"; done
    echo "enhance model=$ENHANCE_MODEL broker=$(test -f "$wd/.codex-broker.json" && echo yes || echo no)" >> ${JSON.stringify(seen)}
    : > "$out" ;;
esac
exit 0
`, { mode: 0o755 });
  for (const tool of ["drawio", "claude"]) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nprev=""\nfor a in "$@"; do [ "$prev" = "-o" ] && : > "$a"; prev="$a"; done\nexit 0\n`, { mode: 0o755 });
  }
  const source = path.join(base, "paper.pdf"); fs.writeFileSync(source, "pdf");
  const opts: PipelineOptions = {
    source, instructions: "one panel", placement: "infer", agent: "claude",
    outDir: path.join(base, "runs"), cwd: base, resumePhase: 0, skipEnhance: false, sequential: false, force: false,
    enhanceModel: "codex-app-server", panelInspects: 1, enhancementAttempts: 2,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      AUTOILLUSTRATE_HEADLESS_BIN: headless, AUTOILLUSTRATE_PYTHON: python, VENV_PY: python,
      AUTOILLUSTRATE_SKIP_DRAWIO_SMOKE: "1", AUTOILLUSTRATE_CODEX_BIN: fakeCodex(bin),
      OPENAI_API_KEY: "", GEMINI_API_KEY: "", AUDIT_VLM: "codex-app-server", UNIT_TEST_VLM: "auto",
    },
  };
  assert.equal(await runPipeline(opts), 0);
  const lines = fs.readFileSync(seen, "utf8").trim().split("\n");
  assert.ok(lines.length >= 5, lines.join("\n"));
  for (const line of lines) assert.match(line, /broker=yes/, line);
  for (const line of lines.filter((l) => l.startsWith("agent"))) {
    assert.match(line, /AUDIT_VLM=codex-app-server UNIT_TEST_VLM=auto ENHANCE_MODEL=codex-app-server/, line);
    // Only codex-app-server agents (Seatbelt breaks Electron) export via the broker.
    assert.match(line, /export_via=\[\]/, line);
  }
  assert.ok(lines.some((l) => l === "enhance model=codex-app-server broker=yes"));
  const runDir = path.join(opts.outDir, fs.readdirSync(opts.outDir)[0]);
  assert.ok(!fs.existsSync(path.join(runDir, ".codex-broker.json")), "broker descriptor must be removed when the run ends");
});
