"""Text-fit check for a filled panel template (drawio XML).

The geometry checks in panel_geometry.py see only the Rects a generator
registers; nothing there knows how much room a label needs. A label that
wraps past its box, or a container title registered as one line that wraps
to two, therefore passes every geometry check while the render shows text
spilling over borders and edges running through visible words.

This module estimates each vertex cell's wrapped text block the way draw.io
lays out an HTML label on export (mxText / mxSvgCanvas2D): `<br>`, block
tags and newlines break lines, `whiteSpace=wrap` wraps greedily at spaces
(and after hyphens) within the cell width minus the left/right `spacing`
plus the 2 px foreignObject padding, and every line box is `fontSize * 1.2`
tall. Glyph widths come
from the Helvetica / Helvetica-Bold AFM metrics, which Arial and Liberation
Sans share; kerning is ignored, so estimates are slightly wide (conservative).

  * error   — the glyphs spill outside the cell box (height or width).
  * warning — the glyphs fit but crowd the visible border of a bordered
    cell: the line boxes (glyphs plus their half leading) exceed the box,
    a line reaches into the side `spacing`, or the text sticks out of an
    ellipse / rhombus outline.

`label_size()` returns the box a label needs, so generators can size Rects
from the same estimate the check uses. Labels drawn outside their shape
(`labelPosition` / `verticalLabelPosition`), edge labels, MathJax labels and
`[[ pl ]]` / `[[ mp ]]` placeholder tokens (replaced by images) are not
checked.
"""

from __future__ import annotations

from dataclasses import dataclass
import html
import math
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET

LINE_HEIGHT = 1.2      # draw.io HTML labels: CSS line-height 1.2 (mxConstants.LINE_HEIGHT)
HALF_LEADING = (LINE_HEIGHT - 1) / 2  # empty leading above/below the glyphs of each line box
DEFAULT_SPACING = 2    # draw.io's default `spacing` on every side
FOREIGN_OBJECT_PADDING = 2  # mxSvgCanvas2D.foreignObjectPadding: added to the wrap width on export
DEFAULT_FONT_SIZE = 12  # used only when a cell sets no fontSize (the draw.io editor default)
FIT_EPS = 0.5          # px; absorbs coordinate rounding
UNKNOWN_FONT_FACTOR = 1.1  # non-Helvetica-metric families: scale the table up (conservative)
SWIMLANE_START_SIZE = 40   # mxConstants.DEFAULT_STARTSIZE (swimlane header height)

# Advance widths (1/1000 em) for ASCII 32..126, from the Adobe core-14 AFMs.
_HELVETICA = (
    "278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,"
    "556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,"
    "1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,"
    "667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,"
    "333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,"
    "556,556,333,500,278,556,500,722,500,500,500,334,260,334,584"
)
_HELVETICA_BOLD = (
    "278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,"
    "556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,"
    "975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,"
    "667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,"
    "333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,"
    "611,611,389,556,333,611,556,778,556,556,500,389,280,389,584"
)


def _table(widths: str, extra: dict[str, int]) -> dict[str, int]:
    out = {chr(32 + i): int(w) for i, w in enumerate(widths.split(","))}
    out.update(extra)
    return out


_REGULAR = _table(_HELVETICA, {
    " ": 278, "·": 278, "–": 556, "—": 1000, "‘": 222,
    "’": 222, "“": 333, "”": 333, "•": 350, "…": 1000,
    "×": 584, "±": 584, "°": 400,
})
_BOLD = _table(_HELVETICA_BOLD, {
    " ": 278, "·": 278, "–": 556, "—": 1000, "‘": 278,
    "’": 278, "“": 500, "”": 500, "•": 350, "…": 1000,
    "×": 584, "±": 584, "°": 400,
})
_FALLBACK_WIDE = 1000   # East Asian wide / full-width glyphs
_FALLBACK = 722         # anything else not in the table: about a capital's width
_HELVETICA_FAMILIES = {"helvetica", "arial", "liberation sans", "helvetica neue", "sans-serif"}
_MONO_FAMILIES = {"courier", "courier new", "monospace"}


def _char_width(ch: str, bold: bool) -> int:
    table = _BOLD if bold else _REGULAR
    if ch in table:
        return table[ch]
    base = unicodedata.normalize("NFKD", ch)[:1]
    if base in table:
        return table[base]
    return _FALLBACK_WIDE if unicodedata.east_asian_width(ch) in ("W", "F") else _FALLBACK


def text_width(text: str, font_size: float, bold: bool = False,
               font_family: str = "Helvetica") -> float:
    """Estimated rendered width in px of one unwrapped line."""
    family = font_family.split(",")[0].strip().strip("'\"").lower()
    if family in _MONO_FAMILIES:
        return len(text) * 600 * font_size / 1000
    units = sum(_char_width(ch, bold) for ch in text)
    factor = 1.0 if family in _HELVETICA_FAMILIES else UNKNOWN_FONT_FACTOR
    return units * factor * font_size / 1000


# ── Label markup ──
_BR_RE = re.compile(r"<br\s*/?>", re.I)
_BLOCK_RE = re.compile(r"</?(?:div|p|li|ul|ol|h[1-6]|tr|table)\b[^>]*>", re.I)
_TAG_RE = re.compile(r"<[^>]+>")
_BOLD_RE = re.compile(r"<(?:b|strong)\b|font-weight:\s*(?:bold|[6-9]00)", re.I)
_CSS_SIZE_RE = re.compile(r"font-size:\s*([\d.]+)px", re.I)
_FONT_SIZE_ATTR_RE = re.compile(r"<font\b[^>]*\bsize=[\"']?(\d)", re.I)
_HTML_FONT_SIZES = {1: 10, 2: 13, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48}
_MATH_RE = re.compile(r"\$\$|\\\(|\\\[")
# [[ pl ... ]] / [[ mp ... ]] boxes are replaced by an image; the token never renders.
_PLACEHOLDER_RE = re.compile(r"^\s*\[\[\s*(?:pl|mp)\b.*\]\]\s*$", re.S)
_BLOCK_MARK = "\x00"


def label_lines(value: str, html_label: bool = True) -> list[str]:
    """The label's explicit lines (before wrapping), as draw.io breaks them:
    `<br>`, block tags and literal newlines start a new line; other tags are
    dropped, entities decoded, and runs of whitespace collapsed. `&nbsp;`
    stays a no-break space (U+00A0) so wrapping never splits there."""
    if not html_label:
        return value.split("\n")
    # mxText.replaceLinefeeds; a trailing newline becomes "<div><br></div>",
    # an extra empty line (replaceTrailingNewlines).
    trailing_newline = value.endswith("\n")
    text = value.replace("\n", "<br>")
    text = _BR_RE.sub("\n", text)
    text = _BLOCK_RE.sub(_BLOCK_MARK, text)
    text = _TAG_RE.sub("", text)
    text = re.sub(f"{_BLOCK_MARK}+", "\n", text.strip(_BLOCK_MARK))
    text = html.unescape(text)
    lines = [re.sub(r"[ \t\r\f\v]+", " ", ln).strip(" ") for ln in text.split("\n")]
    if len(lines) > 1 and lines[-1] == "" and not trailing_newline:
        lines.pop()  # a trailing <br> opens no new line box
    return lines


def _pieces(line: str) -> list[tuple[str, bool]]:
    """Split a line at its break opportunities: spaces (the space is dropped
    and the piece is joined back with one) and after a hyphen followed by a
    letter (joined back directly). Returns (piece, joined_with_space)."""
    out: list[tuple[str, bool]] = []
    for wi, word in enumerate(line.split(" ")):
        if not word:
            continue
        parts = re.split(r"(?<=-)(?=[^\W\d_])", word)
        for pi, part in enumerate(parts):
            out.append((part, pi == 0 and wi > 0 and bool(out)))
    return out


def wrap_line(line: str, wrap_width: "float | None", font_size: float, bold: bool = False,
              font_family: str = "Helvetica") -> list[str]:
    """Greedy word wrap of one explicit line at `wrap_width` px (None = no wrap)."""
    if wrap_width is None or not line:
        return [line]
    rows: list[str] = []
    current = ""
    for piece, spaced in _pieces(line):
        candidate = f"{current} {piece}" if (current and spaced) else current + piece
        if current and text_width(candidate, font_size, bold, font_family) > wrap_width:
            rows.append(current)
            current = piece
        else:
            current = candidate
    rows.append(current)
    return rows


@dataclass
class TextBlock:
    lines: list[str]          # visual lines after wrapping
    wrapped: list[tuple[str, float]]  # explicit lines that wrapped: (text, unwrapped width)
    font_size: float          # after inline font sizes
    bold: bool                # after inline <b> / bold CSS
    width: float              # widest visual line, px

    @property
    def height(self) -> float:
        """Total line-box height, px."""
        return len(self.lines) * self.font_size * LINE_HEIGHT

    @property
    def ink_height(self) -> float:
        """Height of the glyphs themselves: the line boxes minus the half
        leading above the first line and below the last."""
        return self.height - 2 * HALF_LEADING * self.font_size


def layout_label(value: str, font_size: float, *, bold: bool = False,
                 wrap_width: "float | None" = None, font_family: str = "Helvetica",
                 html_label: bool = True) -> TextBlock:
    """Lay out a label the way draw.io does and measure the block. Inline
    `<b>` / bold CSS and inline font sizes apply to the whole label (an
    overestimate when only part of it is bold or enlarged)."""
    if html_label:
        bold = bold or bool(_BOLD_RE.search(value))
        sizes = [float(s) for s in _CSS_SIZE_RE.findall(value)]
        sizes += [_HTML_FONT_SIZES.get(int(s), 48) for s in _FONT_SIZE_ATTR_RE.findall(value)]
        font_size = max([font_size, *sizes])
    lines: list[str] = []
    wrapped: list[tuple[str, float]] = []
    for line in label_lines(value, html_label):
        rows = wrap_line(line, wrap_width, font_size, bold, font_family)
        if len(rows) > 1:
            wrapped.append((line, text_width(line, font_size, bold, font_family)))
        lines += rows
    width = max((text_width(r, font_size, bold, font_family) for r in lines), default=0.0)
    return TextBlock(lines, wrapped, font_size, bold, width)


def wrap_width_for(box_width: float, spacing_left: float = DEFAULT_SPACING,
                   spacing_right: float = DEFAULT_SPACING) -> float:
    """The width a `whiteSpace=wrap` label wraps at inside a box this wide."""
    return max(0.0, round(box_width - spacing_left - spacing_right)) + FOREIGN_OBJECT_PADDING


def label_size(value: str, font_size: float = 14, *, bold: bool = False,
               box_width: "float | None" = None, font_family: str = "Helvetica",
               spacing: float = DEFAULT_SPACING) -> tuple[float, float]:
    """(width, height) in px of the box a label needs, with `spacing` on
    every side: size Rects from this rather than guessing. With `box_width`
    the label wraps as draw.io wraps it inside a box that wide (a
    `whiteSpace=wrap` cell); without it every explicit line is unwrapped."""
    wrap_width = None if box_width is None else wrap_width_for(box_width, spacing, spacing)
    block = layout_label(value, font_size, bold=bold, wrap_width=wrap_width,
                         font_family=font_family)
    return block.width + 2 * spacing, block.height + 2 * spacing


# ── The check ──
def _parse_style(style: str) -> tuple[set[str], dict[str, str]]:
    names: set[str] = set()
    kv: dict[str, str] = {}
    for tok in (style or "").split(";"):
        if "=" in tok:
            k, v = tok.split("=", 1)
            kv[k.strip()] = v.strip()
        elif tok.strip():
            names.add(tok.strip())
    return names, kv


def _f(kv: dict[str, str], key: str, default: float) -> float:
    try:
        return float(kv[key])
    except (KeyError, ValueError):
        return default


def _check_cell(cell) -> tuple[list[str], list[str]]:
    value = cell.get("value") or ""
    names, st = _parse_style(cell.get("style") or "")
    geo = cell.find("mxGeometry")
    if (not value.strip() or geo is None or geo.get("relative") == "1"
            or st.get("noLabel") == "1" or _MATH_RE.search(value)
            or _PLACEHOLDER_RE.match(value)
            or st.get("labelPosition", "center") != "center"
            or st.get("verticalLabelPosition", "middle") != "middle"):
        return [], []
    html_label = st.get("html") == "1"
    if html_label and not _TAG_RE.sub("", html.unescape(value)).strip():
        return [], []
    w, h = _f(geo.attrib, "width", 0), _f(geo.attrib, "height", 0)
    if st.get("horizontal") == "0":
        w, h = h, w
    if "swimlane" in names or st.get("shape") == "swimlane":
        h = min(h, _f(st, "startSize", SWIMLANE_START_SIZE))
    spacing = _f(st, "spacing", DEFAULT_SPACING)
    left, right = spacing + _f(st, "spacingLeft", 0), spacing + _f(st, "spacingRight", 0)
    top, bottom = spacing + _f(st, "spacingTop", 0), spacing + _f(st, "spacingBottom", 0)
    wraps = html_label and st.get("whiteSpace") == "wrap"
    wrap_width = wrap_width_for(w, left, right) if wraps else None
    bold = bool(int(_f(st, "fontStyle", 0)) & 1)
    family = st.get("fontFamily", "Helvetica")
    block = layout_label(value, _f(st, "fontSize", DEFAULT_FONT_SIZE), bold=bold,
                         wrap_width=wrap_width, font_family=family, html_label=html_label)
    cid = cell.get("id")
    n = len(block.lines)
    line_h = block.font_size * LINE_HEIGHT
    why = "".join(f"; '{t}' ({tw:.0f} px) wraps at the {wrap_width:.0f} px wrap width"
                  for t, tw in block.wrapped)
    need_h = math.ceil(block.height + top + bottom)
    need_w = math.ceil(block.width + left + right)
    errors: list[str] = []
    warnings: list[str] = []
    if block.ink_height > h + FIT_EPS:
        errors.append(
            f"{cid}: label needs {n} lines ({line_h:.1f} px each, glyphs ~{block.ink_height:.0f} px) "
            f"but its box is {h:.0f} px tall, so the text spills out{why}; grow the Rect to "
            f">= {need_h} px tall (panel_text.label_size), widen it, or shorten the label")
    if block.width > w + FIT_EPS:
        widest = max(block.lines, key=lambda r: text_width(r, block.font_size, block.bold, family))
        errors.append(
            f"{cid}: line '{widest}' is {block.width:.0f} px wide but its box is {w:.0f} px wide "
            f"({'an unbreakable word' if wraps else 'the label does not wrap'}); widen the Rect "
            f"to >= {need_w} px or rebreak the label")
    if errors:
        return errors, warnings
    stroke = st.get("strokeColor")
    bordered = (stroke.lower() != "none") if stroke is not None else "text" not in names
    if not bordered:
        return errors, warnings
    shape = st.get("shape") or next((s for s in names if s in ("ellipse", "rhombus")), "")
    inscribed = {"ellipse": 1 / math.sqrt(2), "rhombus": 0.5}.get(shape, 1.0)
    room_w, room_h = w * inscribed, h * inscribed
    if block.height > room_h + FIT_EPS or block.width + left + right > room_w + FIT_EPS:
        where = f"the {shape} outline" if inscribed < 1 else "its border"
        warnings.append(
            f"{cid}: label ({n} lines, {block.width:.0f} x {block.height:.0f} px of line boxes) "
            f"crowds {where} in a {w:.0f} x {h:.0f} px box{why}; size the Rect with "
            f"panel_text.label_size (~{math.ceil(need_w / inscribed)} x "
            f"{math.ceil(need_h / inscribed)} px)")
    return errors, warnings


def check_text_fit(xml_text: str) -> tuple[list[str], list[str]]:
    """Estimate every labelled vertex cell's text block in a filled template
    and return `(errors, warnings)` (see the module docstring)."""
    errors: list[str] = []
    warnings: list[str] = []
    for cell in ET.fromstring(xml_text).iter("mxCell"):
        if cell.get("vertex") != "1":
            continue
        e, w = _check_cell(cell)
        errors += e
        warnings += w
    return errors, warnings


def enforce_text_fit(xml_text: str, bypass_warnings: bool = False) -> None:
    """Abort (`SystemExit(1)`) when a label overflows its box, or when a label
    crowds its border unless `bypass_warnings`. Call it in `main()` right
    after `enforce_rendered`, before writing the `.drawio`."""
    errors, warnings = check_text_fit(xml_text)
    for w in warnings:
        print(f"WARNING: {w}", file=sys.stderr)
    for e in errors:
        print(f"TEXT: {e}", file=sys.stderr)
    if errors:
        raise SystemExit(1)
    if warnings and not bypass_warnings:
        print(
            f"BLOCKED: {len(warnings)} text-fit warning(s) above. Re-run with "
            "--bypass-warnings ONLY if you have reviewed every warning and each "
            "one has a valid reason to be bypassed.",
            file=sys.stderr,
        )
        raise SystemExit(1)
