"""Merge PDF acceptance tests (docs/02_FEATURES.md A1, docs/07_TESTING.md §3)."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import img2pdf
import pikepdf
import pypdfium2 as pdfium
import pytest
from pikepdf import Array, Dictionary, Name, NameTree
from pypdf import PdfReader

from jobs import Cancelled
from protocol import EngineError
from tests.fixtures import (
    LinkStyle,
    add_action_outline,
    add_link,
    make_corrupt_pdf,
    make_encrypted_pdf,
    make_form_pdf,
    make_image,
    make_landscape_pdf,
    make_not_pdf,
    make_restricted_pdf,
    make_text_pdf,
    page_label,
)
from tests.helpers import RecordingContext, sha256
from tools.organize import merge


def run_merge(ctx: RecordingContext, inputs: list[Path], **params: Any) -> Path:
    result = merge({"inputs": [str(p) for p in inputs], **params}, ctx)
    assert len(result.outputs) == 1
    return result.outputs[0]


def page_texts(path: Path) -> list[str]:
    return [(page.extract_text() or "").strip() for page in PdfReader(path).pages]


def render_page(path: Path, index: int) -> bytes:
    doc = pdfium.PdfDocument(str(path))
    try:
        bitmap = doc[index].render(scale=1)
        return bytes(bitmap.buffer)
    finally:
        doc.close()


def dest_page_index(pdf: pikepdf.Pdf, dest: Any) -> int:
    if isinstance(dest, pikepdf.String):
        dest = NameTree(pdf.Root.Names.Dests)[str(dest)]
    if isinstance(dest, Dictionary):
        dest = dest.D
    assert isinstance(dest, Array)
    objgens = [p.obj.objgen for p in pdf.pages]
    return objgens.index(dest[0].objgen)


# --- core acceptance --------------------------------------------------------------------------


def test_page_count_is_sum_and_order_respected(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 2)
    b = make_text_pdf(tmp_path / "b.pdf", 3)
    c = make_text_pdf(tmp_path / "c.pdf", 1)
    out = run_merge(ctx, [b, a, c])
    expected = [page_label("b", n) for n in (1, 2, 3)]
    expected += [page_label("a", n) for n in (1, 2)] + [page_label("c", 1)]
    assert page_texts(out) == expected


def test_first_page_renders_identically(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 2)
    b = make_landscape_pdf(tmp_path / "b.pdf", 1)
    out = run_merge(ctx, [a, b])
    assert render_page(out, 0) == render_page(a, 0)
    assert render_page(out, 2) == render_page(b, 0)


def test_inputs_are_never_modified(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 2, bookmarks=True, named_link=True)
    b = make_text_pdf(tmp_path / "b.pdf", 2)
    before = {p: (sha256(p), p.stat().st_mtime_ns) for p in (a, b)}
    run_merge(ctx, [a, b], options={"bookmark_per_file": True})
    assert {p: (sha256(p), p.stat().st_mtime_ns) for p in (a, b)} == before


def test_progress_reported_and_stats(tmp_path: Path, ctx: RecordingContext) -> None:
    inputs = [make_text_pdf(tmp_path / f"f{n}.pdf", 2) for n in range(4)]
    result = merge({"inputs": [str(p) for p in inputs]}, ctx)
    percents = [e["percent"] for e in ctx.events]
    assert percents == sorted(percents)
    assert percents[-1] == 100
    assert any("Adding file 3 of 4" in e["message"] for e in ctx.events)
    assert result.stats["pages"] == 8
    assert result.stats["files"] == 4
    assert result.stats["bytes"] == result.outputs[0].stat().st_size


# --- naming -----------------------------------------------------------------------------------


def test_default_output_next_to_first_input(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "report.pdf", 1)
    (tmp_path / "other").mkdir()
    b = make_text_pdf(tmp_path / "other" / "b.pdf", 1)
    assert run_merge(ctx, [a, b]) == tmp_path / "report_merge.pdf"


def test_running_twice_never_overwrites(tmp_path: Path) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    b = make_text_pdf(tmp_path / "b.pdf", 1)
    first = run_merge(RecordingContext(tmp_path / "t1"), [a, b])
    first_hash = sha256(first)
    second = run_merge(RecordingContext(tmp_path / "t2"), [a, b])
    assert first.name == "a_merge.pdf"
    assert second.name == "a_merge (1).pdf"
    assert sha256(first) == first_hash


def test_output_dir_and_explicit_output(tmp_path: Path) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    b = make_text_pdf(tmp_path / "b.pdf", 1)
    out_dir = tmp_path / "exports"
    assert run_merge(RecordingContext(tmp_path / "t1"), [a, b], output_dir=str(out_dir)) == (
        out_dir / "a_merge.pdf"
    )
    explicit = tmp_path / "custom.pdf"
    assert run_merge(RecordingContext(tmp_path / "t2"), [a, b], output=str(explicit)) == explicit


def test_explicit_output_equal_to_input_does_not_overwrite(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    b = make_text_pdf(tmp_path / "b.pdf", 1)
    original = sha256(a)
    out = run_merge(ctx, [a, b], output=str(a))
    assert out == tmp_path / "a (1).pdf"
    assert sha256(a) == original


def test_no_part_files_left_behind(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    b = make_text_pdf(tmp_path / "b.pdf", 1)
    run_merge(ctx, [a, b])
    assert sorted(p.name for p in tmp_path.glob("*.pdf")) == ["a.pdf", "a_merge.pdf", "b.pdf"]
    assert not list(tmp_path.glob(".*.part"))


# --- bookmarks & links ------------------------------------------------------------------------


def outline_titles(path: Path) -> list[tuple[str, list[str]]]:
    with pikepdf.open(path) as pdf, pdf.open_outline() as outline:
        return [(item.title, [c.title for c in item.children]) for item in outline.root]


def outline_targets(path: Path) -> dict[str, int]:
    targets: dict[str, int] = {}
    with pikepdf.open(path) as pdf:
        outline = pdf.open_outline()

        def walk(items: list[pikepdf.OutlineItem]) -> None:
            for item in items:
                dest: Any = item.destination
                if dest is None and item.action is not None:
                    dest = item.action.D
                targets[item.title] = dest_page_index(pdf, dest)
                walk(item.children)

        walk(outline.root)
    return targets


def test_bookmarks_preserved_and_retargeted(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 2, bookmarks=True)
    b = make_text_pdf(tmp_path / "b.pdf", 3, bookmarks=True)
    out = run_merge(ctx, [a, b])
    assert [t for t, _ in outline_titles(out)] == ["a §1", "a §2", "b §1", "b §2", "b §3"]
    assert outline_targets(out) == {"a §1": 0, "a §2": 1, "b §1": 2, "b §2": 3, "b §3": 4}


def test_bookmarks_dropped_when_disabled(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 2, bookmarks=True)
    b = make_text_pdf(tmp_path / "b.pdf", 2, bookmarks=True)
    out = run_merge(ctx, [a, b], options={"bookmarks": False})
    assert outline_titles(out) == []


def test_bookmark_per_source_file(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "Chapter A.pdf", 2, label="a", bookmarks=True)
    b = make_text_pdf(tmp_path / "Chapter B.pdf", 2, label="b")
    out = run_merge(ctx, [a, b], options={"bookmarks": True, "bookmark_per_file": True})
    assert outline_titles(out) == [("Chapter A", ["a §1", "a §2"]), ("Chapter B", [])]
    targets = outline_targets(out)
    assert targets["Chapter A"] == 0
    assert targets["Chapter B"] == 2
    assert targets["a §2"] == 1


def test_bookmark_per_file_without_source_bookmarks(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 2, bookmarks=True)
    b = make_text_pdf(tmp_path / "b.pdf", 1)
    out = run_merge(ctx, [a, b], options={"bookmarks": False, "bookmark_per_file": True})
    assert outline_titles(out) == [("a", []), ("b", [])]


def link_targets(path: Path) -> list[tuple[int, int]]:
    """(page with link, target page) for every internal link in ``path``."""
    found: list[tuple[int, int]] = []
    with pikepdf.open(path) as pdf:
        for n, page in enumerate(pdf.pages):
            for annot in page.obj.get("/Annots", Array()):
                if annot.get("/Subtype") != Name.Link:
                    continue
                dest: Any = annot.get("/Dest")
                if dest is None and "/A" in annot and annot.A.get("/S") == Name.GoTo:
                    dest = annot.A.D
                if dest is not None:
                    found.append((n, dest_page_index(pdf, dest)))
    return found


def test_named_links_point_to_merged_pages(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 2)
    b = make_text_pdf(tmp_path / "b.pdf", 3, named_link=True)  # b p1 -> b p3
    out = run_merge(ctx, [a, b])
    assert link_targets(out) == [(2, 4)]


def test_explicit_links_point_to_merged_pages(tmp_path: Path, ctx: RecordingContext) -> None:
    a = add_link(make_text_pdf(tmp_path / "a.pdf", 3), from_page=0, to_page=2)
    b = add_link(make_text_pdf(tmp_path / "b.pdf", 2), from_page=1, to_page=0)
    out = run_merge(ctx, [a, b])
    assert sorted(link_targets(out)) == [(0, 2), (4, 3)]


@pytest.mark.parametrize("style", ["named", "goto", "legacy"])
def test_named_destination_styles_are_resolved(
    style: LinkStyle, tmp_path: Path, ctx: RecordingContext
) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    b = add_link(make_text_pdf(tmp_path / "b.pdf", 3), from_page=0, to_page=2, style=style)
    out = run_merge(ctx, [a, b])
    assert link_targets(out) == [(1, 3)]


def test_same_file_twice_keeps_links_separate(tmp_path: Path, ctx: RecordingContext) -> None:
    a = add_link(make_text_pdf(tmp_path / "a.pdf", 2), from_page=0, to_page=1)
    out = run_merge(ctx, [a, a])
    assert len(PdfReader(out).pages) == 4
    assert sorted(link_targets(out)) == [(0, 1), (2, 3)]


def test_action_bookmarks_and_uri_bookmarks(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    b = add_action_outline(
        make_text_pdf(tmp_path / "b.pdf", 3),
        [("Intro", 0), ("End", 2)],
        uri="https://example.org/",
    )
    out = run_merge(ctx, [a, b])
    with pikepdf.open(out) as pdf:
        items = list(pdf.open_outline().root)
        assert [i.title for i in items] == ["Intro", "End", "Website"]
        assert dest_page_index(pdf, items[0].destination) == 1
        assert dest_page_index(pdf, items[1].destination) == 3
        assert items[2].action is not None
        assert str(items[2].action.URI) == "https://example.org/"


# --- images -----------------------------------------------------------------------------------


def test_images_are_auto_converted(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "doc.pdf", 2)
    images = [
        make_image(tmp_path / "photo.jpg"),
        make_image(tmp_path / "alpha.png", mode="RGBA", color=(255, 0, 0, 128)),
        make_image(tmp_path / "pic.webp"),
        make_image(tmp_path / "bitmap.bmp"),
        make_image(tmp_path / "gray.png", mode="L", color=(90,)),
    ]
    out = run_merge(ctx, [pdf, *images])
    assert len(PdfReader(out).pages) == 2 + len(images)


def test_pillow_fallback_when_img2pdf_refuses(
    tmp_path: Path, ctx: RecordingContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_convert = img2pdf.convert

    def picky(src: Any, **kwargs: Any) -> bytes:
        if isinstance(src, str):  # direct conversion of the user's file: refuse it
            raise img2pdf.ImageOpenError("unsupported")
        result: bytes = real_convert(src, **kwargs)
        return result

    monkeypatch.setattr(img2pdf, "convert", picky)
    pdf = make_text_pdf(tmp_path / "doc.pdf", 1)
    images = [
        make_image(tmp_path / "alpha.png", mode="RGBA", color=(255, 0, 0, 128)),
        make_image(tmp_path / "la.png", mode="LA", color=(80, 200)),
        make_image(tmp_path / "hsv.tif", mode="RGB"),
        make_image(tmp_path / "pal.gif", mode="P", color=(3,)),
    ]
    out = run_merge(ctx, [pdf, *images])
    assert len(PdfReader(out).pages) == 1 + len(images)


def test_corrupt_image_reported(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "doc.pdf", 1)
    bad = tmp_path / "broken.png"
    bad.write_bytes(b"\x89PNG\r\n\x1a\n not really")
    with pytest.raises(EngineError) as info:
        run_merge(ctx, [pdf, bad])
    assert (info.value.code, info.value.file) == ("CORRUPT_FILE", str(bad))


# --- errors -----------------------------------------------------------------------------------


def test_password_required(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    locked = make_encrypted_pdf(tmp_path / "locked.pdf", 2, "s3cret")
    with pytest.raises(EngineError) as info:
        run_merge(ctx, [a, locked])
    assert (info.value.code, info.value.file) == ("PASSWORD_REQUIRED", str(locked))


def test_wrong_password(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    locked = make_encrypted_pdf(tmp_path / "locked.pdf", 2, "s3cret")
    with pytest.raises(EngineError) as info:
        run_merge(ctx, [a, locked], passwords={str(locked): "guess"})
    assert info.value.code == "WRONG_PASSWORD"


def test_correct_password(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    locked = make_encrypted_pdf(tmp_path / "locked.pdf", 2, "s3cret")
    out = run_merge(ctx, [a, locked], passwords={str(locked): "s3cret"})
    assert page_texts(out) == [page_label("a", 1), page_label("locked", 1), page_label("locked", 2)]


def test_corrupt_pdf(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    bad = make_corrupt_pdf(tmp_path / "bad.pdf")
    with pytest.raises(EngineError) as info:
        run_merge(ctx, [a, bad])
    assert (info.value.code, info.value.file) == ("CORRUPT_FILE", str(bad))


def test_not_a_pdf(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    fake = make_not_pdf(tmp_path / "fake.pdf")
    with pytest.raises(EngineError) as info:
        run_merge(ctx, [a, fake])
    assert (info.value.code, info.value.file) == ("INVALID_INPUT", str(fake))


def test_missing_file(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    with pytest.raises(EngineError) as info:
        run_merge(ctx, [a, tmp_path / "gone.pdf"])
    assert info.value.code == "INVALID_INPUT"


@pytest.mark.parametrize(
    "params",
    [
        {"inputs": []},
        {"inputs": ["only-one.pdf"]},
        {"inputs": "a.pdf"},
        {"inputs": ["a.pdf", 3]},
        {"inputs": ["a.pdf", "b.pdf"], "options": {"bookmarks": "yes"}},
        {"inputs": ["a.pdf", "b.pdf"], "output": "out.docx"},
    ],
)
def test_invalid_params(params: dict[str, Any], ctx: RecordingContext) -> None:
    with pytest.raises(EngineError) as info:
        merge(params, ctx)
    assert info.value.code == "INVALID_INPUT"


def test_too_many_inputs(ctx: RecordingContext) -> None:
    with pytest.raises(EngineError):
        merge({"inputs": [f"{n}.pdf" for n in range(501)]}, ctx)


# --- cancellation -----------------------------------------------------------------------------


def test_cancel_mid_job_leaves_no_output(tmp_path: Path) -> None:
    inputs = [make_text_pdf(tmp_path / f"f{n}.pdf", 2) for n in range(5)]
    ctx = RecordingContext(tmp_path / "job", cancel_after=2)
    with pytest.raises(Cancelled):
        run_merge(ctx, inputs)
    assert not list(tmp_path.glob("*_merge*.pdf"))
    assert not list(tmp_path.glob(".*.part"))


def test_cancel_during_save_leaves_no_output(tmp_path: Path) -> None:
    inputs = [make_text_pdf(tmp_path / f"f{n}.pdf", 20) for n in range(3)]
    ctx = RecordingContext(tmp_path / "job")
    original = ctx.progress

    def cancel_when_saving(percent: float, message: str = "") -> None:
        original(percent, message)
        if message == "Saving":
            ctx.token.cancel()

    ctx.progress = cancel_when_saving  # type: ignore[method-assign]
    with pytest.raises(Cancelled):
        run_merge(ctx, inputs)
    assert not list(tmp_path.glob("*_merge*.pdf"))


# --- scale & performance ----------------------------------------------------------------------


def test_perf_merge_10_by_10_pages_under_2s(tmp_path: Path, ctx: RecordingContext) -> None:
    """docs/05_NON_FUNCTIONAL.md P3."""
    inputs = [make_text_pdf(tmp_path / f"f{n}.pdf", 10) for n in range(10)]
    start = time.perf_counter()
    out = run_merge(ctx, inputs)
    elapsed = time.perf_counter() - start
    assert len(PdfReader(out).pages) == 100
    assert elapsed < 2.0, f"merge took {elapsed:.2f}s"


def test_max_inputs_500(tmp_path: Path, ctx: RecordingContext) -> None:
    template = make_text_pdf(tmp_path / "t.pdf", 1)
    data = template.read_bytes()
    inputs = []
    for n in range(500):
        p = tmp_path / "many" / f"{n:03}.pdf"
        p.parent.mkdir(exist_ok=True)
        p.write_bytes(data)
        inputs.append(p)
    out = run_merge(ctx, inputs)
    assert len(PdfReader(out).pages) == 500


def test_form_fields_survive_merge(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_form_pdf(tmp_path / "a.pdf", "name")
    b = make_form_pdf(tmp_path / "b.pdf", "name")  # same field name: must not collapse
    out = run_merge(ctx, [a, b])
    with pikepdf.open(out) as pdf:
        fields = pdf.Root.AcroForm.Fields
        assert len(fields) == 2
        assert len({str(f.T) for f in fields}) == 2


# --- protected inputs (decision: output unencrypted, UI warns) ---------------------------------


def test_protected_inputs_are_counted_and_output_is_unprotected(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    plain = make_text_pdf(tmp_path / "a.pdf", 1)
    locked = make_encrypted_pdf(tmp_path / "locked.pdf", 1, "s3cret")
    restricted = make_restricted_pdf(tmp_path / "restricted.pdf", 1)
    result = merge(
        {
            "inputs": [str(plain), str(locked), str(restricted)],
            "passwords": {str(locked): "s3cret"},
        },
        ctx,
    )
    assert result.stats["protected_inputs"] == 2
    with pikepdf.open(result.outputs[0]) as pdf:
        assert not pdf.is_encrypted
        assert len(pdf.pages) == 3


def test_unprotected_inputs_report_zero(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    b = make_image(tmp_path / "b.png")
    result = merge({"inputs": [str(a), str(b)]}, ctx)
    assert result.stats["protected_inputs"] == 0
