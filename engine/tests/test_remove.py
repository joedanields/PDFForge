"""Remove pages (docs/02 A3)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pytest
from pikepdf import Array, Name, NameTree
from pypdf import PdfReader

from protocol import EngineError
from tests.fixtures import (
    add_link,
    make_encrypted_pdf,
    make_form_pdf,
    make_text_pdf,
    page_label,
)
from tests.helpers import RecordingContext, sha256
from tools.organize import remove_pages


def run(ctx: RecordingContext, src: Path, pages: str, **params: Any) -> Path:
    return remove_pages({"inputs": [str(src)], "options": {"pages": pages}, **params}, ctx).outputs[
        0
    ]


def texts(path: Path) -> list[str]:
    return [(p.extract_text() or "").strip() for p in PdfReader(path).pages]


def all_decoded_streams(path: Path) -> bytes:
    """Every stream in the file, decoded — to prove removed content is truly gone."""
    chunks: list[bytes] = []
    with pikepdf.open(path) as pdf:
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Stream):
                try:
                    chunks.append(obj.read_bytes())
                except pikepdf.PdfError:
                    chunks.append(obj.read_raw_bytes())
    return b"\n".join(chunks)


def test_removes_selected_pages(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 5)
    out = run(ctx, src, "2,4")
    assert out.name == "doc_remove.pdf"
    assert texts(out) == [page_label("doc", n) for n in (1, 3, 5)]


def test_removed_content_is_not_in_the_file(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 4, bookmarks=True)
    src = add_link(src, from_page=0, to_page=1, style="named")  # name tree points at page 2
    out = run(ctx, src, "2")
    blob = all_decoded_streams(out)
    assert b"doc page 2" not in blob
    assert b"doc page 3" in blob
    with pikepdf.open(out) as pdf:
        assert len(pdf.pages) == 3
        names = pdf.Root.get("/Names")
        if names is not None and "/Dests" in names:
            for _, dest in NameTree(names.Dests).items():
                target = dest.D[0] if "/D" in dest else dest[0]
                assert target.objgen in {p.obj.objgen for p in pdf.pages}


def test_bookmarks_to_removed_pages_are_dropped(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 4, bookmarks=True)
    out = run(ctx, src, "2-3")
    with pikepdf.open(out) as pdf:
        items = list(pdf.open_outline().root)
        assert [i.title for i in items] == ["doc §1", "doc §4"]
        pages = [p.obj.objgen for p in pdf.pages]
        dest = items[1].destination
        assert isinstance(dest, Array)
        assert pages.index(dest[0].objgen) == 1


def test_links_are_retargeted_or_dropped(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 4)
    add_link(src, from_page=0, to_page=3)  # survives: page 4 becomes page 3
    add_link(src, from_page=0, to_page=1)  # dropped: page 2 is removed
    out = run(ctx, src, "2")
    with pikepdf.open(out) as pdf:
        links = [a for a in pdf.pages[0].obj.Annots if a.get("/Subtype") == Name.Link]
        assert len(links) == 1
        assert isinstance(links[0].Dest, Array)
        assert links[0].Dest[0].objgen == pdf.pages[2].obj.objgen


def test_cannot_remove_every_page(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    with pytest.raises(EngineError) as info:
        run(ctx, src, "1-3")
    assert info.value.code == "INVALID_INPUT"
    assert "every page" in info.value.message


@pytest.mark.parametrize("pages", ["", "  ", "7", "3-1"])
def test_invalid_selection(pages: str, tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    with pytest.raises(EngineError) as info:
        run(ctx, src, pages)
    assert info.value.code == "INVALID_INPUT"


def test_metadata_and_forms_kept(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_form_pdf(tmp_path / "form.pdf")
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.docinfo["/Title"] = "Quarterly report"
        pdf.pages.append(pdf.pages[0])  # second page so one can be removed
        pdf.save(src)
    out = run(ctx, src, "2")
    with pikepdf.open(out) as pdf:
        assert str(pdf.docinfo["/Title"]) == "Quarterly report"
        assert len(pdf.Root.AcroForm.Fields) >= 1


def test_protected_input_reported(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_encrypted_pdf(tmp_path / "locked.pdf", 3, "pw")
    result = remove_pages(
        {"inputs": [str(src)], "options": {"pages": "1"}, "passwords": {str(src): "pw"}}, ctx
    )
    assert result.stats["protected_inputs"] == 1
    assert result.stats["removed"] == 1
    with pikepdf.open(result.outputs[0]) as pdf:
        assert not pdf.is_encrypted
        assert len(pdf.pages) == 2


def test_input_untouched(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    before = sha256(src)
    run(ctx, src, "1")
    assert sha256(src) == before


def test_large_document(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "big.pdf", 300)
    out = run(ctx, src, "2-299")
    assert texts(out) == [page_label("big", 1), page_label("big", 300)]
