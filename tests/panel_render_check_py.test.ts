import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The geometry checks validate the Rects / EdgePaths Python builds, but the
// .drawio that ships is the *template* filled with params. If the template
// drops a waypoint slot or draws a cell nobody registered, the render diverges
// from what was checked (an arrow that stops short of its box passes every
// check). panel_geometry.check_rendered compares the filled template with the
// validated geometry, and scripts/check_params_contract.py runs it.

const python = process.env.AUTOILLUSTRATE_PYTHON ?? "python3";

const ELEMENTS = `[Rect("a", 0, 0, 100, 50), Rect("b", 300, 200, 100, 50), Rect("a_label", 120, 40, 60, 20)]`;
const PATHS = `[EdgePath("ab", "#111111", [(100, 25), (200, 25), (200, 225), (300, 225)])]`;

function cell(id: string, x: number, y: number, w: number, h: number): string {
  return `<mxCell id="${id}" value="x" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
}
function edge(pts: number[][], extra = ""): string {
  const [s, ...rest] = pts;
  const t = rest.pop()!;
  const mids = rest.map(([x, y]) => `<mxPoint x="${x}" y="${y}"/>`).join("");
  return `<mxCell id="e" style="endArrow=block;strokeColor=#111111;" edge="1" parent="1"${extra}><mxGeometry relative="1" as="geometry">` +
    `<mxPoint x="${s[0]}" y="${s[1]}" as="sourcePoint"/><mxPoint x="${t[0]}" y="${t[1]}" as="targetPoint"/>` +
    (mids ? `<Array as="points">${mids}</Array>` : "") + `</mxGeometry></mxCell>`;
}
function doc(cells: string[]): string {
  return `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join("")}</root></mxGraphModel>`;
}
const GOOD_CELLS = [cell("a", 0, 0, 100, 50), cell("b", 300, 200, 100, 50), cell("lab", 120, 40, 60, 20)];
const GOOD_EDGE = edge([[100, 25], [200, 25], [200, 225], [300, 225]]);

function check(xml: string): string[] {
  const r = spawnSync(python, ["-c", `
import json, sys
sys.path.insert(0, "assets")
from panel_geometry import Rect, EdgePath, check_rendered
print(json.dumps(check_rendered(sys.stdin.read(), ${ELEMENTS}, ${PATHS})))
`], { input: xml, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("check_rendered: a render that matches the validated geometry is clean", () => {
  assert.deepEqual(check(doc([...GOOD_CELLS, GOOD_EDGE])), []);
});

test("check_rendered: a template that drops a waypoint is caught (arrow stops short of its box)", () => {
  const errs = check(doc([...GOOD_CELLS, edge([[100, 25], [200, 25], [200, 225]])]));
  assert.ok(errs.some((e) => /ab: .*not drawn/.test(e)), JSON.stringify(errs));
  assert.ok(errs.some((e) => /edge cell e .*matches no EdgePath/.test(e)), JSON.stringify(errs));
});

test("check_rendered: a reversed polyline (wrong arrow direction) does not match", () => {
  const errs = check(doc([...GOOD_CELLS, edge([[300, 225], [200, 225], [200, 25], [100, 25]])]));
  assert.ok(errs.some((e) => /ab: .*not drawn/.test(e)), JSON.stringify(errs));
});

test("check_rendered: a vertex drawn somewhere no Rect was registered is caught", () => {
  const errs = check(doc([cell("a", 0, 0, 100, 50), cell("b", 300, 260, 100, 50), cell("lab", 120, 40, 60, 20), GOOD_EDGE]));
  assert.ok(errs.some((e) => /vertex cell b .*\[300.*260.*\] matches no registered Rect/.test(e)), JSON.stringify(errs));
  assert.ok(errs.some((e) => /Rect b .*not drawn/.test(e)), JSON.stringify(errs));
});

test("check_rendered: straight edges wired by source/target ids are accepted for two-point paths", () => {
  const two = `[EdgePath("ab", "#111111", [(100, 25), (300, 225)])]`;
  const xml = doc([...GOOD_CELLS, `<mxCell id="e" style="endArrow=block;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>`]);
  const r = spawnSync(python, ["-c", `
import json, sys
sys.path.insert(0, "assets")
from panel_geometry import Rect, EdgePath, check_rendered
print(json.dumps(check_rendered(sys.stdin.read(), ${ELEMENTS}, ${two})))
`], { input: xml, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test("check_rendered: container cells are matched against the containers", () => {
  const r = spawnSync(python, ["-c", `
import json, sys
sys.path.insert(0, "assets")
from panel_geometry import Rect, EdgePath, check_rendered
print(json.dumps(check_rendered(sys.stdin.read(), ${ELEMENTS}, ${PATHS}, [Rect("grp", 0, 0, 500, 300)])))
`], { input: doc([cell("grp", 0, 0, 500, 300), ...GOOD_CELLS, GOOD_EDGE]), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test("check_params_contract.py fails when the filled template diverges from the validated geometry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-contract-"));
  for (const lib of ["panel_geometry.py", "panel_layout.py"]) {
    fs.copyFileSync(path.join("assets", lib), path.join(dir, lib));
  }
  const gen = (pts: string) => `
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from panel_geometry import Rect, EdgePath, enforce
def build_elements(): return ${ELEMENTS}
def build_containers(): return []
def build_paths(): return ${PATHS}
def build_params(bypass_warnings=False):
    enforce(build_elements(), build_paths(), 600, 400, bypass_warnings=True)
    p = {"page_w": 600, "page_h": 400}
    for i, (x, y) in enumerate(build_paths()[0].points):
        p[f"ab_x{i}"], p[f"ab_y{i}"] = x, y
    return p
`;
  const tpl = (n: number) => doc([...GOOD_CELLS,
    `<mxCell id="e" style="endArrow=block;strokeColor=#111111;" edge="1" parent="1"><mxGeometry relative="1" as="geometry">` +
    `<mxPoint x="{ab_x0}" y="{ab_y0}" as="sourcePoint"/><mxPoint x="{ab_x${n}}" y="{ab_y${n}}" as="targetPoint"/>` +
    `<Array as="points"><mxPoint x="{ab_x1}" y="{ab_y1}"/>${n === 3 ? `<mxPoint x="{ab_x2}" y="{ab_y2}"/>` : ""}</Array></mxGeometry></mxCell>`]);
  fs.writeFileSync(path.join(dir, "generate_p.py"), gen(PATHS));
  const run = () => spawnSync(python, ["scripts/check_params_contract.py", path.join(dir, "generate_p.py")], { encoding: "utf8" });

  fs.writeFileSync(path.join(dir, "p.drawio.template"), tpl(3));
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);

  fs.writeFileSync(path.join(dir, "p.drawio.template"), tpl(2));
  const bad = run();
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /CONTRACT: .*render/i);
  assert.match(bad.stderr, /ab: .*not drawn/);
});
