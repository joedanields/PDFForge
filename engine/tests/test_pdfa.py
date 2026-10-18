"""PDF → PDF/A (docs/02 D5), best effort without Ghostscript.

When veraPDF is available on the development machine (vendor/_tools/verapdf with a portable
JRE in vendor/_tools/jre, or PDFFORGE_VERAPDF pointing at verapdf.bat) every result is also
validated by it; otherwise the structural checks below still run.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from pikepdf import AttachedFileSpec, Dictionary, Name, String
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from protocol import EngineError, ErrorCode
from tests.fixtures import (
    add_link,
    make_document_pdf,
    make_encrypted_pdf,
    make_form_pdf,
    make_text_pdf,
)
from tests.helpers import RecordingContext, sha256
from tools.pdfa import font_dir, is_embedded, pdf_to_pdfa
from utils.vendor import vendor_root

TOOLS = vendor_root() / "_tools"
VERAPDF = Path(os.environ.get("PDFFORGE_VERAPDF", TOOLS / "verapdf" / "verapdf.bat"))
JRE = next((TOOLS / "jre").glob("*"), None) if (TOOLS / "jre").is_dir() else None
needs_fonts = pytest.mark.skipif(
    not (font_dir() / "LiberationSans-Regular.ttf").is_file(),
    reason="Liberation fonts come with the fetched LibreOffice",
)


def run(ctx: RecordingContext, inputs: list[Path], **params: Any) -> Any:
    return pdf_to_pdfa({"inputs": [str(p) for p in inputs], **params}, ctx)


def verapdf(path: Path, flavour: str) -> str | None:
    """veraPDF verdict ("PASS ..." / "FAIL ...") or None when veraPDF is not installed."""
    if not VERAPDF.is_file():
        return None
    env = dict(os.environ)
    if JRE is not None:
        env["JAVA_HOME"] = str(JRE)
        env["PATH"] = f"{JRE / 'bin'};{env.get('PATH', '')}"
    result = subprocess.run(
        ["cmd", "/c", str(VERAPDF), "--format", "text", "--flavour", flavour, str(path)],
        capture_output=True,
        text=True,
        env=env,
        timeout=180,
        check=False,
    )
    return result.stdout.strip()


def attach(doc: pikepdf.Pdf, name: str, data: bytes, mime: str) -> None:
    spec = AttachedFileSpec(doc, data, filename=name, mime_type=mime)  # type: ignore[call-arg]
    doc.attachments[name] = spec


def assert_pdfa(path: Path, part: str) -> None:
    with pikepdf.open(path) as pdf:
        assert not pdf.is_encrypted
        meta = pdf.open_metadata()
        assert meta.get("pdfaid:part") == part
        assert meta.get("pdfaid:conformance") == "B"
        intents = pdf.Root.OutputIntents
        assert intents[0].S == Name.GTS_PDFA1
        assert intents[0].DestOutputProfile.N == 3
        for page in pdf.pages:
            for _name, font in (page.Resources.get("/Font") or Dictionary()).items():
                assert isinstance(font, Dictionary) and is_embedded(font), font.get("/BaseFont")
    verdict = verapdf(path, f"{part}b")
    if verdict is not None:
        assert verdict.startswith("PASS"), verdict


@needs_fonts
def test_standard_fonts_are_replaced_by_embedded_metric_twins(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    pdf = make_document_pdf(tmp_path / "report.pdf", pages=2)
    before = sha256(pdf)
    result = run(ctx, [pdf])
    out = result.outputs[0]
    assert out == tmp_path / "report_pdfa.pdf"
    assert sha256(pdf) == before
    assert result.stats["fixes"]["fonts_embedded"] == 3  # regular, bold, oblique
    assert result.stats["level"] == "2b"
    assert_pdfa(out, "2")
    with pikepdf.open(out) as converted:
        names = {str(f.BaseFont) for _n, f in converted.pages[0].Resources.Font.items()}
    assert names == {"/LiberationSans", "/LiberationSans-Bold", "/LiberationSans-Italic"}


@needs_fonts
def test_forms_links_javascript_and_attachments(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_form_pdf(tmp_path / "form.pdf")
    with pikepdf.open(pdf, allow_overwriting_input=True) as doc:
        js = doc.make_indirect(Dictionary(S=Name.JavaScript, JS=String("app.alert('hi')")))
        doc.Root.OpenAction = js
        doc.Root.Names = Dictionary(
            JavaScript=Dictionary(Names=pikepdf.Array([String("init"), js]))
        )
        attach(doc, "notes.txt", b"attached", "text/plain")
        doc.save(pdf)
    add_link(pdf, 0, 0)
    result = run(ctx, [pdf])
    fixes = result.stats["fixes"]
    assert fixes["javascript_removed"] == 1
    assert fixes["actions_removed"] >= 1
    assert fixes["attachments_removed"] == 1
    out = result.outputs[0]
    assert_pdfa(out, "2")
    with pikepdf.open(out) as converted:
        assert (
            "/OpenAction" not in converted.Root
            or converted.Root.OpenAction.get("/S") != Name.JavaScript
        )
        assert len(converted.attachments) == 0
        assert len(converted.pages[0].Annots) >= 1  # the link survives


@needs_fonts
def test_pdfa_3b_keeps_attachments(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "invoice.pdf", 1)
    with pikepdf.open(pdf, allow_overwriting_input=True) as doc:
        attach(doc, "data.xml", b"<x/>", "text/xml")
        doc.save(pdf)
    result = run(ctx, [pdf], options={"level": "3b"})
    out = result.outputs[0]
    assert_pdfa(out, "3")
    with pikepdf.open(out) as converted:
        assert list(converted.attachments) == ["data.xml"]
        assert converted.Root.AF[0].AFRelationship == Name.Unspecified


@needs_fonts
def test_encrypted_input_becomes_unprotected_archive(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_encrypted_pdf(tmp_path / "secret.pdf", 2, "pw")
    with pytest.raises(EngineError) as err:
        run(ctx, [pdf])
    assert err.value.code == ErrorCode.PASSWORD_REQUIRED
    result = run(RecordingContext(tmp_path / "j2"), [pdf], passwords={str(pdf): "pw"})
    assert result.stats["protected_inputs"] == 1
    assert_pdfa(result.outputs[0], "2")


def test_cmyk_colour_is_refused_not_mislabelled(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = tmp_path / "print.pdf"
    c = canvas.Canvas(str(pdf), pagesize=A4)
    c.setFillColorCMYK(0, 1, 1, 0)
    c.rect(100, 100, 200, 200, fill=1, stroke=0)
    c.save()
    with pytest.raises(EngineError) as err:
        run(ctx, [pdf])
    assert err.value.code == ErrorCode.UNSUPPORTED
    assert "CMYK" in err.value.message
    assert not (tmp_path / "print_pdfa.pdf").exists()


def test_unreplaceable_font_is_refused(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = tmp_path / "symbols.pdf"
    c = canvas.Canvas(str(pdf), pagesize=A4)
    c.setFont("Symbol", 14)
    c.drawString(72, 700, "abc")
    c.save()
    with pytest.raises(EngineError) as err:
        run(ctx, [pdf])
    assert err.value.code == ErrorCode.UNSUPPORTED
    assert "Symbol" in err.value.message


def test_rejects_unknown_level(tmp_path: Path, ctx: RecordingContext) -> None:
    with pytest.raises(EngineError) as err:
        run(ctx, [make_text_pdf(tmp_path / "a.pdf", 1)], options={"level": "1b"})
    assert err.value.code == ErrorCode.INVALID_INPUT
