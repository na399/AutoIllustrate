import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Rule (i): a backslash escape outside math (e.g. a JSON/Python-style "\n"
// typed into an XML attribute) renders literally in draw.io — "Training
// records\nand reference labels". LaTeX inside math (\nabla, \neq) is fine.
function lint(values: string[]): { status: number | null; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-escape-"));
  const file = path.join(dir, "p.drawio.template");
  const cells = values.map((v, i) =>
    `<mxCell id="c${i}" value="${v}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>`).join("\n");
  fs.writeFileSync(file, `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>\n${cells}\n</root></mxGraphModel>\n`);
  const python = process.env.AUTOILLUSTRATE_PYTHON ?? "python3";
  const r = spawnSync(python, ["scripts/lint_math.py", file], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
}

test("lint_math rule (i) rejects literal escapes like \\n in labels", () => {
  const bad = lint(["Training records\\nand reference labels", "tab\\there"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /id='c0'.*literal escape '\\\\n'/);
  assert.match(bad.stderr, /id='c1'.*literal escape '\\\\t'/);
  assert.match(bad.stderr, /&lt;br&gt;|&#xa;/);
});

test("lint_math rule (i) allows real line breaks and LaTeX commands inside math", () => {
  const ok = lint([
    "Training records&lt;br&gt;and reference labels",
    "Training records&#xa;and labels",
    "Gradient \\(\\nabla f \\neq 0\\)",
    "$$\\nu_t = \\nabla \\theta$$",
  ]);
  assert.equal(ok.status, 0, ok.stderr);
});
