// `autoillustrate export` inside a codex-app-server agent delegates to the
// orchestrator's broker, because draw.io (Electron) aborts in the agent sandbox.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { startFakeBroker, type Message } from "./fixtures/broker-harness.js";

const cli = (args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> => new Promise((resolve) => {
  execFile(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { env, encoding: "utf8" }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr });
  });
});

test("cli export delegates to the broker named by AUTOILLUSTRATE_CODEX_BROKER", async (t) => {
  const calls: Message[] = [];
  const f = await startFakeBroker(t, "ok", {}, { exportDrawio: async (req) => {
    calls.push(req);
    if (req.widthPx === 13) throw new Error("export wedged");
    fs.writeFileSync(req.pngOut, "png");
  } });
  const wd = fs.realpathSync(f.workdir);
  const input = path.join(wd, "p.drawio"); fs.writeFileSync(input, "<mxfile/>");
  // PATH without drawio: a local export attempt would fail.
  const env = { ...process.env, PATH: "/usr/bin:/bin", AUTOILLUSTRATE_CODEX_BROKER: f.broker.descriptorPath };
  const ok = await cli(["export", input, path.join(wd, "p.png"), "--export-scale", "2"], env);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /via the Codex broker/);
  assert.deepEqual(calls, [{ drawioPath: input, pngOut: path.join(wd, "p.png"), scale: 2 }]);

  const bad = await cli(["export", input, path.join(wd, "q.png"), "--export-width", "13"], env);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /export wedged/);

  const gone = await cli(["export", input, path.join(wd, "r.png")], { ...env, AUTOILLUSTRATE_CODEX_BROKER: path.join(wd, "missing.json") });
  assert.equal(gone.code, 1);
  assert.match(gone.out, /broker/i);
});
