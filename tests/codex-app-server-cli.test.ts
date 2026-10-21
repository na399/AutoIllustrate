import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCli, USAGE } from "../src/cli.js";
import { allChecks, checkAgentCli, checkCodexAppServerCli, checkCodexCli, preflight } from "../src/doctor.js";

const args = [process.cwd(), "--prompt", "Draw the method", "--agent", "codex-app-server"];
for (const mode of ["light", "medium", "full"]) {
  test(`CLI accepts app-server with ${mode} and leaves Codex model/effort defaults intact`, () => {
    const result = parseCli([...args, "--mode", mode]);
    assert.equal(result.command, "run");
    assert.equal(result.agent, "codex-app-server");
    assert.equal(result.pipeline?.agent, "codex-app-server");
    assert.equal(result.pipeline?.model, undefined);
    assert.equal(result.pipeline?.effort, undefined);
  });
}
test("CLI forwards app-server model, effort, phase budgets and skip-enhance", () => {
  const result = parseCli([...args, "--model", "my-model", "--effort", "xhigh", "--panel-inspects", "0", "--skip-enhance"]);
  assert.equal(result.pipeline?.model, "my-model");
  assert.equal(result.pipeline?.effort, "xhigh");
  assert.equal(result.pipeline?.panelInspects, 0);
  assert.equal(result.pipeline?.skipEnhance, true);
});
test("CLI permits app-server doctor and resume without a new source", () => {
  const doctor = parseCli(["doctor", "--agent", "codex-app-server"]);
  assert.equal(doctor.command, "doctor"); assert.equal(doctor.agent, "codex-app-server");
  const resume = parseCli(["--workdir", "/tmp/existing-run", "--resume-from", "panels", "--agent", "codex-app-server"]);
  assert.equal(resume.pipeline?.resumePhase, 2);
  assert.equal(resume.pipeline?.agent, "codex-app-server");
});
test("CLI rejects unsupported tmux/effort without changing legacy agents", () => {
  assert.throws(() => parseCli([...args, "--tmux"]), /tmux.*not supported/);
  assert.throws(() => parseCli([...args, "--effort", "maximum"]), /effort/);
  assert.equal(parseCli([process.cwd(), "--prompt", "Draw it"]).agent, "claude");
  const legacy = parseCli([process.cwd(), "--prompt", "Draw it", "--agent", "codex", "--tmux"]);
  assert.equal(legacy.agent, "codex"); assert.equal(legacy.pipeline?.tmux, true);
});
test("help documents the provider and literal executable override", () => {
  assert.match(USAGE, /codex-app-server/);
  assert.match(USAGE, /AUTOILLUSTRATE_CODEX_BIN/);
});
test("doctor resolves codex on PATH, not a nonexistent codex-app-server executable", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-codex-doctor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "codex"); fs.writeFileSync(binary, "#!/bin/sh\necho 'Usage: codex app-server [OPTIONS]'\n", { mode: 0o755 });
  const check = checkAgentCli("codex-app-server", { PATH: dir });
  assert.equal(check.ok, true); assert.equal(check.detail, `${binary} (app-server supported)`);
});
test("doctor honors an absolute override containing spaces and fails invalid overrides", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-codex-doctor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "custom codex"); fs.writeFileSync(binary, "#!/bin/sh\necho 'Usage: codex app-server [OPTIONS]'\n", { mode: 0o755 });
  assert.equal(checkAgentCli("codex-app-server", { PATH: "", AUTOILLUSTRATE_CODEX_BIN: binary }).ok, true);
  assert.equal(checkAgentCli("codex-app-server", { PATH: dir, AUTOILLUSTRATE_CODEX_BIN: path.join(dir, "missing") }).ok, false);
  const missing = checkAgentCli("codex-app-server", { PATH: "" });
  assert.match(missing.hint!, /AUTOILLUSTRATE_CODEX_BIN/);
});
test("doctor does not require Headless for the native app-server route", () => {
  const env = { ...process.env, PATH: "", VENV_PY: process.execPath,
    AUTOILLUSTRATE_SKIP_DRAWIO_SMOKE: "1", AUTOILLUSTRATE_HEADLESS_BIN: "/missing-headless-test",
  };
  assert.equal(allChecks("codex-app-server", env).some((c) => c.name === "headless"), false);
  assert.equal(allChecks("codex", env).some((c) => c.name === "headless"), true);
});

function doctorFixture(t: TestContext, script = "console.log('Usage: codex app-server [OPTIONS]')") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-server preflight "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "custom codex");
  fs.writeFileSync(binary, `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
  const python = path.join(dir, "python"); fs.writeFileSync(python, "#!/bin/sh\necho 3.12\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "drawio"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { PATH: dir, AUTOILLUSTRATE_CODEX_BIN: binary, AUTOILLUSTRATE_PYTHON: python,
    AUTOILLUSTRATE_SKIP_DRAWIO_SMOKE: "1", VENV_PY: python };
  return { dir, binary, env };
}

for (const script of ["process.exit(1)", "console.log('not codex help')", "console.error('secret-token'); process.exit(2)"]) {
  test(`doctor rejects an unsupported executable: ${script}`, (t) => {
    const f = doctorFixture(t, script), check = checkAgentCli("codex-app-server", f.env);
    assert.equal(check.ok, false);
    assert.doesNotMatch(check.detail, /secret-token/);
  });
}

test("doctor capability probe is bounded even when the executable ignores TERM", (t) => {
  const f = doctorFixture(t, "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)");
  const result = checkCodexAppServerCli(f.env, 150);
  assert.equal(result.ok, false); assert.match(result.detail, /timed out/);
});

test("doctor validates app-server settings before launching its capability probe", (t) => {
  const f = doctorFixture(t);
  assert.equal(checkAgentCli("codex-app-server", { ...f.env, AUTOILLUSTRATE_CODEX_RPC_TIMEOUT: "NaN" }).ok, false);
  assert.equal(checkAgentCli("codex-app-server", { ...f.env, AUTOILLUSTRATE_CODEX_NETWORK_ACCESS: "no" }).ok, false);
});

test("scoped preflight accepts an agent-only run without API keys or Headless", (t) => {
  const f = doctorFixture(t);
  assert.equal(preflight({ agent: "codex-app-server", needsAgentPhases: true, needsOpenai: false }, f.env, f.dir), true);
  assert.equal(preflight({ agent: "codex-app-server", needsAgentPhases: true, needsOpenai: true }, f.env, f.dir), false);
});

test("preflight skips the agent check when the resumed operation needs no agent", (t) => {
  const f = doctorFixture(t); fs.unlinkSync(f.binary);
  assert.equal(preflight({ agent: "codex-app-server", needsAgentPhases: false, needsOpenai: false }, f.env, f.dir), true);
  assert.equal(preflight({ agent: "codex-app-server", needsAgentPhases: true, needsOpenai: false }, f.env, f.dir), false);
});

test("custom app-server executable does not satisfy the independent Codex image backend", (t) => {
  const f = doctorFixture(t);
  assert.equal(checkAgentCli("codex-app-server", f.env).ok, true);
  assert.equal(checkCodexCli(f.env).ok, false);
  assert.equal(preflight({ agent: "codex-app-server", needsAgentPhases: true, needsOpenai: false, needsCodexCli: true }, f.env, f.dir), false);
});

test("CLI help names both new settings and configured effort defaults", () => {
  assert.match(USAGE, /AUTOILLUSTRATE_CODEX_RPC_TIMEOUT/);
  assert.match(USAGE, /AUTOILLUSTRATE_CODEX_NETWORK_ACCESS/);
  assert.match(USAGE, /keeps Codex effort defaults/);
});
