import { test } from "node:test";
import assert from "node:assert/strict";

import { CANONICAL_INNER, expectedExportHeight, figureCanvas } from "../src/canvas.js";

// The composite canvas (inner panel-space size) is figure.json's canvas_w /
// canvas_h when `schema.py --populate-targets` recorded one (taller for
// binding layouts), else the placement's fixed CANONICAL_INNER.

test("figureCanvas prefers figure.json's canvas over the placement default", () => {
  assert.deepEqual(figureCanvas({ canvas_w: 2000, canvas_h: 2688 }, "full-width"), [2000, 2688]);
  assert.deepEqual(figureCanvas({ panels: [] }, "full-width"), CANONICAL_INNER["full-width"]);
  assert.deepEqual(figureCanvas(null, "half-width"), [2000, 1104]);
  assert.equal(figureCanvas(null, "infer"), undefined);
  // A malformed canvas is ignored rather than trusted.
  assert.deepEqual(figureCanvas({ canvas_w: 2000, canvas_h: 0 }, "full-width"), [2000, 832]);
  assert.deepEqual(figureCanvas({ canvas_w: "2000", canvas_h: 900 }, "full-width"), [2000, 832]);
});

test("expectedExportHeight scales the canvas plus compose margins to the export width", () => {
  // The fixed placements reproduce the old hard-coded targets.
  assert.equal(expectedExportHeight(null, "full-width", 2560), 1100);
  assert.equal(expectedExportHeight(null, "half-width", 2560), 1440);
  // A layout-driven canvas: (2688 + 48) / (2000 + 48) * 2560.
  assert.equal(expectedExportHeight({ canvas_w: 2000, canvas_h: 2688 }, "full-width", 2560), 3420);
  assert.equal(expectedExportHeight(null, "infer", 2560), undefined);
});
