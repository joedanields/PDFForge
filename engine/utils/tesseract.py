"""Tesseract OCR (bundled, Apache-2.0) — used by OCR PDF (B3) and PDF → Word's OCR mode.

Language models: the bundled ``vendor/tesseract/tessdata`` (eng, osd, tam, hin) plus any
``.traineddata`` the user added in Settings (``%APPDATA%\\PDFForge\\tessdata``). Tesseract
reads models from a single folder, so when a user language is requested the job assembles
one in its temp folder (hard links where possible).
"""

from __future__ import annotations

import csv
import io
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from jobs import JobContext
from protocol import EngineError, ErrorCode
from utils.process import run_helper
from utils.vendor import bundled_tessdata, require, tesseract_path

DEFAULT_TIMEOUT_S = 5 * 60
_LANG_RE = re.compile(r"^[A-Za-z0-9_]{2,40}$")


def user_tessdata() -> Path:
    override = os.environ.get("PDFFORGE_USER_TESSDATA")
    if override:
        return Path(override)
    return Path(os.environ.get("APPDATA", str(Path.home()))) / "PDFForge" / "tessdata"


def available_languages() -> dict[str, Path]:
    """Language code -> model file; bundled models win over user copies with the same name."""
    found: dict[str, Path] = {}
    for folder in (user_tessdata(), bundled_tessdata()):
        if folder.is_dir():
            for model in folder.glob("*.traineddata"):
                if model.stem != "osd":
                    found[model.stem] = model
    return found


def check_languages(langs: list[str]) -> list[str]:
    if not langs:
        raise EngineError(ErrorCode.INVALID_INPUT, "Choose at least one OCR language")
    available = available_languages()
    for lang in langs:
        if not _LANG_RE.match(lang) or lang not in available:
            raise EngineError(
                ErrorCode.UNSUPPORTED,
                f"The OCR language '{lang}' is not installed. Add it in Settings → OCR languages.",
            )
    return langs


def _tessdata_for(langs: list[str], ctx: JobContext) -> Path:
    bundled = bundled_tessdata()
    if all((bundled / f"{lang}.traineddata").is_file() for lang in langs):
        return bundled
    folder = ctx.temp_dir / "tessdata"
    if folder.is_dir():
        return folder
    folder.mkdir(parents=True)
    available = available_languages()
    for name in ("pdf.ttf", "osd.traineddata"):
        if (bundled / name).is_file():
            _link_or_copy(bundled / name, folder / name)
    if (bundled / "configs").is_dir():
        shutil.copytree(bundled / "configs", folder / "configs")
    for lang in langs:
        _link_or_copy(available[lang], folder / f"{lang}.traineddata")
    return folder


def _link_or_copy(src: Path, dest: Path) -> None:
    try:
        os.link(src, dest)
    except OSError:
        shutil.copyfile(src, dest)


def _run(image: Path, out_base: Path, langs: list[str], ctx: JobContext, extra: list[str]) -> None:
    exe = require(tesseract_path(), "Tesseract OCR")
    tessdata = _tessdata_for(langs, ctx)
    args: list[str | Path] = [
        exe,
        image,
        out_base,
        "--tessdata-dir",
        tessdata,
        "-l",
        "+".join(langs),
        *extra,
    ]
    # One thread per Tesseract process: pages are OCR'd in parallel instead (05 P6).
    result = run_helper(
        args,
        ctx,
        timeout_s=DEFAULT_TIMEOUT_S,
        what="OCR",
        env={"OMP_THREAD_LIMIT": "1"},
        cwd=out_base.parent,
    )
    if result.returncode != 0:
        raise EngineError(
            ErrorCode.INTERNAL, f"OCR failed: {result.stderr.strip()[-300:] or 'unknown error'}"
        )


def ocr_text_pdf(image: Path, out_base: Path, langs: list[str], dpi: int, ctx: JobContext) -> Path:
    """Invisible-text-only PDF of ``image`` (page size = image size at ``dpi``)."""
    _run(image, out_base, langs, ctx, ["--dpi", str(dpi), "-c", "textonly_pdf=1", "pdf"])
    produced = out_base.with_suffix(".pdf")
    if not produced.is_file():
        raise EngineError(ErrorCode.INTERNAL, "OCR produced no result")
    return produced


@dataclass(frozen=True)
class OcrWord:
    text: str
    left: int
    top: int
    width: int
    height: int
    conf: float
    block: int
    par: int
    line: int


def ocr_words(
    image: Path, out_base: Path, langs: list[str], dpi: int, ctx: JobContext
) -> list[OcrWord]:
    """Recognised words with pixel boxes (Tesseract TSV output)."""
    _run(image, out_base, langs, ctx, ["--dpi", str(dpi), "tsv"])
    tsv = out_base.with_suffix(".tsv")
    words: list[OcrWord] = []
    reader = csv.DictReader(
        io.StringIO(tsv.read_text(encoding="utf-8", errors="replace")),
        delimiter="\t",
        quoting=csv.QUOTE_NONE,
    )
    for row in reader:
        text = (row.get("text") or "").strip()
        if row.get("level") != "5" or not text:
            continue
        words.append(
            OcrWord(
                text,
                int(row["left"]),
                int(row["top"]),
                int(row["width"]),
                int(row["height"]),
                float(row["conf"]),
                int(row["block_num"]),
                int(row["par_num"]),
                int(row["line_num"]),
            )
        )
    return words


def detect_rotation(image: Path, out_base: Path, ctx: JobContext) -> int:
    """Clockwise rotation (0/90/180/270) that makes the page upright, via Tesseract OSD.

    Returns 0 when there is too little text to decide.
    """
    exe = require(tesseract_path(), "Tesseract OCR")
    result = run_helper(
        [exe, image, "stdout", "--tessdata-dir", bundled_tessdata(), "--psm", "0"],
        ctx,
        timeout_s=DEFAULT_TIMEOUT_S,
        what="OCR",
        env={"OMP_THREAD_LIMIT": "1"},
        cwd=out_base.parent,
    )
    match = re.search(r"Rotate:\s*(\d+)", result.stdout)
    confidence = re.search(r"Orientation confidence:\s*([\d.]+)", result.stdout)
    if result.returncode != 0 or not match or not confidence or float(confidence.group(1)) < 2:
        return 0
    return int(match.group(1)) % 360
