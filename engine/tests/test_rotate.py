"""Rotate PDF (docs/02 A6, docs/07 §3: rotate is lossless)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pytest
from pikepdf import Array, Name
from reportlab.lib.pagesizes import A4, landscape

from protocol import EngineError
from tests.fixtures import (
    make_encrypted_pdf,
    make_restricted_pdf,
    make_text_pdf,
)
from tests.helpers import RecordingContext, sha256
from tools.organize import rotate
from utils.pageinfo import rotation


def run(ctx: RecordingContext, src: Path, **options: Any) -> Path:
    result = rotate({"inputs": [str(src)], "options": options}, ctx)
    return result.outputs[0]


def rotations(path: Path, password: str = "") -> list[int]:
    with pikepdf.open(path, password=password) as pdf:
        return [rotation(p) for p in pdf.pages]


def content_bytes(path: Path, password: str = "") -> list[bytes]:
    with pikepdf.open(path, password=password) as pdf:
        return [p.obj.Contents.read_bytes() for p in pdf.pages]


def test_rotates_all_pages_by_default(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    out = run(ctx, src)
    assert out.name == "doc_rotate.pdf"
    assert rotations(out) == [90, 90, 90]


@pytest.mark.parametrize("angle", [90, 180, 270])
def test_rotates_selected_pages(angle: int, tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 5)
    out = run(ctx, src, angle=angle, pages="2,4-5")
    assert rotations(out) == [0, angle, 0, angle, angle]


def test_rotation_is_relative_and_wraps(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 2)
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.pages[0].obj.Rotate = 270
        pdf.save(src)
    assert rotations(run(ctx, src, angle=180)) == [90, 180]


def test_inherited_rotation_is_respected(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 2)
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        for page in pdf.pages:
            if "/Rotate" in page.obj:
                del page.obj["/Rotate"]  # reportlab writes /Rotate 0 on every page
        pdf.Root.Pages.Rotate = 90  # inherited by every page
        pdf.save(src)
    assert rotations(run(ctx, src, angle=90)) == [180, 180]


def test_lossless_only_rotate_differs(tmp_path: Path, ctx: RecordingContext) -> None:
    """docs/07 §3: content stream bytes unchanged, only /Rotate differs."""
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    out = run(ctx, src, angle=90, pages="1-2")
    assert content_bytes(out) == content_bytes(src)
    with pikepdf.open(src) as a, pikepdf.open(out) as b:
        for pa, pb in zip(a.pages, b.pages, strict=True):
            keys_a = {k for k in pa.obj if k not in ("/Rotate", "/Parent")}
            keys_b = {k for k in pb.obj if k not in ("/Rotate", "/Parent")}
            assert keys_a == keys_b
            assert list(pa.mediabox) == list(pb.mediabox)


def test_orientation_filter(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "mixed.pdf", 4, page_sizes=[A4, landscape(A4)])
    assert rotations(run(RecordingContext(tmp_path / "j1"), src, orientation="landscape")) == [
        0,
        90,
        0,
        90,
    ]
    assert rotations(run(RecordingContext(tmp_path / "j2"), src, orientation="portrait")) == [
        90,
        0,
        90,
        0,
    ]


def test_filter_with_no_match_is_reported(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 2)  # all portrait
    with pytest.raises(EngineError) as info:
        run(ctx, src, orientation="landscape")
    assert info.value.code == "INVALID_INPUT"


def test_input_unchanged_and_never_overwritten(tmp_path: Path) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 2)
    before = sha256(src)
    first = run(RecordingContext(tmp_path / "j1"), src)
    second = run(RecordingContext(tmp_path / "j2"), src)
    assert sha256(src) == before
    assert (first.name, second.name) == ("doc_rotate.pdf", "doc_rotate (1).pdf")


def test_password_protected_input_keeps_its_protection(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    src = make_encrypted_pdf(tmp_path / "locked.pdf", 2, "pw")
    result = rotate({"inputs": [str(src)], "passwords": {str(src): "pw"}}, ctx)
    out = result.outputs[0]
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(out)
    assert rotations(out, "pw") == [90, 90]


def test_restrictions_are_kept(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_restricted_pdf(tmp_path / "restricted.pdf", 1)
    out = run(ctx, src)
    with pikepdf.open(out) as pdf:
        assert pdf.is_encrypted
        assert not pdf.allow.extract


def test_password_required(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_encrypted_pdf(tmp_path / "locked.pdf", 1, "pw")
    with pytest.raises(EngineError) as info:
        run(ctx, src)
    assert info.value.code == "PASSWORD_REQUIRED"


@pytest.mark.parametrize(
    "options",
    [{"angle": 45}, {"angle": "90"}, {"pages": "9"}, {"pages": "2-1"}, {"orientation": "square"}],
)
def test_invalid_options(options: dict[str, Any], tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    with pytest.raises(EngineError) as info:
        run(ctx, src, **options)
    assert info.value.code == "INVALID_INPUT"


def test_links_still_work_after_rotation(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3, named_link=True)
    out = run(ctx, src)
    with pikepdf.open(out) as pdf:
        annots = pdf.pages[0].obj.Annots
        assert any(a.get("/Subtype") == Name.Link for a in annots)
        assert isinstance(pdf.pages[0].obj.Annots, Array)
