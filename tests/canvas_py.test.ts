import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Panel page size follows a binding layout's shape. A panel with a
// `layout_spec` has a natural size (its grid's tracks sized to the labels,
// assets/panel_layout.py natural_tracks); `schema.py --populate-targets`
// keeps the composite's inner width at 2000 and lets its height follow those
// natural aspects (`canvas_w` / `canvas_h` in figure.json), so a tall grid is
// no longer squeezed into a 21:9 strip. Figures without a layout_spec keep
// the fixed per-placement canvas (2000x832 full-width, 2000x1104 half-width).

const FIXTURE = path.resolve("tests/fixtures/layout_fig1a.json");
const python = process.env.AUTOILLUSTRATE_PYTHON ?? "python3";

function py(body: string): { status: number | null; stdout: string; stderr: string } {
  const src = `
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path("assets").resolve()))
sys.path.insert(0, str(Path("scripts").resolve()))
import panel_layout as L
import schema as S
FIX = json.loads(Path(${JSON.stringify(FIXTURE)}).read_text())
def spec(d):
    return L.LayoutSpec.from_dict(d)
${body}
`;
  const r = spawnSync(python, ["-c", src], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

function node(id: string, row: number, col: number, label = "Short label"): any {
  return { id, row, col, label };
}

// A narrow, tall grid: 8 rows of two short boxes. Too tall for a 2000-wide
// column page, so it belongs in a row (or a tall grid cell).
function tallSpec(): any {
  const nodes = [];
  for (let r = 0; r < 8; r++) nodes.push(node(`n${r}a`, r, 0), node(`n${r}b`, r, 1));
  return { rows: 8, cols: 2, nodes, edges: [] };
}

// A wide, short grid: one row of six boxes.
function wideSpec(): any {
  const nodes = [];
  for (let c = 0; c < 6; c++) nodes.push(node(`n${c}`, 0, c));
  return { rows: 1, cols: 6, nodes, edges: [] };
}

function panel(id: string, layout_spec?: any, extra: any = {}): any {
  return { id, title: id, short_caption: id, drawio_prompt: "p", ...(layout_spec ? { layout_spec } : {}), ...extra };
}

function populate(fig: any): { status: number | null; stdout: string; stderr: string; out: any } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-"));
  const file = path.join(dir, "figure.json");
  fs.writeFileSync(file, JSON.stringify({ figure_caption: "c", placement: "full-width", ...fig }));
  const r = spawnSync(python, ["scripts/schema.py", "--validate", file, "--populate-targets"], { encoding: "utf8" });
  const out = r.status === 0 ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out };
}

function naturalAspect(spec: any): number {
  const r = py(`w, h = L.natural_size(spec(json.loads(${JSON.stringify(JSON.stringify(spec))})))\nprint(w / h)`);
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout);
}

function pageAspect(out: any, id: string): number {
  const p = out.panels.find((q: any) => q.id === id);
  return (p.proportion_w * out.canvas_w) / (p.proportion_h * out.canvas_h);
}

function near(actual: number, expected: number, rel: number, what: string): void {
  assert.ok(Math.abs(actual / expected - 1) <= rel, `${what}: ${actual} not within ${rel * 100}% of ${expected}`);
}

test("natural_size: a tall grid is taller than wide, a one-row grid is wide", () => {
  assert.ok(naturalAspect(tallSpec()) < 1, "8x2 grid should be portrait");
  assert.ok(naturalAspect(wideSpec()) > 3, "1x6 grid should be a wide strip");
});

test("natural_tracks: tracks fit their labels, wrap long ones, and keep empty tracks as narrow channels", () => {
  const spec = {
    rows: 2, cols: 3, edges: [],
    nodes: [
      node("a", 0, 0, "A"),
      node("b", 0, 2, "One<br>two<br>three<br>four"),
      node("c", 1, 0, "a very long label that would never fit on one line in any sensible box at all"),
    ],
  };
  const r = py(`
import panel_text as T
cols, rows = L.natural_tracks(spec(json.loads(${JSON.stringify(JSON.stringify(spec))})))
print(json.dumps({"cols": cols, "rows": rows, "four": T.label_size("One<br>two<br>three<br>four", L.NODE_FONT_SIZE)[1],
                  "max_w": L.NODE_MAX_TEXT_W, "empty": L.EMPTY_TRACK, "min_w": L.NODE_MIN_W}))`);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.cols.length, 3);
  assert.equal(o.rows.length, 2);
  assert.equal(o.cols[1], o.empty, "a column with no node is a routing channel");
  assert.ok(o.cols[0] <= o.max_w + 2 * 16 + 1e-6, "the long label wraps at NODE_MAX_TEXT_W");
  assert.ok(o.cols[0] >= o.min_w);
  assert.ok(o.rows[0] >= o.four, "the row holds the four-line label");
  assert.ok(o.rows[1] > o.rows[0] / 4, "the wrapped label takes several lines");
});

test("natural_tracks: a container's title adds a header band to its top row", () => {
  const base = { rows: 2, cols: 1, edges: [], nodes: [node("a", 0, 0), node("b", 1, 0)] };
  const boxed = { ...base, containers: [{ id: "grp", members: ["a", "b"], title: "Group" }] };
  const r = py(`
a = L.natural_tracks(spec(json.loads(${JSON.stringify(JSON.stringify(base))})))[1]
b = L.natural_tracks(spec(json.loads(${JSON.stringify(JSON.stringify(boxed))})))[1]
print(json.dumps([a, b, L.CONTAINER_HEADER]))`);
  assert.equal(r.status, 0, r.stderr);
  const [plain, withBox, header] = JSON.parse(r.stdout);
  assert.equal(withBox[0], plain[0] + header);
  assert.equal(withBox[1], plain[1]);
});

test("GridFrame.fit scales the natural tracks to the page, inside the frame margin", () => {
  const r = py(`
s = spec(FIX["layout_spec"])
f = L.GridFrame.fit(s, 1200, 900)
cols, rows = L.natural_tracks(s)
print(json.dumps({"ce": f.col_edges, "re": f.row_edges, "cols": cols, "rows": rows, "m": L.FRAME_MARGIN, "gap": L.TRACK_GAP}))`);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.ce.length, o.cols.length + 1);
  assert.equal(o.re.length, o.rows.length + 1);
  near(o.ce[0], o.m, 1e-9, "first col edge");
  near(o.ce.at(-1), 1200 - o.m, 1e-9, "last col edge");
  near(o.re.at(-1), 900 - o.m, 1e-9, "last row edge");
  // Cells keep the natural proportions (track + gap).
  const w0 = o.ce[1] - o.ce[0], w1 = o.ce[2] - o.ce[1];
  near(w0 / w1, (o.cols[0] + o.gap) / (o.cols[1] + o.gap), 1e-9, "cell ratio");
});

test("a figure without layout_spec keeps the fixed placement canvas", () => {
  const r = populate({ layout: "column", panels: [panel("a"), panel("b")] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.canvas_w, 2000);
  assert.equal(r.out.canvas_h, 832);
  assert.deepEqual(r.out.panels.map((p: any) => [p.proportion_w, p.proportion_h]), [[1, 0.5], [1, 0.5]]);
  const half = populate({ placement: "half-width", layout: "row", panels: [panel("a"), panel("b")] });
  assert.equal(half.status, 0, half.stderr);
  assert.deepEqual([half.out.canvas_w, half.out.canvas_h], [2000, 1104]);
});

const FIG1A = (): any => JSON.parse(fs.readFileSync(FIXTURE, "utf8")).layout_spec;

test("column: stacked layout_spec panels each get a page close to their grid's natural aspect", () => {
  const r = populate({ layout: "column", panels: [panel("a", FIG1A()), panel("b", wideSpec())] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.canvas_w, 2000);
  assert.ok(r.out.canvas_h > 832, `canvas_h ${r.out.canvas_h} should grow past the 21:9 strip`);
  near(pageAspect(r.out, "a"), naturalAspect(FIG1A()), 0.02, "panel a aspect");
  near(pageAspect(r.out, "b"), naturalAspect(wideSpec()), 0.02, "panel b aspect");
  const sumH = r.out.panels.reduce((s: number, p: any) => s + p.proportion_h, 0);
  near(sumH, 1, 1e-3, "column heights sum to 1");
  assert.match(r.stdout, /canvas=\(2000, \d+\)/);
});

test("column: a free panel beside a layout_spec panel keeps its default share of the strip", () => {
  const r = populate({ layout: "column", panels: [panel("a", FIG1A()), panel("b")] });
  assert.equal(r.status, 0, r.stderr);
  near(pageAspect(r.out, "a"), naturalAspect(FIG1A()), 0.02, "panel a aspect");
  const b = r.out.panels[1];
  near(b.proportion_h * r.out.canvas_h, 832 / 2, 0.01, "free panel height");
});

test("row: a tall layout_spec panel beside another shares one height and each keeps its natural aspect", () => {
  const r = populate({ layout: "row", panels: [panel("a", tallSpec()), panel("b", FIG1A())] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.canvas_w, 2000);
  near(pageAspect(r.out, "a"), naturalAspect(tallSpec()), 0.02, "panel a aspect");
  near(pageAspect(r.out, "b"), naturalAspect(FIG1A()), 0.02, "panel b aspect");
  for (const p of r.out.panels) assert.equal(p.proportion_h, 1);
  const sumW = r.out.panels.reduce((s: number, p: any) => s + p.proportion_w, 0);
  near(sumW, 1, 1e-3, "row widths sum to 1");
});

test("grid: the canvas grows to the tallest panel's need; shares stay span-based", () => {
  const r = populate({
    layout: "grid", grid_rows: 2, grid_cols: 2,
    panels: [
      panel("a", tallSpec(), { row: 0, col: 0, rowspan: 2 }),
      panel("b", undefined, { row: 0, col: 1 }),
      panel("c", FIG1A(), { row: 1, col: 1 }),
    ],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.panels.map((p: any) => [p.proportion_w, p.proportion_h]), [[0.5, 1], [0.5, 0.5], [0.5, 0.5]]);
  near(pageAspect(r.out, "a"), naturalAspect(tallSpec()), 0.02, "panel a aspect");
});

test("the canvas is capped at a printable page aspect (0.7); layout panels absorb the squeeze", () => {
  const r = populate({ layout: "column", panels: [panel("a", tallSpec()), panel("b", tallSpec())] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.canvas_w, 2000);
  assert.equal(r.out.canvas_h, Math.round(2000 / 0.7));
  assert.deepEqual(r.out.panels.map((p: any) => p.proportion_h), [0.5, 0.5]);
  const mixed = populate({ layout: "column", panels: [panel("a", tallSpec()), panel("b")] });
  assert.equal(mixed.status, 0, mixed.stderr);
  assert.equal(mixed.out.canvas_h, Math.round(2000 / 0.7));
  near(mixed.out.panels[1].proportion_h * mixed.out.canvas_h, 832 / 2, 0.01, "free panel keeps its height");
});

test("target dims use the stored canvas; a legacy populate (no canvas) falls back to the placement canvas", () => {
  const r = py(`
fig = {"figure_caption": "c", "placement": "full-width", "layout": "column",
       "panels": [{"id": "a", "title": "a", "short_caption": "a", "drawio_prompt": "p",
                   "layout_spec": json.loads(${JSON.stringify(JSON.stringify(tallSpec()))})}]}
fresh = S.FigureDoc.model_validate(fig)
S.populate_proportions(fresh)
stored = S.compute_panel_target_dims(fresh)["a"]
legacy = S.FigureDoc.model_validate({**fig, "panels": [{**fig["panels"][0], "proportion_w": 1.0, "proportion_h": 1.0}]})
print(json.dumps({"canvas": [fresh.canvas_w, fresh.canvas_h], "stored": stored,
                  "legacy": S.compute_panel_target_dims(legacy)["a"],
                  "unpopulated": S.compute_panel_target_dims(S.FigureDoc.model_validate(fig))["a"]}))`);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepEqual(o.stored, o.canvas);
  assert.deepEqual(o.legacy, [2000, 832]);
  assert.deepEqual(o.unpopulated, o.canvas, "an unpopulated figure computes the same canvas");
});

test("validate rejects a non-positive canvas", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-bad-"));
  const file = path.join(dir, "figure.json");
  fs.writeFileSync(file, JSON.stringify({
    figure_caption: "c", placement: "full-width", layout: "column", canvas_w: 2000, canvas_h: 0, panels: [panel("a")],
  }));
  const r = spawnSync(python, ["scripts/schema.py", "--validate", file], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /canvas/);
});

test("Phase 3's dimension check holds a layout panel to the layout-driven page", () => {
  const r = populate({ layout: "column", panels: [panel("a", FIG1A()), panel("b", wideSpec())] });
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-inspect-")), "figure.json");
  fs.writeFileSync(file, JSON.stringify(r.out));
  const a = r.out.panels[0];
  const w = Math.round(a.proportion_w * r.out.canvas_w), h = Math.round(a.proportion_h * r.out.canvas_h);
  const q = py(`
import inspect_panel as I
t = I._resolve_panel_target(Path(${JSON.stringify(file)}), "a")
fit = I._dimension_issues("a", I._expected_png_dims(${w}, ${h}), t)
strip = I._dimension_issues("a", I._expected_png_dims(2000, 416), t)
print(json.dumps({"fit": fit, "strip": [i["check"] for i in strip]}))`);
  assert.equal(q.status, 0, q.stderr);
  const o = JSON.parse(q.stdout);
  assert.deepEqual(o.fit, [], "a page at the layout-driven target passes");
  assert.deepEqual(o.strip, ["dimensions"], "the old 2000x416 strip is flagged");
});
