"""Compress PDF (docs/02 B1; docs/07 §3: compressed scanned corpus is smaller, else the
original is kept and flagged)."""

from __future__ import annotations

import io
import time
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from pikepdf import Name
from PIL import Image
from pypdf import PdfReader
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from protocol import EngineError
from tests.fixtures import make_encrypted_pdf, make_image_pdf, make_text_pdf
from tests.helpers import RecordingContext, sha256
from tools.optimize import compress
from utils.placement import image_display_sizes


def run(ctx: RecordingContext, src: Path, **options: Any) -> Any:
    return compress({"inputs": [str(src)], "options": options}, ctx)


def scan(path: Path, pages: int = 3) -> Path:
    """200-dpi colour 'scans' at high JPEG quality — what Compress is for."""
    return make_image_pdf(path, pages, (1654, 2339), quality=95, grain=3)


def image_streams(path: Path) -> list[dict[str, Any]]:
    """Width, filter, colour space and raw data of every image (read while the file is open)."""
    with pikepdf.open(path) as pdf:
        return [
            {
                "width": int(o.Width),
                "filter": o.get("/Filter"),
                "colorspace": o.get("/ColorSpace"),
                "raw": o.read_raw_bytes(),
            }
            for o in pdf.objects
            if isinstance(o, pikepdf.Stream) and o.get("/Subtype") == Name.Image
        ]


def test_scanned_corpus_gets_smaller(tmp_path: Path, ctx: RecordingContext) -> None:
    """docs/07 §3: output < input for the scanned corpus."""
    src = scan(tmp_path / "scan.pdf")
    result = run(ctx, src)
    out = result.outputs[0]
    assert out.name == "scan_compressed.pdf"
    assert out.stat().st_size < src.stat().st_size * 0.8
    assert result.stats["saved_percent"] > 20
    assert result.stats["images_recompressed"] == 3
    assert result.stats["original_bytes"] == src.stat().st_size
    assert len(PdfReader(out).pages) == 3


def test_images_are_downsampled_to_the_level_dpi(tmp_path: Path, ctx: RecordingContext) -> None:
    src = scan(tmp_path / "scan.pdf", 1)
    with pikepdf.open(src) as pdf:
        ((drawn_w, _),) = image_display_sizes(pdf).values()
    out = run(ctx, src, level="recommended").outputs[0]
    (image,) = image_streams(out)
    assert abs(image["width"] - drawn_w / 72 * 150) <= 2
    assert image["filter"] == Name.DCTDecode


def test_levels_are_ordered(tmp_path: Path) -> None:
    src = scan(tmp_path / "scan.pdf", 2)
    sizes = {}
    for level in ("extreme", "recommended", "low"):
        result = run(RecordingContext(tmp_path / level), src, level=level)
        sizes[level] = result.stats["bytes"]
    assert sizes["extreme"] < sizes["recommended"] <= sizes["low"]


def test_custom_grayscale_and_metadata(tmp_path: Path, ctx: RecordingContext) -> None:
    src = scan(tmp_path / "scan.pdf", 1)
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.docinfo["/Author"] = "Someone"
        with pdf.open_metadata() as meta:
            meta["dc:title"] = "Secret title"
        pdf.save(src)
    out = run(
        ctx, src, level="custom", dpi=100, quality=50, grayscale=True, remove_metadata=True
    ).outputs[0]
    (image,) = image_streams(out)
    assert image["colorspace"] == Name.DeviceGray
    with pikepdf.open(out) as pdf:
        assert "/Author" not in pdf.docinfo
        assert "/Metadata" not in pdf.Root


def test_already_compressed_file_keeps_original(tmp_path: Path) -> None:
    """docs/02 B1: if the output would not be smaller, keep the original and say so."""
    src = scan(tmp_path / "scan.pdf", 1)
    once = run(RecordingContext(tmp_path / "j1"), src).outputs[0]
    files_before = sorted(p.name for p in tmp_path.glob("*.pdf"))
    again = run(RecordingContext(tmp_path / "j2"), once)
    assert again.outputs == []
    assert again.stats["kept_original"] is True
    assert again.stats["bytes"] == once.stat().st_size
    assert sorted(p.name for p in tmp_path.glob("*.pdf")) == files_before  # no new file


def _pdf_with(path: Path, img: Image.Image, fmt: str) -> Path:
    buffer = io.BytesIO()
    img.save(buffer, fmt, **({"quality": 95} if fmt == "JPEG" else {}))
    buffer.seek(0)
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawImage(ImageReader(buffer), 36, 72, width=500, height=700)
    c.showPage()
    c.save()
    return path


def test_line_art_is_left_lossless(tmp_path: Path, ctx: RecordingContext) -> None:
    art = Image.new("RGB", (2400, 3200), "white")
    for x in range(0, 2400, 40):
        art.paste((0, 0, 0), (x, 0, x + 4, 3200))
    src = _pdf_with(tmp_path / "chart.pdf", art, "PNG")
    result = run(ctx, src)
    images = image_streams(result.outputs[0]) if result.outputs else image_streams(src)
    assert all(img["filter"] != Name.DCTDecode for img in images)


def test_cmyk_images_are_untouched(tmp_path: Path, ctx: RecordingContext) -> None:
    cmyk = Image.new("CMYK", (2000, 2800), (10, 80, 30, 5))
    src = _pdf_with(tmp_path / "print.pdf", cmyk, "JPEG")
    before = [img["raw"] for img in image_streams(src)]
    result = run(ctx, src)
    after = image_streams(result.outputs[0]) if result.outputs else image_streams(src)
    assert [img["raw"] for img in after] == before


def test_placement_inside_scaled_form(tmp_path: Path) -> None:
    """An image drawn through a form XObject with a /Matrix is measured at its real size."""
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    image = pikepdf.Stream(pdf, b"\x80" * 30)
    image.Type, image.Subtype = Name.XObject, Name.Image
    image.Width, image.Height, image.BitsPerComponent = 10, 1, 8
    image.ColorSpace = Name.DeviceRGB
    form = pikepdf.Stream(pdf, b"q 100 0 0 50 0 0 cm /Im0 Do Q")
    form.Type, form.Subtype = Name.XObject, Name.Form
    form.BBox = pikepdf.Array([0, 0, 1000, 1000])
    form.Matrix = pikepdf.Array([2, 0, 0, 2, 0, 0])
    form.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=image))
    page = pdf.pages[0]
    page.obj.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm0=form))
    page.obj.Contents = pdf.make_stream(b"q 1.5 0 0 1.5 10 10 cm /Fm0 Do Q")
    (size,) = image_display_sizes(pdf).values()
    assert size == pytest.approx((300.0, 150.0))  # 100 x 50, x2 (form), x1.5 (page)


def test_keeps_password(tmp_path: Path, ctx: RecordingContext) -> None:
    plain = scan(tmp_path / "scan.pdf", 1)
    with pikepdf.open(plain) as pdf:
        locked = tmp_path / "locked.pdf"
        pdf.save(locked, encryption=pikepdf.Encryption(user="pw", owner="pw"))
    result = compress({"inputs": [str(locked)], "passwords": {str(locked): "pw"}}, ctx)
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(result.outputs[0])


def test_text_is_unchanged(tmp_path: Path, ctx: RecordingContext) -> None:
    src = scan(tmp_path / "scan.pdf", 2)
    out = run(ctx, src).outputs[0]
    before = [p.extract_text() for p in PdfReader(src).pages]
    assert [p.extract_text() for p in PdfReader(out).pages] == before


@pytest.mark.parametrize(
    "options",
    [{"level": "maximum"}, {"level": "custom", "dpi": 10}, {"level": "custom", "quality": 100}],
)
def test_invalid(options: dict[str, Any], tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    with pytest.raises(EngineError) as info:
        run(ctx, src, **options)
    assert info.value.code == "INVALID_INPUT"


def test_input_untouched(tmp_path: Path, ctx: RecordingContext) -> None:
    src = scan(tmp_path / "scan.pdf", 1)
    before = sha256(src)
    run(ctx, src)
    assert sha256(src) == before


def test_password_required(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_encrypted_pdf(tmp_path / "locked.pdf", 1, "pw")
    with pytest.raises(EngineError) as info:
        run(ctx, src)
    assert info.value.code == "PASSWORD_REQUIRED"


def test_perf_image_heavy(tmp_path: Path, ctx: RecordingContext) -> None:
    """Scaled-down docs/05 P4 (50 MB ≤ 30 s): ~10 MB of scans must take well under 6 s."""
    src = scan(tmp_path / "big.pdf", 8)
    start = time.perf_counter()
    run(ctx, src)
    elapsed = time.perf_counter() - start
    mb = src.stat().st_size / 1024 / 1024
    assert elapsed < max(6.0, mb * 0.6), f"{mb:.1f} MB took {elapsed:.1f}s"
