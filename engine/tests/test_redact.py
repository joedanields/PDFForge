"""Redact PDF (docs/02 F4): true redaction — text under the boxes cannot be recovered."""

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
from tools.redact import redact
from utils.vendor import tesseract_path

needs_tesseract = pytest.mark.skipif(not tesseract_path().is_file(), reason="Tesseract not fetched")
W, H = A4


def make_statement(path: Path) -> Path:
    """Page 1: a secret account number at a known place, plus readable public text.
    Page 2: nothing secret."""
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica", 28)
    c.drawString(72, H - 120, "Public heading line")
    c.drawString(72, H - 300, "Account 9876543210")
    # Hidden text under the visible secret (white on white): must go too.
    c.setFillColorRGB(1, 1, 1)
    c.drawString(80, H - 300, "HIDDENSECRET")
    c.setFillColorRGB(0, 0, 0)
    c.showPage()
    c.setFont("Helvetica", 28)
    c.drawString(72, H - 120, "Second page stays")
    c.showPage()
    c.setTitle("Confidential statement")
    c.save()
    return path


# The secret line: baseline 300 pt from the top, 28 pt font -> roughly y 0.33..0.37 of the page.
SECRET_AREA = {"page": 0, "x": 0.08, "y": 0.32, "w": 0.75, "h": 0.05}


def run(ctx: RecordingContext, pdf: Path, areas: list[dict[str, Any]], **options: Any) -> Any:
    return redact({"inputs": [str(pdf)], "options": {"areas": areas, **options}}, ctx)


def page_text(path: Path, index: int) -> str:
    doc = pdfium.PdfDocument(str(path))
    try:
        return str(doc[index].get_textpage().get_text_range())
    finally:
        doc.close()


def test_redacted_text_is_gone_everywhere(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_statement(tmp_path / "statement.pdf")
    before = sha256(pdf)
    result = run(ctx, pdf, [SECRET_AREA], ocr=False)
    out = result.outputs[0]
    assert out == tmp_path / "statement_redacted.pdf"
    assert sha256(pdf) == before
    raw = out.read_bytes()
    for secret in (b"9876543210", b"HIDDENSECRET", b"Account"):
        assert secret not in raw
    assert "9876543210" not in page_text(out, 0)
    with pikepdf.open(out) as redacted:
        page = redacted.pages[0]
        assert list(page.Resources.keys()) == ["/XObject"]  # no fonts left on the page
        assert "/Font" not in page.Resources
        doc = pdfium.PdfDocument(str(out))
        try:
            img = doc[0].render(scale=1).to_pil().convert("L")
        finally:
            doc.close()
        # The marked area is solid black.
        cx = int((SECRET_AREA["x"] + SECRET_AREA["w"] / 2) * img.width)
        cy = int((SECRET_AREA["y"] + SECRET_AREA["h"] / 2) * img.height)
        assert img.getpixel((cx, cy)) < 10


def test_untouched_pages_and_metadata(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_statement(tmp_path / "statement.pdf")
    out = run(ctx, pdf, [SECRET_AREA], ocr=False).outputs[0]
    with pikepdf.open(out) as redacted, pikepdf.open(pdf) as original:
        assert redacted.pages[1].Contents.read_bytes() == original.pages[1].Contents.read_bytes()
        assert "/Title" not in redacted.docinfo
        assert "/Metadata" not in redacted.Root
    assert "Second page stays" in page_text(out, 1)


@needs_tesseract
def test_rest_of_the_page_stays_searchable(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_statement(tmp_path / "statement.pdf")
    result = run(ctx, pdf, [SECRET_AREA])
    text = page_text(result.outputs[0], 0)
    assert "Public heading line" in text
    assert "9876543210" not in text
    assert result.stats["searchable"] is True


def test_rotated_page_areas_are_in_display_coordinates(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    pdf = make_text_pdf(tmp_path / "doc.pdf", 1)
    with pikepdf.open(pdf, allow_overwriting_input=True) as doc:
        doc.pages[0].obj.Rotate = 90
        doc.save(pdf)
    area = {"page": 0, "x": 0.0, "y": 0.0, "w": 0.3, "h": 0.3}
    out = run(ctx, pdf, [area], ocr=False).outputs[0]
    doc = pdfium.PdfDocument(str(out))
    try:
        img = doc[0].render(scale=0.5).to_pil().convert("L")
    finally:
        doc.close()
    assert img.width > img.height  # still displayed landscape
    assert img.getpixel((int(img.width * 0.1), int(img.height * 0.1))) < 10
    assert img.getpixel((int(img.width * 0.8), int(img.height * 0.8))) > 240


def test_encrypted_input_keeps_protection(tmp_path: Path) -> None:
    pdf = make_encrypted_pdf(tmp_path / "secret.pdf", 1, "pw")
    result = redact(
        {
            "inputs": [str(pdf)],
            "options": {"areas": [SECRET_AREA], "ocr": False},
            "passwords": {str(pdf): "pw"},
        },
        RecordingContext(tmp_path / "job"),
    )
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(result.outputs[0])


@pytest.mark.parametrize(
    "areas",
    [[], [{"page": 3, "x": 0, "y": 0, "w": 0.1, "h": 0.1}], [{"page": 0, "x": "a"}], "all"],
)
def test_invalid_areas(tmp_path: Path, ctx: RecordingContext, areas: Any) -> None:
    pdf = make_text_pdf(tmp_path / "doc.pdf", 1)
    with pytest.raises(EngineError) as err:
        run(ctx, pdf, areas)
    assert err.value.code == ErrorCode.INVALID_INPUT
