"""Edit tools (docs/02_FEATURES.md §E): page numbers (E2), watermark (E3) and crop (E4).

Both stamp an overlay (drawn with ReportLab) onto existing pages with pikepdf — page content is
not re-rendered, and the file keeps its password/permissions.
"""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from pikepdf import Array, Pdf
from PIL import Image, ImageOps
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils.overlay import GRID_POSITIONS, anchor_point, frame_of, mirror
from utils.pageinfo import display_rect_to_page, displayed_size, visible_box
from utils.pdfio import deliver_pdf, open_pdf, save_pdf, single_pdf_input
from utils.ranges import parse_page_set
from utils.validation import (
    IMAGE_SUFFIXES,
    check_readable_file,
    option_bool,
    option_choice,
    option_float,
    option_int,
    option_str,
    options_dict,
    passwords_map,
)

FONTS: dict[str, tuple[str, str]] = {
    "helvetica": ("Helvetica", "Helvetica-Bold"),
    "times": ("Times-Roman", "Times-Bold"),
    "courier": ("Courier", "Courier-Bold"),
}
NUMBER_FORMATS = ("n", "page_n", "n_of_total", "page_n_of_total", "custom")
_HEX = re.compile(r"^#?([0-9a-fA-F]{6})$")
CAP_HEIGHT = 0.72  # of the font size, for vertical centring of a text line


def option_color(options: dict[str, Any], key: str, default: str) -> tuple[float, float, float]:
    value = option_str(options, key, default, max_len=7)
    match = _HEX.match(value)
    if not match:
        raise EngineError(ErrorCode.INVALID_INPUT, f"Option '{key}' must be a colour like #1A2B3C")
    raw = match.group(1)
    return tuple(int(raw[i : i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def _font(options: dict[str, Any]) -> str:
    family = option_choice(options, "font", tuple(FONTS), "helvetica")
    return FONTS[family][1 if option_bool(options, "bold", False) else 0]


def _check_latin(text: str, what: str) -> None:
    # The standard PDF fonts used here cover Latin-1 only; other scripts need embedded fonts.
    try:
        text.encode("latin-1")
    except UnicodeEncodeError as exc:
        raise EngineError(
            ErrorCode.UNSUPPORTED, f"{what} can only use Latin characters for now"
        ) from exc


def number_label(fmt: str, template: str, n: int, total: int) -> str:
    if fmt == "page_n":
        return f"Page {n}"
    if fmt == "n_of_total":
        return f"{n} of {total}"
    if fmt == "page_n_of_total":
        return f"Page {n} of {total}"
    if fmt == "custom":
        # Literal substitution only — no str.format, so templates cannot inject anything.
        return template.replace("{n}", str(n)).replace("{total}", str(total))
    return str(n)


# ── E2 Page numbers ─────────────────────────────────────────────────────────────────────────


def page_numbers(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    source = single_pdf_input(params)
    options = options_dict(params)
    position = option_choice(options, "position", GRID_POSITIONS, "bottom-center")
    margin = option_float(options, "margin", 28.0, lo=0, hi=300)
    first = option_int(options, "first_number", 1, lo=0, hi=1_000_000)
    fmt = option_choice(options, "format", NUMBER_FORMATS, "n")
    template = option_str(options, "template", "{n}", max_len=200)
    if fmt == "custom":
        if "{n}" not in template:
            raise EngineError(ErrorCode.INVALID_INPUT, "The custom format needs {n}")
        _check_latin(template, "The custom format")
    font = _font(options)
    size = option_float(options, "size", 11.0, lo=4, hi=144)
    rgb = option_color(options, "color", "#000000")
    facing = option_bool(options, "facing", False)
    skip_first = option_bool(options, "skip_first", False)
    pages_text = option_str(options, "pages", "all", max_len=2000)
    tmp = ctx.temp_dir / "numbered.pdf"
    overlay_path = ctx.temp_dir / "numbers-overlay.pdf"

    with open_pdf(source, passwords_map(params)) as pdf:
        selected = parse_page_set(pages_text, len(pdf.pages))
        if skip_first:
            selected = [i for i in selected if i != 0]
        if not selected:
            raise EngineError(ErrorCode.INVALID_INPUT, "There are no pages to number")
        last = first + len(selected) - 1
        frames = [frame_of(pdf.pages[i]) for i in selected]

        c = canvas.Canvas(str(overlay_path))
        for k, frame in enumerate(frames):
            if k % 50 == 0:
                ctx.check_cancelled()
                ctx.progress(k * 50 / len(frames), f"Numbering page {selected[k] + 1}")
            n = first + k
            text = number_label(fmt, template, n, last)
            # Facing pages: odd numbers on right-hand pages, even numbers mirrored to the left.
            where = mirror(position) if facing and n % 2 == 0 else position
            box = (stringWidth(text, font, size), size * CAP_HEIGHT)
            x, y = anchor_point(where, frame.size, box, margin)
            c.setPageSize(frame.size)
            c.setFillColorRGB(*rgb)
            c.setFont(font, size)
            c.drawString(x, y, text)
            c.showPage()
        c.save()

        with Pdf.open(overlay_path) as overlay:
            for k, index in enumerate(selected):
                # add_overlay maps the display-sized canvas onto the visible, rotated page.
                pdf.pages[index].add_overlay(overlay.pages[k], None)
        save_pdf(pdf, tmp, ctx, start=60, keep_encryption=True)
        total_pages = len(pdf.pages)

    ctx.check_cancelled()
    final = deliver_pdf(tmp, params, source, "numbered", protected=[source])
    return ToolResult(
        [final],
        {
            "pages": total_pages,
            "numbered": len(selected),
            "first": first,
            "last": last,
            "bytes": final.stat().st_size,
        },
    )


# ── E3 Watermark ────────────────────────────────────────────────────────────────────────────

WATERMARK_MARGIN = 36.0


def _rotated_box(width: float, height: float, degrees: float) -> tuple[float, float]:
    """Axis-aligned size of a ``width`` by ``height`` box rotated by ``degrees``."""
    rad = math.radians(degrees)
    c, s = abs(math.cos(rad)), abs(math.sin(rad))
    return width * c + height * s, width * s + height * c


def _stamp_centres(
    tile: bool,
    position: str,
    page: tuple[float, float],
    box: tuple[float, float],
) -> list[tuple[float, float]]:
    """Centre points of every stamp on a page of display size ``page``."""
    width, height = page
    bw, bh = box
    if not tile:
        x, y = anchor_point(position, page, box, WATERMARK_MARGIN)
        return [(x + bw / 2, y + bh / 2)]
    gap = max(min(bw, bh) * 0.6, 48.0)
    step_x, step_y = bw + gap, bh + gap
    centres: list[tuple[float, float]] = []
    row = 0
    y = step_y / 2
    while y - bh / 2 < height:
        offset = (step_x / 2) * (row % 2)  # brick pattern
        x = step_x / 2 - offset
        while x - bw / 2 < width:
            centres.append((x, y))
            x += step_x
        y += step_y
        row += 1
    return centres


def watermark(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    source = single_pdf_input(params)
    options = options_dict(params)
    kind = option_choice(options, "kind", ("text", "image"), "text")
    tile = option_bool(options, "tile", False)
    position = option_choice(options, "position", GRID_POSITIONS, "middle-center")
    layer = option_choice(options, "layer", ("over", "under"), "over")
    opacity = option_float(options, "opacity", 0.3, lo=0.02, hi=1.0)
    rotation = option_float(options, "rotation", 45.0, lo=-180, hi=180)
    pages_text = option_str(options, "pages", "all", max_len=2000)

    text = ""
    image: ImageReader | None = None
    if kind == "text":
        text = option_str(options, "text", "", max_len=200).strip()
        if not text:
            raise EngineError(ErrorCode.INVALID_INPUT, "Enter the watermark text")
        _check_latin(text, "Watermark text")
        font = _font(options)
        size = option_float(options, "size", 48.0, lo=6, hi=400)
        rgb = option_color(options, "color", "#808080")
    else:
        image_path = Path(option_str(options, "image", "", max_len=4000))
        if not image_path.name or image_path.suffix.lower() not in IMAGE_SUFFIXES:
            raise EngineError(ErrorCode.INVALID_INPUT, "Choose an image for the watermark")
        check_readable_file(image_path)
        try:
            with Image.open(image_path) as img:
                img.load()
                pixel_size = img.size
                png = ctx.temp_dir / "watermark.png"
                (ImageOps.exif_transpose(img) or img).convert("RGBA").save(png, "PNG")
        except (OSError, ValueError, Image.DecompressionBombError) as exc:
            raise EngineError(
                ErrorCode.CORRUPT_FILE,
                f"{image_path.name} is not a readable image",
                str(image_path),
            ) from exc
        image = ImageReader(str(png))
        scale = option_float(options, "scale", 0.4, lo=0.02, hi=1.0)

    tmp = ctx.temp_dir / "watermarked.pdf"
    overlay_path = ctx.temp_dir / "watermark-overlay.pdf"
    with open_pdf(source, passwords_map(params)) as pdf:
        selected = parse_page_set(pages_text, len(pdf.pages))
        # One overlay page per distinct page size: identical stamps share one form XObject.
        sizes: dict[tuple[float, float], int] = {}
        page_sizes = [frame_of(pdf.pages[i]).size for i in selected]
        c = canvas.Canvas(str(overlay_path))
        stamps = 0
        for size_key in page_sizes:
            key = (round(size_key[0], 2), round(size_key[1], 2))
            if key in sizes:
                continue
            sizes[key] = len(sizes)
            width, height = size_key
            c.setPageSize((width, height))
            c.setFillAlpha(opacity)
            c.setStrokeAlpha(opacity)
            if image is not None:
                w = width * scale
                h = w * pixel_size[1] / pixel_size[0]
                box = _rotated_box(w, h, rotation)
                for cx, cy in _stamp_centres(tile, position, (width, height), box):
                    c.saveState()
                    c.translate(cx, cy)
                    c.rotate(rotation)
                    c.drawImage(image, -w / 2, -h / 2, width=w, height=h, mask="auto")
                    c.restoreState()
                    stamps += 1
            else:
                tw = stringWidth(text, font, size)
                th = size * CAP_HEIGHT
                box = _rotated_box(tw, th, rotation)
                c.setFillColorRGB(*rgb)
                c.setFont(font, size)
                for cx, cy in _stamp_centres(tile, position, (width, height), box):
                    c.saveState()
                    c.translate(cx, cy)
                    c.rotate(rotation)
                    c.drawCentredString(0, -th / 2, text)
                    c.restoreState()
                    stamps += 1
            c.showPage()
        c.save()

        with Pdf.open(overlay_path) as overlay:
            for n, index in enumerate(selected):
                if n % 50 == 0:
                    ctx.check_cancelled()
                    ctx.progress(n * 60 / len(selected), f"Watermarking page {index + 1}")
                w, h = page_sizes[n]
                stamp = overlay.pages[sizes[(round(w, 2), round(h, 2))]]
                if layer == "over":
                    pdf.pages[index].add_overlay(stamp, None)
                else:
                    pdf.pages[index].add_underlay(stamp, None)
        save_pdf(pdf, tmp, ctx, start=65, keep_encryption=True)
        total = len(pdf.pages)

    ctx.check_cancelled()
    final = deliver_pdf(tmp, params, source, "watermark", protected=[source])
    return ToolResult(
        [final],
        {
            "pages": total,
            "watermarked": len(selected),
            "kind": kind,
            "layer": layer,
            "bytes": final.stat().st_size,
        },
    )


# ── Crop (E4) ─────────────────────────────────────────────────────────────────────────────

CROP_MIN_PT = 18.0  # never crop a page smaller than a quarter inch
TRIM_THRESHOLD = 245  # rendered grey levels above this count as white margin


def _fraction_box(raw: Any) -> tuple[float, float, float, float]:
    """``[left, top, right, bottom]`` fractions of the displayed page, validated."""
    if (
        not isinstance(raw, list)
        or len(raw) != 4
        or not all(isinstance(v, int | float) and not isinstance(v, bool) for v in raw)
    ):
        raise EngineError(ErrorCode.INVALID_INPUT, "Draw the area to keep on the page")
    left, top, right, bottom = (min(1.0, max(0.0, float(v))) for v in raw)
    if right - left < 0.02 or bottom - top < 0.02:
        raise EngineError(ErrorCode.INVALID_INPUT, "The crop area is too small")
    return left, top, right, bottom


def content_box(image: Image.Image) -> tuple[float, float, float, float] | None:
    """Fractions (left, top, right, bottom) of the non-white part of a rendered page."""
    gray = image.convert("L")
    ink = gray.point(lambda v: 255 if v < TRIM_THRESHOLD else 0)
    bbox = ink.getbbox()
    if bbox is None:
        return None
    w, h = gray.size
    return bbox[0] / w, bbox[1] / h, bbox[2] / w, bbox[3] / h


def _to_display_points(
    page: Any, box: tuple[float, float, float, float]
) -> tuple[float, float, float, float]:
    width, height = displayed_size(page)
    left, top, right, bottom = box
    return left * width, (1 - bottom) * height, right * width, (1 - top) * height


def crop(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Set the CropBox of the selected pages — lossless: content outside is hidden, not
    removed (02 E4). ``mode`` "box": keep ``box`` (fractions of the displayed page, drawn on
    the preview); "auto": trim each page's white margins, keeping ``margin`` points around
    the content."""
    source = single_pdf_input(params)
    options = options_dict(params)
    mode = option_choice(options, "mode", ("box", "auto"), "box")
    margin = option_float(options, "margin", 6.0, lo=0.0, hi=144.0)
    box = _fraction_box(options.get("box")) if mode == "box" else None
    tmp = ctx.temp_dir / "cropped.pdf"
    with open_pdf(source, passwords_map(params)) as pdf:
        total = len(pdf.pages)
        selected = parse_page_set(option_str(options, "pages", "all", max_len=2000), total)
        boxes: dict[int, tuple[float, float, float, float] | None] = {}
        if mode == "auto":
            plain = ctx.temp_dir / "plain.pdf"
            pdf.save(plain)
            doc = pdfium.PdfDocument(str(plain))
            try:
                for n, index in enumerate(selected):
                    ctx.check_cancelled()
                    ctx.progress(5 + 70 * n / max(1, len(selected)), f"Measuring page {index + 1}")
                    rendered = doc[index]
                    try:
                        bitmap = rendered.render(scale=100 / 72, grayscale=True)
                        boxes[index] = content_box(bitmap.to_pil())
                    finally:
                        rendered.close()
            finally:
                doc.close()
        cropped = 0
        for index in selected:
            page = pdf.pages[index]
            fractions = box if box is not None else boxes.get(index)
            if fractions is None:
                continue  # an empty page has nothing to trim to
            x0, y0, x1, y1 = display_rect_to_page(page, _to_display_points(page, fractions))
            if mode == "auto":
                vx0, vy0, vx1, vy1 = visible_box(page)
                x0, y0 = max(vx0, x0 - margin), max(vy0, y0 - margin)
                x1, y1 = min(vx1, x1 + margin), min(vy1, y1 + margin)
            if x1 - x0 < CROP_MIN_PT or y1 - y0 < CROP_MIN_PT:
                continue
            page.obj.CropBox = Array([x0, y0, x1, y1])
            for key in ("/TrimBox", "/ArtBox", "/BleedBox"):
                if key in page.obj:
                    del page.obj[key]
            cropped += 1
        if cropped == 0:
            raise EngineError(ErrorCode.INVALID_INPUT, "Nothing to crop on the selected pages")
        save_pdf(pdf, tmp, ctx, start=80, keep_encryption=True)
    final = deliver_pdf(tmp, params, source, "cropped", protected=[source])
    return ToolResult([final], {"pages": total, "cropped": cropped, "mode": mode})
