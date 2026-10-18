"""Edit tools (docs/02_FEATURES.md §E). Phase 1: Add page numbers (E2) and Add watermark (E3).

Both stamp an overlay (drawn with ReportLab) onto existing pages with pikepdf — page content is
not re-rendered, and the file keeps its password/permissions.
"""

from __future__ import annotations

import re
from typing import Any

from pikepdf import Pdf
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils.overlay import GRID_POSITIONS, anchor_point, frame_of, mirror
from utils.pdfio import deliver_pdf, open_pdf, save_pdf, single_pdf_input
from utils.ranges import parse_page_set
from utils.validation import (
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
