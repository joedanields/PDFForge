"""Word / PowerPoint / Excel → PDF via the bundled LibreOffice (docs/02 C2-C4)."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest

from jobs import Cancelled
from protocol import EngineError, ErrorCode
from tests.fixtures import make_docx, make_encrypted_office, make_pptx, make_xlsx
from tests.helpers import RecordingContext, sha256
from tools.office import excel_to_pdf, powerpoint_to_pdf, word_to_pdf
from utils.vendor import soffice_path

pytestmark = pytest.mark.skipif(
    not soffice_path().is_file(), reason="LibreOffice not fetched (scripts/fetch-vendor.ps1)"
)


def run(tool: Any, ctx: RecordingContext, inputs: list[Path], **options: Any) -> Any:
    return tool({"inputs": [str(p) for p in inputs], "options": options}, ctx)


def page_texts(path: Path) -> list[str]:
    pdf = pdfium.PdfDocument(str(path))
    try:
        return [page.get_textpage().get_text_range() for page in pdf]
    finally:
        pdf.close()


def page_count(path: Path) -> int:
    with pikepdf.open(path) as pdf:
        return len(pdf.pages)


# ── Word ──────────────────────────────────────────────────────────────────────────────────


def test_docx_to_pdf_keeps_name_text_and_pages(tmp_path: Path, ctx: RecordingContext) -> None:
    docx = make_docx(tmp_path / "report.docx", pages=3)
    before = sha256(docx)
    result = run(word_to_pdf, ctx, [docx])
    out = result.outputs[0]
    assert out == tmp_path / "report.pdf"
    texts = page_texts(out)
    assert len(texts) == 3
    assert "Quarterly report" in texts[0]
    assert "R2C2" in texts[0]
    assert "Section 3." in texts[2]
    assert result.stats["pages"] == 3
    assert sha256(docx) == before  # input never modified
    assert not list(tmp_path.glob(".~lock*"))  # no LibreOffice lock files beside the input


def test_never_overwrites_existing_pdf(tmp_path: Path, ctx: RecordingContext) -> None:
    docx = make_docx(tmp_path / "report.docx", pages=1)
    existing = tmp_path / "report.pdf"
    existing.write_bytes(b"keep me")
    out = run(word_to_pdf, ctx, [docx]).outputs[0]
    assert out.name == "report (1).pdf"
    assert existing.read_bytes() == b"keep me"


def test_rtf_and_unicode_file_name(tmp_path: Path, ctx: RecordingContext) -> None:
    rtf = tmp_path / "Brief für Ämter.rtf"
    rtf.write_text(r"{\rtf1\ansi{\fonttbl\f0 Arial;}\f0 Hello from RTF\par}", encoding="ascii")
    out = run(word_to_pdf, ctx, [rtf]).outputs[0]
    assert out.name == "Brief für Ämter.pdf"
    assert "Hello from RTF" in page_texts(out)[0]


def test_several_documents_each_beside_their_source(tmp_path: Path, ctx: RecordingContext) -> None:
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    first = make_docx(tmp_path / "a" / "one.docx", pages=1)
    second = make_docx(tmp_path / "b" / "two.docx", pages=2)
    result = run(word_to_pdf, ctx, [first, second])
    assert result.outputs == [tmp_path / "a" / "one.pdf", tmp_path / "b" / "two.pdf"]
    assert result.stats["files"] == 2
    assert result.stats["pages"] == 3


def test_output_dir_option(tmp_path: Path, ctx: RecordingContext) -> None:
    docx = make_docx(tmp_path / "report.docx", pages=1)
    target = tmp_path / "exports"
    target.mkdir()
    params = {"inputs": [str(docx)], "output_dir": str(target)}
    assert word_to_pdf(params, ctx).outputs == [target / "report.pdf"]


def test_50_page_docx_under_15_seconds(tmp_path: Path, ctx: RecordingContext) -> None:
    """docs/05 P5 / 07 acceptance: 50-page DOCX → PDF ≤ 15 s incl. LibreOffice start."""
    run(word_to_pdf, ctx, [make_docx(tmp_path / "warm.docx", pages=1)])  # build the template
    docx = make_docx(tmp_path / "long.docx", pages=50)
    started = time.monotonic()
    out = run(word_to_pdf, RecordingContext(tmp_path / "job2"), [docx]).outputs[0]
    elapsed = time.monotonic() - started
    assert page_count(out) == 50
    assert elapsed < 15, f"took {elapsed:.1f} s"


def test_wrong_extension_is_rejected(tmp_path: Path, ctx: RecordingContext) -> None:
    txt = tmp_path / "notes.txt"
    txt.write_text("hi")
    with pytest.raises(EngineError) as err:
        run(word_to_pdf, ctx, [txt])
    assert err.value.code == ErrorCode.INVALID_INPUT


def test_password_protected_office_file_is_explained(tmp_path: Path, ctx: RecordingContext) -> None:
    locked = make_encrypted_office(tmp_path / "secret.docx")
    with pytest.raises(EngineError) as err:
        run(word_to_pdf, ctx, [locked])
    assert err.value.code == ErrorCode.UNSUPPORTED
    assert "password" in err.value.message


def test_damaged_document_reports_corrupt(tmp_path: Path, ctx: RecordingContext) -> None:
    broken = tmp_path / "broken.docx"
    broken.write_bytes(b"PK\x03\x04 this is not really a zip" * 10)
    with pytest.raises(EngineError) as err:
        run(word_to_pdf, ctx, [broken])
    assert err.value.code == ErrorCode.CORRUPT_FILE
    assert not (tmp_path / "broken.pdf").exists()


def test_cancel_kills_libreoffice_and_leaves_nothing(tmp_path: Path) -> None:
    docx = make_docx(tmp_path / "report.docx", pages=20)
    ctx = RecordingContext(tmp_path / "job", cancel_after=1)
    started = time.monotonic()
    with pytest.raises(Cancelled):
        run(word_to_pdf, ctx, [docx])
    assert time.monotonic() - started < 10
    assert not (tmp_path / "report.pdf").exists()


def test_missing_libreoffice_is_unsupported(
    tmp_path: Path, ctx: RecordingContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PDFFORGE_VENDOR_DIR", str(tmp_path / "no-vendor"))
    docx = make_docx(tmp_path / "report.docx", pages=1)
    with pytest.raises(EngineError) as err:
        run(word_to_pdf, ctx, [docx])
    assert err.value.code == ErrorCode.UNSUPPORTED


# ── PowerPoint ────────────────────────────────────────────────────────────────────────────


def test_pptx_one_page_per_slide(tmp_path: Path, ctx: RecordingContext) -> None:
    deck = make_pptx(tmp_path / "deck.pptx", slides=3)
    out = run(powerpoint_to_pdf, ctx, [deck]).outputs[0]
    texts = page_texts(out)
    assert len(texts) == 3
    assert "Slide 2" in texts[1]
    assert not any("Speaker note" in t for t in texts)


def test_pptx_with_notes_adds_notes_pages(tmp_path: Path, ctx: RecordingContext) -> None:
    deck = make_pptx(tmp_path / "deck.pptx", slides=3)
    out = run(powerpoint_to_pdf, ctx, [deck], include_notes=True).outputs[0]
    texts = page_texts(out)
    assert len(texts) == 6
    assert any("Speaker note 2" in t for t in texts)


# ── Excel ─────────────────────────────────────────────────────────────────────────────────


def test_xlsx_all_sheets(tmp_path: Path, ctx: RecordingContext) -> None:
    book = make_xlsx(tmp_path / "book.xlsx", columns=30)
    out = run(excel_to_pdf, ctx, [book]).outputs[0]
    text = "".join(page_texts(out))
    assert "Column 1" in text
    assert "Summary" in text
    assert page_count(out) > 2  # 30 columns spill over several pages wide


def test_xlsx_fit_width_puts_each_sheet_on_one_page_wide(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    book = make_xlsx(tmp_path / "book.xlsx", columns=30)
    before = sha256(book)
    out = run(excel_to_pdf, ctx, [book], fit_width=True).outputs[0]
    texts = page_texts(out)
    assert len(texts) == 2  # one page per sheet
    assert "Column 1" in texts[0]
    assert "Column 30" in texts[0]
    assert sha256(book) == before


def test_xlsx_active_sheet_only(tmp_path: Path, ctx: RecordingContext) -> None:
    book = make_xlsx(tmp_path / "book.xlsx", columns=3, active=1)
    out = run(excel_to_pdf, ctx, [book], sheets="active").outputs[0]
    text = "".join(page_texts(out))
    assert "Summary" in text
    assert "Column 1" not in text


def test_csv_and_ods_via_xlsx_with_options(tmp_path: Path, ctx: RecordingContext) -> None:
    csv = tmp_path / "people.csv"
    csv.write_text(
        "name,city,score\n" + "".join(f"Person {n},Chennai,{n}\n" for n in range(5)),
        encoding="utf-8",
    )
    plain = run(excel_to_pdf, ctx, [csv]).outputs[0]
    assert "Person 3" in page_texts(plain)[0]
    fitted = run(excel_to_pdf, RecordingContext(tmp_path / "j2"), [csv], fit_width=True)
    assert fitted.outputs[0].name == "people (1).pdf"
    assert "Chennai" in page_texts(fitted.outputs[0])[0]


def test_profile_template_belongs_to_one_installation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A profile made by another LibreOffice installation (before an app update) is never reused:
    LibreOffice would resync it and quit without converting."""
    from utils import libreoffice

    program = tmp_path / "libreoffice" / "program"
    program.mkdir(parents=True)
    (program / "soffice.com").write_bytes(b"")
    (program / "mergedlo.dll").write_bytes(b"x" * 10)
    stamp = tmp_path / "libreoffice" / ".pdfforge-vendor"
    stamp.write_text("26.2.6 abc trim3", encoding="utf-8")
    monkeypatch.setattr(libreoffice, "soffice_path", lambda: program / "soffice.com")
    before = libreoffice._template_dir()
    assert before == libreoffice._template_dir()
    stamp.write_text("26.2.6 abc trim4", encoding="utf-8")
    assert libreoffice._template_dir() != before
