"""Edit PDF (docs/02 E1): objects placed in display coordinates, flattened or as annotations."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from PIL import Image

from protocol import EngineError, ErrorCode
from tests.fixtures import make_encrypted_pdf, make_image, make_text_pdf
from tests.helpers import RecordingContext, sha256
from tools.editor import edit_pdf

RED, BLUE = "#E03131", "#1C7ED6"


def run(ctx: RecordingContext, pdf: Path, objects: list[dict[str, Any]], **params: Any) -> Any:
    options = {"objects": objects, **params.pop("options", {})}
    return edit_pdf({"inputs": [str(pdf)], "options": options, **params}, ctx)


def render(path: Path, index: int = 0) -> Image.Image:
    doc = pdfium.PdfDocument(str(path))
    try:
        image: Image.Image = doc[index].render(scale=1, may_draw_forms=True).to_pil().convert("RGB")
        return image
    finally:
        doc.close()


def pixel(img: Image.Image, u: float, v: float) -> tuple[int, int, int]:
    """Colour at a display fraction of the rendered page."""
    value = img.getpixel((int(u * (img.width - 1)), int(v * (img.height - 1))))
    assert isinstance(value, tuple)
    return value[0], value[1], value[2]


def near(color: tuple[int, int, int], hex_color: str, tolerance: int = 40) -> bool:
    target = tuple(int(hex_color[i : i + 2], 16) for i in (1, 3, 5))
    return all(abs(a - b) <= tolerance for a, b in zip(color, target, strict=True))


def rect(page: int, x: float, y: float, w: float, h: float, fill: str) -> dict[str, Any]:
    return {
        "page": page,
        "kind": "rect",
        "x": x,
        "y": y,
        "w": w,
        "h": h,
        "fill": fill,
        "stroke": None,
    }


def test_shapes_land_where_placed(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "doc.pdf", 2)
    before = sha256(pdf)
    result = run(
        ctx,
        pdf,
        [
            rect(0, 0.1, 0.1, 0.2, 0.1, RED),
            {"page": 1, "kind": "ellipse", "x": 0.5, "y": 0.5, "w": 0.3, "h": 0.2, "fill": BLUE},
        ],
    )
    out = result.outputs[0]
    assert out == tmp_path / "doc_edited.pdf"
    assert sha256(pdf) == before
    assert near(pixel(render(out, 0), 0.2, 0.15), RED)
    assert pixel(render(out, 0), 0.6, 0.6) == (255, 255, 255)
    assert near(pixel(render(out, 1), 0.65, 0.6), BLUE)
    assert result.stats == {"objects": 2, "pages_edited": 2, "annotations": False}
    with pikepdf.open(out) as edited:
        assert "/Annots" not in edited.pages[0].obj  # flattened into the content


def test_rotated_page_uses_display_coordinates(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "doc.pdf", 1)
    with pikepdf.open(pdf, allow_overwriting_input=True) as doc:
        doc.pages[0].obj.Rotate = 90
        doc.save(pdf)
    out = run(ctx, pdf, [rect(0, 0.05, 0.05, 0.2, 0.1, RED)]).outputs[0]
    img = render(out)
    assert img.width > img.height  # displayed landscape
    assert near(pixel(img, 0.15, 0.1), RED)  # top-left as the user saw it
    assert pixel(img, 0.85, 0.9) == (255, 255, 255)


def test_text_line_arrow_ink_highlight_and_image(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "doc.pdf", 1)
    picture = make_image(tmp_path / "logo.png", (80, 40), "RGB", (20, 160, 60))
    objects = [
        {
            "page": 0,
            "kind": "text",
            "x": 0.1,
            "y": 0.3,
            "w": 0.6,
            "h": 0.1,
            "text": "Approved by PDFForge",
            "size": 18,
            "bold": True,
            "stroke": "#000000",
        },
        {"page": 0, "kind": "line", "points": [[0.1, 0.5], [0.9, 0.5]], "stroke": RED, "width": 4},
        {
            "page": 0,
            "kind": "arrow",
            "points": [[0.1, 0.6], [0.5, 0.6]],
            "stroke": BLUE,
            "width": 3,
        },
        {
            "page": 0,
            "kind": "ink",
            "points": [[0.6, 0.7], [0.7, 0.75], [0.8, 0.7]],
            "stroke": RED,
            "width": 3,
        },
        {
            "page": 0,
            "kind": "highlight",
            "points": [[0.1, 0.8], [0.4, 0.8]],
            "stroke": "#FFD43B",
            "width": 14,
            "opacity": 0.5,
        },
        {
            "page": 0,
            "kind": "image",
            "x": 0.6,
            "y": 0.85,
            "w": 0.2,
            "h": 0.1,
            "image": str(picture),
        },
    ]
    out = run(ctx, pdf, objects).outputs[0]
    img = render(out)
    assert near(pixel(img, 0.5, 0.5), RED)
    assert near(pixel(img, 0.3, 0.6), BLUE)
    assert near(pixel(img, 0.25, 0.8), "#FFE99D", tolerance=50)  # translucent yellow
    assert near(pixel(img, 0.7, 0.9), "#14A03C")
    doc = pdfium.PdfDocument(str(out))
    try:
        assert "Approved by PDFForge" in doc[0].get_textpage().get_text_range()
    finally:
        doc.close()


def test_keep_as_annotations(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "doc.pdf", 1)
    objects = [
        rect(0, 0.1, 0.1, 0.2, 0.1, RED),
        {"page": 0, "kind": "arrow", "points": [[0.1, 0.6], [0.5, 0.6]], "stroke": BLUE},
        {"page": 0, "kind": "text", "x": 0.1, "y": 0.3, "w": 0.6, "h": 0.1, "text": "Hello"},
        {"page": 0, "kind": "note", "x": 0.8, "y": 0.1, "text": "Check this figure"},
    ]
    result = run(ctx, pdf, objects, options={"annotations": True})
    out = result.outputs[0]
    with pikepdf.open(out) as edited:
        annots = list(edited.pages[0].Annots)
        subtypes = sorted(str(a.Subtype) for a in annots)
        assert subtypes == ["/FreeText", "/Line", "/Square", "/Text"]
        note = next(a for a in annots if a.Subtype == pikepdf.Name.Text)
        assert str(note.Contents) == "Check this figure"
        square = next(a for a in annots if a.Subtype == pikepdf.Name.Square)
        assert "/AP" in square
    # Appearance streams render exactly where the object was placed.
    assert near(pixel(render(out), 0.2, 0.15), RED)


def test_notes_are_annotations_even_when_flattening(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "doc.pdf", 1)
    out = run(ctx, pdf, [{"page": 0, "kind": "note", "x": 0.5, "y": 0.5, "text": "hi"}]).outputs[0]
    with pikepdf.open(out) as edited:
        assert [str(a.Subtype) for a in edited.pages[0].Annots] == ["/Text"]


def test_encrypted_document_keeps_its_password(tmp_path: Path) -> None:
    pdf = make_encrypted_pdf(tmp_path / "secret.pdf", 1, "pw")
    result = run(
        RecordingContext(tmp_path / "job"),
        pdf,
        [rect(0, 0.1, 0.1, 0.2, 0.1, RED)],
        passwords={str(pdf): "pw"},
    )
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(result.outputs[0])


@pytest.mark.parametrize(
    ("objects", "message"),
    [
        ([], "Add something"),
        ([{"page": 5, "kind": "rect", "x": 0, "y": 0, "w": 0.1, "h": 0.1}], "does not exist"),
        ([{"page": 0, "kind": "laser"}], "Unknown object"),
        ([{"page": 0, "kind": "rect", "x": 0, "y": 0, "w": 0, "h": 0.1}], "no size"),
        ([{"page": 0, "kind": "line", "points": [[0, 0]]}], "start and an end"),
        (
            [{"page": 0, "kind": "rect", "x": 0, "y": 0, "w": 0.1, "h": 0.1, "fill": "red"}],
            "colour",
        ),
        (
            [{"page": 0, "kind": "image", "x": 0, "y": 0, "w": 0.1, "h": 0.1, "image": "C:/x.png"}],
            "picture",
        ),
    ],
)
def test_invalid_objects_are_refused(
    tmp_path: Path, ctx: RecordingContext, objects: list[dict[str, Any]], message: str
) -> None:
    pdf = make_text_pdf(tmp_path / "doc.pdf", 1)
    with pytest.raises(EngineError) as err:
        run(ctx, pdf, objects)
    assert err.value.code == ErrorCode.INVALID_INPUT
    assert message in err.value.message
