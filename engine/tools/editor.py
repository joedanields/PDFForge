"""Edit PDF (docs/02_FEATURES.md E1): add text boxes, images, shapes, freehand drawing and notes.

The UI sends the added objects with positions as fractions of the page *as displayed*
(origin top-left), so they land where the user put them on rotated or cropped pages too.

- Flatten (default): all objects of a page are drawn on one display-sized ReportLab canvas and
  laid over the page (utils/overlay) — they become ordinary page content.
- Keep as annotations: every object becomes a PDF annotation (Square, Circle, Line, Ink,
  FreeText, Stamp) whose appearance is the same drawing, placed with the display → page
  matrix, so other PDF editors can still move or delete it.
Notes are always annotations (a sticky note is an annotation by nature).
Existing page content is never edited (02 E1: "editing existing text is out of scope").
"""

from __future__ import annotations

import io
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pikepdf import Array, Dictionary, Name, Pdf, String
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils.images import load_image
from utils.pageinfo import apply, display_matrix, display_rect_to_page, displayed_size
from utils.pdfio import deliver_pdf, open_pdf, save_pdf, single_pdf_input
from utils.textlayout import FAMILIES, Counter
from utils.validation import IMAGE_SUFFIXES, option_bool, options_dict, passwords_map

MAX_OBJECTS = 2000
MAX_POINTS = 5000
KINDS = ("text", "image", "rect", "ellipse", "line", "arrow", "ink", "highlight", "note")
_ALIGN = {"left": TA_LEFT, "center": TA_CENTER, "right": TA_RIGHT}
_ANNOT_PRINT = 4


@dataclass
class EditObject:
    page: int
    kind: str
    x: float = 0.0
    y: float = 0.0
    w: float = 0.0
    h: float = 0.0
    points: list[tuple[float, float]] = field(default_factory=list)
    stroke: str | None = "#000000"
    fill: str | None = None
    width: float = 1.5
    opacity: float = 1.0
    text: str = ""
    font: str = "helvetica"
    size: float = 12.0
    bold: bool = False
    italic: bool = False
    align: str = "left"
    image: Path | None = None


# ── parsing ───────────────────────────────────────────────────────────────────────────────


def _bad(message: str) -> EngineError:
    return EngineError(ErrorCode.INVALID_INPUT, message)


def _num(raw: dict[str, Any], key: str, default: float, lo: float, hi: float) -> float:
    value = raw.get(key, default)
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise _bad(f"Invalid value for {key}")
    return min(hi, max(lo, float(value)))


def _color(raw: dict[str, Any], key: str, default: str | None) -> str | None:
    value = raw.get(key, default)
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value) != 7 or not value.startswith("#"):
        raise _bad(f"Invalid colour for {key}")
    int(value[1:], 16)
    return value


def parse_objects(raw: Any, page_count: int) -> list[EditObject]:
    if not isinstance(raw, list) or not raw:
        raise _bad("Add something to a page first")
    if len(raw) > MAX_OBJECTS:
        raise _bad(f"At most {MAX_OBJECTS} objects can be added at once")
    objects = []
    for item in raw:
        if not isinstance(item, dict):
            raise _bad("Invalid object")
        kind = item.get("kind")
        page = item.get("page")
        if kind not in KINDS:
            raise _bad(f"Unknown object type: {kind}")
        if not isinstance(page, int) or isinstance(page, bool) or not 0 <= page < page_count:
            raise _bad("Object on a page that does not exist")
        obj = EditObject(
            page=page,
            kind=kind,
            x=_num(item, "x", 0, 0, 1),
            y=_num(item, "y", 0, 0, 1),
            w=_num(item, "w", 0, 0, 1),
            h=_num(item, "h", 0, 0, 1),
            stroke=_color(item, "stroke", "#000000"),
            fill=_color(item, "fill", None),
            width=_num(item, "width", 1.5, 0.25, 72),
            opacity=_num(item, "opacity", 1, 0.05, 1),
            size=_num(item, "size", 12, 4, 200),
            bold=bool(item.get("bold", False)),
            italic=bool(item.get("italic", False)),
        )
        font = item.get("font", "helvetica")
        if font not in FAMILIES:
            raise _bad(f"Unknown font: {font}")
        obj.font = font
        align = item.get("align", "left")
        obj.align = align if align in _ALIGN else "left"
        text = item.get("text", "")
        if not isinstance(text, str) or len(text) > 20_000:
            raise _bad("Invalid text")
        obj.text = text
        points = item.get("points", [])
        if not isinstance(points, list) or len(points) > MAX_POINTS:
            raise _bad("Too many points in a drawing")
        for point in points:
            if (
                not isinstance(point, list | tuple)
                or len(point) != 2
                or not all(isinstance(v, int | float) and not isinstance(v, bool) for v in point)
            ):
                raise _bad("Invalid drawing point")
            obj.points.append(
                (min(1.0, max(0.0, float(point[0]))), min(1.0, max(0.0, float(point[1]))))
            )
        if kind in ("line", "arrow") and len(obj.points) != 2:
            raise _bad("A line needs a start and an end point")
        if kind in ("ink", "highlight") and len(obj.points) < 2:
            raise _bad("A drawing needs at least two points")
        if kind in ("text", "image", "rect", "ellipse") and (obj.w <= 0 or obj.h <= 0):
            raise _bad("An object has no size")
        if kind == "image":
            path = Path(str(item.get("image", "")))
            if path.suffix.lower() not in IMAGE_SUFFIXES or not path.is_file():
                raise EngineError(ErrorCode.INVALID_INPUT, "A picture file could not be found")
            obj.image = path
        objects.append(obj)
    return objects


# ── drawing (display space: points, origin bottom-left) ─────────────────────────────────


@dataclass
class Space:
    width: float
    height: float

    def point(self, u: float, v: float) -> tuple[float, float]:
        return u * self.width, self.height - v * self.height

    def box(self, obj: EditObject) -> tuple[float, float, float, float]:
        """(x0, y0, x1, y1) of a box object in display points."""
        x0, top = self.point(obj.x, obj.y)
        x1, bottom = self.point(obj.x + obj.w, obj.y + obj.h)
        return x0, bottom, x1, top


def _font_name(obj: EditObject) -> str:
    regular, bold, italic, bold_italic = FAMILIES[obj.font]
    if obj.bold and obj.italic:
        return bold_italic
    return bold if obj.bold else italic if obj.italic else regular


def _escape(text: str) -> str:
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br/>")
    )


def bounds(obj: EditObject, space: Space) -> tuple[float, float, float, float]:
    """Display-space bounding box incl. stroke, for annotation rectangles."""
    pad = obj.width / 2 + 1
    if obj.kind in ("line", "arrow", "ink", "highlight"):
        pts = [space.point(u, v) for u, v in obj.points]
        if obj.kind == "arrow":
            pad += obj.width * 4
        if obj.kind == "highlight":
            pad = max(pad, obj.width * 6)
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad
    x0, y0, x1, y1 = space.box(obj)
    return x0 - pad, y0 - pad, x1 + pad, y1 + pad


def draw(c: canvas.Canvas, obj: EditObject, space: Space, counter: Counter) -> None:
    c.saveState()
    c.setFillAlpha(obj.opacity)
    c.setStrokeAlpha(obj.opacity)
    if obj.stroke:
        c.setStrokeColor(HexColor(obj.stroke))
    if obj.fill:
        c.setFillColor(HexColor(obj.fill))
    c.setLineWidth(obj.width)
    c.setLineCap(1)
    c.setLineJoin(1)
    if obj.kind in ("rect", "ellipse"):
        x0, y0, x1, y1 = space.box(obj)
        stroke, fill = int(obj.stroke is not None), int(obj.fill is not None)
        if obj.kind == "rect":
            c.rect(x0, y0, x1 - x0, y1 - y0, stroke=stroke, fill=fill)
        else:
            c.ellipse(x0, y0, x1, y1, stroke=stroke, fill=fill)
    elif obj.kind in ("line", "arrow"):
        (ax, ay), (bx, by) = (space.point(u, v) for u, v in obj.points)
        c.line(ax, ay, bx, by)
        if obj.kind == "arrow":
            _arrow_head(c, (ax, ay), (bx, by), obj)
    elif obj.kind in ("ink", "highlight"):
        if obj.kind == "highlight":
            c.setBlendMode("Multiply")
            c.setStrokeAlpha(obj.opacity)  # ReportLab's blend-mode state replaces the alpha
        path = c.beginPath()
        first, *rest = (space.point(u, v) for u, v in obj.points)
        path.moveTo(*first)
        for point in rest:
            path.lineTo(*point)
        c.drawPath(path, stroke=1, fill=0)
    elif obj.kind == "text":
        x0, y0, x1, y1 = space.box(obj)
        style = ParagraphStyle(
            "edit",
            fontName=_font_name(obj),
            fontSize=obj.size,
            leading=obj.size * 1.2,
            textColor=HexColor(obj.stroke or "#000000"),
            alignment=_ALIGN[obj.align],
        )
        if obj.fill:
            c.rect(x0, y0, x1 - x0, y1 - y0, stroke=0, fill=1)
        paragraph = Paragraph(_escape(counter.clean(obj.text)), style)
        _w, h = paragraph.wrapOn(c, x1 - x0, 10_000)
        paragraph.drawOn(c, x0, y1 - h)
    elif obj.kind == "image" and obj.image is not None:
        x0, y0, x1, y1 = space.box(obj)
        img = load_image(obj.image)
        picture = img if img.mode in ("RGB", "RGBA") else img.convert("RGBA")
        buffer = io.BytesIO()
        picture.save(buffer, "PNG")
        buffer.seek(0)
        c.drawImage(ImageReader(buffer), x0, y0, x1 - x0, y1 - y0, mask="auto")
    c.restoreState()


def _arrow_head(
    c: canvas.Canvas, start: tuple[float, float], end: tuple[float, float], obj: EditObject
) -> None:
    import math

    angle = math.atan2(end[1] - start[1], end[0] - start[0])
    length = max(8.0, obj.width * 4)
    spread = math.radians(25)
    left = (end[0] - length * math.cos(angle - spread), end[1] - length * math.sin(angle - spread))
    right = (end[0] - length * math.cos(angle + spread), end[1] - length * math.sin(angle + spread))
    path = c.beginPath()
    path.moveTo(*end)
    path.lineTo(*left)
    path.lineTo(*right)
    path.close()
    c.setFillColor(HexColor(obj.stroke or "#000000"))
    c.drawPath(path, stroke=0, fill=1)


def _render(objects: list[EditObject], space: Space, path: Path, counter: Counter) -> None:
    c = canvas.Canvas(str(path), pagesize=(space.width, space.height))
    for obj in objects:
        draw(c, obj, space, counter)
    c.showPage()
    c.save()


# ── annotations ───────────────────────────────────────────────────────────────────────────

_SUBTYPES = {
    "rect": Name.Square,
    "ellipse": Name.Circle,
    "line": Name.Line,
    "arrow": Name.Line,
    "ink": Name.Ink,
    "highlight": Name.Ink,
    "text": Name.FreeText,
    "image": Name.Stamp,
}


def _rgb(color: str | None) -> Array:
    if not color:
        return Array([])
    value = int(color[1:], 16)
    return Array([((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255])


def _annotation(
    pdf: Pdf, page_index: int, obj: EditObject, space: Space, work: Path, counter: Counter
) -> Dictionary:
    page = pdf.pages[page_index]
    drawing = work / f"annot_{uuid.uuid4().hex[:8]}.pdf"
    _render([obj], space, drawing, counter)
    bx0, by0, bx1, by1 = bounds(obj, space)
    with Pdf.open(drawing) as single:
        form = single.pages[0].as_form_xobject()
        form.BBox = Array([bx0, by0, bx1, by1])
        form.Matrix = Array(list(display_matrix(page)))
        appearance = pdf.copy_foreign(form)
    rect = display_rect_to_page(page, (bx0, by0, bx1, by1))
    annot = Dictionary(
        Type=Name.Annot,
        Subtype=_SUBTYPES[obj.kind],
        Rect=Array(list(rect)),
        AP=Dictionary(N=appearance),
        F=_ANNOT_PRINT,
        T=String("PDFForge"),
        NM=String(f"pdfforge-{uuid.uuid4().hex[:12]}"),
        CA=obj.opacity,
        C=_rgb(obj.stroke),
    )
    if obj.fill and obj.kind in ("rect", "ellipse"):
        annot.IC = _rgb(obj.fill)
    matrix = display_matrix(page)
    if obj.kind in ("line", "arrow"):
        (ax, ay), (bx, by) = (apply(matrix, *space.point(u, v)) for u, v in obj.points)
        annot.L = Array([ax, ay, bx, by])
        if obj.kind == "arrow":
            annot.LE = Array([Name.None_, Name.OpenArrow])
    if obj.kind in ("ink", "highlight"):
        flat: list[float] = []
        for u, v in obj.points:
            flat.extend(apply(matrix, *space.point(u, v)))
        annot.InkList = Array([Array(flat)])
    if obj.kind in ("rect", "ellipse", "line", "arrow", "ink", "highlight"):
        annot.BS = Dictionary(W=obj.width)
    if obj.kind == "text":
        annot.Contents = String(obj.text)
        annot.DA = String(f"/Helv {obj.size:g} Tf 0 g")
    return annot


def _note(pdf: Pdf, page_index: int, obj: EditObject, space: Space) -> Dictionary:
    page = pdf.pages[page_index]
    x, y = space.point(obj.x, obj.y)
    rect = display_rect_to_page(page, (x, y - 20, x + 20, y))
    return Dictionary(
        Type=Name.Annot,
        Subtype=Name.Text,
        Rect=Array(list(rect)),
        Contents=String(obj.text),
        Name=Name.Comment,
        Open=False,
        F=_ANNOT_PRINT | 16 | 8,  # print, no zoom, no rotate (an icon)
        T=String("PDFForge"),
        NM=String(f"pdfforge-{uuid.uuid4().hex[:12]}"),
        C=_rgb(obj.fill or "#FFD43B"),
    )


def _add_annots(pdf: Pdf, page_index: int, annots: list[Dictionary]) -> None:
    page = pdf.pages[page_index]
    existing = page.obj.get("/Annots")
    array = Array(list(existing)) if existing is not None else Array([])
    for annot in annots:
        indirect = pdf.make_indirect(annot)
        indirect.P = page.obj
        array.append(indirect)
    page.obj.Annots = array


# ── tool ──────────────────────────────────────────────────────────────────────────────────


def edit_pdf(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    source = single_pdf_input(params)
    options = options_dict(params)
    keep_annotations = option_bool(options, "annotations", False)
    counter = Counter()
    tmp = ctx.temp_dir / "edited.pdf"
    work = ctx.temp_dir / "drawings"
    work.mkdir()
    with open_pdf(source, passwords_map(params)) as pdf:
        objects = parse_objects(options.get("objects"), len(pdf.pages))
        by_page: dict[int, list[EditObject]] = {}
        for obj in objects:
            by_page.setdefault(obj.page, []).append(obj)
        opened: list[Pdf] = []
        try:
            for n, (index, page_objects) in enumerate(sorted(by_page.items())):
                ctx.check_cancelled()
                ctx.progress(5 + 80 * n / len(by_page), f"Page {index + 1}")
                page = pdf.pages[index]
                space = Space(*displayed_size(page))
                notes = [o for o in page_objects if o.kind == "note"]
                drawn = [o for o in page_objects if o.kind != "note"]
                annots = [_note(pdf, index, o, space) for o in notes]
                if keep_annotations:
                    annots += [_annotation(pdf, index, o, space, work, counter) for o in drawn]
                elif drawn:
                    overlay_path = work / f"page_{index}.pdf"
                    _render(drawn, space, overlay_path, counter)
                    overlay = Pdf.open(overlay_path)
                    opened.append(overlay)
                    page.add_overlay(overlay.pages[0], None)
                if annots:
                    _add_annots(pdf, index, annots)
            save_pdf(pdf, tmp, ctx, start=88, keep_encryption=True)
        finally:
            for overlay in opened:
                overlay.close()
    final = deliver_pdf(tmp, params, source, "edited", protected=[source])
    stats: dict[str, Any] = {
        "objects": len(objects),
        "pages_edited": len(by_page),
        "annotations": keep_annotations,
    }
    if counter.replaced:
        stats["replaced_characters"] = counter.replaced
    return ToolResult([final], stats)
