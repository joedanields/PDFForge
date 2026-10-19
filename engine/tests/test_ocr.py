"""OCR PDF (docs/02 B3): invisible text layer via the bundled Tesseract, no OCRmyPDF."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from PIL import Image

from jobs import Cancelled
from protocol import EngineError, ErrorCode
from tests.fixtures import make_scanned_text_pdf, make_text_pdf
from tests.helpers import RecordingContext, sha256
from tools.ocr import ocr, skew_angle
from utils.vendor import tesseract_path

pytestmark = pytest.mark.skipif(not tesseract_path().is_file(), reason="Tesseract not fetched")

LINES = [
    "Invoice number 4711 for PDFForge",
    "Total amount due 1234 rupees",
    "Payment within thirty days please",
    "Thank you for your business today",
]


def run(ctx: RecordingContext, inputs: list[Path], **params: Any) -> Any:
    return ocr({"inputs": [str(p) for p in inputs], **params}, ctx)


def page_texts(path: Path) -> list[str]:
    doc = pdfium.PdfDocument(str(path))
    try:
        return [p.get_textpage().get_text_range().replace("\r\n", " ") for p in doc]
    finally:
        doc.close()


def first_image(pdf: pikepdf.Pdf) -> Image.Image:
    stream = next(iter(pdf.pages[0].get_images().values()))
    assert isinstance(stream, pikepdf.Stream)
    return pikepdf.PdfImage(stream).as_pil_image()


def render(path: Path) -> Image.Image:
    doc = pdfium.PdfDocument(str(path))
    try:
        image: Image.Image = doc[0].render(scale=0.5).to_pil().convert("L")
        return image
    finally:
        doc.close()


def test_scan_becomes_searchable_and_looks_the_same(tmp_path: Path, ctx: RecordingContext) -> None:
    scan = make_scanned_text_pdf(tmp_path / "scan.pdf", LINES, pages=2)
    before = sha256(scan)
    result = run(ctx, [scan])
    out = result.outputs[0]
    assert out == tmp_path / "scan_ocr.pdf"
    assert sha256(scan) == before
    texts = page_texts(out)
    assert "Invoice number 4711 for PDFForge" in texts[0]
    assert "Thank you for your business today p2" in texts[1]
    assert result.stats["ocr_pages"] == 2
    assert result.stats["languages"] == "eng"
    # The text layer is invisible: the page renders exactly as before.
    assert render(out).tobytes() == render(scan).tobytes()


def test_text_layer_lines_up_with_the_picture(tmp_path: Path, ctx: RecordingContext) -> None:
    scan = make_scanned_text_pdf(tmp_path / "scan.pdf", LINES, dpi=200)
    out = run(ctx, [scan]).outputs[0]
    doc = pdfium.PdfDocument(str(out))
    try:
        page = doc[0]
        textpage = page.get_textpage()
        found = textpage.search("Invoice")
        assert found.get_next() is not None
        rects = [textpage.get_charbox(i) for i in range(textpage.count_chars())[:1]]
        left, _bottom, _right, top = rects[0]
        # The fixture draws the first line 1 inch from the left and top edge.
        assert left == pytest.approx(72, abs=8)
        assert page.get_height() - top == pytest.approx(72, abs=12)
    finally:
        doc.close()


def test_pages_with_text_are_skipped_unless_forced(tmp_path: Path, ctx: RecordingContext) -> None:
    digital = make_text_pdf(tmp_path / "digital.pdf", 2)
    result = run(ctx, [digital])
    assert result.outputs == []
    assert result.stats["skipped_pages"] == 2
    assert "already contains text" in result.stats["no_output_reason"]
    forced = run(RecordingContext(tmp_path / "j2"), [digital], options={"force": True})
    assert forced.stats["ocr_pages"] == 2
    assert forced.outputs[0].name == "digital_ocr.pdf"


def test_auto_rotate_turns_sideways_scans_upright(tmp_path: Path, ctx: RecordingContext) -> None:
    scan = make_scanned_text_pdf(tmp_path / "sideways.pdf", LINES, turn=90)
    result = run(ctx, [scan])
    assert result.stats["rotated"] == 1
    with pikepdf.open(result.outputs[0]) as pdf:
        assert int(pdf.pages[0].obj.Rotate) == 90
    assert "Invoice number 4711" in page_texts(result.outputs[0])[0]
    plain = run(RecordingContext(tmp_path / "j2"), [scan], options={"auto_rotate": False})
    assert plain.stats["rotated"] == 0


def test_deskew_straightens_the_scan(tmp_path: Path, ctx: RecordingContext) -> None:
    scan = make_scanned_text_pdf(tmp_path / "skewed.pdf", LINES, skew=2.5)
    with pikepdf.open(scan) as pdf:
        original = first_image(pdf)
    assert skew_angle(original) == pytest.approx(-2.5, abs=0.3)
    result = run(ctx, [scan], options={"deskew": True})
    assert result.stats["deskewed"] == 1
    with pikepdf.open(result.outputs[0]) as pdf:
        fixed = first_image(pdf)
    assert fixed.size == original.size
    assert skew_angle(fixed) == 0.0
    assert "Payment within thirty days please" in page_texts(result.outputs[0])[0]


def test_skew_angle_is_zero_for_straight_and_blank_pages() -> None:
    assert skew_angle(Image.new("L", (800, 1000), 255)) == 0.0


def test_ocr_speed_per_page(tmp_path: Path, ctx: RecordingContext) -> None:
    """docs/05 P6: OCR ≤ 4 s per page at 300 dpi, using all cores."""
    scan = make_scanned_text_pdf(tmp_path / "four.pdf", LINES, pages=4)
    started = time.monotonic()
    result = run(ctx, [scan])
    per_page = (time.monotonic() - started) / 4
    assert result.stats["ocr_pages"] == 4
    assert per_page < 4, f"{per_page:.1f} s per page"


def test_encrypted_scan_keeps_its_password(tmp_path: Path) -> None:
    scan = make_scanned_text_pdf(tmp_path / "scan.pdf", LINES)
    secret = tmp_path / "secret.pdf"
    with pikepdf.open(scan) as pdf:
        pdf.save(secret, encryption=pikepdf.Encryption(user="pw", owner="pw"))
    with pytest.raises(EngineError) as err:
        run(RecordingContext(tmp_path / "j1"), [secret])
    assert err.value.code == ErrorCode.PASSWORD_REQUIRED
    result = run(RecordingContext(tmp_path / "j2"), [secret], passwords={str(secret): "pw"})
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(result.outputs[0])
    with pikepdf.open(result.outputs[0], password="pw") as pdf:
        assert len(pdf.pages) == 1


def test_languages_are_checked(tmp_path: Path, ctx: RecordingContext) -> None:
    scan = make_scanned_text_pdf(tmp_path / "scan.pdf", LINES)
    with pytest.raises(EngineError) as err:
        run(ctx, [scan], options={"languages": "eng+xyz"})
    assert err.value.code == ErrorCode.UNSUPPORTED
    result = run(RecordingContext(tmp_path / "j2"), [scan], options={"languages": "eng+tam"})
    assert result.stats["languages"] == "eng+tam"


def test_cancel_stops_tesseract_and_leaves_nothing(tmp_path: Path) -> None:
    scan = make_scanned_text_pdf(tmp_path / "scan.pdf", LINES, pages=6)
    ctx = RecordingContext(tmp_path / "job", cancel_after=8)
    with pytest.raises(Cancelled):
        run(ctx, [scan])
    assert not (tmp_path / "scan_ocr.pdf").exists()


def test_rejects_non_pdf(tmp_path: Path, ctx: RecordingContext) -> None:
    other = tmp_path / "a.txt"
    other.write_text("x")
    with pytest.raises(EngineError):
        run(ctx, [other])
