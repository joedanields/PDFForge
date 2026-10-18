"""Extract pages (docs/02 A4)."""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from pypdf import PdfReader

from protocol import EngineError
from tests.fixtures import make_encrypted_pdf, make_text_pdf, page_label
from tests.helpers import RecordingContext, sha256
from tools.organize import extract_pages


def run(ctx: RecordingContext, src: Path, **options: Any) -> tuple[list[Path], dict[str, Any]]:
    result = extract_pages({"inputs": [str(src)], "options": options}, ctx)
    return result.outputs, result.stats


def texts(path: Path) -> list[str]:
    return [(p.extract_text() or "").strip() for p in PdfReader(path).pages]


def test_single_file(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 6, bookmarks=True)
    outputs, stats = run(ctx, src, pages="2,4-5")
    assert [p.name for p in outputs] == ["doc_extract.pdf"]
    assert texts(outputs[0]) == [page_label("doc", n) for n in (2, 4, 5)]
    assert stats["pages"] == 3
    with pikepdf.open(outputs[0]) as pdf:
        assert [i.title for i in pdf.open_outline().root] == ["doc §2", "doc §4", "doc §5"]


def test_document_order_regardless_of_typed_order(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 5)
    outputs, _ = run(ctx, src, pages="5,1")
    assert texts(outputs[0]) == [page_label("doc", 1), page_label("doc", 5)]


def test_separate_files_go_into_a_new_folder(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 5)
    outputs, stats = run(ctx, src, pages="1,3,5", mode="separate")
    folder = tmp_path / "doc_extract"
    assert stats["folder"] == str(folder)
    assert stats["files"] == 3
    assert [p.name for p in outputs] == ["doc_page-1.pdf", "doc_page-3.pdf", "doc_page-5.pdf"]
    assert all(p.parent == folder for p in outputs)
    for path, n in zip(outputs, (1, 3, 5), strict=True):
        assert texts(path) == [page_label("doc", n)]


def test_separate_never_overwrites_an_existing_folder(tmp_path: Path) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    first, _ = run(RecordingContext(tmp_path / "j1"), src, pages="1-2", mode="separate")
    second, stats = run(RecordingContext(tmp_path / "j2"), src, pages="1-2", mode="separate")
    assert first[0].parent.name == "doc_extract"
    assert second[0].parent.name == "doc_extract (1)"
    assert stats["folder"].endswith("doc_extract (1)")


def test_separate_single_page_is_just_a_file(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    outputs, stats = run(ctx, src, pages="2", mode="separate")
    assert outputs == [tmp_path / "doc_page-2.pdf"]
    assert "folder" not in stats


def test_zip(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 4)
    outputs, stats = run(ctx, src, pages="1-3", mode="separate", zip=True)
    assert outputs == [tmp_path / "doc_extract.zip"]
    with zipfile.ZipFile(outputs[0]) as zf:
        assert sorted(zf.namelist()) == ["doc_page-1.pdf", "doc_page-2.pdf", "doc_page-3.pdf"]
    assert stats["files"] == 3


def test_unselected_content_is_not_in_the_output(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    outputs, _ = run(ctx, src, pages="2")
    with pikepdf.open(outputs[0]) as pdf:
        blob = b"".join(obj.read_bytes() for obj in pdf.objects if isinstance(obj, pikepdf.Stream))
    assert b"doc page 1" not in blob and b"doc page 3" not in blob


@pytest.mark.parametrize("options", [{"pages": ""}, {"pages": "9"}, {"pages": "1", "mode": "x"}])
def test_invalid(options: dict[str, Any], tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    with pytest.raises(EngineError) as info:
        run(ctx, src, **options)
    assert info.value.code == "INVALID_INPUT"


def test_protected_input(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_encrypted_pdf(tmp_path / "locked.pdf", 3, "pw")
    result = extract_pages(
        {"inputs": [str(src)], "options": {"pages": "2"}, "passwords": {str(src): "pw"}}, ctx
    )
    assert result.stats["protected_inputs"] == 1
    assert texts(result.outputs[0]) == [page_label("locked", 2)]


def test_input_untouched(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    before = sha256(src)
    run(ctx, src, pages="1", mode="separate")
    assert sha256(src) == before
