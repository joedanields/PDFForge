"""Split PDF (docs/02 A2, docs/07 §3: split by range "1-3,5" → 2 files with 3 and 1 pages)."""

from __future__ import annotations

import time
import zipfile
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from pypdf import PdfReader

from protocol import EngineError
from tests.fixtures import add_action_outline, make_image_pdf, make_text_pdf, page_label
from tests.helpers import RecordingContext, sha256
from tools.organize import split


def run(ctx: RecordingContext, src: Path, **options: Any) -> tuple[list[Path], dict[str, Any]]:
    result = split({"inputs": [str(src)], "options": options}, ctx)
    return result.outputs, result.stats


def page_counts(paths: list[Path]) -> list[int]:
    return [len(PdfReader(p).pages) for p in paths]


def texts(path: Path) -> list[str]:
    return [(p.extract_text() or "").strip() for p in PdfReader(path).pages]


def test_split_by_range_acceptance(tmp_path: Path, ctx: RecordingContext) -> None:
    """docs/07 §3: split by range `1-3,5` → 2 files with 3 and 1 pages."""
    src = make_text_pdf(tmp_path / "doc.pdf", 6)
    outputs, stats = run(ctx, src, mode="ranges", ranges="1-3,5")
    assert page_counts(outputs) == [3, 1]
    assert [p.name for p in outputs] == ["doc_1-3.pdf", "doc_5.pdf"]
    assert stats["folder"] == str(tmp_path / "doc_split")
    assert texts(outputs[1]) == [page_label("doc", 5)]


def test_ranges_keep_written_order_and_allow_repeats(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 6)
    outputs, _ = run(ctx, src, mode="ranges", ranges="5-6, 1-2, 1-2")
    assert [p.name for p in outputs] == ["doc_5-6.pdf", "doc_1-2.pdf", "doc_1-2 (3).pdf"]


def test_merge_ranges_into_one_file(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 8)
    outputs, stats = run(ctx, src, mode="ranges", ranges="1-2, 7-8", merge_ranges=True)
    assert outputs == [tmp_path / "doc_split.pdf"]
    assert texts(outputs[0]) == [page_label("doc", n) for n in (1, 2, 7, 8)]
    assert stats["ranges"] == 2


def test_every_n_pages(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 7)
    outputs, stats = run(ctx, src, mode="fixed", every=3)
    assert page_counts(outputs) == [3, 3, 1]
    assert [p.name for p in outputs] == ["doc_1-3.pdf", "doc_4-6.pdf", "doc_7-7.pdf"]
    assert stats["files"] == 3


def test_extract_all(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 4)
    outputs, _ = run(ctx, src, mode="all")
    assert [p.name for p in outputs] == [f"doc_page-{n}.pdf" for n in range(1, 5)]
    assert page_counts(outputs) == [1, 1, 1, 1]


def test_by_file_size(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_image_pdf(tmp_path / "scan.pdf", 8)
    page_kb = src.stat().st_size / 8 / 1024
    limit_mb = page_kb * 2.5 / 1024  # room for about two pages per file
    outputs, stats = run(ctx, src, mode="size", max_mb=limit_mb)
    assert sum(page_counts(outputs)) == 8
    assert len(outputs) >= 3
    for path in outputs:
        assert path.stat().st_size <= limit_mb * 1024 * 1024
    assert "oversized_pages" not in stats


def test_by_file_size_reports_oversized_pages(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_image_pdf(tmp_path / "scan.pdf", 3)
    outputs, stats = run(ctx, src, mode="size", max_mb=0.05)
    assert page_counts(outputs) == [1, 1, 1]
    assert stats["oversized_pages"] == 3


def test_by_bookmarks(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "book.pdf", 6)
    add_action_outline(src, [("Intro", 1), ("Middle part", 3), ("End: notes", 5)])
    outputs, _ = run(ctx, src, mode="bookmarks")
    # Page 1 (before the first bookmark) joins the first file.
    assert [p.name for p in outputs] == [
        "book_01 Intro.pdf",
        "book_02 Middle part.pdf",
        "book_03 End_ notes.pdf",
    ]
    assert page_counts(outputs) == [3, 2, 1]


def test_by_bookmarks_without_bookmarks(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "plain.pdf", 3)
    with pytest.raises(EngineError) as info:
        run(ctx, src, mode="bookmarks")
    assert "no bookmarks" in info.value.message


def test_zip(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    outputs, stats = run(ctx, src, mode="all", zip=True)
    assert outputs == [tmp_path / "doc_split.zip"]
    with zipfile.ZipFile(outputs[0]) as zf:
        assert len(zf.namelist()) == 3
    assert stats["files"] == 3


def test_bookmarks_follow_their_pages(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 4, bookmarks=True)
    outputs, _ = run(ctx, src, mode="ranges", ranges="1-2,3-4")
    with pikepdf.open(outputs[1]) as pdf:
        assert [i.title for i in pdf.open_outline().root] == ["doc §3", "doc §4"]


@pytest.mark.parametrize(
    "options",
    [
        {"mode": "ranges", "ranges": ""},
        {"mode": "ranges", "ranges": "1-3, 9"},
        {"mode": "ranges", "ranges": "4-2"},
        {"mode": "fixed", "every": 0},
        {"mode": "size", "max_mb": 0},
        {"mode": "halves"},
    ],
)
def test_invalid(options: dict[str, Any], tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 5)
    with pytest.raises(EngineError) as info:
        run(ctx, src, **options)
    assert info.value.code == "INVALID_INPUT"


def test_input_untouched(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    before = sha256(src)
    run(ctx, src, mode="all")
    assert sha256(src) == before


def test_perf_500_pages_into_single_pages_under_10s(tmp_path: Path, ctx: RecordingContext) -> None:
    """docs/05_NON_FUNCTIONAL.md P3."""
    src = make_text_pdf(tmp_path / "big.pdf", 500)
    start = time.perf_counter()
    outputs, _ = run(ctx, src, mode="all")
    elapsed = time.perf_counter() - start
    assert len(outputs) == 500
    assert elapsed < 10, f"split took {elapsed:.1f}s"
