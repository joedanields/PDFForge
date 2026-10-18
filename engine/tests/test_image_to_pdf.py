"""Image → PDF (docs/02 C1)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pytest

from protocol import EngineError
from tests.fixtures import (
    make_exif_rotated_jpeg,
    make_heic,
    make_image,
    make_multipage_tiff,
    make_text_pdf,
)
from tests.helpers import RecordingContext, sha256
from tools.to_pdf import image_to_pdf


def run(ctx: RecordingContext, images: list[Path], **options: Any) -> Any:
    return image_to_pdf({"inputs": [str(p) for p in images], "options": options}, ctx)


def page_sizes(path: Path) -> list[tuple[int, int]]:
    with pikepdf.open(path) as pdf:
        out = []
        for page in pdf.pages:
            box = [float(v) for v in page.mediabox]
            w, h = box[2] - box[0], box[3] - box[1]
            if int(page.obj.get("/Rotate", 0)) % 180:
                w, h = h, w
            out.append((round(w), round(h)))
        return out


def test_combines_images_into_one_pdf(tmp_path: Path, ctx: RecordingContext) -> None:
    images = [
        make_image(tmp_path / "photo.jpg", (400, 300)),
        make_image(tmp_path / "logo.png", (200, 200), "RGBA", (0, 0, 255, 100)),
        make_image(tmp_path / "scan.bmp", (300, 500)),
        make_image(tmp_path / "pic.webp", (320, 240)),
    ]
    result = run(ctx, images)
    out = result.outputs[0]
    assert out.name == "photo_images.pdf"
    assert result.stats == {**result.stats, "images": 4, "pages": 4}
    assert len(page_sizes(out)) == 4


def test_jpeg_is_embedded_without_recompression(tmp_path: Path, ctx: RecordingContext) -> None:
    jpg = make_image(tmp_path / "photo.jpg", (640, 480))
    out = run(ctx, [jpg]).outputs[0]
    with pikepdf.open(out) as pdf:
        images = list(pdf.pages[0].get_images().values())
        assert images[0].Filter == pikepdf.Name.DCTDecode
        assert images[0].read_raw_bytes() == jpg.read_bytes()


def test_exif_orientation_is_honoured(tmp_path: Path, ctx: RecordingContext) -> None:
    jpg = make_exif_rotated_jpeg(tmp_path / "phone.jpg", (400, 200), orientation=6)
    ((w, h),) = page_sizes(run(ctx, [jpg]).outputs[0])
    assert w < h, "a photo shot in portrait must produce a portrait page"


def test_multipage_tiff_and_heic(tmp_path: Path, ctx: RecordingContext) -> None:
    tiff = make_multipage_tiff(tmp_path / "fax.tiff", frames=3)
    heic = make_heic(tmp_path / "phone.heic")
    result = run(ctx, [tiff, heic])
    assert result.stats["pages"] == 4


@pytest.mark.parametrize(
    ("page_size", "orientation", "expected"),
    [
        ("a4", "portrait", (595, 842)),
        ("a4", "landscape", (842, 595)),
        ("letter", "portrait", (612, 792)),
        ("a4", "auto", (842, 595)),  # landscape image → landscape page
    ],
)
def test_page_sizes(
    page_size: str,
    orientation: str,
    expected: tuple[int, int],
    tmp_path: Path,
    ctx: RecordingContext,
) -> None:
    img = make_image(tmp_path / "wide.png", (800, 400))
    out = run(ctx, [img], page_size=page_size, orientation=orientation).outputs[0]
    assert page_sizes(out) == [expected]


def test_fit_page_with_margin_is_larger(tmp_path: Path) -> None:
    img = make_image(tmp_path / "pic.png", (300, 300))
    tight = page_sizes(run(RecordingContext(tmp_path / "a"), [img], margin="none").outputs[0])
    roomy = page_sizes(run(RecordingContext(tmp_path / "b"), [img], margin="large").outputs[0])
    assert roomy[0][0] > tight[0][0]


def test_one_pdf_per_image(tmp_path: Path, ctx: RecordingContext) -> None:
    images = [make_image(tmp_path / f"img{n}.jpg") for n in range(3)]
    result = run(ctx, images, mode="separate")
    assert [p.name for p in result.outputs] == ["img0.pdf", "img1.pdf", "img2.pdf"]
    assert result.stats["folder"].endswith("img0_pdfs")


def test_single_image_separate_is_named_like_the_image(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    img = make_image(tmp_path / "receipt.jpg")
    result = run(ctx, [img], mode="separate")
    assert result.outputs == [tmp_path / "receipt.pdf"]


def test_rejects_non_images(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "doc.pdf", 1)
    with pytest.raises(EngineError) as info:
        run(ctx, [pdf])
    assert info.value.code == "INVALID_INPUT"


def test_corrupt_image(tmp_path: Path, ctx: RecordingContext) -> None:
    bad = tmp_path / "broken.png"
    bad.write_bytes(b"\x89PNG\r\n\x1a\nnot an image")
    with pytest.raises(EngineError) as info:
        run(ctx, [bad])
    assert (info.value.code, info.value.file) == ("CORRUPT_FILE", str(bad))


def test_inputs_untouched(tmp_path: Path, ctx: RecordingContext) -> None:
    img = make_image(tmp_path / "photo.jpg")
    before = sha256(img)
    run(ctx, [img])
    assert sha256(img) == before


@pytest.mark.parametrize("options", [{"page_size": "a3"}, {"margin": 5}, {"mode": "zip"}])
def test_invalid_options(options: dict[str, Any], tmp_path: Path, ctx: RecordingContext) -> None:
    img = make_image(tmp_path / "photo.jpg")
    with pytest.raises(EngineError):
        run(ctx, [img], **options)
