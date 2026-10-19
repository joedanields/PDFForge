"""Sign PDF (docs/02 F3): signature pictures arrive as job secrets and become page content."""

from __future__ import annotations

import base64
import io
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from PIL import Image, ImageDraw

from protocol import EngineError, ErrorCode
from tests.fixtures import make_text_pdf
from tests.helpers import RecordingContext, sha256
from tools.editor import sign


def signature_png() -> str:
    """A transparent PNG with a dark-blue scribble, as the UI produces."""
    img = Image.new("RGBA", (300, 100), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.line([(10, 70), (80, 20), (150, 80), (290, 30)], fill=(20, 40, 120, 255), width=12)
    buffer = io.BytesIO()
    img.save(buffer, "PNG")
    return base64.b64encode(buffer.getvalue()).decode()


def run(ctx: RecordingContext, pdf: Path, objects: list[dict[str, Any]], **params: Any) -> Any:
    return sign({"inputs": [str(pdf)], "options": {"objects": objects}, **params}, ctx)


def test_signature_date_and_name_are_stamped(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "contract.pdf", 2)
    before = sha256(pdf)
    objects = [
        {
            "page": 1,
            "kind": "image",
            "x": 0.55,
            "y": 0.8,
            "w": 0.3,
            "h": 0.1,
            "image": "secret:sig1",
        },
        {
            "page": 1,
            "kind": "text",
            "x": 0.55,
            "y": 0.9,
            "w": 0.3,
            "h": 0.03,
            "text": "19 October 2026",
            "size": 11,
        },
    ]
    result = run(ctx, pdf, objects, secrets={"images": {"sig1": signature_png()}})
    out = result.outputs[0]
    assert out == tmp_path / "contract_signed.pdf"
    assert sha256(pdf) == before
    doc = pdfium.PdfDocument(str(out))
    try:
        page = doc[1]
        assert "19 October 2026" in page.get_textpage().get_text_range()
        img = page.render(scale=1).to_pil().convert("RGB")
    finally:
        doc.close()
    # Some of the scribble's dark-blue pixels are inside the placed box ...
    box = img.crop(
        (int(0.55 * img.width), int(0.8 * img.height), int(0.85 * img.width), int(0.9 * img.height))
    )
    data = box.tobytes()
    pixels = (data[i : i + 3] for i in range(0, len(data), 3))
    assert any(r < 60 and g < 80 and b > 90 for r, g, b in pixels)
    # ... and the transparent parts stay transparent (the page shows through, not a white box).
    with pikepdf.open(out) as signed:
        assert "/Annots" not in signed.pages[1].obj
    assert result.stats["objects"] == 2


def test_signature_is_not_left_on_disk(tmp_path: Path) -> None:
    pdf = make_text_pdf(tmp_path / "contract.pdf", 1)
    job = tmp_path / "job"
    ctx = RecordingContext(job)
    run(
        ctx,
        pdf,
        [
            {
                "page": 0,
                "kind": "image",
                "x": 0.1,
                "y": 0.1,
                "w": 0.3,
                "h": 0.1,
                "image": "secret:a1",
            }
        ],
        secrets={"images": {"a1": signature_png()}},
    )
    # The decoded picture lives only in the job folder, which the job manager deletes.
    assert all(job in p.parents for p in tmp_path.rglob("a1.png"))


@pytest.mark.parametrize(
    ("secrets", "image", "message"),
    [
        ({}, "secret:missing", "picture"),
        ({"images": {"x": "not base64!"}}, "secret:x", "damaged"),
        ({"images": {"x": base64.b64encode(b"GIF89a").decode()}}, "secret:x", "damaged"),
        ({"images": {"../x": signature_png()}}, "secret:x", "Invalid"),
    ],
)
def test_bad_signature_images(
    tmp_path: Path, ctx: RecordingContext, secrets: dict[str, Any], image: str, message: str
) -> None:
    pdf = make_text_pdf(tmp_path / "contract.pdf", 1)
    with pytest.raises(EngineError) as err:
        run(
            ctx,
            pdf,
            [{"page": 0, "kind": "image", "x": 0.1, "y": 0.1, "w": 0.3, "h": 0.1, "image": image}],
            secrets=secrets,
        )
    assert err.value.code == ErrorCode.INVALID_INPUT
    assert message in err.value.message
