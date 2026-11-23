import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Binding layouts: Phase 1 records a user-supplied grid layout as a panel's
// `layout_spec` in figure.json; generators load it through the staged
// assets/panel_layout.py and pass it to panel_geometry.enforce(), which checks
// that the rendered geometry keeps the spec's rows/columns, containers, edge
// set, attachment sides and labels. The fixture is FlowBuilder Figure 1A
// (approved layout + reference geometry), which must pass cleanly.

const FIXTURE = path.resolve("tests/fixtures/layout_fig1a.json");

function py(body: string): { status: number | null; stdout: string; stderr: string } {
  const python = process.env.AUTOILLUSTRATE_PYTHON ?? "python3";
  const src = `
import copy, importlib.util, json, sys
from pathlib import Path
sys.path.insert(0, str(Path("assets").resolve()))
import panel_geometry as g
import panel_layout as L
Rect, EdgePath = g.Rect, g.EdgePath
FIX = json.loads(Path(${JSON.stringify(FIXTURE)}).read_text())
def geometry(fix=None):
    fix = fix or FIX
    elements = [Rect(*e) for e in fix["elements"]]
    containers = [Rect(*c) for c in fix["containers"]]
    paths = [EdgePath(n, c, [tuple(p) for p in pts]) for n, c, pts in fix["paths"]]
    return elements, containers, paths
def spec(fix=None):
    return L.LayoutSpec.from_dict((fix or FIX)["layout_spec"])
def layout_errors(fix):
    elements, containers, paths = geometry(fix)
    return spec(fix).check(elements, paths, containers)[0]
def moved(name, **kw):
    fix = copy.deepcopy(FIX)
    for coll in ("elements", "containers"):
        for e in fix[coll]:
            if e[0] == name:
                for k, v in kw.items():
                    e["xywh".index(k) + 1] = v
    return fix
${body}
`;
  const r = spawnSync(python, ["-c", src], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

function json(body: string): any {
  const r = py(body);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

test("Figure 1A reference geometry satisfies its layout spec and every geometry error check", () => {
  const out = json(`
elements, containers, paths = geometry()
errors, warnings = g.run_checks(elements, paths, *FIX["page"], containers=containers,
                                layout=spec(), palette=FIX["palette"])
print(json.dumps({"errors": errors, "layout": spec().check(elements, paths, containers)}))`);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.layout, [[], []]);
});

test("a node moved to another row breaks row order", () => {
  const errs = json(`print(json.dumps(layout_errors(moved("selected", y=200))))`);
  assert.ok(errs.some((e: string) => /selected .*row/.test(e)), JSON.stringify(errs));
});

test("nodes sharing a row must stay aligned in that row", () => {
  const errs = json(`print(json.dumps(layout_errors(moved("validation", y=300))))`);
  assert.ok(errs.some((e: string) => /validation.*select.*share row 2/.test(e) || /select.*validation.*share row 2/.test(e)), JSON.stringify(errs));
});

test("swapping column order is caught", () => {
  const errs = json(`print(json.dumps(layout_errors(moved("llm", x=1000))))`);
  assert.ok(errs.some((e: string) => /llm.*col/.test(e) || /host.*col/.test(e)), JSON.stringify(errs));
});

test("an edge must leave and enter on the sides the spec names", () => {
  const errs = json(`
fix = copy.deepcopy(FIX)
for p in fix["paths"]:
    if p[0] == "select_selected":
        p[2] = [[520, 450], [520, 480], [900, 480], [900, 450]]
print(json.dumps(layout_errors(fix)))`);
  assert.ok(errs.some((e: string) => /select_selected: source .* right side of select/.test(e)), JSON.stringify(errs));
  assert.ok(errs.some((e: string) => /select_selected: target .* left side of selected/.test(e)), JSON.stringify(errs));
});

test("every spec edge must be drawn and no unspecified edge may be added", () => {
  const errs = json(`
fix = copy.deepcopy(FIX)
fix["paths"] = [p for p in fix["paths"] if p[0] != "generate_select"]
fix["paths"].append(["extra", "#3C4043", [[40, 790], [400, 790]]])
print(json.dumps(layout_errors(fix)))`);
  assert.ok(errs.some((e: string) => /generate_select.*not drawn/.test(e)), JSON.stringify(errs));
  assert.ok(errs.some((e: string) => /extra.*not in the layout/.test(e)), JSON.stringify(errs));
});

test("every spec node needs a rect; every labelled edge needs a <edge>_label rect", () => {
  const errs = json(`
fix = copy.deepcopy(FIX)
fix["elements"] = [e for e in fix["elements"] if e[0] not in ("seed", "dev_host_label")]
print(json.dumps(layout_errors(fix)))`);
  assert.ok(errs.some((e: string) => /node seed .*no Rect/.test(e)), JSON.stringify(errs));
  assert.ok(errs.some((e: string) => /dev_host_label/.test(e)), JSON.stringify(errs));
});

test("containers must enclose their members and title, keep the title above, and exclude non-members", () => {
  const out = json(`
missing = copy.deepcopy(FIX)
missing["containers"] = [c for c in missing["containers"] if c[0] != "agentic"]
print(json.dumps({
    "shrunk": layout_errors(moved("lite", w=200)),
    "title_low": layout_errors(moved("development_data_title", y=300)),
    "intruder": layout_errors(moved("selected", x=600)),
    "missing": layout_errors(missing),
}))`);
  assert.ok(out.shrunk.some((e: string) => /lite does not enclose generate/.test(e)), JSON.stringify(out.shrunk));
  assert.ok(out.title_low.some((e: string) => /development_data_title .*above/.test(e)), JSON.stringify(out.title_low));
  assert.ok(out.intruder.some((e: string) => /selected .*inside container lite/.test(e)), JSON.stringify(out.intruder));
  assert.ok(out.missing.some((e: string) => /container agentic .*no Rect/.test(e)), JSON.stringify(out.missing));
});

test("a fork edge must start on its parent edge", () => {
  const errs = json(`
fix = copy.deepcopy(FIX)
for p in fix["paths"]:
    if p[0] == "tagger_host":
        p[2] = [[1120, 250], [1120, 600]]
print(json.dumps(layout_errors(fix)))`);
  assert.ok(errs.some((e: string) => /tagger_host: source .* on edge tagger_generate/.test(e)), JSON.stringify(errs));
});

test("a declared fork start is not reported as a dangling endpoint", () => {
  const out = json(`
elements, containers, paths = geometry()
_, warnings = g.run_checks(elements, paths, *FIX["page"], containers=containers, layout=spec())
print(json.dumps(warnings))`);
  assert.ok(!out.some((w: string) => /tagger_host: source endpoint/.test(w)), JSON.stringify(out));
});

test("a planar layout forbids crossings even when allowed_crossings declares them", () => {
  const out = json(`
fix = copy.deepcopy(FIX)
for p in fix["paths"]:
    if p[0] == "host_selected":
        p[2] = [[1010, 600], [1010, 540], [900, 540], [900, 450]]
elements, containers, paths = geometry(fix)
errors, _ = g.run_checks(elements, paths, *FIX["page"], containers=containers, layout=spec(),
                         allowed_crossings=[("host_selected", "select_host")])
print(json.dumps(errors))`);
  assert.ok(out.some((e: string) => /planar.*allowed_crossings/.test(e)), JSON.stringify(out));
  assert.ok(out.some((e: string) => /host_selected .*crosses select_host/.test(e) || /select_host .*crosses host_selected/.test(e)), JSON.stringify(out));
});

test("GridFrame places nodes centred in their grid cells, and rejects bad boundaries", () => {
  const out = json(`
frame = L.GridFrame(spec(), col_edges=[0, 300, 740, 1160], row_edges=[40, 150, 330, 500, 720])
r = frame.rect("selected", 280, 80)
s = frame.span("selected")
try:
    L.GridFrame(spec(), col_edges=[0, 300, 1160], row_edges=[40, 150, 330, 500, 720])
    bad = "accepted"
except ValueError as e:
    bad = str(e)
print(json.dumps({"rect": [r.name, r.x, r.y, r.w, r.h], "span": list(s), "bad": bad}))`);
  assert.deepEqual(out.rect, ["selected", 810, 375, 280, 80]);
  assert.deepEqual(out.span, [740, 330, 420, 170]);
  assert.match(out.bad, /col_edges/);
});

test("load_layout_spec / load_palette read figure.json beside the module or at an explicit path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-spec-"));
  const fix = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const fig = {
    palette: fix.palette,
    panels: [
      { id: "construction", layout_spec: fix.layout_spec },
      { id: "execution" },
    ],
  };
  fs.writeFileSync(path.join(dir, "figure.json"), JSON.stringify(fig));
  const out = json(`
f = Path(${JSON.stringify(path.join(dir, "figure.json"))})
s = L.load_layout_spec("construction", figure_json=f)
print(json.dumps({
    "rows": s.rows, "cols": s.cols, "planar": s.planar, "n_edges": len(s.edges),
    "none": L.load_layout_spec("execution", figure_json=f),
    "absent": L.load_layout_spec("nope", figure_json=f),
    "missing_file": L.load_layout_spec("construction", figure_json=f.parent / "missing.json"),
    "palette": L.load_palette(figure_json=f),
}))`);
  assert.equal(out.rows, 4);
  assert.equal(out.cols, 3);
  assert.equal(out.planar, true);
  assert.equal(out.n_edges, 13);
  assert.equal(out.none, null);
  assert.equal(out.absent, null);
  assert.equal(out.missing_file, null);
  assert.deepEqual(out.palette, fix.palette);
});

test("enforce(layout=...) aborts on a layout violation", () => {
  const r = py(`
elements, containers, paths = geometry(moved("selected", y=200))
g.enforce(elements, paths, *FIX["page"], bypass_warnings=True, containers=containers, layout=spec())`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /selected .*row/);
});

test("an edge label must sit next to its edge", () => {
  const errs = json(`print(json.dumps(layout_errors(moved("dev_host_label", y=560))))`);
  assert.ok(errs.some((e: string) => /dev_host_label is \d+px from its edge dev_host/.test(e)), JSON.stringify(errs));
});
