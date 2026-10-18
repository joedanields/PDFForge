"""Organize tools. Phase 0: Merge (docs/02_FEATURES.md A1). Split/remove/extract/organize/rotate
arrive in Phase 1.

Merge is lossless: pages are copied object-for-object by qpdf, never re-rendered. Form fields
and named destinations travel with the pages; links and bookmarks are re-pointed explicitly.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import img2pdf
import pikepdf
from pikepdf import Array, Dictionary, Name, NameTree, OutlineItem, Pdf
from PIL import Image, ImageOps, ImageSequence, UnidentifiedImageError

from jobs import Cancelled, JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils.atomic import commit
from utils.naming import resolve_output
from utils.validation import (
    check_pdf,
    check_readable_file,
    is_image,
    option_bool,
    optional_str,
    options_dict,
    passwords_map,
    require_str_list,
)

MERGE_MAX_INPUTS = 500
_OUTLINE_MAX_DEPTH = 32

DestLookup = Callable[[Any], Array | None]


@dataclass
class _Source:
    path: Path
    pdf: Pdf
    offset: int  # index of this source's first page in the output
    page_index: dict[tuple[int, int], int]  # source page objgen -> source page index
    lookup: DestLookup


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
    sources: list[_Source] = []
    protected = 0
    try:
        for i, path in enumerate(inputs):
            ctx.check_cancelled()
            ctx.progress(i * 85 / total, f"Adding file {i + 1} of {total}")
            pdf = _open_input(path, i, passwords, ctx)
            source = _Source(
                path=path,
                pdf=pdf,
                offset=len(out.pages),
                page_index={page.obj.objgen: n for n, page in enumerate(pdf.pages)},
                lookup=_dest_lookup(pdf),
            )
            sources.append(source)
            protected += int(pdf.is_encrypted)  # password or permission restrictions
            out.add_pages_from(pdf)  # keeps form fields and named destinations
            _remap_links(source, out)

        ctx.check_cancelled()
        if keep_bookmarks or bookmark_per_file:
            ctx.progress(87, "Building bookmarks")
            _build_outline(out, sources, keep_bookmarks, bookmark_per_file)

        ctx.progress(90, "Saving")

        def on_save(pct: int) -> None:
            if ctx.is_cancelled():
                raise Cancelled
            ctx.progress(90 + pct * 0.1, "Saving")

        version = max((s.pdf.pdf_version for s in sources), default="1.4")
        out.save(tmp_out, min_version=version, progress=on_save)
        page_count = len(out.pages)
    finally:
        out.close()
        for source in sources:
            source.pdf.close()

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


# --- inputs -------------------------------------------------------------------------------


def _open_input(path: Path, index: int, passwords: dict[str, str], ctx: JobContext) -> Pdf:
    pdf_path = _image_to_pdf(path, ctx.temp_dir / f"image_{index}.pdf") if is_image(path) else path
    password = passwords.get(str(path), "")
    try:
        return Pdf.open(pdf_path, password=password)
    except pikepdf.PasswordError as exc:
        if password:
            raise EngineError(
                ErrorCode.WRONG_PASSWORD, f"The password for {path.name} is incorrect", str(path)
            ) from exc
        raise EngineError(
            ErrorCode.PASSWORD_REQUIRED, f"{path.name} is password protected", str(path)
        ) from exc
    except pikepdf.PdfError as exc:
        raise EngineError(
            ErrorCode.CORRUPT_FILE, f"{path.name} is damaged and could not be read", str(path)
        ) from exc


def _image_to_pdf(path: Path, dst: Path) -> Path:
    """One page per image (all frames for multi-page TIFF). EXIF orientation honoured."""
    try:
        data = img2pdf.convert(str(path), rotation=img2pdf.Rotation.ifvalid)
    except Exception:
        # img2pdf refuses some inputs (alpha channel, WEBP, BMP, palette modes); normalise them.
        data = _normalised_image_pdf(path, dst.with_suffix(""))
    dst.write_bytes(data)
    return dst


def _normalised_image_pdf(path: Path, work_stem: Path) -> bytes:
    try:
        with Image.open(path) as img:
            frames = ImageSequence.all_frames(img) if img.format == "TIFF" else [img.copy()]
            pngs: list[str] = []
            for n, frame in enumerate(frames):
                frame = ImageOps.exif_transpose(frame) or frame
                frame = _flatten(frame)
                png = work_stem.with_name(f"{work_stem.name}_{n}.png")
                frame.save(png, "PNG")
                pngs.append(str(png))
    except Image.DecompressionBombError as exc:
        raise EngineError(
            ErrorCode.INVALID_INPUT, f"{path.name} is too large to process", str(path)
        ) from exc
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise EngineError(
            ErrorCode.CORRUPT_FILE, f"{path.name} is not a readable image", str(path)
        ) from exc
    result: bytes = img2pdf.convert(pngs)
    return result


def _flatten(img: Image.Image) -> Image.Image:
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    if img.mode not in ("RGB", "L", "CMYK", "1"):
        return img.convert("RGB")
    return img


# --- destinations: links and bookmarks ------------------------------------------------------


def _dest_lookup(pdf: Pdf) -> DestLookup:
    """Resolve a destination (explicit array, named string, or legacy /Dests name) to an array."""
    tree: NameTree | None = None
    names = pdf.Root.get("/Names")
    if isinstance(names, Dictionary) and "/Dests" in names:
        tree = NameTree(names.Dests)
    legacy = pdf.Root.get("/Dests")

    def lookup(dest: Any) -> Array | None:
        value: Any = dest
        if isinstance(dest, pikepdf.String):
            key = str(dest)
            value = tree[key] if tree is not None and key in tree else None
        elif isinstance(dest, Name):
            value = legacy.get(dest) if isinstance(legacy, Dictionary) else None
        if isinstance(value, Dictionary) and "/D" in value:
            value = value.D
        if isinstance(value, Array) and len(value) >= 1:
            return value
        return None

    return lookup


def _remap(dest: Any, source: _Source, out: Pdf) -> Array | None:
    """Explicit destination pointing at the merged copy of the source page, or None."""
    resolved = source.lookup(dest)
    if resolved is None:
        return None
    target = resolved[0]
    index: int | None = None
    if isinstance(target, Dictionary):
        index = source.page_index.get(target.objgen)
    elif isinstance(target, int) and 0 <= target < len(source.page_index):
        index = target
    if index is None:
        return None
    return Array([out.pages[source.offset + index].obj, *list(resolved)[1:]])


def _remap_links(source: _Source, out: Pdf) -> None:
    """Point internal links (GoTo / named dests) at the merged pages (A1: links preserved)."""
    for n, src_page in enumerate(source.pdf.pages):
        src_annots = src_page.obj.get("/Annots")
        out_annots = out.pages[source.offset + n].obj.get("/Annots")
        if not isinstance(src_annots, Array) or not isinstance(out_annots, Array):
            continue
        if len(src_annots) != len(out_annots):
            continue
        for src_annot, out_annot in zip(src_annots, out_annots, strict=True):
            if not isinstance(src_annot, Dictionary) or src_annot.get("/Subtype") != Name.Link:
                continue
            if "/Dest" in src_annot:
                new = _remap(src_annot.Dest, source, out)
                if new is not None:
                    out_annot.Dest = new
                continue
            action = src_annot.get("/A")
            if isinstance(action, Dictionary) and action.get("/S") == Name.GoTo and "/D" in action:
                new = _remap(action.D, source, out)
                if new is not None:
                    out_annot.A = Dictionary(S=Name.GoTo, D=new)


def _build_outline(out: Pdf, sources: list[_Source], keep: bool, per_file: bool) -> None:
    with out.open_outline() as outline:
        for source in sources:
            children = _copy_outline(source, out) if keep else []
            if per_file:
                item = OutlineItem(source.path.stem, source.offset)
                item.children.extend(children)
                outline.root.append(item)
            else:
                outline.root.extend(children)


def _copy_outline(source: _Source, out: Pdf) -> list[OutlineItem]:
    try:
        root = source.pdf.open_outline().root
    except pikepdf.OutlineStructureError:
        return []
    return [_copy_item(item, source, out, 0) for item in root]


def _copy_item(item: OutlineItem, source: _Source, out: Pdf, depth: int) -> OutlineItem:
    dest: Array | None = None
    action = item.action
    if item.destination is not None:
        dest = _remap(item.destination, source, out)
    elif isinstance(action, Dictionary) and action.get("/S") == Name.GoTo and "/D" in action:
        dest = _remap(action.D, source, out)

    copy = OutlineItem(item.title, dest)
    if dest is None and isinstance(action, Dictionary) and action.get("/S") == Name.URI:
        copy.action = Dictionary(S=Name.URI, URI=action.URI)
    copy.is_closed = item.is_closed
    if depth < _OUTLINE_MAX_DEPTH:
        copy.children.extend(_copy_item(child, source, out, depth + 1) for child in item.children)
    return copy
