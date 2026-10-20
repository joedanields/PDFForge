"""Web page to PDF (docs/02 C5 "URL*", D-043): the only tool allowed online.

A local HTTP server on 127.0.0.1 plays the website; loopback is always reachable.
"""

from __future__ import annotations

import socket
import threading
from collections.abc import Iterator
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pdfplumber
import pytest
from PIL import Image

from protocol import EngineError, ErrorCode
from tests.helpers import RecordingContext
from tools.to_pdf import url_to_pdf
from utils import netguard, webfetch
from utils.vendor import soffice_path

needs_lo = pytest.mark.skipif(not soffice_path().is_file(), reason="LibreOffice not fetched")

PAGE = """<!doctype html><html><head><title>Quarterly  News</title>
<link rel="stylesheet" href="/css/site.css">
<base href="/articles/">
</head><body><h1>Hello from the web</h1>
<p>Some paragraph text.</p>
<img src="../img/red.png" width="200" height="100">
<img src="missing.png">
<script>document.write('SCRIPT RAN')</script></body></html>"""


@pytest.fixture
def site(tmp_path: Path) -> Iterator[str]:
    root = tmp_path / "site"
    (root / "img").mkdir(parents=True)
    (root / "css").mkdir()
    (root / "articles").mkdir()
    Image.new("RGB", (200, 100), (200, 30, 30)).save(root / "img" / "red.png")
    (root / "css" / "site.css").write_text(
        "@import url('https://cdn.example.com/x.css');\nh1 { color: #003399; "
        "background: url(https://example.com/bg.png); }",
        encoding="utf-8",
    )
    (root / "index.html").write_text(PAGE, encoding="utf-8")
    (root / "report.pdf").write_bytes(b"%PDF-1.7\n")

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, directory=str(root), **kwargs)

        def log_message(self, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def run(ctx: RecordingContext, url: str, out_dir: Path, **options: Any) -> Any:
    out_dir.mkdir(exist_ok=True)
    return url_to_pdf({"options": {"url": url, **options}, "output_dir": str(out_dir)}, ctx)


@needs_lo
def test_page_with_pictures_and_styles(tmp_path: Path, ctx: RecordingContext, site: str) -> None:
    result = run(ctx, f"{site}/index.html", tmp_path / "out")
    [out] = result.outputs
    assert out == tmp_path / "out" / "Quarterly News.pdf"
    assert result.stats["resources"] == 2  # the picture and the style sheet
    assert result.stats["resources_failed"] == 1  # missing.png
    assert result.stats["url"] == f"{site}/index.html"
    with pdfplumber.open(out) as pdf:
        text = "\n".join(page.extract_text() or "" for page in pdf.pages)
        images = sum(len(page.images) for page in pdf.pages)
    assert "Hello from the web" in text
    assert "SCRIPT RAN" not in text
    assert images == 1


def test_web_errors_are_explained(tmp_path: Path, ctx: RecordingContext, site: str) -> None:
    with pytest.raises(EngineError) as info:
        run(ctx, f"{site}/nothing-here.html", tmp_path / "out")
    assert info.value.code == ErrorCode.INVALID_INPUT
    assert "404" in info.value.message
    with pytest.raises(EngineError) as info:
        run(ctx, f"{site}/report.pdf", tmp_path / "out")
    assert info.value.code == ErrorCode.UNSUPPORTED


def test_page_size_limit(
    tmp_path: Path, ctx: RecordingContext, site: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(webfetch, "MAX_PAGE_BYTES", 100)
    with pytest.raises(EngineError) as info:
        run(ctx, f"{site}/index.html", tmp_path / "out")
    assert info.value.code == ErrorCode.UNSUPPORTED


@pytest.mark.parametrize(
    "url", ["", "ftp://example.com/a.html", "javascript:alert(1)", "file:///C:/x.html", "a b"]
)
def test_only_web_addresses(url: str) -> None:
    with pytest.raises(EngineError) as info:
        webfetch.check_url(url)
    assert info.value.code == ErrorCode.INVALID_INPUT


def test_address_is_cleaned() -> None:
    assert webfetch.check_url("  example.com/news#top ") == "https://example.com/news"
    assert webfetch.check_url("http://example.com") == "http://example.com"


def test_network_stays_blocked_outside_the_tool() -> None:
    # conftest installs the guard, as the worker does.
    with pytest.raises(netguard.NetworkBlockedError):
        socket.getaddrinfo("example.com", 443)
    with netguard.allowed():
        assert netguard._permitted(("93.184.216.34", 443))
    assert not netguard._permitted(("93.184.216.34", 443))
    assert netguard._permitted(("127.0.0.1", 80))
