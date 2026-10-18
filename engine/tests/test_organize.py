"""Organize PDF (docs/02 A5): reorder, rotate, delete, duplicate, blank pages, multiple PDFs."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pytest
from pypdf import PdfReader

from protocol import EngineError
from tests.fixtures import add_link, make_encrypted_pdf, make_text_pdf, page_label
from tests.helpers import RecordingContext, sha256
from tools.organize import organize
from utils.pageinfo import rotation


def run(
    ctx: RecordingContext, inputs: list[Path], pages: list[dict[str, Any]], **params: Any
) -> Any:
    return organize(
        {"inputs": [str(p) for p in inputs], "options": {"pages": pages}, **params}, ctx
    )


def p(src: int, page: int, rotate: int = 0) -> dict[str, Any]:
    return {"src": src, "page": page, "rotate": rotate}


def texts(path: Path) -> list[str]:
    return [(pg.extract_text() or "").strip() for pg in PdfReader(path).pages]


def test_reorder_and_delete(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 4)
    result = run(ctx, [src], [p(0, 3), p(0, 0), p(0, 2)])  # page 2 deleted
    out = result.outputs[0]
    assert out.name == "doc_organize.pdf"
    assert texts(out) == [page_label("doc", n) for n in (4, 1, 3)]
    assert result.stats["pages"] == 3


def test_per_page_rotation_is_lossless(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 2)
    out = run(ctx, [src], [p(0, 0, 90), p(0, 1, 270)]).outputs[0]
    with pikepdf.open(out) as pdf, pikepdf.open(src) as orig:
        assert [rotation(pg) for pg in pdf.pages] == [90, 270]
        assert [pg.obj.Contents.read_bytes() for pg in pdf.pages] == [
            pg.obj.Contents.read_bytes() for pg in orig.pages
        ]


def test_duplicates_are_independent_pages(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 2)
    out = run(ctx, [src], [p(0, 0), p(0, 0, 180), p(0, 1), p(0, 0)]).outputs[0]
    assert texts(out) == [page_label("doc", n) for n in (1, 1, 2, 1)]
    with pikepdf.open(out) as pdf:
        objgens = [pg.obj.objgen for pg in pdf.pages]
        assert len(set(objgens)) == 4
        assert [rotation(pg) for pg in pdf.pages] == [0, 180, 0, 0]


def test_blank_pages(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    blank = {"blank": True, "width": 612, "height": 792}
    result = run(ctx, [src], [blank, p(0, 0), {**blank, "rotate": 90}])
    with pikepdf.open(result.outputs[0]) as pdf:
        assert len(pdf.pages) == 3
        assert [float(v) for v in pdf.pages[0].mediabox] == [0, 0, 612, 792]
        assert rotation(pdf.pages[2]) == 90
    assert result.stats["blank_pages"] == 2


def test_pages_from_several_pdfs(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 3)
    b = make_text_pdf(tmp_path / "b.pdf", 2)
    out = run(ctx, [a, b], [p(0, 0), p(1, 1), p(0, 2), p(1, 0)]).outputs[0]
    assert texts(out) == [
        page_label("a", 1),
        page_label("b", 2),
        page_label("a", 3),
        page_label("b", 1),
    ]


def test_bookmarks_and_links_follow_pages(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3, bookmarks=True)
    add_link(src, from_page=0, to_page=2)
    out = run(ctx, [src], [p(0, 2), p(0, 0)]).outputs[0]  # page 2 dropped, 3 moved first
    with pikepdf.open(out) as pdf:
        items = list(pdf.open_outline().root)
        assert [i.title for i in items] == ["doc §1", "doc §3"]
        pages = [pg.obj.objgen for pg in pdf.pages]
        dest = items[1].destination
        assert isinstance(dest, pikepdf.Array)
        assert pages.index(dest[0].objgen) == 0
        link = pdf.pages[1].obj.Annots[0]
        assert pages.index(link.Dest[0].objgen) == 0


@pytest.mark.parametrize(
    "pages",
    [
        [],
        [p(1, 0)],
        [p(0, 9)],
        [p(0, 0, 45)],
        [{"blank": True, "width": 0, "height": 10}],
        ["page"],
    ],
)
def test_invalid_plans(pages: list[Any], tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 2)
    with pytest.raises(EngineError) as info:
        run(ctx, [src], pages)
    assert info.value.code == "INVALID_INPUT"


def test_protected_inputs(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    b = make_encrypted_pdf(tmp_path / "b.pdf", 1, "pw")
    result = run(ctx, [a, b], [p(1, 0), p(0, 0)], passwords={str(b): "pw"})
    assert result.stats["protected_inputs"] == 1
    with pikepdf.open(result.outputs[0]) as pdf:
        assert not pdf.is_encrypted


def test_inputs_untouched(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 2)
    before = sha256(a)
    run(ctx, [a], [p(0, 1, 90), p(0, 0)])
    assert sha256(a) == before


def test_many_pages_are_batched(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "big.pdf", 300)
    plan = [p(0, i) for i in reversed(range(300))]
    out = run(ctx, [src], plan).outputs[0]
    got = texts(out)
    assert got[0] == page_label("big", 300) and got[-1] == page_label("big", 1)
