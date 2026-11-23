import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Edge-routing rules in the shared geometry library (assets/panel_geometry.py):
//   * crossings are errors whatever the edge colours; the only exemption is an
//     explicitly declared `allowed_crossings` pair (colour-independent), so a
//     panel agent can no longer "fix" a crossing by recolouring one edge;
//   * an edge may not run through the interior of a node or label rect;
//   * a figure-level palette, when given, closes the set of edge colours.

const GEOMETRY = "assets/panel_geometry.py";

function py(body: string): { status: number | null; stdout: string; stderr: string } {
  const python = process.env.AUTOILLUSTRATE_PYTHON ?? "python3";
  const src = `
import importlib.util, json
from pathlib import Path
_spec = importlib.util.spec_from_file_location("panel_geometry", Path(${JSON.stringify(GEOMETRY)}))
m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(m)
Rect, EdgePath = m.Rect, m.EdgePath
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

// An X: a horizontal and a vertical edge crossing at (100, 100).
const X = `
h = EdgePath("h", "#111111", [(0, 100), (200, 100)])
v = EdgePath("v", "#222222", [(100, 0), (100, 200)])
`;

test("check_path_crossings: differently coloured edges that cross are an error (recolouring no longer exempts)", () => {
  const errs = json(`${X}\nprint(json.dumps(m.check_path_crossings([h, v])))`);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /h segment 0->1 crosses v segment 0->1/);
  assert.match(errs[0], /colou?r does not exempt/i);
});

test("check_path_crossings: same-coloured crossings remain an error", () => {
  const errs = json(`
h = EdgePath("h", "#111111", [(0, 100), (200, 100)])
v = EdgePath("v", "#111111", [(100, 0), (100, 200)])
print(json.dumps(m.check_path_crossings([h, v])))`);
  assert.equal(errs.length, 1);
});

test("check_path_crossings: a declared allowed_crossings pair is exempt regardless of colour or order", () => {
  const out = json(`${X}
same = EdgePath("v", "#111111", v.points)
print(json.dumps({
    "diff": m.check_path_crossings([h, v], allowed_crossings=[("v", "h")]),
    "same": m.check_path_crossings([h, same], allowed_crossings=[("h", "v")]),
}))`);
  assert.deepEqual(out, { diff: [], same: [] });
});

test("check_path_crossings: an allowed_crossings entry naming an unknown edge is an error", () => {
  const errs = json(`${X}\nprint(json.dumps(m.check_path_crossings([h, v], allowed_crossings=[("h", "v"), ("h", "ghost")])))`);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /allowed_crossings.*ghost/);
});

test("check_path_crossings: allowed crossings still count toward the per-path budget", () => {
  const errs = json(`
h = EdgePath("h", "#111111", [(0, 100), (400, 100)])
vs = [EdgePath(f"v{i}", "#111111", [(50 + 100 * i, 0), (50 + 100 * i, 200)]) for i in range(3)]
allowed = [("h", p.name) for p in vs]
print(json.dumps(m.check_path_crossings([h, *vs], allowed_crossings=allowed)))`);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /h has 3 crossings/);
});

test("check_path_crossings: shared endpoints and T-junction forks are not crossings", () => {
  const errs = json(`
trunk = EdgePath("trunk", "#111111", [(100, 0), (100, 100), (0, 100)])
fork = EdgePath("fork", "#111111", [(100, 100), (100, 300)])
tee = EdgePath("tee", "#222222", [(200, 50), (100, 50)])
print(json.dumps(m.check_path_crossings([trunk, fork, tee])))`);
  assert.deepEqual(errs, []);
});

test("check_edges_through_elements: an edge running through a node or a label is an error", () => {
  const errs = json(`
box = Rect("box", 80, 80, 40, 40)
lab = Rect("lab_text", 150, 90, 30, 20)
through = EdgePath("through", "#111111", [(0, 100), (300, 100)])
print(json.dumps(m.check_edges_through_elements([through], [box, lab])))`);
  assert.equal(errs.length, 2, JSON.stringify(errs));
  assert.match(errs[0], /through segment 0->1 .* passes through box/);
  assert.match(errs[1], /passes through lab_text/);
});

test("check_edges_through_elements: diagonal segments are tested too", () => {
  const errs = json(`
box = Rect("box", 80, 80, 40, 40)
print(json.dumps(m.check_edges_through_elements([EdgePath("d", "#111111", [(0, 0), (200, 200)])], [box])))`);
  assert.equal(errs.length, 1);
});

test("check_edges_through_elements: attaching to a side, grazing a side, or passing by is clean", () => {
  const errs = json(`
a = Rect("a", 0, 0, 100, 50)
b = Rect("b", 200, 0, 100, 50)
attach = EdgePath("attach", "#111111", [(100, 25), (200, 25)])
graze = EdgePath("graze", "#111111", [(0, 50), (300, 50)])
by = EdgePath("by", "#111111", [(0, 120), (300, 120)])
print(json.dumps(m.check_edges_through_elements([attach, graze, by], [a, b])))`);
  assert.deepEqual(errs, []);
});

test("check_edge_palette: edge colours outside the figure palette are errors (case-insensitive)", () => {
  const out = json(`
ok = EdgePath("ok", "#3c4043", [(0, 0), (100, 0)])
bad = EdgePath("bad", "#A45B37", [(0, 50), (100, 50)])
print(json.dumps({
    "errs": m.check_edge_palette([ok, bad], ["#3C4043", "#9AA0A6"]),
    "none": m.check_edge_palette([ok, bad], None),
}))`);
  assert.equal(out.errs.length, 1, JSON.stringify(out.errs));
  assert.match(out.errs[0], /bad: colou?r #A45B37 is not in the figure palette/);
  assert.deepEqual(out.none, []);
});

test("run_checks wires crossings (with allowed pairs), edges-through-elements and palette", () => {
  const out = json(`${X}
box = Rect("box", 20, 20, 30, 30)
plain = m.run_checks([box], [h, v], 400, 400)[0]
allowed = m.run_checks([box], [h, v], 400, 400, allowed_crossings=[("h", "v")])[0]
pal = m.run_checks([box], [h, v], 400, 400, allowed_crossings=[("h", "v")], palette=["#111111"])[0]
print(json.dumps({"plain": plain, "allowed": allowed, "pal": pal}))`);
  assert.ok(out.plain.some((e: string) => /crosses/.test(e)), JSON.stringify(out.plain));
  assert.deepEqual(out.allowed, []);
  assert.equal(out.pal.length, 1);
  assert.match(out.pal[0], /v: colou?r #222222/);
});

test("run_checks counts container perimeters as valid edge endpoints", () => {
  const out = json(`
group = Rect("group", 0, 0, 200, 100)
node = Rect("node", 50, 300, 100, 50)
e = EdgePath("e", "#111111", [(100, 100), (100, 300)])
print(json.dumps({
    "without": m.run_checks([node], [e], 400, 400)[1],
    "with": m.run_checks([node], [e], 400, 400, containers=[group])[1],
}))`);
  assert.ok(out.without.some((w: string) => /source endpoint .* dangling/.test(w)), JSON.stringify(out.without));
  assert.ok(!out.with.some((w: string) => /dangling/.test(w)), JSON.stringify(out.with));
});

test("enforce aborts on a recoloured crossing and passes once the pair is declared", () => {
  const blocked = py(`${X}\nm.enforce([], [h, v], 400, 400, bypass_warnings=True)`);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /crosses/);
  const ok = py(`${X}\nm.enforce([], [h, v], 400, 400, bypass_warnings=True, allowed_crossings=[("h", "v")])\nprint("ok")`);
  assert.equal(ok.status, 0, ok.stderr);
});
