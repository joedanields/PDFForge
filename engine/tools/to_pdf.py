"""Convert to PDF (docs/02_FEATURES.md §C).

Image → PDF (C1), HTML → PDF (C5) and Text/Markdown → PDF (C6); Office → PDF is tools/office.py.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import img2pdf
from pikepdf import Pdf
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.platypus import SimpleDocTemplate, Spacer

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils import html_prep, libreoffice, webfetch
from utils.atomic import commit
from utils.images import image_to_pdf_bytes
from utils.naming import sanitize_stem
from utils.pagecopy import PageCopier
from utils.pdfio import deliver_converted, deliver_many, deliver_pdf, save_pdf
from utils.textlayout import FAMILIES, Counter, Styles, markdown_flowables, plain_text_flowables
from utils.validation import (
    IMAGE_SUFFIXES,
    check_readable_file,
    option_bool,
    option_choice,
    option_float,
    option_str,
    optional_str,
    options_dict,
    require_str_list,
)

IMAGE_TO_PDF_MAX = 500
PAGE_SIZES: dict[str, tuple[float, float]] = {
    "a4": (img2pdf.mm_to_pt(210), img2pdf.mm_to_pt(297)),
    "letter": (img2pdf.in_to_pt(8.5), img2pdf.in_to_pt(11)),
}
MARGINS = {"none": 0.0, "small": img2pdf.mm_to_pt(10), "large": img2pdf.mm_to_pt(25)}


def _layout(page_size: str, orientation: str, margin: str) -> Any:
    border = (MARGINS[margin], MARGINS[margin])
    if page_size == "fit":
        # The page takes the image's own size (plus the margin); orientation follows the image.
        return img2pdf.get_layout_fun(None, None, border if margin != "none" else None)
    width, height = PAGE_SIZES[page_size]
    if orientation == "landscape":
        width, height = height, width
    return img2pdf.get_layout_fun(
        (width, height),
        None,
        border,
        img2pdf.FitMode.into,
        auto_orient=orientation == "auto",
    )


def image_to_pdf(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Images (JPG, PNG, BMP, TIFF incl. multi-page, WEBP, GIF, HEIC) → one PDF or one PDF each.

    JPEG and PNG data is embedded without re-compression (img2pdf); EXIF orientation is
    honoured.
    """
    inputs = [
        Path(p) for p in require_str_list(params, "inputs", min_len=1, max_len=IMAGE_TO_PDF_MAX)
    ]
    for path in inputs:
        if path.suffix.lower() not in IMAGE_SUFFIXES:
            raise EngineError(
                ErrorCode.INVALID_INPUT, f"{path.name} is not a supported image", str(path)
            )
        check_readable_file(path)
    options = options_dict(params)
    page_size = option_choice(options, "page_size", ("fit", "a4", "letter"), "fit")
    orientation = option_choice(options, "orientation", ("auto", "portrait", "landscape"), "auto")
    margin = option_choice(options, "margin", ("none", "small", "large"), "none")
    mode = option_choice(options, "mode", ("merge", "separate"), "merge")
    layout = _layout(page_size, orientation, margin)

    converted: list[Path] = []
    for n, path in enumerate(inputs):
        ctx.check_cancelled()
        ctx.progress(n * 80 / len(inputs), f"Converting {path.name}")
        pdf_bytes = image_to_pdf_bytes(path, ctx.temp_dir / f"work_{n}", layout)
        target = ctx.temp_dir / "pdfs" / f"{n:04d}" / f"{sanitize_stem(path.stem)}.pdf"
        target.parent.mkdir(parents=True)
        target.write_bytes(pdf_bytes)
        converted.append(target)

    if mode == "separate":
        outputs, extra = deliver_many(converted, params, inputs[0], "pdfs", ctx, protected=inputs)
        pages = 0
        for path in outputs:
            with Pdf.open(path) as pdf:
                pages += len(pdf.pages)
        return ToolResult(outputs, {"images": len(inputs), "pages": pages, **extra})

    out = Pdf.new()
    opened: list[Pdf] = []
    tmp = ctx.temp_dir / "images.pdf"
    try:
        copier = PageCopier(out)
        for path in converted:
            pdf = Pdf.open(path)
            opened.append(pdf)
            copier.add(pdf, range(len(pdf.pages)))
        copier.finish()
        save_pdf(out, tmp, ctx, start=85)
        pages = len(out.pages)
    finally:
        out.close()
        for pdf in opened:
            pdf.close()
    final = deliver_pdf(tmp, params, inputs[0], "images", protected=inputs)
    return ToolResult(
        [final], {"images": len(inputs), "pages": pages, "bytes": final.stat().st_size}
    )


# ── Text / Markdown → PDF (C6) ────────────────────────────────────────────────────────────

TEXT_SUFFIXES = (".txt", ".md", ".markdown")
TEXT_MAX_BYTES = 20 * 1024 * 1024
TEXT_PAGE_SIZES: dict[str, tuple[float, float]] = {"a4": A4, "letter": LETTER}


def read_text_file(path: Path) -> str:
    """Decode a text file: BOM-marked UTF-8/UTF-16, else UTF-8, else Windows-1252."""
    data = path.read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", "replace")
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", "replace")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp1252", "replace")


def text_to_pdf(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Plain text (.txt) and Markdown (.md) → one PDF each, beside the source."""
    inputs = [Path(p) for p in require_str_list(params, "inputs", min_len=1, max_len=100)]
    for path in inputs:
        if path.suffix.lower() not in TEXT_SUFFIXES:
            raise EngineError(
                ErrorCode.INVALID_INPUT, f"{path.name} is not a text or Markdown file", str(path)
            )
        check_readable_file(path)
        if path.stat().st_size > TEXT_MAX_BYTES:
            raise EngineError(ErrorCode.UNSUPPORTED, f"{path.name} is larger than 20 MB", str(path))
    options = options_dict(params)
    family = option_choice(options, "font", tuple(FAMILIES), "helvetica")
    size = option_float(options, "size", 11.0, lo=6.0, hi=36.0)
    page_size = TEXT_PAGE_SIZES[option_choice(options, "page_size", ("a4", "letter"), "a4")]
    margin = {"narrow": 36.0, "normal": 72.0, "wide": 108.0}[
        option_choice(options, "margins", ("narrow", "normal", "wide"), "normal")
    ]
    styles = Styles(family, size)
    outputs: list[Path] = []
    pages = 0
    replaced = 0
    for n, source in enumerate(inputs):
        ctx.check_cancelled()
        ctx.progress(n * 95 / len(inputs), f"Typesetting {source.name}")
        counter = Counter()
        text = read_text_file(source)
        markdown = source.suffix.lower() in (".md", ".markdown")
        story = (
            markdown_flowables(text, styles, counter)
            if markdown
            else plain_text_flowables(text, styles, counter)
        ) or [Spacer(1, 1)]
        tmp = ctx.temp_dir / f"text_{n:03d}" / f"{sanitize_stem(source.stem)}.pdf"
        tmp.parent.mkdir(parents=True)
        doc = SimpleDocTemplate(
            str(tmp),
            pagesize=page_size,
            leftMargin=margin,
            rightMargin=margin,
            topMargin=margin,
            bottomMargin=margin,
            title=source.stem,
            creator="PDFForge",
        )
        doc.build(story)
        with Pdf.open(tmp) as pdf:
            pages += len(pdf.pages)
        replaced += counter.replaced
        outputs.append(deliver_converted(tmp, params, source, protected=inputs))
    ctx.progress(100, "Done")
    stats: dict[str, Any] = {"files": len(outputs), "pages": pages}
    if replaced:
        stats["replaced_characters"] = replaced
    return ToolResult(outputs, stats)


# ── HTML → PDF (C5) ───────────────────────────────────────────────────────────────────────

HTML_SUFFIXES = (".html", ".htm")


def html_to_pdf(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Local HTML files → PDF via the bundled LibreOffice (no scripts run, nothing is fetched
    from the internet; local pictures and style sheets are included)."""
    inputs = [Path(p) for p in require_str_list(params, "inputs", min_len=1, max_len=100)]
    for path in inputs:
        if path.suffix.lower() not in HTML_SUFFIXES:
            raise EngineError(
                ErrorCode.INVALID_INPUT, f"{path.name} is not an HTML file", str(path)
            )
        check_readable_file(path)
        if path.stat().st_size > TEXT_MAX_BYTES:
            raise EngineError(ErrorCode.UNSUPPORTED, f"{path.name} is larger than 20 MB", str(path))
    options = options_dict(params)
    page_size = option_choice(options, "page_size", tuple(html_prep.PAGE_SIZES), "a4")
    orientation = option_choice(options, "orientation", ("portrait", "landscape"), "portrait")
    margins = option_choice(options, "margins", tuple(html_prep.MARGINS), "normal")
    background = option_bool(options, "background", True)
    outputs: list[Path] = []
    pages = 0
    remote = 0
    missing = 0
    for n, source in enumerate(inputs):
        ctx.check_cancelled()
        ctx.progress(n * 95 / len(inputs), f"Converting {source.name}")
        prepared = html_prep.prepare(
            source,
            page_size=page_size,
            orientation=orientation,
            margins=margins,
            background=background,
        )
        remote += prepared.remote_skipped
        missing += prepared.missing
        work = ctx.temp_dir / f"html_{n:03d}"
        work.mkdir(parents=True)
        copy = work / "input.html"
        copy.write_bytes(prepared.html)
        produced = libreoffice.convert(
            copy, work, ctx, filter_name="writer_web_pdf_Export", shown=source
        )
        with Pdf.open(produced) as pdf:
            pages += len(pdf.pages)
        tmp = work / "result" / f"{sanitize_stem(source.stem)}.pdf"
        tmp.parent.mkdir()
        produced.replace(tmp)
        outputs.append(deliver_converted(tmp, params, source, protected=inputs))
    ctx.progress(100, "Done")
    stats: dict[str, Any] = {"files": len(outputs), "pages": pages}
    if remote:
        stats["remote_skipped"] = remote
    if missing:
        stats["missing_files"] = missing
    return ToolResult(outputs, stats)


def url_to_pdf(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Web page to PDF (D-043): the only tool that goes online, and only to the address the
    user typed (plus the page's own pictures and style sheets). The UI confirms first."""
    options = options_dict(params)
    url = option_str(options, "url", "", max_len=webfetch.MAX_URL_CHARS)
    page_size = option_choice(options, "page_size", tuple(html_prep.PAGE_SIZES), "a4")
    orientation = option_choice(options, "orientation", ("portrait", "landscape"), "portrait")
    margins = option_choice(options, "margins", tuple(html_prep.MARGINS), "normal")
    background = option_bool(options, "background", True)
    out_dir = optional_str(params, "output_dir")
    folder = Path(out_dir) if out_dir else Path.home() / "Downloads"
    if not folder.is_dir():
        raise EngineError(ErrorCode.INVALID_INPUT, f"The output folder {folder} does not exist")

    work = ctx.temp_dir / "web"
    fetched = webfetch.fetch_page(url, work, ctx, start=2, end=55)
    ctx.check_cancelled()
    ctx.progress(60, "Converting to PDF")
    prepared = html_prep.prepare(
        fetched.page,
        page_size=page_size,
        orientation=orientation,
        margins=margins,
        background=background,
    )
    copy = work / "input.html"
    copy.write_bytes(prepared.html)
    produced = libreoffice.convert(copy, work, ctx, filter_name="writer_web_pdf_Export")
    with Pdf.open(produced) as pdf:
        pages = len(pdf.pages)
    host = urlparse(fetched.final_url).hostname or "web page"
    name = sanitize_stem(fetched.title or host)
    final = commit(produced, folder / f"{name}.pdf")
    ctx.progress(100, "Done")
    stats: dict[str, Any] = {
        "pages": pages,
        "url": fetched.final_url,
        "downloaded_bytes": fetched.bytes,
        "resources": fetched.resources,
    }
    if fetched.failed:
        stats["resources_failed"] = fetched.failed
    return ToolResult([final], stats)
