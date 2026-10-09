"""Generators for test inputs (docs/07_TESTING.md §2). Everything is created on the fly so no
binary corpus is committed; later phases extend this module.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

import pikepdf
from pikepdf import Array, Dictionary, Name, NameTree, OutlineItem
from PIL import Image
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas


def page_label(label: str, n: int) -> str:
    """Text drawn on page ``n`` (1-based) of a fixture called ``label``."""
    return f"{label} page {n}"


def make_text_pdf(
    path: Path,
    pages: int,
    label: str | None = None,
    *,
    bookmarks: bool = False,
    named_link: bool = False,
    page_sizes: Sequence[tuple[float, float]] | None = None,
) -> Path:
    """A simple text PDF; each page shows ``"{label} page {n}"``.

    ``bookmarks``: one outline entry per page ("{label} §n") using named destinations.
    ``named_link``: page 1 gets an internal link (named destination) to the last page.
    """
    label = label or path.stem
    c = canvas.Canvas(str(path), pagesize=A4)
    for n in range(1, pages + 1):
        size = page_sizes[(n - 1) % len(page_sizes)] if page_sizes else A4
        c.setPageSize(size)
        c.setFont("Helvetica", 24)
        c.drawString(72, size[1] - 100, page_label(label, n))
        key = f"p{n}"
        c.bookmarkPage(key)
        if bookmarks:
            c.addOutlineEntry(f"{label} §{n}", key, level=0)
        if named_link and n == 1 and pages > 1:
            c.linkRect("", f"p{pages}", (72, 400, 300, 440), relative=0)
        c.showPage()
    c.save()
    return path


LinkStyle = Literal["explicit", "named", "goto", "legacy"]


def _name_tree(pdf: pikepdf.Pdf) -> NameTree:
    names = pdf.Root.get("/Names")
    if not isinstance(names, Dictionary):
        names = pdf.make_indirect(Dictionary())
        pdf.Root.Names = names
    if "/Dests" not in names:
        names.Dests = NameTree.new(pdf).obj
    return NameTree(names.Dests)


def _named_target(pdf: pikepdf.Pdf, name: str, to_page: int, legacy: bool) -> Any:
    explicit = Array([pdf.pages[to_page].obj, Name.Fit])
    if legacy:
        dests = pdf.Root.get("/Dests")
        if not isinstance(dests, Dictionary):
            dests = pdf.make_indirect(Dictionary())
            pdf.Root.Dests = dests
        dests[Name(f"/{name}")] = explicit
        return Name(f"/{name}")
    _name_tree(pdf)[name] = Dictionary(D=explicit)
    return pikepdf.String(name)


def add_link(path: Path, from_page: int, to_page: int, style: LinkStyle = "explicit") -> Path:
    """Add an internal Link annotation (0-based pages).

    ``explicit``: ``/Dest [page /Fit]``; ``named``: ``/Dest (name)`` via the /Names tree;
    ``goto``: ``/A << /S /GoTo /D (name) >>``; ``legacy``: ``/Dest /name`` via PDF 1.1 /Dests.
    """
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        fields: dict[str, Any]
        if style == "explicit":
            fields = {"Dest": Array([pdf.pages[to_page].obj, Name.Fit])}
        else:
            target = _named_target(pdf, f"d{from_page}to{to_page}", to_page, style == "legacy")
            fields = (
                {"A": Dictionary(S=Name.GoTo, D=target)} if style == "goto" else {"Dest": target}
            )
        annot = pdf.make_indirect(
            Dictionary(
                Type=Name.Annot,
                Subtype=Name.Link,
                Rect=Array([72, 300, 300, 340]),
                Border=Array([0, 0, 0]),
                **fields,
            )
        )
        page = pdf.pages[from_page].obj
        annots = page.get("/Annots")
        if isinstance(annots, Array):
            annots.append(annot)
        else:
            page.Annots = Array([annot])
        pdf.save(path)
    return path


def add_action_outline(
    path: Path, entries: Sequence[tuple[str, int]], uri: str | None = None
) -> Path:
    """Replace the outline with GoTo-action bookmarks to named destinations, plus an optional
    URI bookmark (used to check non-page actions survive)."""
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        actions = [
            (title, Dictionary(S=Name.GoTo, D=_named_target(pdf, f"o{n}", page, legacy=False)))
            for n, (title, page) in enumerate(entries)
        ]
        with pdf.open_outline() as outline:
            outline.root.clear()
            for title, action in actions:
                outline.root.append(OutlineItem(title, action=action))
            if uri:
                outline.root.append(OutlineItem("Website", action=Dictionary(S=Name.URI, URI=uri)))
        pdf.save(path)
    return path


def make_landscape_pdf(path: Path, pages: int, label: str | None = None) -> Path:
    return make_text_pdf(path, pages, label, page_sizes=[landscape(A4)])


def make_encrypted_pdf(
    path: Path, pages: int, user_password: str, owner_password: str = ""
) -> Path:
    plain = path.with_name(f"{path.stem}.plain.pdf")
    make_text_pdf(plain, pages, path.stem)
    with pikepdf.open(plain) as pdf:
        pdf.save(
            path,
            encryption=pikepdf.Encryption(
                user=user_password, owner=owner_password or user_password, R=6
            ),
        )
    plain.unlink()
    return path


def make_corrupt_pdf(path: Path) -> Path:
    """Starts like a PDF, contains no recoverable structure."""
    path.write_bytes(b"%PDF-1.7\n" + b"\x00garbage\xff" * 200)
    return path


def make_not_pdf(path: Path) -> Path:
    path.write_text("this is plain text, not a PDF\n", encoding="utf-8")
    return path


def make_image(
    path: Path,
    size: tuple[int, int] = (400, 300),
    mode: str = "RGB",
    color: tuple[int, ...] = (30, 120, 200),
) -> Path:
    """An image in the format implied by ``path``'s suffix."""
    img = Image.new(mode, size, color if len(color) == len(mode) else color[: len(mode)])
    img.save(path)
    return path


def make_form_pdf(path: Path, field_name: str = "name") -> Path:
    """One page with a single AcroForm text field."""
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawString(72, 760, f"Form {path.stem}")
    c.acroForm.textfield(name=field_name, x=72, y=700, width=200, height=24)
    c.showPage()
    c.save()
    return path
