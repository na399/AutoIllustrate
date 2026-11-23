#!/usr/bin/env python3
# Skeleton starter for a per-panel `generate_<panel_id>.py`. Copy this
# file into the workdir, rename it `generate_<panel_id>.py`, and fill
# in the constants / build_elements() / build_paths() bodies.
#
# This script ONLY computes numbers (positions, sizes) and feeds them
# into template.format(**params). It must NEVER build mxCell XML
# strings — all cells live in the .drawio.template. (See
# references/panel_agent.md "No XML generation in Python".)
#
# All the FIXED geometry validation (collision, orthogonal-waypoint,
# short-segment, path-crossing, edge-through-element, palette,
# dangling-endpoint, page-fill and corner dead-zone checks, plus the
# Rect / EdgePath types) lives in the shared `panel_geometry` module;
# `panel_layout` loads this panel's binding layout (figure.json
# `layout_spec`) and the figure palette. Both are staged into this workdir
# next to the generators. Do NOT copy those checks in here; import them
# (below) and call `enforce(...)` from build_params(). Only panel-specific
# geometry (page size, element sizes, layout params, build_elements /
# build_containers / build_paths) belongs in this file.
from pathlib import Path
import argparse
import math
import sys

# Import the shared geometry library from this generator's own directory
# (the workdir), so the import resolves however this file is loaded: run
# directly by the panel agent, imported by scripts/compose.py's
# generate_composite.py, or by scripts/check_params_contract.py. `__file__`
# is the generator's path in the workdir in every one of those contexts.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from panel_geometry import Rect, EdgePath, enforce, enforce_rendered  # noqa: E402
from panel_layout import GridFrame, load_layout_spec, load_palette  # noqa: E402
from panel_text import enforce_text_fit, label_size  # noqa: E402

# This generator is generate_<panel_id>.py, so the id comes from the filename.
PANEL_ID = Path(__file__).stem.removeprefix("generate_")

# ── Binding constraints from figure.json ──
# LAYOUT is None unless Phase 1 recorded a binding layout for this panel.
# When it is set, place every node in its grid cell (GridFrame.fit(LAYOUT,
# PAGE_W, PAGE_H) gives cells sized to the labels, as Phase 1 sized the page), name
# each node Rect / container Rect / EdgePath by its spec id, give each
# container title a `<container_id>_title` Rect and each labelled edge an
# `<edge_id>_label` Rect, and draw exactly the spec's edges on the declared
# sides — `enforce` checks all of it. PALETTE (if set) closes the edge colors.
LAYOUT = load_layout_spec(PANEL_ID)
PALETTE = load_palette()

# Crossings are errors whatever the edge colors. Declare a pair here ONLY
# when a crossing is genuinely the cleaner drawing (justify it in the plan);
# never under a planar LAYOUT. Recoloring an edge does not exempt it.
ALLOWED_CROSSINGS: list[tuple[str, str]] = []

# ── Page ── (proportion_w * canvas_w, proportion_h * canvas_h from figure.json)
PAGE_W, PAGE_H = 1000, 540

# ── Element sizes ──
NODE_W, NODE_H = 120, 48
# ... all sizes as constants ...
# Size every labelled Rect (nodes, `_label`s, `_title`s) to fit its text:
# label_size(value, font_size, box_width=W) gives the (w, h) the wrapped label
# needs inside a box W wide (font_size and bold as in the template's style),
# e.g. NODE_H = max(NODE_H, math.ceil(label_size("Two-line<br>label", 14, box_width=NODE_W)[1])).
# main() rejects a filled template whose labels overflow (enforce_text_fit).

# ── Layout parameters ──
COL_GAP = 200              # center-to-center between columns
L_CENTER = ...             # center x of left half
# ... vertical tier positions ...

# ── Edge label placement ──
SAME_LABEL_GAP = 8         # gap from arrow to same-polarity label
CROSS_LABEL_T = 0.22       # position along diagonal (0=source, 1=target)
CROSS_LABEL_PERP_OFFSET = 16  # perpendicular push outward from diagonal


def build_elements() -> list[Rect]:
    # return ALL visible elements including edge labels and container titles
    return [ ... ]

def build_containers() -> list[Rect]:
    # group / zone boxes that enclose other elements (kept out of
    # build_elements so members do not "collide" with their container)
    return [ ... ]

def build_paths() -> list[EdgePath]:
    # return EVERY routed edge in the panel, with full polyline + color
    return [ ... ]

# ── Position computation ──
# All positions derived from layout constants using center_x/center_y helpers
# Edge label positions computed from edge geometry (source/target points)

# ── Template filling ──
def build_params(bypass_warnings: bool = False) -> dict:
    """Compute every position. Runs the shared geometry checks first
    (`enforce`), which aborts on any error and on any warning unless
    bypassed. Returned dict MUST contain page_w / page_h as lowercase keys
    (NOT the PAGE_W / PAGE_H module constants — the Phase 4 composer reads
    lowercase), every rect-geometry placeholder, every path's waypoints as
    `<name>_x<i>` / `<name>_y<i>`, and every path's `<name>_color`.
    Coordinate keys end in `_x` / `_y` so the Phase 4 composer can offset
    them by the panel origin. Pure: no file I/O. Both `main()` here and
    the composer call this — keep it free of side effects.

    Generation does not run while EITHER errors or warnings remain.
    Errors are never bypassable. Warnings block too, unless
    `bypass_warnings=True` (surfaced as `--bypass-warnings` on the CLI) —
    pass it ONLY when every warning printed has been reviewed and each one
    has a valid reason to be bypassed.
    """
    elements = build_elements()
    containers = build_containers()
    paths = build_paths()
    enforce(
        elements, paths, PAGE_W, PAGE_H, bypass_warnings=bypass_warnings,
        containers=containers, allowed_crossings=ALLOWED_CROSSINGS,
        layout=LAYOUT, palette=PALETTE,
    )
    return dict(...)  # all computed positions as ints, plus every path's points + color

def _assert_param_contract(params: dict) -> None:
    """Fail generation if build_params() omits the page_w / page_h keys the
    Phase 4 composer reads to size and place this panel. A panel renders a
    valid drawio without them (its own template can frame itself), so without
    this guard the omission stays invisible until compose raises a KeyError.
    Common slip: returning PAGE_W / PAGE_H — the module-constant names — when
    the composer requires lowercase page_w / page_h. Keep this call in main().
    """
    for key in ("page_w", "page_h"):
        if isinstance(params.get(key), int) and params[key] > 0:
            continue
        hint = ""
        if key.upper() in params:
            hint = f" (found '{key.upper()}' — the composer reads lowercase '{key}')"
        raise SystemExit(
            f"ERROR: build_params() must return a positive int '{key}'{hint}. "
            "Phase 4 compose reads page_w / page_h to lay this panel out."
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bypass-warnings",
        action="store_true",
        help="Run even when geometry warnings remain (errors still abort). "
             "Use ONLY if every warning printed above has been reviewed and "
             "each one has a valid reason to be bypassed.",
    )
    args = parser.parse_args()
    params = build_params(bypass_warnings=args.bypass_warnings)
    _assert_param_contract(params)
    here = Path(__file__).resolve().parent
    template = (here / f"{PANEL_ID}.drawio.template").read_text()
    xml = template.format(**params)
    enforce_rendered(xml, build_elements(), build_paths(), build_containers())
    enforce_text_fit(xml, bypass_warnings=args.bypass_warnings)
    (here / f"{PANEL_ID}.drawio").write_text(xml)


if __name__ == "__main__":
    main()
