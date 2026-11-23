import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Rule (j): when the template's workdir holds a figure.json with a
// `palette`, every hex colour literal in a cell style must come from that
// palette (white is always allowed; deferred-visual placeholder boxes keep
// their mandated grey). Without a palette the rule is off.

function lint(styles: string[], palette?: string[]): { status: number | null; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-palette-"));
  if (palette) fs.writeFileSync(path.join(dir, "figure.json"), JSON.stringify({ palette }));
  const file = path.join(dir, "p.drawio.template");
  const cells = styles.map((s, i) =>
    `<mxCell id="c${i}" value="${s.startsWith("PH") ? "[[ pl p 1 ]]" : "x"}" style="${s.replace(/^PH/, "")}" vertex="1" parent="1"><mxGeometry x="{x}" y="{y}" width="10" height="10" as="geometry"/></mxCell>`).join("\n");
  fs.writeFileSync(file, `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>\n${cells}\n</root></mxGraphModel>\n`);
  const r = spawnSync(process.env.AUTOILLUSTRATE_PYTHON ?? "python3", ["scripts/lint_math.py", file], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
}

const PALETTE = ["#1F2328", "#F1F3F5", "#0F5E5E"];

test("lint_math rule (j) rejects off-palette colours when figure.json declares a palette", () => {
  const r = lint([
    "rounded=1;fillColor=#f1f3f5;strokeColor=#1F2328;fontColor=#1F2328;",
    "rounded=1;fillColor=#A45B37;strokeColor=#1F2328;",
    "text;fontColor=#704D78;",
  ], PALETTE);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /id='c1'.*#A45B37.*palette/);
  assert.match(r.stderr, /id='c2'.*#704D78.*palette/);
  assert.doesNotMatch(r.stderr, /id='c0'/);
});

test("lint_math rule (j) allows white, none, placeholders, and placeholder-box greys", () => {
  const r = lint([
    "rounded=1;fillColor=#FFFFFF;strokeColor=none;fontColor=#ffffff;",
    "rounded=1;fillColor={fill};strokeColor=#0F5E5E;",
    "PHrounded=0;whiteSpace=wrap;html=1;fillColor=#F0F0F0;strokeColor=#9E9E9E;dashed=1;fontColor=#616161;",
  ], PALETTE);
  assert.equal(r.status, 0, r.stderr);
});

test("lint_math rule (j) is off without a palette", () => {
  const r = lint(["rounded=1;fillColor=#A45B37;"]);
  assert.equal(r.status, 0, r.stderr);
});
