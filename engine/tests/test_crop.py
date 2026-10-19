"""Crop PDF (docs/02 E4): CropBox from a drawn area or auto-trimmed margins, lossless."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from protocol import EngineError, ErrorCode
from tests.fixtures import make_encrypted_pdf, make_text_pdf
from tests.helpers import RecordingContext, sha256
from tools.edit import crop


def run(ctx: RecordingContext, pdf: Path, **options: Any) -> Any:
    return crop({"inputs": [str(pdf)], "options": options}, ctx)


def crop_box(path: Path, index: int = 0) -> list[float]:
    with pikepdf.open(path) as pdf:
        return [round(float(v), 1) for v in pdf.pages[index].obj.CropBox]


def make_framed_pdf(path: Path, rotate: int = 0) -> Path:
    """A4 page with a filled square at (200..300, 400..500) and nothing else."""
    c = canvas.Canvas(str(path), pagesize=A4)
    c.rect(200, 400, 100, 100, fill=1)
    c.showPage()
    c.save()
    if rotate:
        with pikepdf.open(path, allow_overwriting_input=True) as pdf:
            pdf.pages[0].obj.Rotate = rotate
            pdf.save(path)
    return path


def test_drawn_box_sets_the_cropbox(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "doc.pdf", 3)
    before = sha256(pdf)
    result = run(ctx, pdf, box=[0.1, 0.2, 0.6, 0.7], pages="2")
    out = result.outputs[0]
    assert out == tmp_path / "doc_cropped.pdf"
    assert sha256(pdf) == before
    width, height = 595.28, 841.89
    expected = [0.1 * width, (1 - 0.7) * height, 0.6 * width, (1 - 0.2) * height]
    assert crop_box(out, 1) == pytest.approx(expected, abs=0.2)
    with pikepdf.open(out) as cropped, pikepdf.open(pdf) as original:
        assert "/CropBox" not in cropped.pages[0].obj  # page 1 untouched
        # Lossless: the page content is exactly the same.
        assert cropped.pages[1].Contents.read_bytes() == original.pages[1].Contents.read_bytes()
    assert result.stats == {"pages": 3, "cropped": 1, "mode": "box"}


def test_box_is_in_display_coordinates_on_rotated_pages(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    pdf = make_framed_pdf(tmp_path / "rot.pdf", rotate=90)
    # Keep the left half of the page *as displayed* (landscape after rotation).
    out = run(ctx, pdf, box=[0.0, 0.0, 0.5, 1.0]).outputs[0]
    doc = pdfium.PdfDocument(str(out))
    try:
        width, height = doc[0].get_size()
    finally:
        doc.close()
    assert width == pytest.approx(841.89 / 2, abs=1)
    assert height == pytest.approx(595.28, abs=1)


def test_auto_trim_keeps_content_plus_margin(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_framed_pdf(tmp_path / "square.pdf")
    out = run(ctx, pdf, mode="auto", margin=10).outputs[0]
    assert crop_box(out) == pytest.approx([190, 390, 310, 510], abs=2)


def test_auto_trim_skips_blank_pages(tmp_path: Path, ctx: RecordingContext) -> None:
    blank = tmp_path / "blank.pdf"
    c = canvas.Canvas(str(blank), pagesize=A4)
    c.showPage()
    c.save()
    with pytest.raises(EngineError) as err:
        run(ctx, blank, mode="auto")
    assert err.value.code == ErrorCode.INVALID_INPUT


def test_encrypted_file_keeps_protection(tmp_path: Path) -> None:
    pdf = make_encrypted_pdf(tmp_path / "secret.pdf", 1, "pw")
    result = crop(
        {
            "inputs": [str(pdf)],
            "options": {"box": [0.1, 0.1, 0.9, 0.9]},
            "passwords": {str(pdf): "pw"},
        },
        RecordingContext(tmp_path / "job"),
    )
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(result.outputs[0])


@pytest.mark.parametrize("box", [None, [0.1, 0.1], [0.5, 0.5, 0.51, 0.9], ["a", 0, 1, 1]])
def test_invalid_boxes(tmp_path: Path, ctx: RecordingContext, box: Any) -> None:
    pdf = make_text_pdf(tmp_path / "doc.pdf", 1)
    with pytest.raises(EngineError) as err:
        run(ctx, pdf, box=box)
    assert err.value.code == ErrorCode.INVALID_INPUT
