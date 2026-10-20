"""Fill PDF Forms (docs/02 E5)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from pikepdf import Name
from pikepdf.form import Form

from protocol import EngineError, ErrorCode
from tests.fixtures import make_full_form_pdf, make_text_pdf
from tests.helpers import RecordingContext, sha256
from tools.forms import field_names, fill_forms

VALUES: dict[str, Any] = {
    "name": "Asha Raman",
    "notes": "First line\nSecond line",
    "agree": True,
    "size": "large",
    "country": "Japan",
    "city": "Chennai",
}


def run(ctx: RecordingContext, pdf: Path, **options: Any) -> Any:
    return fill_forms({"inputs": [str(pdf)], "options": options}, ctx)


def page_text(path: Path, index: int) -> str:
    doc = pdfium.PdfDocument(str(path))
    try:
        return str(doc[index].get_textpage().get_text_range())
    finally:
        doc.close()


def test_fills_every_field_type(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_full_form_pdf(tmp_path / "application.pdf")
    before = sha256(pdf)
    result = run(ctx, pdf, values=VALUES)
    [out] = result.outputs
    assert out.name == "application_filled.pdf"
    assert sha256(pdf) == before
    assert result.stats == {"fields_filled": 6, "flattened": False}
    with pikepdf.open(out) as filled:
        form = Form(filled)
        assert form["name"].value == "Asha Raman"
        assert form["notes"].value == "First line\nSecond line"
        assert form["agree"].checked is True
        assert form["size"].value == Name("/large")
        assert form["country"].value == "Japan"
        assert form["city"].value == "Chennai"
    assert set(field_names(out)) == set(VALUES)


def test_flatten_turns_fields_into_page_content(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_full_form_pdf(tmp_path / "application.pdf")
    out = run(ctx, pdf, values=VALUES, flatten=True).outputs[0]
    with pikepdf.open(out) as flat:
        assert "/AcroForm" not in flat.Root
        for page in flat.pages:
            widgets = [a for a in page.obj.get("/Annots", []) if a.get("/Subtype") == Name.Widget]
            assert widgets == []
    assert "Asha Raman" in page_text(out, 0)
    assert "Chennai" in page_text(out, 1)


def test_untouched_fields_keep_their_values(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_full_form_pdf(tmp_path / "application.pdf")
    out = run(ctx, pdf, values={"city": "Pune"}).outputs[0]
    with pikepdf.open(out) as filled:
        form = Form(filled)
        assert form["country"].value == "India"
        assert form["size"].value == Name("/small")


def test_unicode_text_stays_fillable_but_cannot_be_flattened(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    pdf = make_full_form_pdf(tmp_path / "application.pdf")
    out = run(ctx, pdf, values={"name": "ஆஷா"}).outputs[0]
    with pikepdf.open(out) as filled:
        assert Form(filled)["name"].value == "ஆஷா"
    with pytest.raises(EngineError) as info:
        run(ctx, pdf, values={"name": "ஆஷா"}, flatten=True)
    assert info.value.code == ErrorCode.UNSUPPORTED


@pytest.mark.parametrize(
    ("values", "code"),
    [
        ({"missing": "x"}, ErrorCode.INVALID_INPUT),
        ({"agree": "yes"}, ErrorCode.INVALID_INPUT),
        ({"size": "huge"}, ErrorCode.INVALID_INPUT),
        ({"name": 5}, ErrorCode.INVALID_INPUT),
    ],
)
def test_bad_values_are_refused(
    tmp_path: Path, ctx: RecordingContext, values: dict[str, Any], code: ErrorCode
) -> None:
    pdf = make_full_form_pdf(tmp_path / "application.pdf")
    with pytest.raises(EngineError) as info:
        run(ctx, pdf, values=values)
    assert info.value.code == code


def test_pdf_without_form(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "plain.pdf", 1)
    with pytest.raises(EngineError) as info:
        run(ctx, pdf, values={})
    assert info.value.code == ErrorCode.UNSUPPORTED
