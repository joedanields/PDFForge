"""Lossless page assembly shared by Merge, Remove, Extract, Split and Organize.

``PageCopier`` copies pages from one or more source PDFs into a new PDF object-for-object
(qpdf, never re-rendered), keeps form fields and named destinations (pikepdf
``add_pages_from``), and afterwards re-points internal links and bookmarks at the copied pages.
Links or bookmarks whose target page was not copied are dropped, so a removed page never stays
reachable (and its content never ends up in the output) through a dangling reference.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

import pikepdf
from pikepdf import Array, Dictionary, Name, NameTree, OutlineItem, Pdf

_OUTLINE_MAX_DEPTH = 32

DestLookup = Callable[[Any], Array | None]


@dataclass
class _Source:
    pdf: Pdf
    page_index: dict[tuple[int, int], int]  # source page objgen -> 0-based index
    lookup: DestLookup
    # 0-based source page -> output page indices it was copied to (first one is canonical)
    placed: dict[int, list[int]] = field(default_factory=dict)


def dest_lookup(pdf: Pdf) -> DestLookup:
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


class PageCopier:
    """Build ``out`` page by page from source PDFs, then fix links (``finish``)."""

    def __init__(self, out: Pdf) -> None:
        self.out = out
        self._sources: dict[int, _Source] = {}
        # For every output page: (source key, source page index); None for inserted blank pages.
        self._origin: list[tuple[int, int] | None] = []

    def _source(self, pdf: Pdf) -> _Source:
        key = id(pdf)
        if key not in self._sources:
            self._sources[key] = _Source(
                pdf=pdf,
                page_index={page.obj.objgen: n for n, page in enumerate(pdf.pages)},
                lookup=dest_lookup(pdf),
            )
        return self._sources[key]

    def add(self, pdf: Pdf, indices: Iterable[int]) -> list[int]:
        """Append the given 0-based pages of ``pdf`` (duplicates allowed); return output indices."""
        source = self._source(pdf)
        placed: list[int] = []
        batch: list[int] = []

        def flush() -> None:
            if not batch:
                return
            start = len(self.out.pages)
            self.out.add_pages_from(pdf, list(batch))
            for offset, src_index in enumerate(batch):
                out_index = start + offset
                source.placed.setdefault(src_index, []).append(out_index)
                self._origin.append((id(pdf), src_index))
                placed.append(out_index)
            batch.clear()

        for index in indices:
            if index in batch:  # same page twice in one call: copy it in a separate batch
                flush()
            batch.append(index)
        flush()
        return placed

    def add_blank(self, width: float, height: float) -> int:
        self.out.add_blank_page(page_size=(width, height))
        self._origin.append(None)
        return len(self.out.pages) - 1

    def rotate(self, out_index: int, degrees: int) -> None:
        """Rotate an output page clockwise by ``degrees`` (multiple of 90), relative to now."""
        if degrees % 360:
            self.out.pages[out_index].rotate(degrees % 360, relative=True)

    # --- destinations ---------------------------------------------------------------------

    def remap(self, dest: Any, pdf: Pdf) -> Array | None:
        """Explicit destination on the (first) output copy of the target page, or None."""
        source = self._sources.get(id(pdf))
        if source is None:
            return None
        resolved = source.lookup(dest)
        if resolved is None:
            return None
        target = resolved[0]
        index: int | None = None
        if isinstance(target, Dictionary):
            index = source.page_index.get(target.objgen)
        elif isinstance(target, int) and 0 <= target < len(source.page_index):
            index = target
        if index is None or index not in source.placed:
            return None
        out_page = self.out.pages[source.placed[index][0]].obj
        return Array([out_page, *list(resolved)[1:]])

    def finish(self) -> None:
        """Re-point internal links; drop links whose target page was not copied."""
        for out_index, origin in enumerate(self._origin):
            if origin is None:
                continue
            source = self._sources[origin[0]]
            src_annots = source.pdf.pages[origin[1]].obj.get("/Annots")
            out_page = self.out.pages[out_index].obj
            out_annots = out_page.get("/Annots")
            if not isinstance(src_annots, Array) or not isinstance(out_annots, Array):
                continue
            if len(src_annots) != len(out_annots):
                continue
            keep: list[Any] = []
            for src_annot, out_annot in zip(src_annots, out_annots, strict=True):
                if not isinstance(src_annot, Dictionary) or src_annot.get("/Subtype") != Name.Link:
                    keep.append(out_annot)
                    continue
                action = src_annot.get("/A")
                if "/Dest" in src_annot:
                    new = self.remap(src_annot.Dest, source.pdf)
                    if new is None:
                        continue  # internal link to a page that is not in the output
                    out_annot.Dest = new
                elif (
                    isinstance(action, Dictionary)
                    and action.get("/S") == Name.GoTo
                    and "/D" in action
                ):
                    new = self.remap(action.D, source.pdf)
                    if new is None:
                        continue
                    out_annot.A = Dictionary(S=Name.GoTo, D=new)
                keep.append(out_annot)
            if len(keep) != len(out_annots):
                out_page.Annots = Array(keep)

    # --- bookmarks ------------------------------------------------------------------------

    def outline_items(self, pdf: Pdf) -> list[OutlineItem]:
        """Bookmarks of ``pdf`` re-pointed at the output; entries for missing pages are dropped
        (their children are kept, one level up)."""
        try:
            root = pdf.open_outline().root
        except pikepdf.OutlineStructureError:
            return []
        items: list[OutlineItem] = []
        for item in root:
            items.extend(self._copy_item(item, pdf, 0))
        return items

    def _copy_item(self, item: OutlineItem, pdf: Pdf, depth: int) -> list[OutlineItem]:
        children: list[OutlineItem] = []
        if depth < _OUTLINE_MAX_DEPTH:
            for child in item.children:
                children.extend(self._copy_item(child, pdf, depth + 1))

        action = item.action
        dest: Array | None = None
        is_page_link = item.destination is not None or (
            isinstance(action, Dictionary) and action.get("/S") == Name.GoTo
        )
        if item.destination is not None:
            dest = self.remap(item.destination, pdf)
        elif isinstance(action, Dictionary) and action.get("/S") == Name.GoTo and "/D" in action:
            dest = self.remap(action.D, pdf)

        if is_page_link and dest is None:
            return children  # its page is gone: promote the children
        copy = OutlineItem(item.title, dest)
        if dest is None and isinstance(action, Dictionary) and action.get("/S") == Name.URI:
            copy.action = Dictionary(S=Name.URI, URI=action.URI)
        copy.is_closed = item.is_closed
        copy.children.extend(children)
        return [copy]


def copy_document_info(src: Pdf, out: Pdf) -> None:
    """Carry title/author/... and XMP metadata over to a rebuilt document."""
    for key, value in src.docinfo.items():
        out.docinfo[key] = out.copy_foreign(value) if value.is_indirect else value
    lang = src.Root.get("/Lang")
    if lang is not None:
        out.Root.Lang = lang
    metadata = src.Root.get("/Metadata")
    if metadata is not None:
        out.Root.Metadata = out.copy_foreign(metadata)


def write_outline(out: Pdf, items: list[OutlineItem]) -> None:
    if not items:
        return
    with out.open_outline() as outline:
        outline.root.extend(items)
