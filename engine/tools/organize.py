"""Organize tools (docs/02_FEATURES.md §A): Merge, Rotate, Remove, Extract, Split, Organize.

All of them are lossless: pages are copied object-for-object by qpdf (utils/pagecopy.py), never
re-rendered. Rotation only changes /Rotate.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pikepdf
from pikepdf import Dictionary, Name, ObjectStreamMode, OutlineItem, Pdf

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils.atomic import commit
from utils.images import image_to_pdf_bytes
from utils.naming import resolve_output, sanitize_stem
from utils.pagecopy import PageCopier, copy_document_info, dest_lookup, write_outline
from utils.pageinfo import is_landscape, rotation, set_rotation
from utils.pdfio import deliver_many, deliver_pdf, open_pdf, save_pdf, single_pdf_input
from utils.ranges import parse_page_set, parse_ranges
from utils.validation import (
    check_pdf,
    check_readable_file,
    is_image,
    option_bool,
    option_choice,
    option_float,
    option_int,
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


# ── A3 Remove pages ─────────────────────────────────────────────────────────────────────────


def _rebuild(src: Pdf, keep: list[int]) -> Pdf:
    """New document with only ``keep`` (0-based, in order) — bookmarks and links re-pointed,
    those aimed at dropped pages removed, so dropped pages are truly gone from the file."""
    out = Pdf.new()
    copier = PageCopier(out)
    copier.add(src, keep)
    copier.finish()
    write_outline(out, copier.outline_items(src))
    copy_document_info(src, out)
    return out


def remove_pages(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    source = single_pdf_input(params)
    pages_text = option_str(options_dict(params), "pages", "", max_len=2000)
    if not pages_text.strip():
        raise EngineError(ErrorCode.INVALID_INPUT, "Select the pages to remove")
    tmp = ctx.temp_dir / "removed.pdf"

    with open_pdf(source, passwords_map(params)) as src:
        total = len(src.pages)
        remove = set(parse_page_set(pages_text, total))
        keep = [i for i in range(total) if i not in remove]
        if not keep:
            raise EngineError(
                ErrorCode.INVALID_INPUT, "You can't remove every page — keep at least one"
            )
        ctx.progress(10, f"Removing {len(remove)} pages")
        ctx.check_cancelled()
        out = _rebuild(src, keep)
        try:
            save_pdf(out, tmp, ctx, start=40, min_version=src.pdf_version)
        finally:
            out.close()
        protected = int(src.is_encrypted)

    ctx.check_cancelled()
    final = deliver_pdf(tmp, params, source, "remove", protected=[source])
    return ToolResult(
        [final],
        {
            "pages": len(keep),
            "removed": len(remove),
            "bytes": final.stat().st_size,
            "protected_inputs": protected,
        },
    )


# ── A4 Extract pages ────────────────────────────────────────────────────────────────────────


def extract_pages(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Selected pages → one new PDF, or one PDF per page (in a new folder, optionally zipped)."""
    source = single_pdf_input(params)
    options = options_dict(params)
    pages_text = option_str(options, "pages", "", max_len=2000)
    if not pages_text.strip():
        raise EngineError(ErrorCode.INVALID_INPUT, "Select the pages to extract")
    mode = option_choice(options, "mode", ("single", "separate"), "single")
    stem = sanitize_stem(source.stem)

    with open_pdf(source, passwords_map(params)) as src:
        selected = parse_page_set(pages_text, len(src.pages))
        protected = int(src.is_encrypted)
        version = src.pdf_version
        files: list[Path] = []
        if mode == "single":
            ctx.progress(10, f"Extracting {len(selected)} pages")
            out = _rebuild(src, selected)
            try:
                tmp = ctx.temp_dir / "extracted.pdf"
                save_pdf(out, tmp, ctx, start=40, min_version=version)
            finally:
                out.close()
        else:
            for n, index in enumerate(selected):
                ctx.check_cancelled()
                ctx.progress(n * 95 / len(selected), f"Page {index + 1}")
                out = _rebuild(src, [index])
                try:
                    path = ctx.temp_dir / f"{stem}_page-{index + 1}.pdf"
                    out.save(path, min_version=version)
                finally:
                    out.close()
                files.append(path)

    ctx.check_cancelled()
    if mode == "single":
        final = deliver_pdf(tmp, params, source, "extract", protected=[source])
        outputs, extra = [final], {"bytes": final.stat().st_size}
    else:
        outputs, extra = deliver_many(files, params, source, "extract", ctx, protected=[source])
    return ToolResult(
        outputs,
        {"pages": len(selected), "files": len(files) or 1, **extra, "protected_inputs": protected},
    )


# ── A2 Split ────────────────────────────────────────────────────────────────────────────────

SPLIT_MODES = ("ranges", "fixed", "all", "size", "bookmarks")


@dataclass
class _Chunk:
    pages: list[int]  # 0-based, in output order
    name: str  # file name part after the document stem


def split(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Split by ranges, every N pages, one file per page, file size or top-level bookmarks."""
    source = single_pdf_input(params)
    options = options_dict(params)
    mode = option_choice(options, "mode", SPLIT_MODES, "ranges")
    stem = sanitize_stem(source.stem)

    with open_pdf(source, passwords_map(params)) as src:
        total = len(src.pages)
        protected = int(src.is_encrypted)
        version = src.pdf_version
        oversized = 0
        if mode == "ranges":
            text = option_str(options, "ranges", "", max_len=5000)
            if not text.strip():
                raise EngineError(ErrorCode.INVALID_INPUT, "Enter the page ranges to split out")
            ranges = parse_ranges(text, total)
            if option_bool(options, "merge_ranges", False):
                pages = [p - 1 for r in ranges for p in r.pages()]
                out = _rebuild(src, pages)
                try:
                    tmp = ctx.temp_dir / "split.pdf"
                    save_pdf(out, tmp, ctx, start=20, min_version=version)
                finally:
                    out.close()
                final = deliver_pdf(tmp, params, source, "split", protected=[source])
                stats = {"pages": len(pages), "files": 1, "ranges": len(ranges)}
                return ToolResult([final], {**stats, "protected_inputs": protected})
            chunks = [_Chunk([p - 1 for p in r.pages()], r.label()) for r in ranges]
        elif mode == "fixed":
            every = option_int(options, "every", 1, lo=1, hi=100_000)
            chunks = [
                _Chunk(list(range(a, min(a + every, total))), f"{a + 1}-{min(a + every, total)}")
                for a in range(0, total, every)
            ]
        elif mode == "all":
            chunks = [_Chunk([i], f"page-{i + 1}") for i in range(total)]
        elif mode == "bookmarks":
            chunks = _bookmark_chunks(src)
        else:
            max_mb = option_float(options, "max_mb", 5.0, lo=0.05, hi=100_000)
            chunks, oversized = _size_chunks(src, int(max_mb * 1024 * 1024), ctx)

        files: list[Path] = []
        for n, chunk in enumerate(chunks):
            ctx.check_cancelled()
            ctx.progress(30 + n * 65 / len(chunks), f"Writing file {n + 1} of {len(chunks)}")
            out = _rebuild(src, chunk.pages)
            try:
                path = ctx.temp_dir / f"{stem}_{sanitize_stem(chunk.name)}.pdf"
                if path in files:  # e.g. the same range typed twice
                    path = path.with_name(f"{path.stem} ({n + 1}).pdf")
                out.save(path, min_version=version, object_stream_mode=ObjectStreamMode.generate)
            finally:
                out.close()
            files.append(path)

    outputs, extra = deliver_many(files, params, source, "split", ctx, protected=[source])
    result: dict[str, Any] = {"pages": total, "files": len(files), **extra}
    result["protected_inputs"] = protected
    if oversized:
        result["oversized_pages"] = oversized
    return ToolResult(outputs, result)


def _bookmark_chunks(src: Pdf) -> list[_Chunk]:
    """One file per top-level bookmark; pages before the first bookmark join the first file."""
    try:
        items = list(src.open_outline().root)
    except pikepdf.OutlineStructureError:
        items = []
    lookup = dest_lookup(src)
    index_of = {page.obj.objgen: n for n, page in enumerate(src.pages)}
    starts: list[tuple[int, str]] = []
    for item in items:
        dest: Any = item.destination
        action = item.action
        if dest is None and isinstance(action, Dictionary) and action.get("/S") == Name.GoTo:
            dest = action.get("/D")
        resolved = lookup(dest) if dest is not None else None
        if resolved is None:
            continue
        target = resolved[0]
        page = index_of.get(target.objgen) if isinstance(target, Dictionary) else None
        if page is not None and all(page != s for s, _ in starts):
            starts.append((page, item.title))
    if not starts:
        raise EngineError(ErrorCode.INVALID_INPUT, "This PDF has no bookmarks to split by")
    starts.sort()
    total = len(src.pages)
    chunks: list[_Chunk] = []
    for n, (start, title) in enumerate(starts):
        first = 0 if n == 0 else start
        end = starts[n + 1][0] if n + 1 < len(starts) else total
        chunks.append(_Chunk(list(range(first, end)), f"{n + 1:02d} {title}"))
    return chunks


def _saved_size(src: Pdf, pages: list[int]) -> int:
    out = _rebuild(src, pages)
    try:
        buffer = io.BytesIO()
        out.save(buffer, object_stream_mode=ObjectStreamMode.generate)
        return buffer.tell()
    finally:
        out.close()


def _size_chunks(src: Pdf, limit: int, ctx: JobContext) -> tuple[list[_Chunk], int]:
    """Greedy chunks of at most ``limit`` bytes.

    Each page is measured on its own; a chunk's real size is at most the sum of its pages'
    sizes (shared fonts and images are stored once), so the grouping does not overshoot. Saved
    chunks are still checked, and a page that alone exceeds the limit gets its own file
    (reported as oversized).
    """
    total = len(src.pages)
    sizes: list[int] = []
    for i in range(total):
        ctx.check_cancelled()
        if i % 20 == 0:
            ctx.progress(i * 25 / total, f"Measuring page {i + 1} of {total}")
        sizes.append(_saved_size(src, [i]))

    groups: list[list[int]] = []
    current: list[int] = []
    current_size = 0
    for i, size in enumerate(sizes):
        if current and current_size + size > limit:
            groups.append(current)
            current, current_size = [], 0
        current.append(i)
        current_size += size
    if current:
        groups.append(current)

    verified: list[list[int]] = []
    pending = groups
    while pending:
        group = pending.pop(0)
        if len(group) > 1 and _saved_size(src, group) > limit:
            half = len(group) // 2
            pending[:0] = [group[:half], group[half:]]
        else:
            verified.append(group)
    oversized = sum(1 for g in verified if len(g) == 1 and sizes[g[0]] > limit)
    return [_Chunk(g, f"part-{n + 1}") for n, g in enumerate(verified)], oversized


# ── A5 Organize ─────────────────────────────────────────────────────────────────────────────

ORGANIZE_MAX_INPUTS = 50
ORGANIZE_MAX_PAGES = 20_000
_MAX_BLANK_SIDE = 14_400.0  # PDF user-unit limit, in points


@dataclass
class _PlanEntry:
    source: int | None  # input index, None for a blank page
    page: int  # 0-based page in that input
    rotate: int  # extra clockwise rotation
    size: tuple[float, float] = (595.28, 841.89)  # blank page size (A4)


def _organize_plan(options: dict[str, Any], inputs: int) -> list[_PlanEntry]:
    raw = options.get("pages")
    if not isinstance(raw, list) or not raw:
        raise EngineError(ErrorCode.INVALID_INPUT, "Add at least one page")
    if len(raw) > ORGANIZE_MAX_PAGES:
        raise EngineError(ErrorCode.INVALID_INPUT, f"At most {ORGANIZE_MAX_PAGES} pages")
    plan: list[_PlanEntry] = []
    for n, item in enumerate(raw):
        if not isinstance(item, dict):
            raise EngineError(ErrorCode.INVALID_INPUT, f"Page entry {n + 1} is not valid")
        rotate = item.get("rotate", 0)
        if rotate not in (0, 90, 180, 270) or isinstance(rotate, bool):
            raise EngineError(ErrorCode.INVALID_INPUT, f"Page entry {n + 1}: bad rotation")
        if item.get("blank") is True:
            width, height = item.get("width", 595.28), item.get("height", 841.89)
            if not all(
                isinstance(v, int | float) and not isinstance(v, bool) and 1 <= v <= _MAX_BLANK_SIDE
                for v in (width, height)
            ):
                raise EngineError(ErrorCode.INVALID_INPUT, f"Page entry {n + 1}: bad page size")
            plan.append(_PlanEntry(None, 0, rotate, (float(width), float(height))))
            continue
        src, page = item.get("src"), item.get("page")
        if (
            not isinstance(src, int)
            or isinstance(src, bool)
            or not 0 <= src < inputs
            or not isinstance(page, int)
            or isinstance(page, bool)
            or page < 0
        ):
            raise EngineError(ErrorCode.INVALID_INPUT, f"Page entry {n + 1} is not valid")
        plan.append(_PlanEntry(src, page, rotate))
    return plan


def organize(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Assemble a new PDF from pages of 1+ PDFs in any order, with per-page rotation, duplicates
    and blank pages. Lossless; bookmarks and links follow each page's first copy."""
    inputs = [
        Path(p) for p in require_str_list(params, "inputs", min_len=1, max_len=ORGANIZE_MAX_INPUTS)
    ]
    for path in inputs:
        check_pdf(path)
    plan = _organize_plan(options_dict(params), len(inputs))
    passwords = passwords_map(params)
    tmp = ctx.temp_dir / "organized.pdf"

    sources: list[Pdf] = []
    out = Pdf.new()
    try:
        for path in inputs:
            ctx.check_cancelled()
            sources.append(open_pdf(path, passwords))
        for entry in plan:
            if entry.source is not None and entry.page >= len(sources[entry.source].pages):
                raise EngineError(
                    ErrorCode.INVALID_INPUT,
                    f"{inputs[entry.source].name} has no page {entry.page + 1}",
                    str(inputs[entry.source]),
                )

        copier = PageCopier(out)
        # Consecutive pages of the same input are copied in one batch (much faster).
        n = 0
        while n < len(plan):
            ctx.check_cancelled()
            entry = plan[n]
            if entry.source is None:
                index = copier.add_blank(*entry.size)
                copier.rotate(index, entry.rotate)
                n += 1
                continue
            run_end = n
            while run_end + 1 < len(plan) and plan[run_end + 1].source == entry.source:
                run_end += 1
            batch = plan[n : run_end + 1]
            placed = copier.add(sources[entry.source], [e.page for e in batch])
            for out_index, e in zip(placed, batch, strict=True):
                copier.rotate(out_index, e.rotate)
            ctx.progress(n * 80 / len(plan), f"Arranging page {n + 1} of {len(plan)}")
            n = run_end + 1

        copier.finish()
        items: list[OutlineItem] = []
        for pdf in sources:
            items.extend(copier.outline_items(pdf))
        write_outline(out, items)
        copy_document_info(sources[0], out)
        version = max((pdf.pdf_version for pdf in sources), default="1.4")
        save_pdf(out, tmp, ctx, start=85, min_version=version)
        protected = sum(int(pdf.is_encrypted) for pdf in sources)
    finally:
        out.close()
        for pdf in sources:
            pdf.close()

    ctx.check_cancelled()
    final = deliver_pdf(tmp, params, inputs[0], "organize", protected=inputs)
    return ToolResult(
        [final],
        {
            "pages": len(plan),
            "files": len(inputs),
            "blank_pages": sum(1 for e in plan if e.source is None),
            "bytes": final.stat().st_size,
            "protected_inputs": protected,
        },
    )
