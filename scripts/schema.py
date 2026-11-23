"""Schema + validation for the drawio-figure decomposition.

A figure is a flat list of panels (max 3) arranged under a single
top-level layout (`row` | `column` | `grid`). There is no nesting and
no notion of a tree — just one figure with up to three panels. The
per-panel field that drives downstream work is `drawio_prompt`, fed
verbatim to the per-panel rendering workflow when each panel is
rendered as its own draw.io diagram. The top-level `placement` field
(`half-width` | `full-width`) records the figure's intended placement
in the paper; it sets the default canvas aspect (16:9 for half-width,
21:9 for full-width) the layout should aim for, which binding layouts
may override (see below), and is passed to the Phase 5 enhancer.

Each panel additionally carries a `proportion_w` and `proportion_h`
in (0, 1] — its share of the composite's inner width and height. By
construction, along the axis the figure's layout divides:

- `row`     → sum of panels' `proportion_w` is 1.0; each panel's
              `proportion_h` is 1.0.
- `column`  → each panel's `proportion_w` is 1.0; sum of panels'
              `proportion_h` is 1.0.
- `grid`    → `proportion_w = colspan / grid_cols`,
              `proportion_h = rowspan / grid_rows`; per-row width
              shares and per-column height shares each sum to 1.0
              when that row/column is fully packed.

The proportions are shares of the composite's inner canvas, recorded
as top-level `canvas_w` / `canvas_h` (panel-space units). Without a
binding layout the canvas is the placement's fixed CANONICAL_INNER
(21:9 or 16:9) and the shares split it evenly. When any panel carries a
`layout_spec`, the canvas keeps its 2000 width but its height follows
the grids' natural aspects (`panel_layout.natural_size`), so a tall
grid gets a tall page instead of a slice of a 21:9 strip:

- `column` → each layout panel gets height W / aspect; other panels keep
              their even share of the placement height.
- `row`    → one shared height; each layout panel gets width H * aspect,
              other panels keep their even share of the width.
- `grid`   → shares stay span-based; the height grows to the tallest
              height any layout panel's cell needs.

The canvas aspect is clamped to [MIN_CANVAS_ASPECT, MAX_CANVAS_ASPECT]
(about a printed page at the tall end); a clamped tall canvas squeezes
layout panels evenly. The export width stays 2560 px, so a layout figure
may come out portrait.

These fields are normally populated automatically by running this
script with `--populate-targets` after `--validate`. The per-panel
rendering subagent uses them to pick `PAGE_W` / `PAGE_H`, and
`inspect_panel.py` uses them to dimension-check the rendered PNG
(±15% tolerance, see `inspect_panel.py`).

Run as a script:

    # validate structure only
    python schema.py --validate path/to/figure.json

    # validate, then back-fill canvas_w / canvas_h and proportion_w / proportion_h
    python schema.py --validate path/to/figure.json --populate-targets
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field

# The binding-layout geometry (natural grid size) lives with the panel
# libraries in assets/, which the panel generators import from their workdir.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "assets"))
import panel_layout  # noqa: E402

Layout = Literal["grid", "row", "column"]
Placement = Literal["half-width", "full-width"]

# Canonical interior dimensions of the composite, in draw.io "panel-space"
# units. The composer builds the composite at this fixed coordinate size;
# the Phase 4 `drawio --width` export then rescales it to the target PNG
# width (2560 px). These are the composite's inner area AFTER subtracting
# the composite page margin (24 px on each side, matching `compose.py`'s
# DEFAULT_PAGE_MARGIN). They determine the absolute panel-space target
# size each panel should aim for, given its `proportion_w/h`.
#   full-width: 21:9 outer → 2000 × 832 panel-space (export rescaled to 2560 px wide)
#   half-width: 16:9 outer → 2000 × 1104 panel-space (export rescaled to 2560 px wide)
CANONICAL_INNER: dict[str, tuple[int, int]] = {
    "full-width": (2000, 832),
    "half-width": (2000, 1104),
}

# Bounds on the canvas aspect (w / h) when binding layouts set its height:
# no taller than a printed page's text block (about 7 x 10 in), no wider
# than the 3:1 the image models accept.
MIN_CANVAS_ASPECT = 0.7
MAX_CANVAS_ASPECT = 3.0


class LayoutNode(BaseModel):
    """A node's cell in a binding layout grid (0-based row / col)."""

    id: str
    row: int
    col: int
    rowspan: int = 1
    colspan: int = 1
    label: Optional[str] = None


class LayoutContainer(BaseModel):
    """A titled group enclosing some nodes (no nesting)."""

    id: str
    members: list[str]
    title: Optional[str] = None
    optional: bool = False


class LayoutEdge(BaseModel):
    """An edge of a binding layout. `source` / `target` name a node, a
    container, or another edge (a fork / merge on that edge's polyline);
    `exit` / `entry` name the side it leaves / enters (top, bottom, left,
    right) and are required for node and container endpoints."""

    id: str
    source: str
    target: str
    exit: Optional[str] = None
    entry: Optional[str] = None
    label: Optional[str] = None
    dashed: bool = False
    route: Optional[str] = None


class LayoutSpec(BaseModel):
    """A user-supplied binding layout for one panel, transcribed by Phase 1
    (e.g. from an ASCII grid). Phase 2 generators load it through
    `assets/panel_layout.py` and `enforce(..., layout=...)` checks the
    rendered geometry against it: grid order, containers, edge set, sides,
    labels (each within reach of its edge) and — when `planar` — zero crossings."""

    rows: int
    cols: int
    planar: bool = True
    nodes: list[LayoutNode]
    containers: list[LayoutContainer] = Field(default_factory=list)
    edges: list[LayoutEdge] = Field(default_factory=list)


class Panel(BaseModel):
    id: str
    title: str
    short_caption: str

    # The per-panel prompt fed verbatim to the per-panel rendering
    # workflow when this panel is rendered as a draw.io diagram.
    drawio_prompt: str

    # Placement within the figure (only meaningful if layout == "grid").
    row: Optional[int] = None
    col: Optional[int] = None
    rowspan: Optional[int] = Field(default=1)
    colspan: Optional[int] = Field(default=1)

    # Share of the composite's inner width / height this panel should
    # occupy. Both in (0, 1]. Populated by `--populate-targets`; the
    # per-panel agent uses them to pick PAGE_W / PAGE_H and the
    # inspector uses them to dimension-check the rendered PNG.
    proportion_w: Optional[float] = None
    proportion_h: Optional[float] = None

    # Binding layout from the user's instructions; None when the panel
    # agent is free to choose the arrangement.
    layout_spec: Optional[LayoutSpec] = None


class LetterMark(BaseModel):
    """A caption sub-label ((a), (b), …) placed on the figure.

    Letters form a figure-wide enumeration that maps many-to-one onto
    panels: one panel may own several letters, and there may be more
    letters than panels. Phase 1 assigns each letter to a panel and an
    anchor (prose describing where inside that panel it sits); Phase 2
    draws it. Populated only when the source caption enumerates
    sub-labels; absent otherwise.
    """

    label: str    # "a", "b", ...
    panel: str    # id of the panel this letter appears in
    anchor: str   # short prose: where inside that panel it sits


class FigureDoc(BaseModel):
    version: int = 1
    figure_caption: str
    placement: Placement

    # Single top-level layout for the whole figure.
    layout: Layout
    grid_rows: Optional[int] = None
    grid_cols: Optional[int] = None

    panels: list[Panel]

    # Caption sub-labels ((a), (b), …) to draw on the figure. None when
    # the caption has no sub-labels.
    letters: Optional[list[LetterMark]] = None

    # The composite's inner size in panel-space units; panels' proportions
    # are shares of it. Populated by `--populate-targets` (compute_canvas).
    canvas_w: Optional[int] = None
    canvas_h: Optional[int] = None

    # Binding visual direction from the user's instructions, verbatim
    # (palette, strokes, fonts). The Style phase must honour it exactly.
    style_constraints: Optional[str] = None

    # Closed set of allowed #RRGGBB colors (white is always allowed).
    # Enforced on edge colors by panel_geometry.enforce and on template
    # style colors by lint_math.py rule (j).
    palette: Optional[list[str]] = None


SIDES = ("top", "bottom", "left", "right")
HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def validate_layout_spec(spec: LayoutSpec) -> list[str]:
    """Structural invariants of a binding layout (geometry is checked later,
    per panel, by assets/panel_layout.py)."""
    errors: list[str] = []
    if spec.rows < 1 or spec.cols < 1:
        errors.append(f"grid must be at least 1x1 (got {spec.rows}x{spec.cols})")
    ids: set[str] = set()
    for item in [*spec.nodes, *spec.containers, *spec.edges]:
        if item.id in ids:
            errors.append(f"duplicate layout id {item.id!r}")
        ids.add(item.id)

    cells: dict[tuple[int, int], str] = {}
    for n in spec.nodes:
        if (n.row < 0 or n.col < 0 or n.rowspan < 1 or n.colspan < 1
                or n.row + n.rowspan > spec.rows or n.col + n.colspan > spec.cols):
            errors.append(f"node {n.id!r} at ({n.row},{n.col}) span "
                          f"{n.rowspan}x{n.colspan} is outside the "
                          f"{spec.rows}x{spec.cols} grid")
            continue
        for r in range(n.row, n.row + n.rowspan):
            for c in range(n.col, n.col + n.colspan):
                if (r, c) in cells:
                    errors.append(f"nodes {cells[(r, c)]!r} and {n.id!r} share "
                                  f"grid cell ({r},{c})")
                cells[(r, c)] = n.id

    node_ids = {n.id for n in spec.nodes}
    container_of: dict[str, str] = {}
    for c in spec.containers:
        for m in c.members:
            if m not in node_ids:
                errors.append(f"container {c.id!r} lists unknown member {m!r}")
            elif m in container_of:
                errors.append(f"node {m!r} is in more than one container "
                              f"({container_of[m]!r}, {c.id!r}); nesting is "
                              f"not supported")
            else:
                container_of[m] = c.id

    edge_ids = {e.id for e in spec.edges}
    endpoints = node_ids | {c.id for c in spec.containers}
    for e in spec.edges:
        for kind, ref, side, side_name in (("source", e.source, e.exit, "exit"),
                                           ("target", e.target, e.entry, "entry")):
            if ref == e.id:
                errors.append(f"edge {e.id!r} cannot fork from itself")
            elif ref not in endpoints and ref not in edge_ids:
                errors.append(f"edge {e.id!r} has unknown {kind} {ref!r}")
            elif ref in endpoints and side is None:
                errors.append(f"edge {e.id!r} needs an {side_name} side "
                              f"(its {kind} is a node/container)")
            if side is not None and side not in SIDES:
                errors.append(f"edge {e.id!r} {side_name} side {side!r} is not "
                              f"one of {'/'.join(SIDES)}")
    return errors


def validate(doc: FigureDoc, max_panels: int = 3) -> None:
    """Raise ValueError with a human-readable message on any invariant violation."""
    errors: list[str] = []

    seen: set[str] = set()
    for p in doc.panels:
        if p.id in seen:
            errors.append(f"duplicate panel id: {p.id}")
        seen.add(p.id)
        if not p.drawio_prompt or not p.drawio_prompt.strip():
            errors.append(f"panel {p.id!r} missing drawio_prompt")
        if p.layout_spec is not None:
            errors += [f"panel {p.id!r} layout_spec: {e}"
                       for e in validate_layout_spec(p.layout_spec)]

    for color in doc.palette or []:
        if not HEX_RE.match(color):
            errors.append(f"palette entry {color!r} is not a #RRGGBB hex color")

    if (doc.canvas_w is None) != (doc.canvas_h is None):
        errors.append("canvas_w and canvas_h must be set together")
    elif doc.canvas_w is not None and (doc.canvas_w <= 0 or doc.canvas_h <= 0):
        errors.append(f"canvas must be positive (got {doc.canvas_w}x{doc.canvas_h})")

    if len(doc.panels) < 1:
        errors.append("figure has no panels")
    if len(doc.panels) > max_panels:
        errors.append(f"{len(doc.panels)} panels exceeds max_panels {max_panels}")

    if doc.layout not in ("grid", "row", "column"):
        errors.append(f"invalid layout {doc.layout!r}")

    if doc.layout == "grid":
        if not doc.grid_rows or not doc.grid_cols:
            errors.append("grid layout missing grid_rows/grid_cols")
        else:
            occupied: set[tuple[int, int]] = set()
            for p in doc.panels:
                if p.row is None or p.col is None:
                    errors.append(f"panel {p.id!r} missing row/col under grid layout")
                    continue
                rs = p.rowspan or 1
                cs = p.colspan or 1
                if (
                    p.row < 0
                    or p.col < 0
                    or p.row + rs > doc.grid_rows
                    or p.col + cs > doc.grid_cols
                ):
                    errors.append(f"panel {p.id!r} placement out of bounds")
                    continue
                for r in range(p.row, p.row + rs):
                    for cc in range(p.col, p.col + cs):
                        if (r, cc) in occupied:
                            errors.append(
                                f"grid cell ({r},{cc}) occupied twice"
                            )
                        occupied.add((r, cc))

    if doc.letters:
        seen_labels: set[str] = set()
        for lm in doc.letters:
            if lm.panel not in seen:
                errors.append(
                    f"letter {lm.label!r} references unknown panel {lm.panel!r}"
                )
            if lm.label in seen_labels:
                errors.append(f"duplicate letter label: {lm.label!r}")
            seen_labels.add(lm.label)

    if errors:
        raise ValueError("schema validation failed:\n  - " + "\n  - ".join(errors))


def ordered_panels(doc: FigureDoc) -> list[Panel]:
    """Panels in display order — used for panel labels A, B, C, ...

    For grid layouts, sort by (row, col). For row / column layouts,
    keep the panels' declared order.
    """
    if doc.layout == "grid":
        return sorted(
            doc.panels,
            key=lambda p: (p.row if p.row is not None else 0,
                           p.col if p.col is not None else 0),
        )
    return list(doc.panels)


# ──────────────────────────── proportions / targets ─────────────────────────


def natural_aspect(panel: Panel) -> Optional[float]:
    """w / h of the panel's binding grid at its natural tracks
    (`panel_layout.natural_size`), or None for a panel without a layout_spec."""
    if panel.layout_spec is None:
        return None
    spec = panel_layout.LayoutSpec.from_dict(panel.layout_spec.model_dump())
    w, h = panel_layout.natural_size(spec)
    return w / h


def _span_shares(doc: FigureDoc) -> dict[str, tuple[float, float]]:
    rows, cols = doc.grid_rows, doc.grid_cols
    if not rows or not cols:
        raise ValueError("grid layout missing grid_rows/grid_cols")
    return {p.id: ((p.colspan or 1) / cols, (p.rowspan or 1) / rows) for p in doc.panels}


def _plan_canvas(doc: FigureDoc) -> tuple[tuple[int, int], dict[str, tuple[float, float]]]:
    """((canvas_w, canvas_h), {panel id: (proportion_w, proportion_h)}) for
    the figure; see the module docstring for the rules."""
    if doc.placement not in CANONICAL_INNER:
        raise ValueError(f"unknown placement {doc.placement!r}")
    if doc.layout not in ("row", "column", "grid"):
        raise ValueError(f"unknown layout {doc.layout!r}")
    inner_w, inner_h = CANONICAL_INNER[doc.placement]
    n = len(doc.panels)
    aspects = {p.id: natural_aspect(p) for p in doc.panels}
    has_layout = any(a is not None for a in aspects.values())

    if doc.layout == "grid":
        shares = _span_shares(doc)
        if not has_layout:
            return (inner_w, inner_h), shares
        # The height at which each layout panel's cell has its natural aspect.
        height = max(shares[pid][0] * inner_w / a / shares[pid][1]
                     for pid, a in aspects.items() if a is not None)
        return (inner_w, _clamp_height(inner_w, height)), shares

    if doc.layout == "column":
        if not has_layout:
            return (inner_w, inner_h), {p.id: (1.0, 1.0 / n) for p in doc.panels}
        free_h = inner_h / n
        heights = {pid: inner_w / a if a is not None else free_h for pid, a in aspects.items()}
        height = _clamp_height(inner_w, sum(heights.values()))
        # A clamped canvas rescales the layout panels; free panels keep their share.
        free_total = free_h * sum(a is None for a in aspects.values())
        layout_total = sum(h for pid, h in heights.items() if aspects[pid] is not None)
        scale = (height - free_total) / layout_total
        heights = {pid: h * scale if aspects[pid] is not None else h for pid, h in heights.items()}
        return (inner_w, height), {pid: (1.0, h / height) for pid, h in heights.items()}

    # row
    if not has_layout:
        return (inner_w, inner_h), {p.id: (1.0 / n, 1.0) for p in doc.panels}
    free = [pid for pid, a in aspects.items() if a is None]
    height = (inner_w - len(free) * inner_w / n) / sum(a for a in aspects.values() if a is not None)
    widths = {pid: height * a if a is not None else inner_w / n for pid, a in aspects.items()}
    return ((inner_w, _clamp_height(inner_w, height)),
            {pid: (w / inner_w, 1.0) for pid, w in widths.items()})


def _clamp_height(width: int, height: float) -> int:
    return round(min(max(height, width / MAX_CANVAS_ASPECT), width / MIN_CANVAS_ASPECT))


def compute_panel_proportions(doc: FigureDoc) -> dict[str, tuple[float, float]]:
    """Derive each panel's (proportion_w, proportion_h) — its share of the
    canvas — from the figure's top-level layout and any binding layouts.

    Both numbers are in (0, 1]. Along the axis the layout divides, sibling
    proportions sum to 1; along the other axis each panel takes the full
    extent (1.0). For `grid`, each panel's proportions are its colspan /
    rowspan share of the grid.
    """
    return _plan_canvas(doc)[1]


def compute_canvas(doc: FigureDoc) -> tuple[int, int]:
    """The composite's inner (canvas_w, canvas_h) in panel-space units: the
    placement's CANONICAL_INNER, or with binding layouts a height that
    follows their natural aspects."""
    return _plan_canvas(doc)[0]


def resolve_canvas(doc: FigureDoc) -> tuple[int, int]:
    """The canvas the panels were sized against: the stored canvas_w/h; for a
    figure.json populated before the canvas was recorded (proportions but no
    canvas), the placement's CANONICAL_INNER; otherwise computed afresh."""
    if doc.canvas_w is not None and doc.canvas_h is not None:
        return doc.canvas_w, doc.canvas_h
    if any(p.proportion_w is not None or p.proportion_h is not None for p in doc.panels):
        if doc.placement not in CANONICAL_INNER:
            raise ValueError(f"unknown placement {doc.placement!r}")
        return CANONICAL_INNER[doc.placement]
    return compute_canvas(doc)


def compute_panel_target_dims(doc: FigureDoc) -> dict[str, tuple[float, float]]:
    """Resolve each panel's (target_w, target_h) in panel-space units,
    using its `proportion_w/h` (or computing them) and the figure's canvas
    (`resolve_canvas`)."""
    inner_w, inner_h = resolve_canvas(doc)
    proportions = compute_panel_proportions(doc)
    targets: dict[str, tuple[float, float]] = {}
    for p in doc.panels:
        pw = p.proportion_w if p.proportion_w is not None else proportions[p.id][0]
        ph = p.proportion_h if p.proportion_h is not None else proportions[p.id][1]
        targets[p.id] = (pw * inner_w, ph * inner_h)
    return targets


def populate_proportions(doc: FigureDoc) -> None:
    """Mutate `doc` in place, writing the computed canvas_w/h and each
    panel's `proportion_w/h` (overwriting any existing values to keep them
    consistent with the layout)."""
    (doc.canvas_w, doc.canvas_h), proportions = _plan_canvas(doc)
    for p in doc.panels:
        pw, ph = proportions[p.id]
        # Round to avoid noisy floats like 0.3333333333333333 in figure.json.
        p.proportion_w = round(pw, 4)
        p.proportion_h = round(ph, 4)


def _cli() -> int:
    p = argparse.ArgumentParser(description="Validate a drawio-figure figure.json.")
    p.add_argument("--validate", required=True, type=Path,
                   help="Path to figure.json.")
    p.add_argument("--max-panels", type=int, default=3)
    p.add_argument("--populate-targets", action="store_true",
                   help="After validating, compute the canvas (canvas_w/"
                        "canvas_h) and each panel's proportion_w/proportion_h "
                        "from the figure's layout and binding layouts, and "
                        "write them back to the file in place.")
    args = p.parse_args()

    if not args.validate.exists():
        print(f"ERROR: file not found: {args.validate}", file=sys.stderr)
        return 2
    raw = args.validate.read_text()
    try:
        doc = FigureDoc.model_validate_json(raw)
    except Exception as e:
        print(f"ERROR: JSON/Pydantic parse failed: {e}", file=sys.stderr)
        return 1
    try:
        validate(doc, max_panels=args.max_panels)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 1

    if args.populate_targets:
        try:
            populate_proportions(doc)
        except ValueError as e:
            print(f"ERROR: cannot populate proportions: {e}", file=sys.stderr)
            return 1
        # Preserve any orderly formatting choices in the source file by
        # re-serialising from the validated model.
        args.validate.write_text(
            json.dumps(doc.model_dump(exclude_none=True), indent=2) + "\n"
        )
        targets = compute_panel_target_dims(doc)
        print(
            f"OK: {len(doc.panels)} panels, layout={doc.layout!r}, "
            f"placement={doc.placement!r}, "
            f"canvas=({doc.canvas_w}, {doc.canvas_h}); populated proportions "
            f"and resolved targets (panel-space units):"
        )
        for panel in doc.panels:
            tw, th = targets[panel.id]
            print(
                f"  - {panel.id}: proportion=({panel.proportion_w}, "
                f"{panel.proportion_h}) → target=({tw:.0f}, {th:.0f})"
            )
        return 0

    print(f"OK: {len(doc.panels)} panels, layout={doc.layout!r}.")
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
