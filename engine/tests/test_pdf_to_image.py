"""PDF → Image (docs/02 D1)."""

from __future__ import annotations

import base64
import zipfile
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from PIL import Image

from protocol import EngineError
from tests.fixtures import make_encrypted_pdf, make_image, make_image_pdf, make_text_pdf
from tests.helpers import RecordingContext, sha256
from tools.from_pdf import pdf_to_image


def run(ctx: RecordingContext, src: Path, **options: Any) -> Any:
    return pdf_to_image({"inputs": [str(src)], "options": options}, ctx)


@pytest.mark.parametrize(("dpi", "size"), [(72, (595, 842)), (150, (1240, 1754))])
def test_renders_pages_at_dpi(
    dpi: int, size: tuple[int, int], tmp_path: Path, ctx: RecordingContext
) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 2)
    result = run(ctx, src, dpi=dpi, format="png")
    assert [p.name for p in result.outputs] == ["doc_page-1.png", "doc_page-2.png"]
    assert result.stats["folder"].endswith("doc_images")
    with Image.open(result.outputs[0]) as img:
        assert abs(img.width - size[0]) <= 2 and abs(img.height - size[1]) <= 2
        assert img.format == "PNG"


def test_jpeg_output_and_page_range(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 5)
    result = run(ctx, src, format="jpg", dpi=72, pages="2,4")
    assert [p.name for p in result.outputs] == ["doc_page-2.jpg", "doc_page-4.jpg"]
    with Image.open(result.outputs[1]) as img:
        assert img.format == "JPEG"
        assert img.getpixel((5, 5)) == (255, 255, 255)  # white background, not transparent black


def test_single_page_is_a_plain_file(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    result = run(ctx, src, pages="3", dpi=72)
    assert result.outputs == [tmp_path / "doc_page-3.jpg"]


def test_zip(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    result = run(ctx, src, dpi=72, zip=True)
    assert result.outputs == [tmp_path / "doc_images.zip"]
    with zipfile.ZipFile(result.outputs[0]) as zf:
        assert len(zf.namelist()) == 3


def _jpeg_payload(img: pikepdf.Object) -> bytes:
    """The JPEG inside an image stream; reportlab wraps it in ASCII85, which qpdf will not
    strip on its own while DCT stays encoded."""
    raw = img.read_raw_bytes()
    filters = img.get("/Filter")
    names = [str(f) for f in filters] if isinstance(filters, pikepdf.Array) else [str(filters)]
    if "/ASCII85Decode" in names:
        raw = base64.a85decode(raw.strip().removesuffix(b"~>"))
    return raw


def test_extract_embedded_images_byte_for_byte(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_image_pdf(tmp_path / "scan.pdf", 2)
    with pikepdf.open(src) as pdf:
        originals = sorted(
            _jpeg_payload(img) for page in pdf.pages for img in page.get_images().values()
        )
    result = run(ctx, src, mode="extract")
    assert result.stats["images"] == 2
    assert all(p.suffix == ".jpg" for p in result.outputs)
    assert sorted(p.read_bytes() for p in result.outputs) == originals


def test_extract_deduplicates_reused_images(tmp_path: Path, ctx: RecordingContext) -> None:
    logo = make_image(tmp_path / "logo.png", (120, 60))
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    path = tmp_path / "letterhead.pdf"
    c = canvas.Canvas(str(path), pagesize=A4)
    for _ in range(3):
        c.drawImage(str(logo), 40, 760, width=120, height=60)
        c.showPage()
    c.save()
    result = run(ctx, path, mode="extract")
    assert result.stats["images"] == 1


def test_extract_without_images(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "text.pdf", 2)
    with pytest.raises(EngineError) as info:
        run(ctx, src, mode="extract")
    assert "no embedded images" in info.value.message


def test_password_protected(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_encrypted_pdf(tmp_path / "locked.pdf", 1, "pw")
    with pytest.raises(EngineError) as info:
        run(ctx, src)
    assert info.value.code == "PASSWORD_REQUIRED"
    result = pdf_to_image(
        {"inputs": [str(src)], "options": {"dpi": 72}, "passwords": {str(src): "pw"}},
        RecordingContext(tmp_path / "j2"),
    )
    assert len(result.outputs) == 1


@pytest.mark.parametrize("options", [{"dpi": 96}, {"format": "gif"}, {"pages": "7"}, {"mode": "x"}])
def test_invalid_options(options: dict[str, Any], tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 2)
    with pytest.raises(EngineError) as info:
        run(ctx, src, **options)
    assert info.value.code == "INVALID_INPUT"


def test_input_untouched(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    before = sha256(src)
    run(ctx, src, dpi=72)
    assert sha256(src) == before
