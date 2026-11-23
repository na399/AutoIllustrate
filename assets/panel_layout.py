#!/usr/bin/env python3
"""Binding panel layouts for per-panel `generate_<panel_id>.py`.

When the user supplies a layout (an ASCII grid, explicit rows/columns, edge
routes), Phase 1 transcribes it into the panel's `layout_spec` in
`figure.json`. The generator loads it with `load_layout_spec(PANEL_ID)` and
passes it to `panel_geometry.enforce(..., layout=LAYOUT)`, which runs
`LayoutSpec.check` so the rendered geometry must keep:

  * the grid topology — a node in an earlier row sits entirely above every
    node in a later row; nodes sharing a row overlap vertically (aligned in
    that row); the same for columns, left to right;
  * the containers — each encloses its members and its title (`<id>_title`
    Rect), the title sits above the members (its own header band), and no
    non-member node sits inside it;
  * the edge set and routes — exactly the spec's edges are drawn (EdgePath
    named by edge id), each leaves/enters on the declared sides, a fork edge
    (source = another edge's id) starts on its parent edge, and every
    labelled edge has an `<edge_id>_label` Rect within LABEL_MAX_GAP px of
    its polyline.

Pixel pitches stay the generator's choice (`GridFrame` helps place nodes in
their cells; `GridFrame.fit` starts from the grid's natural tracks, the same
`natural_size` that scripts/schema.py turns into the panel's page shape);
only the relations above are binding. `load_palette()` returns
the figure's closed color set for `enforce(..., palette=PALETTE)`.

Stdlib-only; staged into the panel WORKDIR next to `panel_geometry.py`,
`panel_text.py` and `figure.json`, so both loaders default to the
figure.json beside this file.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path

from panel_geometry import ENDPOINT_SNAP_TOL, EdgePath, Rect
from panel_text import label_size

SIDES = ("top", "bottom", "left", "right")

# An edge label belongs beside its edge: its box must come within this many
# px of the edge's polyline, or the reader cannot tell which arrow it names.
LABEL_MAX_GAP = 30


@dataclass(frozen=True)
class LayoutNode:
    id: str
    row: int
    col: int
    rowspan: int = 1
    colspan: int = 1
    label: str | None = None

    @property
    def rows(self) -> tuple[int, int]:
        return self.row, self.row + self.rowspan - 1

    @property
    def cols(self) -> tuple[int, int]:
        return self.col, self.col + self.colspan - 1


@dataclass(frozen=True)
class LayoutContainer:
    id: str
    members: tuple[str, ...]
    title: str | None = None
    optional: bool = False


@dataclass(frozen=True)
class LayoutEdge:
    id: str
    source: str            # node id, container id, or another edge's id (a fork)
    target: str
    exit: str | None = None    # side of the source the edge leaves from
    entry: str | None = None   # side of the target the edge enters
    label: str | None = None
    dashed: bool = False
    route: str | None = None   # prose routing hint for the panel agent (not checked)


def _on_side(pt: tuple[float, float], r: Rect, side: str, tol: float) -> bool:
    x, y = pt
    within_x = r.x - tol <= x <= r.x + r.w + tol
    within_y = r.y - tol <= y <= r.y + r.h + tol
    if side == "top":
        return abs(y - r.y) <= tol and within_x
    if side == "bottom":
        return abs(y - (r.y + r.h)) <= tol and within_x
    if side == "left":
        return abs(x - r.x) <= tol and within_y
    return abs(x - (r.x + r.w)) <= tol and within_y


def _dist_to_segment(pt, a, b) -> float:
    (px, py), (ax, ay), (bx, by) = pt, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _on_polyline(pt, points, tol: float) -> bool:
    return any(_dist_to_segment(pt, a, b) <= tol for a, b in zip(points, points[1:]))


def _point_rect_dist(pt, r: Rect) -> float:
    dx = max(r.x - pt[0], 0.0, pt[0] - (r.x + r.w))
    dy = max(r.y - pt[1], 0.0, pt[1] - (r.y + r.h))
    return math.hypot(dx, dy)


def _rect_polyline_gap(r: Rect, points) -> float:
    """Smallest distance between rect `r` and the polyline (0 if they touch).
    Exact for the orthogonal segments panels use; a close bound otherwise."""
    corners = [(r.x, r.y), (r.x + r.w, r.y), (r.x, r.y + r.h), (r.x + r.w, r.y + r.h)]
    best = math.inf
    for a, b in zip(points, points[1:]):
        if min(a[0], b[0]) <= r.x + r.w and max(a[0], b[0]) >= r.x \
                and min(a[1], b[1]) <= r.y + r.h and max(a[1], b[1]) >= r.y \
                and (a[0] == b[0] or a[1] == b[1]):
            return 0.0
        best = min(best, _point_rect_dist(a, r), _point_rect_dist(b, r),
                   *(_dist_to_segment(c, a, b) for c in corners))
    return best


def _encloses(outer: Rect, inner: Rect) -> bool:
    return (outer.x <= inner.x and outer.y <= inner.y
            and inner.x + inner.w <= outer.x + outer.w
            and inner.y + inner.h <= outer.y + outer.h)


@dataclass
class LayoutSpec:
    rows: int
    cols: int
    nodes: tuple[LayoutNode, ...]
    containers: tuple[LayoutContainer, ...] = ()
    edges: tuple[LayoutEdge, ...] = ()
    planar: bool = True

    @classmethod
    def from_dict(cls, d: dict) -> "LayoutSpec":
        return cls(
            rows=int(d["rows"]),
            cols=int(d["cols"]),
            planar=bool(d.get("planar", True)),
            nodes=tuple(
                LayoutNode(n["id"], int(n["row"]), int(n["col"]),
                           int(n.get("rowspan") or 1), int(n.get("colspan") or 1),
                           n.get("label"))
                for n in d.get("nodes", [])),
            containers=tuple(
                LayoutContainer(c["id"], tuple(c.get("members", [])),
                                c.get("title"), bool(c.get("optional", False)))
                for c in d.get("containers") or []),
            edges=tuple(
                LayoutEdge(e["id"], e["source"], e["target"], e.get("exit"),
                           e.get("entry"), e.get("label"), bool(e.get("dashed", False)),
                           e.get("route"))
                for e in d.get("edges") or []),
        )

    @property
    def edge_ids(self) -> set[str]:
        return {e.id for e in self.edges}

    def fork_endpoints(self, paths: list[EdgePath]) -> frozenset[tuple[str, str]]:
        """`(edge_id, "source" | "target")` endpoints declared to sit on
        another edge (a fork / merge) rather than on a node."""
        ids = self.edge_ids
        out: set[tuple[str, str]] = set()
        for e in self.edges:
            if e.source in ids:
                out.add((e.id, "source"))
            if e.target in ids:
                out.add((e.id, "target"))
        return frozenset(out)

    def check(
        self, elements: list[Rect], paths: list[EdgePath], containers: list[Rect],
    ) -> tuple[list[str], list[str]]:
        """Return `(errors, warnings)` comparing the panel geometry with this
        binding layout (see the module docstring for the rules)."""
        rects: dict[str, Rect] = {}
        for r in elements:
            rects.setdefault(r.name, r)
        boxes = {r.name: r for r in containers}
        errors: list[str] = []
        errors += self._check_nodes(rects)
        errors += self._check_containers(rects, boxes)
        errors += self._check_edges(rects, boxes, paths)
        return errors, []

    def _check_nodes(self, rects: dict[str, Rect]) -> list[str]:
        errors: list[str] = []
        placed = []
        for n in self.nodes:
            if n.id in rects:
                placed.append(n)
            else:
                errors.append(f"layout node {n.id} has no Rect named '{n.id}' in build_elements()")
        for i, a in enumerate(placed):
            for b in placed[i + 1:]:
                errors += self._order(a, b, rects[a.id], rects[b.id], "row")
                errors += self._order(a, b, rects[a.id], rects[b.id], "col")
        return errors

    @staticmethod
    def _order(a: LayoutNode, b: LayoutNode, ra: Rect, rb: Rect, axis: str) -> list[str]:
        """Rows map to y (above / aligned), columns to x (left of / aligned)."""
        (a0, a1), (b0, b1) = (a.rows, b.rows) if axis == "row" else (a.cols, b.cols)
        lo_a, hi_a = (ra.y, ra.y + ra.h) if axis == "row" else (ra.x, ra.x + ra.w)
        lo_b, hi_b = (rb.y, rb.y + rb.h) if axis == "row" else (rb.x, rb.x + rb.w)
        rel = "above" if axis == "row" else "left of"
        if a1 < b0 and hi_a > lo_b:
            return [f"{a.id} ({axis} {a.row if axis == 'row' else a.col}) must sit entirely "
                    f"{rel} {b.id} ({axis} {b.row if axis == 'row' else b.col}) per the layout"]
        if b1 < a0 and hi_b > lo_a:
            return [f"{b.id} ({axis} {b.row if axis == 'row' else b.col}) must sit entirely "
                    f"{rel} {a.id} ({axis} {a.row if axis == 'row' else a.col}) per the layout"]
        if a0 <= b1 and b0 <= a1 and not (lo_a < hi_b and lo_b < hi_a):
            shared = max(a0, b0)
            return [f"{a.id} and {b.id} share {axis} {shared} but are not aligned in it "
                    f"({'y' if axis == 'row' else 'x'} ranges {lo_a}-{hi_a} vs {lo_b}-{hi_b} "
                    f"do not overlap)"]
        return []

    def _check_containers(self, rects: dict[str, Rect], boxes: dict[str, Rect]) -> list[str]:
        errors: list[str] = []
        node_ids = [n.id for n in self.nodes]
        for c in self.containers:
            box = boxes.get(c.id)
            if box is None:
                errors.append(f"layout container {c.id} has no Rect named '{c.id}' in the "
                              f"containers passed to enforce()")
                continue
            members = [rects[m] for m in c.members if m in rects]
            for m in members:
                if not _encloses(box, m):
                    errors.append(f"container {c.id} does not enclose {m.name}")
            if c.title:
                tname = f"{c.id}_title"
                title = rects.get(tname)
                if title is None:
                    errors.append(f"container {c.id} has a title but no Rect named '{tname}'")
                else:
                    if not _encloses(box, title):
                        errors.append(f"container {c.id} does not enclose its title {tname}")
                    if members and title.y + title.h > min(m.y for m in members):
                        errors.append(f"{tname} must sit above all members of {c.id} "
                                      f"(the title gets its own header band)")
            for nid in node_ids:
                if nid in c.members or nid not in rects:
                    continue
                if rects[nid].overlaps(box):
                    errors.append(f"{nid} is not a member but sits inside container {c.id}")
        return errors

    def _check_edges(
        self, rects: dict[str, Rect], boxes: dict[str, Rect], paths: list[EdgePath],
    ) -> list[str]:
        errors: list[str] = []
        by_name = {p.name: p for p in paths}
        ids = self.edge_ids
        for p in paths:
            if p.name not in ids:
                errors.append(f"{p.name}: drawn edge is not in the layout spec "
                              f"(a binding layout adds no arrows)")
        tol = ENDPOINT_SNAP_TOL
        for e in self.edges:
            label = rects.get(f"{e.id}_label")
            if e.label and label is None:
                errors.append(f"{e.id}: labelled edge needs a Rect named '{e.id}_label'")
            p = by_name.get(e.id)
            if label is not None and p is not None:
                gap = _rect_polyline_gap(label, p.points)
                if gap > LABEL_MAX_GAP:
                    errors.append(f"{label.name} is {gap:.0f}px from its edge {e.id} "
                                  f"(max {LABEL_MAX_GAP}); set it beside one of the "
                                  f"edge's segments")
            if p is None:
                errors.append(f"{e.id}: layout edge is not drawn (no EdgePath named '{e.id}')")
                continue
            for kind, ref, side, pt in (("source", e.source, e.exit, p.points[0]),
                                        ("target", e.target, e.entry, p.points[-1])):
                if ref in ids:
                    parent = by_name.get(ref)
                    if parent is not None and not _on_polyline(pt, parent.points, tol):
                        errors.append(f"{e.id}: {kind} {pt} is not on edge {ref} "
                                      f"(declared fork)")
                    continue
                r = rects.get(ref) or boxes.get(ref)
                if r is not None and side and not _on_side(pt, r, side, tol):
                    errors.append(f"{e.id}: {kind} {pt} is not on the {side} side of {ref}")
        return errors


# Natural size of a binding grid: each track as wide / tall as its widest /
# tallest node box at the default label size, so Phase 1 can give the panel a
# page of the grid's own shape (scripts/schema.py) and `GridFrame.fit` can
# scale the same tracks onto that page.
NODE_FONT_SIZE = 14     # the panel default label size (panel_agent.md)
NODE_MAX_TEXT_W = 260   # a node's text wraps beyond this width
NODE_PAD_X = 16         # box padding around the label block, per side
NODE_PAD_Y = 12
NODE_MIN_W = 120
NODE_MIN_H = 48
EMPTY_TRACK = 32        # a row / column with no node: a routing channel
TRACK_GAP = 48          # between neighbouring tracks: an arrow plus its label
CONTAINER_HEADER = 32   # a container title's band above its top row
FRAME_MARGIN = 24       # around the whole grid


def node_box(label: str | None) -> tuple[float, float]:
    """(w, h) of a node box that holds `label` at NODE_FONT_SIZE, wrapping
    lines wider than NODE_MAX_TEXT_W the way draw.io would."""
    w, h = label_size(label or "", NODE_FONT_SIZE)
    if w > NODE_MAX_TEXT_W:
        w, h = label_size(label or "", NODE_FONT_SIZE, box_width=NODE_MAX_TEXT_W)
    return max(NODE_MIN_W, w + 2 * NODE_PAD_X), max(NODE_MIN_H, h + 2 * NODE_PAD_Y)


def _fit_tracks(n: int, spans: list[tuple[int, int, float]]) -> list[float]:
    """Track sizes for `n` tracks given (start, span, size) items: single-track
    items set their track's size; a spanning item that does not fit spreads
    its deficit evenly over its tracks. Tracks with no item are channels."""
    tracks = [0.0] * n
    for start, span, size in spans:
        if span == 1:
            tracks[start] = max(tracks[start], size)
    for start, span, size in spans:
        if span > 1:
            have = sum(tracks[start:start + span]) + TRACK_GAP * (span - 1)
            if have < size:
                for i in range(start, start + span):
                    tracks[i] += (size - have) / span
    return [t if t > 0 else EMPTY_TRACK for t in tracks]


def natural_tracks(spec: LayoutSpec) -> tuple[list[float], list[float]]:
    """(column widths, row heights) the grid needs, excluding gaps: each track
    fits its nodes' boxes; a container's title adds CONTAINER_HEADER to its
    topmost member row."""
    boxes = {n.id: node_box(n.label) for n in spec.nodes}
    cols = _fit_tracks(spec.cols, [(n.col, n.colspan, boxes[n.id][0]) for n in spec.nodes])
    rows = _fit_tracks(spec.rows, [(n.row, n.rowspan, boxes[n.id][1]) for n in spec.nodes])
    by_id = {n.id: n for n in spec.nodes}
    for c in spec.containers:
        member_rows = [by_id[m].row for m in c.members if m in by_id]
        if c.title and member_rows:
            rows[min(member_rows)] += CONTAINER_HEADER
    return cols, rows


def natural_size(spec: LayoutSpec) -> tuple[float, float]:
    """(w, h) of the whole grid at its natural tracks: every cell is its track
    plus TRACK_GAP, inside FRAME_MARGIN. Its ratio is the page aspect the
    panel should get."""
    cols, rows = natural_tracks(spec)
    return (sum(cols) + TRACK_GAP * len(cols) + 2 * FRAME_MARGIN,
            sum(rows) + TRACK_GAP * len(rows) + 2 * FRAME_MARGIN)


class GridFrame:
    """Pixel frame for a layout grid: `col_edges` (cols + 1 x boundaries) and
    `row_edges` (rows + 1 y boundaries), each strictly increasing. Pick them
    to suit the content (or start from `GridFrame.fit`); `rect()` centres a
    node in its (spanned) cell, so the grid topology holds by construction."""

    @classmethod
    def fit(cls, spec: LayoutSpec, page_w: float, page_h: float) -> "GridFrame":
        """A frame whose cells (natural track + TRACK_GAP) are scaled to fill
        the page inside FRAME_MARGIN, so every track keeps its natural share."""
        cols, rows = natural_tracks(spec)

        def edges(tracks: list[float], extent: float) -> list[float]:
            cells = [t + TRACK_GAP for t in tracks]
            scale = (extent - 2 * FRAME_MARGIN) / sum(cells)
            out = [float(FRAME_MARGIN)]
            for c in cells:
                out.append(out[-1] + c * scale)
            out[-1] = extent - FRAME_MARGIN  # absorb float drift
            return out

        return cls(spec, edges(cols, page_w), edges(rows, page_h))

    def __init__(self, spec: LayoutSpec, col_edges: list[float], row_edges: list[float]):
        for name, edges, n in (("col_edges", col_edges, spec.cols),
                               ("row_edges", row_edges, spec.rows)):
            if len(edges) != n + 1 or any(b <= a for a, b in zip(edges, edges[1:])):
                raise ValueError(f"{name} needs {n + 1} strictly increasing boundaries, "
                                 f"got {list(edges)}")
        self.spec = spec
        self.col_edges = list(col_edges)
        self.row_edges = list(row_edges)
        self._nodes = {n.id: n for n in spec.nodes}

    def span(self, node_id: str) -> tuple[float, float, float, float]:
        n = self._nodes[node_id]
        x0, x1 = self.col_edges[n.col], self.col_edges[n.col + n.colspan]
        y0, y1 = self.row_edges[n.row], self.row_edges[n.row + n.rowspan]
        return x0, y0, x1 - x0, y1 - y0

    def rect(self, node_id: str, w: float, h: float) -> Rect:
        x, y, sw, sh = self.span(node_id)
        return Rect(node_id, x + (sw - w) / 2, y + (sh - h) / 2, w, h)


def _figure(figure_json: str | Path | None) -> dict | None:
    path = Path(figure_json) if figure_json else Path(__file__).resolve().parent / "figure.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


def load_layout_spec(panel_id: str, figure_json: str | Path | None = None) -> LayoutSpec | None:
    """The panel's binding `layout_spec` from figure.json, or None when the
    panel (or the file) has none."""
    fig = _figure(figure_json)
    for panel in (fig or {}).get("panels", []):
        if panel.get("id") == panel_id and panel.get("layout_spec"):
            return LayoutSpec.from_dict(panel["layout_spec"])
    return None


def load_palette(figure_json: str | Path | None = None) -> list[str] | None:
    """The figure's closed `palette` (hex colors) from figure.json, or None."""
    fig = _figure(figure_json)
    return (fig or {}).get("palette") or None
