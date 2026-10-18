"""Add page numbers (docs/02 E2): text, formats, and placement on rotated / cropped pages."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from pikepdf import Array
from PIL import Image, ImageChops, ImageStat
from pypdf import PdfReader

from protocol import EngineError
from tests.fixtures import make_encrypted_pdf, make_text_pdf
from tests.helpers import RecordingContext, sha256
from tools.edit import number_label, page_numbers


def run(ctx: RecordingContext, src: Path, **options: Any) -> Any:
    return page_numbers({"inputs": [str(src)], "options": options}, ctx)


def texts(path: Path) -> list[str]:
    return [(p.extract_text() or "").strip() for p in PdfReader(path).pages]


def render(path: Path, index: int = 0) -> Image.Image:
    doc = pdfium.PdfDocument(str(path))
    try:
        image: Image.Image = (
            doc[index].render(scale=1, fill_color=(255, 255, 255, 255)).to_pil().convert("L")
        )
        return image
    finally:
        doc.close()


def stamp_box(before: Path, after: Path, index: int = 0) -> tuple[int, int, int, int]:
    """Bounding box (display pixels) of what the tool added to page ``index``."""
    box = ImageChops.difference(render(before, index), render(after, index)).getbbox()
    assert box is not None, "nothing was drawn"
    return box


def blank_pdf(path: Path, size: tuple[float, float] = (595, 842), rotate: int = 0) -> Path:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=size)
    if rotate:
        pdf.pages[0].obj.Rotate = rotate
    pdf.save(path)
    return path


# ── text & formats ────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("fmt", "expected"),
    [
        ("n", "3"),
        ("page_n", "Page 3"),
        ("n_of_total", "3 of 9"),
        ("page_n_of_total", "Page 3 of 9"),
        ("custom", "- 3 / 9 -"),
    ],
)
def test_formats(fmt: str, expected: str) -> None:
    assert number_label(fmt, "- {n} / {total} -", 3, 9) == expected


def test_custom_template_is_literal() -> None:
    assert number_label("custom", "{n} {0} {__class__}", 1, 2) == "1 {0} {__class__}"


def test_numbers_every_page(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    result = run(ctx, src, format="page_n_of_total")
    out = result.outputs[0]
    assert out.name == "doc_numbered.pdf"
    assert [t.splitlines()[-1] for t in texts(out)] == ["Page 1 of 3", "Page 2 of 3", "Page 3 of 3"]
    assert result.stats["numbered"] == 3


def test_first_number_skip_first_and_range(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 6)
    result = run(ctx, src, first_number=10, skip_first=True, pages="1-4", format="n_of_total")
    lines = texts(result.outputs[0])
    assert "of" not in lines[0]  # skipped
    assert lines[1].endswith("10 of 12") and lines[3].endswith("12 of 12")
    assert "of" not in lines[4]  # outside the range
    assert (result.stats["first"], result.stats["last"]) == (10, 12)


# ── placement ─────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_bottom_right_is_where_the_reader_sees_it(
    rotate: int, tmp_path: Path, ctx: RecordingContext
) -> None:
    src = blank_pdf(tmp_path / f"r{rotate}.pdf", rotate=rotate)
    out = run(ctx, src, position="bottom-right", margin=30, size=20).outputs[0]
    width, height = render(out).size
    x0, y0, x1, y1 = stamp_box(src, out)
    assert width - 60 < x1 <= width - 25, (rotate, (x0, y0, x1, y1))
    assert height - 60 < y1 <= height - 25, (rotate, (x0, y0, x1, y1))
    assert x1 - x0 < 30 and y1 - y0 < 30  # one small upright number, not a rotated column


def test_numbers_read_upright_on_rotated_pages(tmp_path: Path) -> None:
    crops = {}
    for rotate in (0, 90, 180, 270):
        src = blank_pdf(tmp_path / f"u{rotate}.pdf", rotate=rotate)
        out = run(
            RecordingContext(tmp_path / f"j{rotate}"),
            src,
            position="top-left",
            size=40,
            first_number=27,
        ).outputs[0]
        box = stamp_box(src, out)
        crops[rotate] = render(out).crop(box)
    upright = crops[0]
    for rotate in (90, 180, 270):
        crop = crops[rotate].resize(upright.size)
        mean = ImageStat.Stat(ImageChops.difference(upright, crop)).mean[0]
        flipped_mean = ImageStat.Stat(ImageChops.difference(upright, upright.rotate(180))).mean[0]
        assert mean < flipped_mean / 3, f"/Rotate {rotate}: number is not upright"


def test_respects_cropbox_offset(tmp_path: Path, ctx: RecordingContext) -> None:
    src = blank_pdf(tmp_path / "cropped.pdf", size=(800, 1000))
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.pages[0].obj.CropBox = Array([100, 150, 695, 992])  # shows 595 x 842
        pdf.save(src)
    out = run(ctx, src, position="bottom-left", margin=20, size=20).outputs[0]
    x0, _, _, y1 = stamp_box(src, out)
    width, height = render(out).size
    assert (width, height) == (595, 842)
    assert 15 < x0 < 40 and height - 50 < y1 <= height - 15


def test_facing_pages_mirror(tmp_path: Path, ctx: RecordingContext) -> None:
    src = blank_pdf(tmp_path / "book.pdf")
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.add_blank_page(page_size=(595, 842))
        pdf.save(src)
    out = run(ctx, src, position="bottom-right", facing=True).outputs[0]
    assert stamp_box(src, out, 0)[0] > 400  # page 1 (odd): right
    assert stamp_box(src, out, 1)[2] < 200  # page 2 (even): mirrored left


# ── safety ────────────────────────────────────────────────────────────────────────────────────


def test_keeps_password_protection(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_encrypted_pdf(tmp_path / "locked.pdf", 2, "pw")
    result = page_numbers({"inputs": [str(src)], "passwords": {str(src): "pw"}}, ctx)
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(result.outputs[0])


@pytest.mark.parametrize(
    ("options", "code"),
    [
        ({"format": "custom", "template": "no number"}, "INVALID_INPUT"),
        ({"format": "custom", "template": "பக்கம் {n}"}, "UNSUPPORTED"),
        ({"position": "center"}, "INVALID_INPUT"),
        ({"color": "red"}, "INVALID_INPUT"),
        ({"pages": "1", "skip_first": True}, "INVALID_INPUT"),
    ],
)
def test_invalid(options: dict[str, Any], code: str, tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 2)
    with pytest.raises(EngineError) as info:
        run(ctx, src, **options)
    assert info.value.code == code


def test_input_untouched(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 2)
    before = sha256(src)
    run(ctx, src)
    assert sha256(src) == before
