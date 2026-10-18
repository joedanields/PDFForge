"""Convert from PDF (docs/02_FEATURES.md §D). Phase 1: PDF → Image (D1)."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
from pikepdf import Name, PdfImage

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils.naming import sanitize_stem
from utils.pdfio import deliver_many, open_pdf, single_pdf_input
from utils.ranges import parse_page_set
from utils.validation import option_choice, option_str, options_dict, passwords_map

MAX_PIXELS = 100_000_000  # per rendered page; larger pages are scaled down to fit
JPEG_QUALITY = 90


def pdf_to_image(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Render pages to JPG/PNG (pypdfium2) or extract the embedded images (pikepdf)."""
    source = single_pdf_input(params)
    options = options_dict(params)
    mode = option_choice(options, "mode", ("pages", "extract"), "pages")
    passwords = passwords_map(params)
    # pikepdf gives precise password / damage errors before pdfium touches the file.
    with open_pdf(source, passwords) as pdf:
        total = len(pdf.pages)
        if mode == "extract":
            files, skipped = _extract_images(pdf, source, ctx)
            outputs, extra = deliver_many(files, params, source, "images", ctx, protected=[source])
            stats: dict[str, Any] = {"images": len(files), **extra}
            if skipped:
                stats["skipped"] = skipped
            return ToolResult(outputs, stats)

    fmt = option_choice(options, "format", ("jpg", "png"), "jpg")
    dpi = option_choice(options, "dpi", (72, 150, 300), 150)
    selected = parse_page_set(option_str(options, "pages", "all", max_len=2000), total)
    files, downscaled = _render_pages(
        source, passwords.get(str(source), ""), selected, fmt, dpi, ctx
    )
    outputs, extra = deliver_many(files, params, source, "images", ctx, protected=[source])
    stats = {"pages": len(files), "dpi": dpi, "format": fmt, **extra}
    if downscaled:
        stats["downscaled"] = downscaled
    return ToolResult(outputs, stats)


def _render_pages(
    source: Path,
    password: str,
    selected: list[int],
    fmt: str,
    dpi: int,
    ctx: JobContext,
) -> tuple[list[Path], int]:
    stem = sanitize_stem(source.stem)
    files: list[Path] = []
    downscaled = 0
    doc = pdfium.PdfDocument(str(source), password=password or None)
    try:
        for n, index in enumerate(selected):
            ctx.check_cancelled()
            ctx.progress(n * 95 / len(selected), f"Rendering page {index + 1}")
            page = doc[index]
            try:
                scale = dpi / 72
                width, height = page.get_size()
                pixels = width * scale * height * scale
                if pixels > MAX_PIXELS:
                    scale *= math.sqrt(MAX_PIXELS / pixels)
                    downscaled += 1
                bitmap = page.render(
                    scale=scale, may_draw_forms=True, fill_color=(255, 255, 255, 255)
                )
                image = bitmap.to_pil()
                path = ctx.temp_dir / f"{stem}_page-{index + 1}.{fmt}"
                if fmt == "jpg":
                    image.convert("RGB").save(path, "JPEG", quality=JPEG_QUALITY, dpi=(dpi, dpi))
                else:
                    image.save(path, "PNG", dpi=(dpi, dpi), optimize=False)
                files.append(path)
            finally:
                page.close()
    finally:
        doc.close()
    return files, downscaled


def _extract_images(pdf: pikepdf.Pdf, source: Path, ctx: JobContext) -> tuple[list[Path], int]:
    """Each distinct embedded image once, in its native format where possible (JPEG stays
    JPEG, byte for byte); stencil masks are skipped."""
    stem = sanitize_stem(source.stem)
    seen: set[tuple[int, int]] = set()
    files: list[Path] = []
    skipped = 0
    total = len(pdf.pages)
    for page_no, page in enumerate(pdf.pages):
        ctx.check_cancelled()
        ctx.progress(page_no * 95 / max(total, 1), f"Scanning page {page_no + 1}")
        for obj in page.get_images().values():
            key = obj.objgen
            if key in seen:
                continue
            seen.add(key)
            if not isinstance(obj, pikepdf.Stream) or obj.get("/Subtype") != Name.Image:
                continue
            if bool(obj.get("/ImageMask", False)):  # stencil mask, not a picture
                continue
            prefix = ctx.temp_dir / f"{stem}_image-{len(files) + 1}"
            try:
                image = PdfImage(obj)
                try:
                    files.append(Path(image.extract_to(fileprefix=str(prefix))))
                except (pikepdf.UnsupportedImageTypeError, NotImplementedError):
                    pil = image.as_pil_image()
                    path = prefix.with_suffix(".png")
                    pil.save(path, "PNG")
                    files.append(path)
            except Exception:  # one unreadable image must not fail the whole job
                skipped += 1
    if not files:
        raise EngineError(
            ErrorCode.INVALID_INPUT,
            f"{source.name} has no embedded images to extract",
            str(source),
        )
    return files, skipped
