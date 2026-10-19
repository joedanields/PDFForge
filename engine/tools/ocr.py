"""OCR PDF (docs/02_FEATURES.md B3): make scanned pages searchable — AGPL-free (D-026).

No OCRmyPDF / Ghostscript. For each page that needs it:
1. PDFium renders the page at 300 dpi (as displayed: rotation and crop applied);
2. optional *auto-rotate*: Tesseract's orientation detection; the page's /Rotate is corrected
   (lossless) and the rendering turned to match;
3. optional *deskew* (scanned pages that are a single upright picture): the skew angle is
   measured from horizontal projection profiles and the picture itself is straightened;
4. Tesseract's text-only PDF renderer produces an invisible text layer the size of the
   displayed page, which pikepdf lays over the page exactly like a watermark (utils/overlay).
Pages already containing text are skipped unless "force" is set. Pages are recognised in
parallel (one single-threaded Tesseract per core, docs/05 P6).
"""

from __future__ import annotations

import io
import os
import zlib
from concurrent.futures import FIRST_EXCEPTION, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from pikepdf import Name, Pdf, PdfImage
from PIL import Image

from jobs import Cancelled, JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils import tesseract
from utils.pdfio import deliver_pdf, open_pdf, save_pdf
from utils.validation import (
    check_pdf,
    option_bool,
    options_dict,
    passwords_map,
    require_str_list,
)

OCR_MAX = 100
DPI = 300
MIN_SKEW, MAX_SKEW = 0.3, 5.0


@dataclass
class PageJob:
    index: int
    png: Path
    scan_image: pikepdf.Stream | None = None
    rotated: int = 0
    deskewed: float = 0.0


def _languages(options: dict[str, Any]) -> list[str]:
    raw = options.get("languages", "eng")
    if isinstance(raw, str):
        raw = [part for part in raw.replace(",", "+").split("+") if part.strip()]
    if not isinstance(raw, list) or not all(isinstance(x, str) for x in raw):
        raise EngineError(ErrorCode.INVALID_INPUT, "Invalid OCR languages")
    return tesseract.check_languages([x.strip() for x in raw][:6])


# ── page analysis ─────────────────────────────────────────────────────────────────────────


def _has_text(page: pdfium.PdfPage) -> bool:
    textpage = page.get_textpage()
    try:
        return bool(textpage.get_text_range().strip())
    finally:
        textpage.close()


def _single_scan_image(page: pdfium.PdfPage) -> tuple[float, float, float, float] | None:
    """Matrix of the page's only object if it is an upright picture covering the page."""
    objects = list(page.get_objects(max_depth=1))
    if len(objects) != 1 or objects[0].type != pdfium_c.FPDF_PAGEOBJ_IMAGE:
        return None
    matrix = objects[0].get_matrix().get()
    a, b, c, d = matrix[0], matrix[1], matrix[2], matrix[3]
    width, height = page.get_size()
    if b or c or a <= 0 or d <= 0 or a * d < 0.9 * width * height:
        return None
    return a, b, c, d


def _page_image_stream(pdf: Pdf, index: int) -> pikepdf.Stream | None:
    """The image XObject of a single-picture page, if it can be safely rewritten."""
    images = list(pdf.pages[index].get_images().values())
    if len(images) != 1:
        return None
    image = images[0]
    if not isinstance(image, pikepdf.Stream) or (
        image.get("/ImageMask")
        or "/SMask" in image
        or "/Mask" in image
        or "/Decode" in image
        or image.get("/ColorSpace") not in (Name.DeviceGray, Name.DeviceRGB)
        or int(image.get("/BitsPerComponent", 8)) not in (1, 8)
    ):
        return None
    return image


def skew_angle(img: Image.Image) -> float:
    """Degrees to rotate ``img`` counter-clockwise to make its text lines horizontal.

    Projection-profile method: the rotation that makes the row sums of the ink "spikiest"
    (highest variance) aligns the lines. Coarse 0.5° search, then 0.05° refinement.
    """
    small = img.convert("L")
    scale = 1000 / max(small.size)
    if scale < 1:
        small = small.resize((round(small.width * scale), round(small.height * scale)))
    ink = small.point(lambda v: 255 if v < 140 else 0)

    def score(angle: float) -> float:
        rotated = ink.rotate(angle, resample=Image.Resampling.BILINEAR, fillcolor=0)
        rows = rotated.resize((1, rotated.height), Image.Resampling.BOX).tobytes()
        mean = sum(rows) / len(rows)
        return float(sum((r - mean) ** 2 for r in rows))

    coarse: float = max((a / 2 for a in range(-10, 11)), key=score)
    best: float = max((coarse + a / 20 for a in range(-10, 11)), key=score)
    return best if MIN_SKEW <= abs(best) <= MAX_SKEW else 0.0


def deskew_stream(stream: pikepdf.Stream, angle: float) -> None:
    """Straighten a scanned picture in place (same size; corners filled with white)."""
    original = PdfImage(stream).as_pil_image()
    bilevel = original.mode == "1"
    work = original.convert("L" if bilevel or original.mode == "L" else "RGB")
    white: Any = 255 if work.mode == "L" else (255, 255, 255)
    turned = work.rotate(angle, resample=Image.Resampling.BICUBIC, fillcolor=white)
    if bilevel:
        packed = turned.point(lambda v: 255 if v >= 128 else 0).convert("1")
        stream.write(zlib.compress(packed.tobytes()), filter=Name.FlateDecode)
        stream.ColorSpace = Name.DeviceGray
        stream.BitsPerComponent = 1
    else:
        buffer = io.BytesIO()
        turned.save(buffer, "JPEG", quality=88)
        stream.write(buffer.getvalue(), filter=Name.DCTDecode)
        stream.ColorSpace = Name.DeviceGray if turned.mode == "L" else Name.DeviceRGB
        stream.BitsPerComponent = 8
    for key in ("/DecodeParms",):
        if key in stream:
            del stream[key]


# ── tool ──────────────────────────────────────────────────────────────────────────────────


def _run_parallel(
    jobs: list[PageJob], work: Any, ctx: JobContext, label: str, start: float, end: float
) -> list[Any]:
    """Run ``work(job)`` for each page on a thread pool (Tesseract runs out of process)."""
    if not jobs:
        return []
    workers = max(1, min(len(jobs), os.cpu_count() or 2, 8))
    results: list[Any] = [None] * len(jobs)
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures: dict[Future[Any], int] = {pool.submit(work, job): n for n, job in enumerate(jobs)}
        pending = set(futures)
        while pending:
            finished, pending = wait(pending, timeout=0.2, return_when=FIRST_EXCEPTION)
            for future in finished:
                results[futures[future]] = future.result()  # re-raises Cancelled / errors
                done += 1
                ctx.progress(
                    start + (end - start) * done / len(jobs), f"{label} {done} of {len(jobs)}"
                )
            if ctx.is_cancelled():
                for future in pending:
                    future.cancel()
                raise Cancelled
    return results


def _ocr_file(
    source: Path,
    params: dict[str, Any],
    options: dict[str, Any],
    langs: list[str],
    work: Path,
    ctx: JobContext,
) -> tuple[Path, dict[str, int]]:
    force = option_bool(options, "force", False)
    auto_rotate = option_bool(options, "auto_rotate", True)
    deskew = option_bool(options, "deskew", False)
    stats = {"pages": 0, "ocr_pages": 0, "skipped_pages": 0, "rotated": 0, "deskewed": 0}
    tmp = work / "ocr.pdf"
    with open_pdf(source, passwords_map(params)) as pdf:
        plain = work / "plain.pdf"
        pdf.save(plain)  # PDFium reads a decrypted copy
        stats["pages"] = len(pdf.pages)
        jobs: list[PageJob] = []
        rendered = pdfium.PdfDocument(str(plain))
        try:
            for index in range(len(rendered)):
                ctx.check_cancelled()
                ctx.progress(5 + 20 * index / max(1, len(rendered)), f"Reading page {index + 1}")
                page = rendered[index]
                try:
                    if not force and _has_text(page):
                        stats["skipped_pages"] += 1
                        continue
                    job = PageJob(index, work / f"p{index:05d}.png")
                    if deskew and _single_scan_image(page) is not None:
                        job.scan_image = _page_image_stream(pdf, index)
                    bitmap = page.render(scale=DPI / 72, grayscale=job.scan_image is None)
                    bitmap.to_pil().save(job.png)
                    bitmap.close()
                    jobs.append(job)
                finally:
                    page.close()
        finally:
            rendered.close()

        if auto_rotate:

            def detect(job: PageJob) -> int:
                return tesseract.detect_rotation(job.png, work / f"osd{job.index}", ctx)

            for job, rotation in zip(
                jobs, _run_parallel(jobs, detect, ctx, "Checking orientation", 25, 40), strict=True
            ):
                if rotation:
                    page = pdf.pages[job.index]
                    page.obj.Rotate = (int(page.obj.get("/Rotate", 0)) + rotation) % 360
                    with Image.open(job.png) as img:
                        img.rotate(-rotation, expand=True).save(job.png)
                    job.rotated = rotation
                    job.scan_image = None  # rotated pages are not deskewed
                    stats["rotated"] += 1

        for job in jobs:
            if job.scan_image is None:
                continue
            ctx.check_cancelled()
            with Image.open(job.png) as img:
                angle = skew_angle(img)
                if angle:
                    deskew_stream(job.scan_image, angle)
                    img.convert("L").rotate(angle, fillcolor=255).save(job.png)
                    job.deskewed = angle
                    stats["deskewed"] += 1

        def recognise(job: PageJob) -> Path:
            return tesseract.ocr_text_pdf(job.png, work / f"t{job.index:05d}", langs, DPI, ctx)

        layers = _run_parallel(jobs, recognise, ctx, "Recognising page", 40, 90)
        opened = []
        try:
            for job, layer in zip(jobs, layers, strict=True):
                text_pdf = Pdf.open(layer)
                opened.append(text_pdf)
                pdf.pages[job.index].add_overlay(text_pdf.pages[0], None)
            stats["ocr_pages"] = len(jobs)
            save_pdf(pdf, tmp, ctx, start=90, end=99, keep_encryption=True)
        finally:
            for text_pdf in opened:
                text_pdf.close()
    return tmp, stats


def ocr(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    inputs = [Path(p) for p in require_str_list(params, "inputs", min_len=1, max_len=OCR_MAX)]
    for path in inputs:
        check_pdf(path)
    options = options_dict(params)
    langs = _languages(options)
    outputs: list[Path] = []
    totals: dict[str, int] = {}
    for n, source in enumerate(inputs):
        ctx.check_cancelled()
        work = ctx.temp_dir / f"ocr_{n:03d}"
        work.mkdir(parents=True)
        tmp, stats = _ocr_file(source, params, options, langs, work, ctx)
        for key, value in stats.items():
            totals[key] = totals.get(key, 0) + value
        if stats["ocr_pages"] == 0:
            continue  # already searchable: no copy that adds nothing
        outputs.append(deliver_pdf(tmp, params, source, "ocr", protected=inputs))
    ctx.progress(100, "Done")
    result: dict[str, Any] = {"files": len(outputs), "languages": "+".join(langs), **totals}
    if not outputs:
        result["no_output_reason"] = (
            "Every page already contains text, so no new file was created. "
            "Turn on “Recognise pages that already have text” to OCR them anyway."
        )
    return ToolResult(outputs, result)
