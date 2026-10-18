"""Add watermark (docs/02 E3)."""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from PIL import Image, ImageChops
from pypdf import PdfReader

from protocol import EngineError
from tests.fixtures import make_encrypted_pdf, make_image, make_text_pdf
from tests.helpers import RecordingContext, sha256
from tools.edit import watermark


def run(ctx: RecordingContext, src: Path, **options: Any) -> Any:
    return watermark({"inputs": [str(src)], "options": options}, ctx)


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
    box = ImageChops.difference(render(before, index), render(after, index)).getbbox()
    assert box is not None, "nothing was drawn"
    return box


def blank_pdf(path: Path, pages: int = 1) -> Path:
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(595, 842))
    pdf.save(path)
    return path


def alphas(path: Path) -> set[Decimal]:
    """Non-stroking alpha values (/ca) used anywhere in the file (direct or indirect)."""
    found: set[Decimal] = set()
    seen: set[tuple[int, int]] = set()

    def walk(obj: Any, depth: int = 0) -> None:
        if depth > 40:
            return
        if isinstance(obj, pikepdf.Object) and obj.is_indirect:
            if obj.objgen in seen:
                return
            seen.add(obj.objgen)
        if isinstance(obj, pikepdf.Dictionary | pikepdf.Stream):
            if "/ca" in obj:
                found.add(Decimal(str(obj.ca)))
            for key in obj:
                if key != "/Parent":
                    walk(obj.get(str(key)), depth + 1)
        elif isinstance(obj, pikepdf.Array):
            for item in obj:
                walk(item, depth + 1)

    with pikepdf.open(path) as pdf:
        walk(pdf.Root)
    return found


def test_text_watermark(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 2)
    result = run(ctx, src, text="CONFIDENTIAL", opacity=0.25)
    out = result.outputs[0]
    assert out.name == "doc_watermark.pdf"
    assert all("CONFIDENTIAL" in (p.extract_text() or "") for p in PdfReader(out).pages)
    assert Decimal("0.25") in alphas(out)
    assert result.stats["watermarked"] == 2


def test_centred_by_default(tmp_path: Path, ctx: RecordingContext) -> None:
    src = blank_pdf(tmp_path / "blank.pdf")
    out = run(ctx, src, text="DRAFT", rotation=0, opacity=1.0).outputs[0]
    x0, y0, x1, y1 = stamp_box(src, out)
    assert abs((x0 + x1) / 2 - 595 / 2) < 6
    assert abs((y0 + y1) / 2 - 842 / 2) < 8


def test_rotated_text_stays_on_the_page(tmp_path: Path, ctx: RecordingContext) -> None:
    src = blank_pdf(tmp_path / "blank.pdf")
    out = run(ctx, src, text="APPROVED", rotation=45, position="top-right", size=60).outputs[0]
    x0, y0, x1, y1 = stamp_box(src, out)
    assert x1 <= 595 and y0 >= 0
    assert x1 - x0 > 150 and y1 - y0 > 150  # diagonal


def test_tiled(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    out = run(ctx, src, text="COPY", tile=True, size=24).outputs[0]
    assert (PdfReader(out).pages[0].extract_text() or "").count("COPY") >= 6


def test_under_vs_over(tmp_path: Path) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    over = run(RecordingContext(tmp_path / "a"), src, text="X", layer="over").outputs[0]
    under = run(RecordingContext(tmp_path / "b"), src, text="X", layer="under").outputs[0]

    with pikepdf.open(over) as a, pikepdf.open(under) as b:
        over_ops_list = [str(o.operator) for o in pikepdf.parse_content_stream(a.pages[0])]
        under_ops_list = [str(o.operator) for o in pikepdf.parse_content_stream(b.pages[0])]
    # Underlay: stamp drawn before the page's own text; overlay: after it.
    assert under_ops_list.index("Do") < under_ops_list.index("Tj")
    assert over_ops_list.index("Do") > over_ops_list.index("Tj")


def test_image_watermark_stored_once(tmp_path: Path, ctx: RecordingContext) -> None:
    src = blank_pdf(tmp_path / "blank.pdf", pages=10)
    logo = make_image(tmp_path / "logo.png", (300, 150), "RGBA", (200, 30, 30, 255))
    out = run(ctx, src, kind="image", image=str(logo), scale=0.3, opacity=0.5, rotation=0).outputs[
        0
    ]
    with pikepdf.open(out) as pdf:
        images = {
            obj.objgen
            for obj in pdf.objects
            if isinstance(obj, pikepdf.Stream)
            and obj.get("/Subtype") == pikepdf.Name.Image
            and obj.get("/SMask") is not None
        }
    assert len(images) == 1
    x0, y0, x1, y1 = stamp_box(src, out, 9)
    assert 160 < x1 - x0 < 200  # 30% of 595 pt
    # 50% opacity over white: red is visibly lightened
    pixel = render(out, 9).getpixel(((x0 + x1) // 2, (y0 + y1) // 2))
    assert isinstance(pixel, int) and 100 < pixel < 230


def test_page_range(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 3)
    out = run(ctx, src, text="DRAFT", pages="2").outputs[0]
    texts = [p.extract_text() or "" for p in PdfReader(out).pages]
    assert ["DRAFT" in t for t in texts] == [False, True, False]


def test_keeps_password(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_encrypted_pdf(tmp_path / "locked.pdf", 1, "pw")
    out = watermark(
        {"inputs": [str(src)], "options": {"text": "X"}, "passwords": {str(src): "pw"}}, ctx
    ).outputs[0]
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(out)


@pytest.mark.parametrize(
    ("options", "code"),
    [
        ({"text": ""}, "INVALID_INPUT"),
        ({"text": "गोपनीय"}, "UNSUPPORTED"),
        ({"text": "X", "opacity": 2}, "INVALID_INPUT"),
        ({"kind": "image", "image": ""}, "INVALID_INPUT"),
        ({"kind": "image", "image": "C:/nope/missing.png"}, "INVALID_INPUT"),
    ],
)
def test_invalid(options: dict[str, Any], code: str, tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    with pytest.raises(EngineError) as info:
        run(ctx, src, **options)
    assert info.value.code == code


def test_input_untouched(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    before = sha256(src)
    run(ctx, src, text="X")
    assert sha256(src) == before
