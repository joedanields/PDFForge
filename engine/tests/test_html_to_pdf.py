"""HTML → PDF (docs/02 C5) via LibreOffice, with a self-contained, script-free page copy."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pdfplumber
import pypdfium2 as pdfium
import pytest
from PIL import Image

from protocol import EngineError, ErrorCode
from tests.helpers import RecordingContext, sha256
from tools.to_pdf import html_to_pdf
from utils.html_prep import page_css, prepare
from utils.vendor import soffice_path

needs_lo = pytest.mark.skipif(not soffice_path().is_file(), reason="LibreOffice not fetched")

PAGE = """<!doctype html><html><head><meta charset="windows-1252"><title>Demo</title>
<link rel="stylesheet" href="css/site.css">
<link rel="stylesheet" href="https://cdn.example.com/remote.css">
<style>body { background: #ffeeaa; } .box { background-color: #ccffcc; }</style>
</head><body onload="alert(1)"><h1>Hello HTML</h1>
<p class="box">Paragraph with <b>bold</b> and üñí.</p>
<table><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></table>
<img src="img/red.png" width="200" height="100">
<img src="https://example.com/tracker.png">
<script>document.write('SCRIPT RAN')</script>
<iframe src="https://example.com"></iframe></body></html>"""


def make_site(root: Path) -> Path:
    (root / "img").mkdir(parents=True)
    (root / "css").mkdir()
    Image.new("RGB", (200, 100), (200, 30, 30)).save(root / "img" / "red.png")
    (root / "css" / "site.css").write_text("h1 { color: #003399; }", encoding="utf-8")
    page = root / "index.html"
    page.write_bytes(PAGE.encode("cp1252"))  # an old page in its declared legacy charset
    return page


def run(ctx: RecordingContext, inputs: list[Path], **options: Any) -> Any:
    return html_to_pdf({"inputs": [str(p) for p in inputs], "options": options}, ctx)


def test_prepare_inlines_local_and_drops_active_or_remote_content(tmp_path: Path) -> None:
    prepared = prepare(make_site(tmp_path / "site"))
    html = prepared.html.decode("utf-8")
    assert "data:image/png;base64," in html
    assert "h1 { color: #003399; }" in html  # local stylesheet inlined
    assert "<script" not in html and "<iframe" not in html and "onload" not in html
    assert "cdn.example.com" not in html and "tracker.png" not in html
    assert '<meta charset="utf-8">' in html
    assert html.rstrip().endswith("</html>")
    assert "@page { size: 210mm 297mm; margin: 20mm; }" in html
    assert prepared.images_inlined == 1
    assert prepared.remote_skipped == 2  # remote image + remote style sheet


def test_prepare_strips_backgrounds_on_request(tmp_path: Path) -> None:
    html = prepare(make_site(tmp_path / "site"), background=False).html.decode("utf-8")
    assert "#ffeeaa" not in html and "#ccffcc" not in html


def test_page_css() -> None:
    assert page_css("letter", "landscape", "none") == "@page { size: 11in 8.5in; margin: 0; }"


@needs_lo
def test_html_page_converts_with_picture_and_no_script(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    page = make_site(tmp_path / "site")
    before = sha256(page)
    result = run(ctx, [page])
    out = result.outputs[0]
    assert out == tmp_path / "site" / "index.pdf"
    assert sha256(page) == before
    with pdfplumber.open(str(out)) as pdf:
        first = pdf.pages[0]
        text = first.extract_text() or ""
        assert "Hello HTML" in text and "üñí" in text and "A2" in text
        assert "SCRIPT RAN" not in text
        assert len(first.images) == 1
        assert (round(first.width), round(first.height)) == (595, 842)
    assert result.stats["remote_skipped"] == 2


@needs_lo
def test_page_size_orientation_margins_and_background(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    page = make_site(tmp_path / "site")
    out = run(
        ctx, [page], page_size="letter", orientation="landscape", margins="large", background=False
    ).outputs[0]
    with pdfplumber.open(str(out)) as pdf:
        first = pdf.pages[0]
        assert (round(first.width), round(first.height)) == (792, 612)
        assert min(w["x0"] for w in first.extract_words()) == pytest.approx(85, abs=3)  # 30 mm
    doc = pdfium.PdfDocument(str(out))
    try:
        pixel = doc[0].render(scale=1).to_pil().convert("RGB").getpixel((10, 10))
    finally:
        doc.close()
    assert pixel == (255, 255, 255)  # page background left out


def test_rejects_non_html(tmp_path: Path, ctx: RecordingContext) -> None:
    other = tmp_path / "page.txt"
    other.write_text("<p>hi</p>")
    with pytest.raises(EngineError) as err:
        run(ctx, [other])
    assert err.value.code == ErrorCode.INVALID_INPUT
