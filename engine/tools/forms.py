"""Fill PDF Forms (docs/02 E5): set AcroForm field values, optionally flatten them.

The UI reads the fields itself (pdf.js) and sends ``options.values``: {field name: value},
where a value is text for text and choice fields, true/false for check boxes, and the chosen
option's export value for radio groups. Appearance streams are regenerated so every viewer
shows the new values; with ``flatten`` the fields become plain page content.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
from pikepdf import Name
from pikepdf.form import (
    CheckboxField,
    ChoiceField,
    ExtendedAppearanceStreamGenerator,
    Form,
    MultipleFieldProxy,
    RadioButtonGroup,
    TextField,
)

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils.pdfio import deliver_pdf, open_pdf, save_pdf, single_pdf_input
from utils.validation import option_bool, options_dict, passwords_map

MAX_VALUE_CHARS = 10_000


def fill_forms(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    source = single_pdf_input(params)
    options = options_dict(params)
    values = options.get("values", {})
    if not isinstance(values, dict) or not all(isinstance(k, str) for k in values):
        raise EngineError(ErrorCode.INVALID_INPUT, "'values' must map field names to values")
    flatten = option_bool(options, "flatten", False)

    tmp = ctx.temp_dir / "filled.pdf"
    ctx.progress(5, "Reading the form")
    with open_pdf(source, passwords_map(params)) as pdf:
        if "/AcroForm" not in pdf.Root or not pdf.acroform.exists:
            raise EngineError(
                ErrorCode.UNSUPPORTED, f"{source.name} has no form fields to fill", str(source)
            )
        # Draws multi-line and combed fields well, but fails on some fonts (standard-14 fonts
        # without a FontDescriptor); such fields fall back to QPDF's own appearances.
        drawn = Form(pdf, ExtendedAppearanceStreamGenerator)
        plain = Form(pdf)
        filled = 0
        fallback = False
        for name, value in values.items():
            ctx.check_cancelled()
            if name not in plain:
                raise EngineError(ErrorCode.INVALID_INPUT, f"The form has no field '{name}'")
            check_value(plain[name], name, value, flatten)
            try:
                changed = _set(drawn[name], value)
            except (AttributeError, KeyError, ValueError, TypeError, pikepdf.PdfError):
                changed = _set(plain[name], value)
                fallback = True
            filled += changed
        ctx.progress(60, "Drawing the fields")
        if flatten or fallback:
            pdf.generate_appearance_streams()
        if flatten:
            pdf.flatten_annotations("all")
            _drop_form(pdf)
        save_pdf(pdf, tmp, ctx, start=80, keep_encryption=True)
    final = deliver_pdf(tmp, params, source, "filled", protected=[source])
    return ToolResult([final], {"fields_filled": filled, "flattened": flatten})


def check_value(field: Any, name: str, value: Any, flatten: bool) -> None:
    """Refuse a value that does not fit the field's type."""
    target = field[0] if isinstance(field, MultipleFieldProxy) else field
    if isinstance(target, CheckboxField) and not isinstance(value, bool):
        raise EngineError(ErrorCode.INVALID_INPUT, f"'{name}' must be ticked or not")
    if isinstance(target, RadioButtonGroup):
        if not isinstance(value, str):
            raise EngineError(ErrorCode.INVALID_INPUT, f"'{name}' needs one of its options")
        if value not in ("", "Off") and Name("/" + value) not in {
            opt.on_value for opt in target.options
        }:
            raise EngineError(ErrorCode.INVALID_INPUT, f"'{value}' is not an option of '{name}'")
    if isinstance(target, TextField | ChoiceField):
        if not isinstance(value, str) or len(value) > MAX_VALUE_CHARS:
            raise EngineError(ErrorCode.INVALID_INPUT, f"'{name}' must be text")
        if flatten and not _latin(value):
            raise EngineError(
                ErrorCode.UNSUPPORTED,
                "Flattening can only draw Latin text. Untick “Flatten” to keep the fields "
                "fillable; PDF readers will then show the text.",
            )


def _set(field: Any, value: Any) -> bool:
    """Set one (checked) value; returns whether the field was changed."""
    target = field[0] if isinstance(field, MultipleFieldProxy) else field
    if getattr(target, "is_read_only", False):
        return False
    if isinstance(target, CheckboxField):
        for box in field if isinstance(field, MultipleFieldProxy) else [field]:
            box.checked = value
        return True
    if isinstance(target, RadioButtonGroup):
        target.value = Name.Off if value in ("", "Off") else Name("/" + value)
        return True
    if isinstance(target, TextField | ChoiceField):
        target.value = value
        return True
    return False  # buttons and signature fields are left alone


def _latin(text: str) -> bool:
    try:
        text.encode("cp1252")
    except UnicodeEncodeError:
        return False
    return True


def _drop_form(pdf: pikepdf.Pdf) -> None:
    """After flattening, nothing interactive is left: remove the form dictionary and any
    remaining widget annotations."""
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if isinstance(annots, pikepdf.Array):
            kept = [a for a in annots if a.get("/Subtype") != Name.Widget]
            if kept:
                page.obj.Annots = pikepdf.Array(kept)
            else:
                del page.obj["/Annots"]
    if "/AcroForm" in pdf.Root:
        del pdf.Root["/AcroForm"]


def field_names(path: Path, password: str = "") -> list[str]:
    """Names of the fields in ``path`` (tests and diagnostics)."""
    with pikepdf.open(path, password=password) as pdf:
        if "/AcroForm" not in pdf.Root:
            return []
        return [name for name, _ in Form(pdf).items()]
