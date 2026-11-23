import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// figure.json carries the user's binding constraints from Phase 1 to the
// later phases: a per-panel `layout_spec` (grid rows/columns, containers,
// edge routes) plus figure-level `style_constraints` (verbatim visual
// direction) and `palette` (closed set of allowed hex colours).
// scripts/schema.py must validate them and keep them through
// --populate-targets.

const FIXTURE = path.resolve("tests/fixtures/layout_fig1a.json");
const python = process.env.AUTOILLUSTRATE_PYTHON ?? "python3";

function figure(over: (fig: any) => void = () => {}): any {
  const fix = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const fig: any = {
    figure_caption: "c",
    placement: "half-width",
    layout: "column",
    style_constraints: "ink + one accent; no other colour",
    palette: fix.palette,
    panels: [
      { id: "construction", title: "A", short_caption: "a", drawio_prompt: "p", layout_spec: fix.layout_spec },
      { id: "execution", title: "B", short_caption: "b", drawio_prompt: "p" },
    ],
  };
  over(fig);
  return fig;
}

function validate(fig: any, populate = false): { status: number | null; stdout: string; stderr: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-layout-"));
  const file = path.join(dir, "figure.json");
  fs.writeFileSync(file, JSON.stringify(fig));
  const args = ["scripts/schema.py", "--validate", file, ...(populate ? ["--populate-targets"] : [])];
  const r = spawnSync(python, args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, file };
}

test("a figure with a layout_spec, style_constraints and palette validates and survives --populate-targets", () => {
  const r = validate(figure(), true);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(r.file, "utf8"));
  assert.equal(out.style_constraints, "ink + one accent; no other colour");
  assert.equal(out.palette.length, 8);
  const spec = out.panels[0].layout_spec;
  assert.equal(spec.rows, 4);
  assert.equal(spec.edges.length, 13);
  assert.equal(spec.edges.find((e: any) => e.id === "tagger_host").source, "tagger_generate");
  assert.equal(out.panels[1].layout_spec, undefined);
});

test("layout_spec structural errors are reported", () => {
  const r = validate(figure((fig) => {
    const s = fig.panels[0].layout_spec;
    s.nodes.push({ id: "out", row: 9, col: 0 });                   // out of bounds
    s.nodes.push({ id: "twin", row: 0, col: 1 });                  // shares seed's cell
    s.containers[0].members.push("ghost");                         // unknown member
    s.containers[1].members.push("training");                      // in two containers
    s.edges.push({ id: "bad_src", source: "nowhere", target: "host", exit: "top", entry: "top" });
    s.edges.push({ id: "bad_side", source: "seed", target: "host", exit: "middle", entry: "top" });
    s.edges.push({ id: "no_exit", source: "seed", target: "host", entry: "top" });
    s.edges.push({ id: "seed", source: "seed", target: "host", exit: "top", entry: "top" }); // duplicate id
  }));
  assert.equal(r.status, 1);
  for (const re of [
    /node 'out' .*outside the 4x3 grid/,
    /nodes 'seed' and 'twin' share grid cell \(0,1\)/,
    /container 'development_data' .*unknown member 'ghost'/,
    /node 'training' .*more than one container/,
    /edge 'bad_src' .*unknown source 'nowhere'/,
    /edge 'bad_side'/,
    /edge 'no_exit' .*needs an exit side/,
    /duplicate layout id 'seed'/,
  ]) assert.match(r.stderr, re);
});

test("palette entries must be #RRGGBB hex colours", () => {
  const r = validate(figure((fig) => { fig.palette = ["#1F2328", "teal"]; }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /palette/);
});

test("compose.py stages every shared panel library for a compose-only run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-stage-"));
  const r = spawnSync(python, ["-c", `
import sys; from pathlib import Path
sys.path.insert(0, "scripts")
import compose
compose.stage_panel_libraries(Path(${JSON.stringify(dir)}))
`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const lib of ["panel_geometry.py", "panel_layout.py", "panel_text.py"]) {
    assert.ok(fs.existsSync(path.join(dir, lib)), `${lib} not staged`);
  }
});
