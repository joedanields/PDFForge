"""Redact PDF (docs/02_FEATURES.md F4) — *true* redaction.

A black box drawn over text is not redaction: the text stays in the file. Without a PDF
editor that can rewrite text runs safely (MuPDF is AGPL, 09 §3), PDFForge rebuilds every page
that has redactions from pixels (D-032):
1. the page is rendered at ``dpi`` exactly as displayed and the marked areas are painted black;
2. the page's content, resources and annotations are replaced by that one picture, so no text,
   vector or image object of the original page survives — not even under the boxes;
3. optionally the page gets an invisible OCR text layer again (Tesseract), so the rest of the
   page stays searchable; the boxes are black, so nothing behind them can be read back.
Pages without redactions are not touched. Document information and XMP metadata can be
removed too, and the file is saved without incremental history.
"""

from __future__ import annotations

import io
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
from pikepdf import Dictionary, Name, Pdf
from PIL import Image, ImageDraw

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils import tesseract
from utils.pageinfo import display_matrix, displayed_size
from utils.pdfio import deliver_pdf, open_pdf, save_pdf, single_pdf_input
from utils.validation import option_bool, option_choice, options_dict, passwords_map
from utils.vendor import tesseract_path

MAX_AREAS = 5000
DPI_CHOICES = (150, 200, 300)


@dataclass(frozen=True)
class Area:
    page: int
    x: float
    y: float
    w: float
    h: float


def parse_areas(raw: Any, page_count: int) -> list[Area]:
    if not isinstance(raw, list) or not raw:
        raise EngineError(ErrorCode.INVALID_INPUT, "Mark at least one area to redact")
    if len(raw) > MAX_AREAS:
        raise EngineError(ErrorCode.INVALID_INPUT, f"At most {MAX_AREAS} areas at once")
    areas = []
    for item in raw:
        if not isinstance(item, dict):
            raise EngineError(ErrorCode.INVALID_INPUT, "Invalid redaction area")
        page = item.get("page")
        values = [item.get(k) for k in ("x", "y", "w", "h")]
        if (
            not isinstance(page, int)
            or isinstance(page, bool)
            or not 0 <= page < page_count
            or not all(isinstance(v, int | float) and not isinstance(v, bool) for v in values)
        ):
            raise EngineError(ErrorCode.INVALID_INPUT, "Invalid redaction area")
        x, y, w, h = (float(v) for v in values)  # type: ignore[arg-type]
        x, y = min(1.0, max(0.0, x)), min(1.0, max(0.0, y))
        w, h = min(1.0 - x, max(0.0, w)), min(1.0 - y, max(0.0, h))
        if w > 0 and h > 0:
            areas.append(Area(page, x, y, w, h))
    if not areas:
        raise EngineError(ErrorCode.INVALID_INPUT, "Mark at least one area to redact")
    return areas


def burn(image: Image.Image, areas: list[Area]) -> Image.Image:
    """Paint the areas solid black onto the rendered page."""
    draw = ImageDraw.Draw(image)
    width, height = image.size
    for a in areas:
        draw.rectangle(
            (
                int(a.x * width) - 1,
                int(a.y * height) - 1,
                int((a.x + a.w) * width) + 1,
                int((a.y + a.h) * height) + 1,
            ),
            fill=(0, 0, 0) if image.mode == "RGB" else 0,
        )
    return image


def _is_gray(image: Image.Image) -> bool:
    small = image.convert("RGB").resize((64, 64))
    data = small.tobytes()
    return all(
        abs(data[i] - data[i + 1]) < 8 and abs(data[i + 1] - data[i + 2]) < 8
        for i in range(0, len(data), 3)
    )


def _image_stream(pdf: Pdf, image: Image.Image) -> pikepdf.Stream:
    """Grey pages as lossless Flate (sharp text), colour pages as JPEG."""
    if _is_gray(image):
        gray = image.convert("L")
        stream = pdf.make_stream(zlib.compress(gray.tobytes(), 6))
        stream.Filter = Name.FlateDecode
        stream.ColorSpace = Name.DeviceGray
    else:
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer, "JPEG", quality=88)
        stream = pdf.make_stream(buffer.getvalue())
        stream.Filter = Name.DCTDecode
        stream.ColorSpace = Name.DeviceRGB
    stream.Type = Name.XObject
    stream.Subtype = Name.Image
    stream.Width, stream.Height = image.size
    stream.BitsPerComponent = 8
    return stream


def replace_with_image(pdf: Pdf, index: int, image: Image.Image) -> None:
    """Make the page show only ``image`` (rendered as displayed) over its visible area."""
    page = pdf.pages[index]
    width, height = displayed_size(page)
    a, b, c, d, e, f = display_matrix(page)
    # Unit square -> display rectangle (W x H) -> page space.
    cm = [width * a, width * b, height * c, height * d, e, f]
    content = f"q {' '.join(f'{v:.6f}' for v in cm)} cm /Redacted Do Q\n".encode()
    page.obj.Contents = pdf.make_stream(content)
    page.obj.Resources = Dictionary(XObject=Dictionary(Redacted=_image_stream(pdf, image)))
    for key in ("/Annots", "/Group", "/Thumb", "/PieceInfo", "/StructParents", "/AA"):
        if key in page.obj:
            del page.obj[key]


def strip_metadata(pdf: Pdf) -> None:
    for key in list(pdf.docinfo.keys()):
        del pdf.docinfo[key]
    for key in ("/Metadata", "/PieceInfo"):
        if key in pdf.Root:
            del pdf.Root[key]


def redact(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    source = single_pdf_input(params)
    options = options_dict(params)
    dpi = option_choice(options, "dpi", DPI_CHOICES, 200)
    remove_metadata = option_bool(options, "remove_metadata", True)
    ocr = option_bool(options, "ocr", True) and tesseract_path().is_file()
    langs = tesseract.check_languages(_languages(options)) if ocr else []
    tmp = ctx.temp_dir / "redacted.pdf"
    work = ctx.temp_dir / "pages"
    work.mkdir()
    with open_pdf(source, passwords_map(params)) as pdf:
        areas = parse_areas(options.get("areas"), len(pdf.pages))
        by_page: dict[int, list[Area]] = {}
        for area in areas:
            by_page.setdefault(area.page, []).append(area)
        plain = ctx.temp_dir / "plain.pdf"
        pdf.save(plain)
        rendered = pdfium.PdfDocument(str(plain))
        layers: list[tuple[int, Path]] = []
        try:
            for n, (index, page_areas) in enumerate(sorted(by_page.items())):
                ctx.check_cancelled()
                ctx.progress(5 + 70 * n / len(by_page), f"Redacting page {index + 1}")
                page = rendered[index]
                try:
                    image = page.render(scale=dpi / 72, may_draw_forms=True).to_pil().convert("RGB")
                finally:
                    page.close()
                image = burn(image, page_areas)
                replace_with_image(pdf, index, image)
                if ocr:
                    png = work / f"p{index:05d}.png"
                    image.save(png, dpi=(dpi, dpi))
                    layer = tesseract.ocr_text_pdf(png, work / f"t{index:05d}", langs, dpi, ctx)
                    layers.append((index, layer))
        finally:
            rendered.close()
        opened: list[Pdf] = []
        try:
            for index, layer in layers:
                text_pdf = Pdf.open(layer)
                opened.append(text_pdf)
                pdf.pages[index].add_overlay(text_pdf.pages[0], None)
            if remove_metadata:
                strip_metadata(pdf)
            pdf.remove_unreferenced_resources()
            save_pdf(pdf, tmp, ctx, start=85, keep_encryption=True)
        finally:
            for text_pdf in opened:
                text_pdf.close()
    final = deliver_pdf(tmp, params, source, "redacted", protected=[source])
    return ToolResult(
        [final],
        {
            "areas": len(areas),
            "pages_redacted": len(by_page),
            # Pages rebuilt from pixels: the Result screen explains this (D-036).
            "rasterized_pages": len(by_page),
            "searchable": ocr,
            "metadata_removed": remove_metadata,
        },
    )


def _languages(options: dict[str, Any]) -> list[str]:
    raw = options.get("languages", "eng")
    if not isinstance(raw, str):
        raise EngineError(ErrorCode.INVALID_INPUT, "Invalid OCR languages")
    return [part for part in raw.split("+") if part][:6]
