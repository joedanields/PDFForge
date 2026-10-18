"""Page layout analysis for PDF → Office conversions (D2-D4), built on pdfplumber.

Turns the positioned words of a page into lines and paragraphs with their formatting
(font, size, bold/italic, colour, alignment, indents and spacing). Coordinates are PDF points
measured from the top-left corner of the page, as pdfplumber reports them.

This is best-effort reconstruction (02 D2): single-column flowing text, headings, ruled
tables and pictures come out well; multi-column layouts and text inside drawings do not.
"""

from __future__ import annotations

import re
import statistics
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

_SUBSET = re.compile(r"^[A-Z]{6}\+")
_STYLE_SUFFIX = re.compile(
    r"[-,]?(Bold|Italic|Oblique|BoldItalic|BoldOblique|Regular|Roman|Book|Medium|Light|"
    r"Semibold|SemiBold|Black|Heavy|Condensed|Narrow)+$"
)
_BULLET = re.compile("^([•▪◦‣●○■□–*-]|\\(?\\d{1,3}[.)]|\\(?[a-zA-Z][.)])$")  # noqa: RUF001
_FAMILIES = {
    "helvetica": "Arial",
    "arial": "Arial",
    "arialmt": "Arial",
    "times": "Times New Roman",
    "timesnewroman": "Times New Roman",
    "timesnewromanps": "Times New Roman",
    "courier": "Courier New",
    "couriernew": "Courier New",
    "couriernewps": "Courier New",
    "calibri": "Calibri",
    "cambria": "Cambria",
    "carlito": "Calibri",
    "caladea": "Cambria",
    "liberationsans": "Arial",
    "liberationserif": "Times New Roman",
    "liberationmono": "Courier New",
    "dejavusans": "DejaVu Sans",
    "symbol": "Symbol",
    "verdana": "Verdana",
    "georgia": "Georgia",
    "tahoma": "Tahoma",
    "segoeui": "Segoe UI",
}

Box = tuple[float, float, float, float]  # x0, top, x1, bottom


def font_family(fontname: str) -> str:
    """'ABCDEF+TimesNewRomanPS-BoldMT' -> 'Times New Roman'."""
    name = _SUBSET.sub("", fontname or "")
    name = re.sub(r"(PSMT|MT|PS)$", "", name.split(",")[0])
    base = _STYLE_SUFFIX.sub("", name.split("-")[0]) or name
    key = re.sub(r"[^a-z]", "", base.lower())
    for known, family in _FAMILIES.items():
        if key == known or key.startswith(known):
            return family
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", base) or "Arial"


def is_bold(fontname: str) -> bool:
    return bool(re.search(r"bold|black|heavy|semibold|demi", fontname or "", re.I))


def is_italic(fontname: str) -> bool:
    return bool(re.search(r"italic|oblique", fontname or "", re.I))


def color_hex(value: Any) -> str | None:
    """pdfplumber colour (gray / RGB / CMYK tuple of 0..1) -> 'RRGGBB'; None for black/unknown."""
    if not isinstance(value, (tuple, list)) or not value:
        return None
    try:
        parts = [float(v) for v in value]
    except (TypeError, ValueError):
        return None
    if len(parts) == 1:
        r = g = b = parts[0]
    elif len(parts) == 3:
        r, g, b = parts
    elif len(parts) == 4:
        c, m, y, k = parts
        r, g, b = (1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)
    else:
        return None
    rgb = [max(0, min(255, round(v * 255))) for v in (r, g, b)]
    if max(rgb) < 40:  # black-ish: leave the document default
        return None
    return "".join(f"{v:02X}" for v in rgb)


@dataclass
class Word:
    text: str
    x0: float
    top: float
    x1: float
    bottom: float
    size: float
    font: str = "Arial"
    bold: bool = False
    italic: bool = False
    color: str | None = None

    def style(self) -> tuple[str, float, bool, bool, str | None]:
        return (self.font, round(self.size * 2) / 2, self.bold, self.italic, self.color)


@dataclass
class Run:
    text: str
    font: str
    size: float
    bold: bool
    italic: bool
    color: str | None


@dataclass
class Line:
    words: list[Word]

    @property
    def x0(self) -> float:
        return min(w.x0 for w in self.words)

    @property
    def x1(self) -> float:
        return max(w.x1 for w in self.words)

    @property
    def top(self) -> float:
        return min(w.top for w in self.words)

    @property
    def bottom(self) -> float:
        return max(w.bottom for w in self.words)

    @property
    def size(self) -> float:
        return statistics.median(w.size for w in self.words)

    def text(self) -> str:
        parts = []
        for i, word in enumerate(self.words):
            if i and word.x0 - self.words[i - 1].x1 > 0.15 * word.size:
                parts.append(" ")
            parts.append(word.text)
        return "".join(parts)


@dataclass
class Paragraph:
    lines: list[Line]
    kind: str = "body"  # "body" | "heading" | "list"
    level: int = 0  # heading level 1..3
    align: str = "left"  # "left" | "center" | "right" | "justify"
    left_indent: float = 0.0
    first_indent: float = 0.0
    space_before: float = 0.0
    line_pitch: float | None = None

    @property
    def top(self) -> float:
        return self.lines[0].top

    @property
    def bottom(self) -> float:
        return self.lines[-1].bottom

    @property
    def size(self) -> float:
        return statistics.median(w.size for line in self.lines for w in line.words)

    def runs(self) -> list[Run]:
        """Words merged into runs of equal formatting; lines joined with spaces (de-hyphenated)."""
        runs: list[Run] = []
        for n, line in enumerate(self.lines):
            for i, word in enumerate(line.words):
                text = word.text
                if i == 0 and n > 0:
                    previous = runs[-1] if runs else None
                    if previous and previous.text.endswith("-") and text[:1].islower():
                        previous.text = previous.text[:-1]
                    else:
                        text = " " + text
                elif i > 0:
                    gap = word.x0 - line.words[i - 1].x1
                    if gap > 3 * word.size:
                        text = "\t" + text
                    elif gap > 0.15 * word.size:  # touching pieces: a style change mid-word
                        text = " " + text
                style = word.style()
                last = runs[-1] if runs else None
                if last and (last.font, last.size, last.bold, last.italic, last.color) == style:
                    last.text += text
                else:
                    runs.append(Run(text, *style))
        return runs

    def text(self) -> str:
        return "".join(r.text for r in self.runs())


@dataclass
class Picture:
    box: Box
    space_before: float = 0.0


@dataclass
class TableBlock:
    box: Box
    rows: list[list[str]]
    column_widths: list[float] = field(default_factory=list)
    space_before: float = 0.0

    @property
    def top(self) -> float:
        return self.box[1]


def inside(word: Word, box: Box, tolerance: float = 1.0) -> bool:
    cx, cy = (word.x0 + word.x1) / 2, (word.top + word.bottom) / 2
    return (
        box[0] - tolerance <= cx <= box[2] + tolerance
        and box[1] - tolerance <= cy <= box[3] + tolerance
    )


def words_from_plumber(raw: Iterable[dict[str, Any]]) -> list[Word]:
    words = []
    for w in raw:
        text = str(w.get("text", "")).strip()
        if not text:
            continue
        fontname = str(w.get("fontname", ""))
        words.append(
            Word(
                text,
                float(w["x0"]),
                float(w["top"]),
                float(w["x1"]),
                float(w["bottom"]),
                float(w.get("size") or (float(w["bottom"]) - float(w["top"]))),
                font_family(fontname),
                is_bold(fontname),
                is_italic(fontname),
                color_hex(w.get("non_stroking_color")),
            )
        )
    return words


def group_lines(words: Sequence[Word]) -> list[Line]:
    """Words -> lines: words whose vertical centres are within half a line of each other."""
    lines: list[Line] = []
    for word in sorted(words, key=lambda w: ((w.top + w.bottom) / 2, w.x0)):
        centre = (word.top + word.bottom) / 2
        if lines:
            line = lines[-1]
            line_centre = (line.top + line.bottom) / 2
            if abs(centre - line_centre) <= max(2.0, 0.5 * min(word.size, line.size)):
                line.words.append(word)
                continue
        lines.append(Line([word]))
    for line in lines:
        line.words.sort(key=lambda w: w.x0)
    return lines


def split_segments(lines: Sequence[Line], factor: float = 1.5, minimum: float = 8.0) -> list[Line]:
    """Split lines at wide horizontal gaps (table cells, columns, tab stops)."""
    segments: list[Line] = []
    for line in lines:
        current = [line.words[0]]
        for prev, word in zip(line.words, line.words[1:], strict=False):
            if word.x0 - prev.x1 > max(minimum, factor * word.size):
                segments.append(Line(current))
                current = []
            current.append(word)
        segments.append(Line(current))
    return segments


def cluster_columns(xs: Sequence[float], tolerance: float = 6.0) -> list[float]:
    """Left edges -> sorted column anchors (edges closer than ``tolerance`` share a column)."""
    anchors: list[list[float]] = []
    for x in sorted(xs):
        if anchors and x - anchors[-1][-1] <= tolerance:
            anchors[-1].append(x)
        else:
            anchors.append([x])
    return [statistics.mean(group) for group in anchors]


def _starts_item(line: Line) -> bool:
    return bool(_BULLET.match(line.words[0].text)) and len(line.words) > 1


def group_paragraphs(lines: Sequence[Line], body_size: float, frame: Box) -> list[Paragraph]:
    """Lines -> paragraphs, with heading levels, alignment, indents and spacing.

    ``frame`` is the text area (left, top, right, bottom) the page's text uses.
    """
    left, _top, right, _bottom = frame
    width = max(1.0, right - left)
    paragraphs: list[Paragraph] = []
    for line in lines:
        current = paragraphs[-1] if paragraphs else None
        if current is not None and _continues(current, line, right, width):
            current.lines.append(line)
            continue
        paragraphs.append(Paragraph([line]))

    previous_bottom: float | None = None
    for para in paragraphs:
        size = para.size
        ratio = size / body_size if body_size else 1
        if ratio >= 1.15 and len(para.lines) <= 3:
            para.kind = "heading"
            para.level = 1 if ratio >= 1.6 else 2 if ratio >= 1.3 else 3
        elif _starts_item(para.lines[0]):
            para.kind = "list"
        para.align = _alignment(para, left, right, width)
        para.left_indent = max(0.0, min(line.x0 for line in para.lines[1:] or para.lines) - left)
        if para.align == "left":
            para.first_indent = para.lines[0].x0 - left - para.left_indent
        if len(para.lines) > 1:
            pitches = [b.top - a.top for a, b in zip(para.lines, para.lines[1:], strict=False)]
            para.line_pitch = statistics.median(pitches)
        para.space_before = 0.0 if previous_bottom is None else max(0.0, para.top - previous_bottom)
        previous_bottom = para.bottom
    return paragraphs


def _continues(para: Paragraph, line: Line, right: float, width: float) -> bool:
    last = para.lines[-1]
    height = max(1.0, last.bottom - last.top)
    gap = line.top - last.bottom
    if gap > 0.8 * height or gap < -0.5 * height:
        return False
    if abs(line.size - last.size) > 1.0:
        return False
    if _starts_item(line):
        return False
    if all(w.bold for w in last.words) != all(w.bold for w in line.words):
        return False  # a bold line next to normal text: a run-in heading or label
    # A clearly short previous line ending a sentence closes the paragraph.
    short = last.x1 < right - 0.15 * width
    if short and last.text().rstrip().endswith((".", ":", "!", "?")):
        return False
    # Too far left of the paragraph's left edge: a new block.
    return not line.x0 < para.lines[0].x0 - 2 * line.size


def _alignment(para: Paragraph, left: float, right: float, width: float) -> str:
    centre = (left + right) / 2
    lines = para.lines
    centred = all(
        abs((ln.x0 + ln.x1) / 2 - centre) < 0.04 * width and (ln.x1 - ln.x0) < 0.85 * width
        for ln in lines
    )
    if centred:
        return "center"
    if all(ln.x1 > right - 0.03 * width and ln.x0 > left + 0.25 * width for ln in lines):
        return "right"
    if len(lines) >= 3 and all(ln.x1 > right - 0.02 * width for ln in lines[:-1]):
        return "justify"
    return "left"


def body_size(words: Sequence[Word]) -> float:
    """The most common font size, weighted by characters."""
    weights: dict[float, int] = {}
    for w in words:
        key = round(w.size * 2) / 2
        weights[key] = weights.get(key, 0) + len(w.text)
    return max(weights, key=lambda k: weights[k]) if weights else 11.0


def text_frame(words: Sequence[Word], page_width: float, page_height: float) -> Box:
    if not words:
        return (72.0, 72.0, page_width - 72.0, page_height - 72.0)
    return (
        min(w.x0 for w in words),
        min(w.top for w in words),
        max(w.x1 for w in words),
        max(w.bottom for w in words),
    )
