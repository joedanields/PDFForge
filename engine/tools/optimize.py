"""Optimize tools (docs/02_FEATURES.md §B): Compress (B1) and Repair (B2).

AGPL-free by decision (docs/09 §3): pikepdf + Pillow instead of Ghostscript.

What Compress does:
- finds how large each image is drawn (utils/placement.py) and downsamples it to the level's
  DPI, then re-encodes it as JPEG at the level's quality (optionally in grayscale);
- leaves alone what would be damaged or not shrink: line art / screenshots with few colours,
  CMYK and special colour spaces, stencil masks, 1-bit / JBIG2 / CCITT images, images with a
  /Decode array; an image is only replaced if the new data is clearly smaller;
- optionally strips document metadata, removes unused resources and objects, recompresses
  streams and packs objects into object streams;
- if the result is not smaller than the original, keeps the original and creates no file.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
from pikepdf import Name, ObjectStreamMode, Pdf, PdfImage
from PIL import Image
from pypdf import PdfReader, PdfWriter

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils.pdfio import deliver_pdf, open_pdf, save_pdf, single_pdf_input
from utils.placement import image_display_sizes
from utils.validation import (
    check_readable_file,
    option_bool,
    option_choice,
    option_int,
    options_dict,
    passwords_map,
    require_str_list,
)


@dataclass(frozen=True)
class Level:
    dpi: int
    quality: int


LEVELS = {
    "extreme": Level(72, 40),
    "recommended": Level(150, 60),
    "low": Level(300, 80),
}
DOWNSAMPLE_SLACK = 1.15  # only downsample when the image has >15% more pixels than needed
MIN_GAIN = 0.9  # replace an image only if the new data is at most 90% of the old
FEW_COLOURS = 256  # images with this few colours are line art / screenshots: keep lossless
SKIP_FILTERS = {"/JBIG2Decode", "/CCITTFaxDecode", "/JPXDecode"}
SUPPORTED_SPACES = {"/DeviceRGB", "/DeviceGray"}


def _filters(obj: pikepdf.Stream) -> list[str]:
    value = obj.get("/Filter")
    if isinstance(value, pikepdf.Array):
        return [str(v) for v in value]
    return [str(value)] if value is not None else []


def _colour_space(obj: pikepdf.Stream) -> str | None:
    """'/DeviceRGB' or '/DeviceGray' (ICC-based with 3 or 1 components counts), else None."""
    space = obj.get("/ColorSpace")
    if isinstance(space, Name):
        name = str(space)
        return name if name in SUPPORTED_SPACES else None
    if isinstance(space, pikepdf.Array) and len(space) == 2 and space[0] == Name.ICCBased:
        n = space[1].get("/N")
        return {3: "/DeviceRGB", 1: "/DeviceGray"}.get(int(n) if n is not None else 0)
    return None


def _few_colours(img: Image.Image) -> bool:
    sample = img.convert("RGB")
    sample.thumbnail((128, 128))
    return sample.getcolors(FEW_COLOURS) is not None


def _recompress(
    obj: pikepdf.Stream, drawn: tuple[float, float], level: Level, grayscale: bool
) -> bool:
    """Downsample/re-encode one image in place. Returns True if it was replaced."""
    if obj.get("/ImageMask") or "/Decode" in obj or "/Mask" in obj:
        return False
    if int(obj.get("/BitsPerComponent", 8)) != 8:
        return False
    filters = _filters(obj)
    if SKIP_FILTERS.intersection(filters):
        return False
    space = _colour_space(obj)
    if space is None:
        return False
    try:
        img = PdfImage(obj).as_pil_image()
    except Exception:  # unsupported encoding: leave it as it is
        return False

    target_w = max(1, round(drawn[0] / 72 * level.dpi))
    target_h = max(1, round(drawn[1] / 72 * level.dpi))
    width, height = img.size
    downsample = width * height > target_w * target_h * DOWNSAMPLE_SLACK**2
    is_jpeg = filters == ["/DCTDecode"]
    if not downsample and not grayscale and is_jpeg:
        return False  # already JPEG at a sensible resolution: re-encoding would only lose
    if not is_jpeg and _few_colours(img):
        return False  # line art / screenshot: JPEG would add artefacts

    if downsample:
        # The larger ratio keeps *both* axes at or above the target DPI (images are often drawn
        # slightly stretched, so the two axes need different scale factors).
        ratio = max(target_w / width, target_h / height)
        img = img.resize(
            (max(1, round(width * ratio)), max(1, round(height * ratio))), Image.Resampling.LANCZOS
        )
    gray = grayscale or space == "/DeviceGray"
    img = img.convert("L" if gray else "RGB")
    buffer = io.BytesIO()
    img.save(buffer, "JPEG", quality=level.quality, optimize=True)
    data = buffer.getvalue()
    if len(data) > len(obj.read_raw_bytes()) * MIN_GAIN:
        return False

    obj.write(data, filter=Name.DCTDecode)
    obj.Width, obj.Height = img.size
    obj.ColorSpace = Name.DeviceGray if gray else Name.DeviceRGB
    obj.BitsPerComponent = 8
    for key in ("/DecodeParms", "/Interpolate"):
        if key in obj:
            del obj[key]
    return True


def compress(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    source = single_pdf_input(params)
    options = options_dict(params)
    level_name = option_choice(options, "level", (*LEVELS, "custom"), "recommended")
    if level_name == "custom":
        level = Level(
            option_int(options, "dpi", 150, lo=36, hi=600),
            option_int(options, "quality", 60, lo=10, hi=95),
        )
        grayscale = option_bool(options, "grayscale", False)
        strip_metadata = option_bool(options, "remove_metadata", False)
    else:
        level = LEVELS[level_name]
        grayscale = False
        strip_metadata = False

    original_bytes = source.stat().st_size
    tmp = ctx.temp_dir / "compressed.pdf"
    with open_pdf(source, passwords_map(params)) as pdf:
        ctx.progress(2, "Measuring images")
        drawn = image_display_sizes(pdf)
        images = [
            obj
            for obj in pdf.objects
            if isinstance(obj, pikepdf.Stream) and obj.get("/Subtype") == Name.Image
        ]
        replaced = 0
        for n, obj in enumerate(images):
            ctx.check_cancelled()
            ctx.progress(5 + n * 75 / max(len(images), 1), f"Image {n + 1} of {len(images)}")
            size = drawn.get(obj.objgen)
            if size is None:
                continue  # not drawn anywhere: dropped below if unreferenced
            if _recompress(obj, size, level, grayscale):
                replaced += 1

        if strip_metadata:
            for key in list(pdf.docinfo.keys()):
                del pdf.docinfo[key]
            if "/Metadata" in pdf.Root:
                del pdf.Root["/Metadata"]
        ctx.progress(80, "Removing unused objects")
        pdf.remove_unreferenced_resources()
        save_pdf(
            pdf,
            tmp,
            ctx,
            start=82,
            message="Saving",
            keep_encryption=True,
            compress_streams=True,
            recompress_flate=True,
            object_stream_mode=ObjectStreamMode.generate,
        )

    new_bytes = tmp.stat().st_size
    stats: dict[str, Any] = {
        "original_bytes": original_bytes,
        "images": len(images),
        "images_recompressed": replaced,
        "level": level_name,
    }
    if new_bytes >= original_bytes:
        # docs/02 B1: never hand back a bigger file — keep the original and say so.
        tmp.unlink(missing_ok=True)
        return ToolResult([], {**stats, "bytes": original_bytes, "kept_original": True})
    ctx.check_cancelled()
    final = deliver_pdf(tmp, params, source, "compressed", protected=[source])
    saved = round((1 - new_bytes / original_bytes) * 100, 1)
    return ToolResult([final], {**stats, "bytes": new_bytes, "saved_percent": saved})


# ── Repair (B2) ───────────────────────────────────────────────────────────────────────────

REPAIR_MAX = 100
_PAGE_OBJECT = re.compile(rb"/Type\s*/Page(?![a-zA-Z])")
_COUNT = re.compile(rb"/Type\s*/Pages\b[^>]*?/Count\s+(\d+)|/Count\s+(\d+)[^>]*?/Type\s*/Pages\b")


def expected_pages(data: bytes) -> int | None:
    """How many pages the damaged file says it has: the largest page-tree /Count, else the
    number of page objects. Heuristic: the file is broken, after all."""
    counts = [int(a or b) for a, b in _COUNT.findall(data)]
    if counts:
        return max(counts)
    objects = len(_PAGE_OBJECT.findall(data))
    return objects or None


def _healthy_pages(path: Path, ctx: JobContext) -> list[int]:
    """Indexes of pages PDFium can load and render (a tiny render: the content must parse)."""
    healthy = []
    try:
        doc = pdfium.PdfDocument(str(path))
    except pdfium.PdfiumError:
        return []
    try:
        for index in range(len(doc)):
            ctx.check_cancelled()
            try:
                page = doc[index]
                try:
                    page.render(scale=0.05).close()
                finally:
                    page.close()
                healthy.append(index)
            except pdfium.PdfiumError:
                continue
    finally:
        doc.close()
    return healthy


def _has_content(page: pikepdf.Page) -> bool:
    """False when the page's content was lost (qpdf replaces missing objects with null):
    such a page would come out blank, so it does not count as recovered."""
    contents = page.obj.get("/Contents")
    if contents is None:
        return False
    streams = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
    try:
        return any(isinstance(s, pikepdf.Stream) and len(s.read_bytes()) > 0 for s in streams)
    except pikepdf.PdfError:
        return False


def _rebuild_with_qpdf(source: Path, password: str, dest: Path, ctx: JobContext) -> bool:
    """qpdf (via pikepdf) reconstructs the xref table and trailer while opening."""
    try:
        with Pdf.open(source, password=password, attempt_recovery=True) as pdf:
            if len(pdf.pages) == 0:
                return False
            save_pdf(pdf, dest, ctx, start=40, end=60, message="Rebuilding", keep_encryption=True)
        return True
    except pikepdf.PasswordError:
        raise
    except (pikepdf.PdfError, RuntimeError, ValueError):
        return False


def _salvage_with_pypdf(source: Path, password: str, dest: Path) -> bool:
    """Fallback: pypdf's lenient parser, page by page, skipping pages it cannot copy."""
    try:
        reader = PdfReader(str(source), strict=False)
        if reader.is_encrypted:
            reader.decrypt(password)
        writer = PdfWriter()
        for page in reader.pages:
            try:
                writer.add_page(page)
            except Exception:  # a broken page is simply skipped
                continue
        if not writer.pages:
            return False
        with dest.open("wb") as fh:
            writer.write(fh)
        return True
    except Exception:  # pypdf raises many types on garbage
        return False


def _had_problems(source: Path, password: str) -> bool:
    """Did qpdf have to fix anything (warnings while opening, or structural check errors)?"""
    try:
        with Pdf.open(source, password=password) as pdf:
            return bool(pdf.check_pdf_syntax() or pdf.get_warnings())
    except pikepdf.PasswordError:
        return False
    except (pikepdf.PdfError, RuntimeError, ValueError):
        return True


def _password_error(source: Path, password: str) -> EngineError:
    if password:
        return EngineError(
            ErrorCode.WRONG_PASSWORD, f"The password for {source.name} is incorrect", str(source)
        )
    return EngineError(
        ErrorCode.PASSWORD_REQUIRED, f"{source.name} is password protected", str(source)
    )


def _repair_one(
    source: Path, password: str, work: Path, ctx: JobContext, span: tuple[float, float]
) -> tuple[Path, dict[str, Any]]:
    start, width = span
    expected = expected_pages(source.read_bytes())
    problems = _had_problems(source, password)
    rebuilt = work / "rebuilt.pdf"
    method = "qpdf"
    try:
        ok = _rebuild_with_qpdf(source, password, rebuilt, ctx)
    except pikepdf.PasswordError as exc:
        raise _password_error(source, password) from exc
    if not ok:
        method = "pypdf"
        ok = _salvage_with_pypdf(source, password, rebuilt)
    if not ok:
        raise EngineError(
            ErrorCode.CORRUPT_FILE,
            f"{source.name} could not be repaired: no readable pages were found",
            str(source),
        )
    ctx.check_cancelled()
    ctx.progress(start + 0.7 * width, f"Verifying pages of {source.name}")
    final = work / "repaired.pdf"
    with Pdf.open(rebuilt, password=password) as pdf:
        total = len(pdf.pages)
        rendered = list(range(total)) if pdf.is_encrypted else _healthy_pages(rebuilt, ctx)
        healthy = [i for i in rendered if _has_content(pdf.pages[i])]
        if not healthy:
            raise EngineError(
                ErrorCode.CORRUPT_FILE,
                f"{source.name} could not be repaired: no page could be displayed",
                str(source),
            )
        keep = set(healthy)
        for index in reversed(range(total)):
            if index not in keep:
                del pdf.pages[index]
        save_pdf(pdf, final, ctx, start=start + 0.8 * width, end=start + width)
        if pdf.is_encrypted:
            final.unlink()
            save_pdf(pdf, final, ctx, start=start + 0.8 * width, keep_encryption=True)
    recovered = len(healthy)
    expected = max(expected or recovered, total)
    if recovered < expected:
        status = "partial"
    elif problems or method != "qpdf":
        status = "repaired"
    else:
        status = "no_problems"
    return final, {"status": status, "pages": recovered, "expected_pages": expected}


def repair(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Rebuild damaged PDFs: xref/trailer reconstruction (qpdf), pypdf salvage as a fallback,
    and only pages that actually load are kept. Each file reports repaired / partial (N of M
    pages) / no_problems; a file with nothing usable raises CORRUPT_FILE."""
    inputs = [Path(p) for p in require_str_list(params, "inputs", min_len=1, max_len=REPAIR_MAX)]
    for path in inputs:
        check_readable_file(path)
        if path.suffix.lower() != ".pdf":
            raise EngineError(ErrorCode.INVALID_INPUT, f"{path.name} is not a PDF file", str(path))
    passwords = passwords_map(params)
    outputs: list[Path] = []
    reports: list[dict[str, Any]] = []
    for n, source in enumerate(inputs):
        ctx.check_cancelled()
        width = 100 / len(inputs)
        ctx.progress(n * width, f"Checking {source.name}")
        work = ctx.temp_dir / f"repair_{n:03d}"
        work.mkdir(parents=True)
        tmp, report = _repair_one(
            source, passwords.get(str(source), ""), work, ctx, (n * width, width)
        )
        reports.append({"file": source.name, **report})
        outputs.append(deliver_pdf(tmp, params, source, "repaired", protected=inputs))
    ctx.progress(100, "Done")
    stats: dict[str, Any] = {"files": len(outputs), "reports": reports}
    if len(reports) == 1:
        stats.update({k: v for k, v in reports[0].items() if k != "file"})
    return ToolResult(outputs, stats)
