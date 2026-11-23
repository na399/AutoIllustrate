// The composite's inner canvas in draw.io panel-space units. Mirrors
// scripts/schema.py: CANONICAL_INNER is the fixed per-placement canvas, and a
// figure.json populated by `schema.py --populate-targets` records its own
// canvas_w / canvas_h (taller when binding layout_specs need it), which wins.

export const CANONICAL_INNER: Record<string, [number, number]> = {
  "full-width": [2000, 832],
  "half-width": [2000, 1104],
};

// scripts/compose.py DEFAULT_PAGE_MARGIN: the composite page adds this on
// every side of the canvas before the PNG export rescales it.
const COMPOSE_PAGE_MARGIN = 24;

function positive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

export function figureCanvas(figure: unknown, placement: string): [number, number] | undefined {
  const doc = figure as { canvas_w?: unknown; canvas_h?: unknown } | null;
  if (positive(doc?.canvas_w) && positive(doc?.canvas_h)) return [doc.canvas_w, doc.canvas_h];
  return CANONICAL_INNER[placement];
}

// Height in px of the Phase 4 export (`drawio --width exportWidth`) of a
// composite built on this figure's canvas. Panel gaps are ignored, as the
// placement targets always have; Phase 4 allows ±10%.
export function expectedExportHeight(figure: unknown, placement: string, exportWidth: number): number | undefined {
  const canvas = figureCanvas(figure, placement);
  if (!canvas) return undefined;
  const [w, h] = canvas;
  return Math.round((exportWidth * (h + 2 * COMPOSE_PAGE_MARGIN)) / (w + 2 * COMPOSE_PAGE_MARGIN));
}
