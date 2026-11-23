import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Python's Rects are whatever size the generator chose; nothing checks that
// the label drawn into a box actually fits it. The Figure 1 re-runs (v3c)
// shipped "Generate predicates; fit Boolean programs or integer scorecards"
// and "Python host: compile, measure, rank, journal" spilling out of their
// boxes, and a container title that wraps to two lines inside a one-line
// title Rect (so an edge runs through the visible title). assets/panel_text.py
// estimates each filled cell's wrapped text block from Helvetica metrics and
// flags overflow; it runs beside panel_geometry.check_rendered.

const python = process.env.AUTOILLUSTRATE_PYTHON ?? "python3";
const FIXTURES = path.join("tests", "fixtures", "text_fit");

const BOX = "rounded=0;whiteSpace=wrap;html=1;fillColor=#F1F3F5;strokeColor=#1F2328;strokeWidth=1.5;fontFamily=Helvetica;fontColor=#1F2328;align=center;verticalAlign=middle;";
const TITLE = "text;html=1;whiteSpace=wrap;align=center;verticalAlign=middle;fontFamily=Helvetica;fontStyle=1;fontColor=#1F2328;fillColor=#FFFFFF;strokeColor=none;";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function cell(id: string, value: string, style: string, w: number, h: number, fontSize = 14): string {
  return `<mxCell id="${id}" value="${esc(value)}" style="${style}fontSize=${fontSize};" vertex="1" parent="1">` +
    `<mxGeometry x="10" y="10" width="${w}" height="${h}" as="geometry"/></mxCell>`;
}
function doc(cells: string[]): string {
  return `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join("")}</root></mxGraphModel>`;
}

function fit(xml: string): { errors: string[]; warnings: string[] } {
  const r = spawnSync(python, ["-c", `
import json, sys
sys.path.insert(0, "assets")
from panel_text import check_text_fit
errors, warnings = check_text_fit(sys.stdin.read())
print(json.dumps({"errors": errors, "warnings": warnings}))
`], { input: xml, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
function py(code: string): string {
  const r = spawnSync(python, ["-c", `import sys\nsys.path.insert(0, "assets")\n${code}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test("check_text_fit: three explicit lines in a box two lines tall overflow (v3c 'Python host')", () => {
  const { errors } = fit(doc([cell("host", "Python host:<br>compile, measure,<br>rank, journal", BOX, 174, 46)]));
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /^host: /);
  assert.match(errors[0], /3 lines/);
  assert.match(errors[0], /46/);
});

test("check_text_fit: a <br> line that wraps adds a line and overflows (v3c 'Generate predicates')", () => {
  const value = "Generate predicates; fit<br>Boolean programs or integer<br>scorecards";
  const { errors } = fit(doc([cell("generate", value, BOX, 174, 62)]));
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /^generate: /);
  assert.match(errors[0], /4 lines/);
  assert.match(errors[0], /Boolean programs or integer/, "names the line that wraps");
  // The same three lines fit once the box is wide enough not to wrap.
  assert.deepEqual(fit(doc([cell("generate", value, BOX, 200, 62)])).errors, []);
});

test("check_text_fit: a title that wraps to two lines in a one-line title Rect is caught", () => {
  const { errors } = fit(doc([cell("agentic_title", "Optional FlowBuilder-Agentic refinement", TITLE, 240, 16, 15)]));
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /^agentic_title: /);
  assert.match(errors[0], /2 lines/);
});

test("check_text_fit: labels with room to spare are clean", () => {
  const r = fit(doc([
    cell("renderer", "FlowBuilder-Lite<br>SQL renderer", BOX, 260, 54, 15),
    cell("sqlite", "SQLite execution on<br>records selected for<br>the execution check", BOX, 260, 74, 15),
    cell("title", "Development data", TITLE, 142, 20, 15),
  ]));
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("check_text_fit: text whose ink fits but crowds a bordered box is a warning, not an error", () => {
  // Two 14 px lines: line boxes 33.6 px, glyphs ~30.8 px. In a 32 px box the
  // glyphs fit but touch the border.
  const r = fit(doc([cell("tight", "First line<br>second line", BOX, 160, 32)]));
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1, JSON.stringify(r.warnings));
  assert.match(r.warnings[0], /^tight: /);
  // A borderless text cell has no border to crowd: same geometry, no warning.
  assert.deepEqual(fit(doc([cell("tight", "First line<br>second line", TITLE, 160, 32)])), { errors: [], warnings: [] });
  // Line boxes that exactly fill the box are fine (v3b panel B 'Precision, recall / and F1').
  assert.deepEqual(fit(doc([cell("snug", "First line<br>second line", BOX, 160, 34)])), { errors: [], warnings: [] });
});

test("check_text_fit: an unbreakable word wider than the box overflows horizontally", () => {
  const { errors } = fit(doc([cell("word", "Supercalifragilistic", BOX, 90, 40)]));
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /^word: .*wide/);
});

test("check_text_fit: a label without whiteSpace=wrap never wraps, so a long line overflows", () => {
  const style = BOX.replace("whiteSpace=wrap;", "");
  const { errors } = fit(doc([cell("nowrap", "A label that is far too long for its box", style, 120, 60)]));
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /^nowrap: .*wide/);
});

test("check_text_fit: inline <b> uses bold metrics and entities are decoded", () => {
  // 'm' is 833 units regular, 889 bold: ten of them at 14 px are 116.6 vs 124.5 px.
  const regular = "mmmmmmmmmm";
  assert.deepEqual(fit(doc([cell("m", regular, BOX, 122, 30)])), { errors: [], warnings: [] });
  assert.equal(fit(doc([cell("m", `<b>${regular}</b>`, BOX, 122, 30)])).errors.length, 1, "bold is wider than the 122 px box");
  // &nbsp; stays a no-break space so wrapping never splits there.
  assert.equal(py(`from panel_text import label_lines\nprint(label_lines("A &amp; B&nbsp;C<br/>D") == ["A & B\\xa0C", "D"])`), "True");
});

test("check_text_fit: skips empty values, edge labels, labels outside the shape and placeholder tokens", () => {
  const outside = BOX + "verticalLabelPosition=bottom;verticalAlign=top;";
  const placeholder = "rounded=0;whiteSpace=wrap;html=1;fillColor=#F0F0F0;strokeColor=#9E9E9E;dashed=1;fontFamily=monospace;fontColor=#616161;";
  const r = fit(doc([
    cell("empty", "", BOX, 10, 10),
    cell("below", "A long caption under an icon", outside, 20, 20),
    // [[ pl ]] / [[ mp ]] boxes are replaced by an image; the token never renders.
    cell("pl1", "[[ pl construction 1 ]]", placeholder, 30, 30),
    cell("mp1", "[[ mp construction 1 ]]", placeholder, 30, 30),
    `<mxCell id="e" value="a very long edge label that has no box" style="endArrow=block;" edge="1" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>`,
  ]));
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("label_size: returns the box a label needs (lines x 1.2 em + spacing) for sizing Rects", () => {
  const out = JSON.parse(py(`
import json
from panel_text import label_size
print(json.dumps([label_size("Python host:<br>compile, measure,<br>rank, journal", 14),
                  label_size("Generate predicates; fit Boolean programs or integer scorecards", 14, box_width=174)]))`));
  const [[w1, h1], [w2, h2]] = out;
  assert.ok(h1 >= 54 && h1 <= 56, `3 lines at 14 px need ~54.4 px, got ${h1}`);
  assert.ok(w1 > 100 && w1 < 130, `widest line 'compile, measure,' ~ 113 px + spacing, got ${w1}`);
  assert.ok(w2 <= 174, `wrapped inside the 174 px box, got ${w2}`);
  assert.ok(h2 >= 3 * 16.8, `the sentence wraps to at least 3 lines, got ${h2}`);
  // Sizing a box with label_size makes check_text_fit clean.
  const [w, h] = out[0].map((v: number) => Math.ceil(v));
  assert.deepEqual(fit(doc([cell("host", "Python host:<br>compile, measure,<br>rank, journal", BOX, w, h)])), { errors: [], warnings: [] });
});

test("enforce_text_fit: errors abort; warnings abort unless bypassed", () => {
  const run = (value: string, h: number, bypass: boolean) => spawnSync(python, ["-c", `
import sys
sys.path.insert(0, "assets")
from panel_text import enforce_text_fit
enforce_text_fit(sys.stdin.read(), bypass_warnings=${bypass ? "True" : "False"})
print("written")
`], { input: doc([cell("c", value, BOX, 160, h)]), encoding: "utf8" });
  const err = run("one<br>two<br>three", 30, true);
  assert.equal(err.status, 1);
  assert.match(err.stderr, /TEXT: c: /);
  const warn = run("First line<br>second line", 32, false);
  assert.equal(warn.status, 1);
  assert.match(warn.stderr, /WARNING: c: /);
  assert.match(warn.stderr, /--bypass-warnings/);
  const bypassed = run("First line<br>second line", 32, true);
  assert.equal(bypassed.status, 0, bypassed.stderr);
  assert.match(bypassed.stdout, /written/);
});

test("calibration: the v3c construction panel is flagged at exactly the cells that overflow", () => {
  const { errors } = fit(fs.readFileSync(path.join(FIXTURES, "v3c_construction.drawio"), "utf8"));
  const ids = errors.map((e) => e.split(":")[0]).sort();
  assert.deepEqual(ids, ["agentic_title", "generate", "host"], JSON.stringify(errors, null, 1));
});

test("calibration: the v3b construction panel is flagged at its two overflowing cells", () => {
  // Confirmed in the v3b render: 'Python host: compile, measure, rank, journal'
  // spills four lines over a 56 px box, and the edge label 'training evidence
  // and feedback' wraps to two lines inside a 20 px label Rect.
  const { errors } = fit(fs.readFileSync(path.join(FIXTURES, "v3b_construction.drawio"), "utf8"));
  const ids = errors.map((e) => e.split(":")[0]).sort();
  assert.deepEqual(ids, ["host", "host_llm_label"], JSON.stringify(errors, null, 1));
});

test("calibration: panel B of v3b and v3c (every label fits) is clean", () => {
  for (const f of ["v3b_deployment.drawio", "v3c_deployment.drawio"]) {
    assert.deepEqual(fit(fs.readFileSync(path.join(FIXTURES, f), "utf8")), { errors: [], warnings: [] }, f);
  }
});

test("the panel template runs the text-fit check on the filled template before writing", () => {
  const tpl = fs.readFileSync("assets/generate_panel_template.py", "utf8");
  assert.ok(/from panel_text import enforce_text_fit/.test(tpl), tpl.slice(0, 2000));
  assert.ok(
    /enforce_rendered\(xml, build_elements\(\), build_paths\(\), build_containers\(\)\)\s*\n\s*enforce_text_fit\(xml, bypass_warnings=args\.bypass_warnings\)/.test(tpl),
    "main() must check text fit right after the render check",
  );
});

test("check_params_contract.py fails when a filled template's label overflows its box", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "text-contract-"));
  for (const lib of ["panel_geometry.py", "panel_layout.py", "panel_text.py"]) {
    fs.copyFileSync(path.join("assets", lib), path.join(dir, lib));
  }
  fs.writeFileSync(path.join(dir, "generate_p.py"), `
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from panel_geometry import Rect
def build_elements(): return [Rect("c", 10, 10, 160, 30)]
def build_containers(): return []
def build_paths(): return []
def build_params(bypass_warnings=False):
    return {"page_w": 200, "page_h": 60}
`);
  const tpl = (value: string) => doc([cell("c", value, BOX, 160, 30)]).replace(/[{}]/g, (m) => m + m);
  const run = () => spawnSync(python, ["scripts/check_params_contract.py", path.join(dir, "generate_p.py")], { encoding: "utf8" });

  fs.writeFileSync(path.join(dir, "p.drawio.template"), tpl("one line"));
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);

  fs.writeFileSync(path.join(dir, "p.drawio.template"), tpl("one<br>two<br>three"));
  const bad = run();
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stderr, /TEXT: c: /);
  assert.match(bad.stderr, /CONTRACT: .*text/i);
});
