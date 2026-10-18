"""Organize tools (docs/02_FEATURES.md §A): Merge, Rotate, Remove, Extract, Split, Organize.

All of them are lossless: pages are copied object-for-object by qpdf (utils/pagecopy.py), never
re-rendered. Rotation only changes /Rotate.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pikepdf import OutlineItem, Pdf

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils.atomic import commit
from utils.images import image_to_pdf_bytes
from utils.naming import resolve_output
from utils.pagecopy import PageCopier, write_outline
from utils.pageinfo import is_landscape, rotation, set_rotation
from utils.pdfio import deliver_pdf, open_pdf, save_pdf, single_pdf_input
from utils.ranges import parse_page_set
from utils.validation import (
    check_pdf,
    check_readable_file,
    is_image,
    option_bool,
    option_choice,
    option_str,
    optional_str,
    options_dict,
    passwords_map,
    require_str_list,
)

MERGE_MAX_INPUTS = 500


# ── A1 Merge ────────────────────────────────────────────────────────────────────────────────


def merge(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    inputs = [
        Path(p) for p in require_str_list(params, "inputs", min_len=2, max_len=MERGE_MAX_INPUTS)
    ]
    options = options_dict(params)
    keep_bookmarks = option_bool(options, "bookmarks", True)
    bookmark_per_file = option_bool(options, "bookmark_per_file", False)
    passwords = passwords_map(params)
    desired = resolve_output(
        optional_str(params, "output"), optional_str(params, "output_dir"), inputs[0], "merge"
    )
    if desired.suffix.lower() != ".pdf":
        raise EngineError(ErrorCode.INVALID_INPUT, "The output file must end in .pdf")

    for path in inputs:
        check_readable_file(path) if is_image(path) else check_pdf(path)

    total = len(inputs)
    tmp_out = ctx.temp_dir / "merged.pdf"
    out = Pdf.new()
    copier = PageCopier(out)
    opened: list[tuple[Path, Pdf, int]] = []  # (input, pdf, first output page)
    protected = 0
    try:
        for i, path in enumerate(inputs):
            ctx.check_cancelled()
            ctx.progress(i * 85 / total, f"Adding file {i + 1} of {total}")
            if is_image(path):
                converted = ctx.temp_dir / f"image_{i}.pdf"
                converted.write_bytes(image_to_pdf_bytes(path, ctx.temp_dir / f"img_{i}"))
                pdf = open_pdf(converted, passwords, source=path)
            else:
                pdf = open_pdf(path, passwords)
            protected += int(pdf.is_encrypted)  # password or permission restrictions
            opened.append((path, pdf, len(out.pages)))
            copier.add(pdf, range(len(pdf.pages)))

        ctx.check_cancelled()
        copier.finish()
        if keep_bookmarks or bookmark_per_file:
            ctx.progress(87, "Building bookmarks")
            items: list[OutlineItem] = []
            for path, pdf, first_page in opened:
                children = copier.outline_items(pdf) if keep_bookmarks else []
                if bookmark_per_file:
                    item = OutlineItem(path.stem, first_page)
                    item.children.extend(children)
                    items.append(item)
                else:
                    items.extend(children)
            write_outline(out, items)

        version = max((pdf.pdf_version for _, pdf, _ in opened), default="1.4")
        save_pdf(out, tmp_out, ctx, min_version=version)
        page_count = len(out.pages)
    finally:
        out.close()
        for _, pdf, _ in opened:
            pdf.close()

    ctx.check_cancelled()
    final = commit(tmp_out, desired, protected=inputs)
    ctx.progress(100, "Done")
    return ToolResult(
        outputs=[final],
        stats={
            "pages": page_count,
            "bytes": final.stat().st_size,
            "files": total,
            # The merged file is never encrypted; the UI warns when inputs were (decision 2026-10).
            "protected_inputs": protected,
        },
    )


# ── A6 Rotate ───────────────────────────────────────────────────────────────────────────────


def rotate(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Rotate all or selected pages by 90/180/270° — lossless, only /Rotate changes."""
    source = single_pdf_input(params)
    options = options_dict(params)
    angle = option_choice(options, "angle", (90, 180, 270), 90)
    pages_text = option_str(options, "pages", "all", max_len=2000)
    orientation = option_choice(options, "orientation", ("all", "portrait", "landscape"), "all")
    tmp = ctx.temp_dir / "rotated.pdf"

    with open_pdf(source, passwords_map(params)) as pdf:
        selected = parse_page_set(pages_text, len(pdf.pages))
        if orientation != "all":
            want_landscape = orientation == "landscape"
            selected = [i for i in selected if is_landscape(pdf.pages[i]) == want_landscape]
        if not selected:
            raise EngineError(
                ErrorCode.INVALID_INPUT, f"None of the selected pages are {orientation}"
            )
        for n, index in enumerate(selected):
            ctx.check_cancelled()
            page = pdf.pages[index]
            set_rotation(page, rotation(page) + angle)
            if n % 50 == 0:
                ctx.progress(n * 80 / len(selected), f"Rotating page {index + 1}")
        save_pdf(pdf, tmp, ctx, start=80, keep_encryption=True)
        page_count = len(pdf.pages)

    ctx.check_cancelled()
    final = deliver_pdf(tmp, params, source, "rotate", protected=[source])
    return ToolResult(
        [final], {"pages": page_count, "rotated": len(selected), "bytes": final.stat().st_size}
    )
