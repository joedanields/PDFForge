"""Bundled helper programs: locating vendor/, running helpers, LibreOffice / Tesseract wrappers."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from jobs import Cancelled
from protocol import EngineError, ErrorCode
from tests.helpers import RecordingContext
from utils import libreoffice, tesseract
from utils.process import run_helper
from utils.vendor import require, soffice_path, tesseract_path, vendor_root

SLEEPER = [sys.executable, "-c", "import time; time.sleep(30)"]


def test_vendor_root_override_and_dev_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PDFFORGE_VENDOR_DIR", raising=False)
    assert vendor_root() == Path(__file__).resolve().parents[2] / "vendor"
    monkeypatch.setenv("PDFFORGE_VENDOR_DIR", "D:/somewhere")
    assert vendor_root() == Path("D:/somewhere")
    assert soffice_path() == Path("D:/somewhere/libreoffice/program/soffice.com")
    assert tesseract_path() == Path("D:/somewhere/tesseract/tesseract.exe")


def test_require_reports_missing_component(tmp_path: Path) -> None:
    with pytest.raises(EngineError) as err:
        require(tmp_path / "nope.exe", "LibreOffice")
    assert err.value.code == ErrorCode.UNSUPPORTED
    assert "LibreOffice" in err.value.message


def test_run_helper_returns_output(ctx: RecordingContext) -> None:
    result = run_helper(
        [sys.executable, "-c", "print('hello'); import sys; sys.exit(3)"],
        ctx,
        timeout_s=30,
        what="test",
    )
    assert result.returncode == 3
    assert result.stdout.strip() == "hello"


def test_run_helper_timeout_kills(ctx: RecordingContext) -> None:
    started = time.monotonic()
    with pytest.raises(EngineError) as err:
        run_helper(SLEEPER, ctx, timeout_s=1, what="Sleeper")
    assert err.value.code == ErrorCode.TIMEOUT
    assert "Sleeper" in err.value.message
    assert time.monotonic() - started < 10


def test_run_helper_cancel_kills(tmp_path: Path) -> None:
    ctx = RecordingContext(tmp_path / "job")
    ctx.token.cancel()
    started = time.monotonic()
    with pytest.raises(Cancelled):
        run_helper(SLEEPER, ctx, timeout_s=60, what="Sleeper")
    assert time.monotonic() - started < 10


def test_libreoffice_profile_settings_are_hardened() -> None:
    xml = libreoffice._registry_xml()
    assert '"MacroSecurityLevel"' in xml and "<value>3</value>" in xml
    assert '"DisableMacrosExecution"' in xml
    assert '"ooInetHTTPProxyName"' in xml and "127.0.0.1" in xml
    assert libreoffice.HELPER_ENV["SAL_DISABLE_PRINTERLIST"] == "1"


def test_filter_spec() -> None:
    assert libreoffice.filter_spec("pdf", None, None) == "pdf"
    assert libreoffice.filter_spec("pdf", "writer_pdf_Export", None) == "pdf:writer_pdf_Export"
    assert (
        libreoffice.filter_spec("pdf", "impress_pdf_Export", {"ExportNotesPages": True, "Q": 5})
        == 'pdf:impress_pdf_Export:{"ExportNotesPages":{"type":"boolean","value":"true"},'
        '"Q":{"type":"long","value":"5"}}'
    )


@pytest.mark.skipif(not tesseract_path().is_file(), reason="Tesseract not fetched")
def test_tesseract_reads_words_and_bundled_languages(tmp_path: Path) -> None:
    assert {"eng", "tam", "hin"} <= set(tesseract.available_languages())
    img = Image.new("L", (1600, 300), 255)
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont
    try:
        font = ImageFont.truetype("arial.ttf", 64)
    except OSError:
        font = ImageFont.load_default(size=64)
    ImageDraw.Draw(img).text((60, 100), "Offline OCR works", fill=0, font=font)
    png = tmp_path / "line.png"
    img.save(png, dpi=(300, 300))
    ctx = RecordingContext(tmp_path / "job")
    words = tesseract.ocr_words(png, tmp_path / "out", ["eng"], 300, ctx)
    assert [w.text for w in words] == ["Offline", "OCR", "works"]
    assert words[0].left < words[1].left < words[2].left


def test_unknown_language_is_refused() -> None:
    with pytest.raises(EngineError) as err:
        tesseract.check_languages(["klingon"])
    assert err.value.code == ErrorCode.UNSUPPORTED
    with pytest.raises(EngineError):
        tesseract.check_languages([])


def test_user_language_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PDFFORGE_USER_TESSDATA", str(tmp_path))
    (tmp_path / "deu.traineddata").write_bytes(b"x")
    assert tesseract.available_languages()["deu"] == tmp_path / "deu.traineddata"
    assert tesseract.check_languages(["deu"]) == ["deu"]
