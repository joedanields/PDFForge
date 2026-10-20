"""Download a web page and the pictures and style sheets it uses (Web page to PDF, D-043).

The only engine code that goes online, and only inside ``netguard.allowed()``. Limits keep a
hostile or huge page from filling the disk or hanging the job: http(s) only, 30 s per request,
20 MB for the page, 10 MB per resource, 60 MB and 300 resources in total. Nothing on the page
runs: the saved copy goes through html_prep, which removes scripts, frames and plug-ins.
"""

from __future__ import annotations

import mimetypes
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urldefrag, urljoin, urlparse

from lxml import etree
from lxml import html as lxml_html

from jobs import JobContext
from protocol import EngineError, ErrorCode
from utils import netguard

TIMEOUT_S = 30
MAX_PAGE_BYTES = 20 * 1024 * 1024
MAX_RESOURCE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 60 * 1024 * 1024
MAX_RESOURCES = 300
MAX_URL_CHARS = 2048
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PDFForge (Web page to PDF)"
HTML_TYPES = ("text/html", "application/xhtml+xml")


@dataclass
class Fetched:
    """The saved page (``page``) next to its downloaded resources."""

    page: Path
    final_url: str
    title: str
    resources: int = 0
    failed: int = 0
    bytes: int = 0
    notes: list[str] = field(default_factory=list)


def check_url(url: str) -> str:
    """A cleaned http(s) address, or INVALID_INPUT."""
    url = url.strip()
    if url and "://" not in url:
        url = "https://" + url
    parsed = urlparse(url)
    try:
        parsed.port  # noqa: B018 - raises for "javascript:alert(1)" read as host:port
    except ValueError:
        parsed = urlparse("")
    if (
        len(url) > MAX_URL_CHARS
        or parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or any(c.isspace() for c in url)
    ):
        raise EngineError(ErrorCode.INVALID_INPUT, "Enter a web address starting with https://")
    return urldefrag(url)[0]


class _HttpOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> Any:
        if urlparse(newurl).scheme not in ("http", "https"):
            raise urllib.error.URLError(f"redirect to {newurl} refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_HttpOnly())


def _download(url: str, limit: int, ctx: JobContext) -> tuple[bytes, str, str]:
    """(body, final URL, content type); raises URLError/OSError/ValueError on failure."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with netguard.allowed(), _OPENER.open(request, timeout=TIMEOUT_S) as response:
        declared = response.headers.get("Content-Length")
        if declared and declared.isdigit() and int(declared) > limit:
            raise ValueError("too large")
        chunks: list[bytes] = []
        size = 0
        while True:
            ctx.check_cancelled()
            chunk = response.read(64 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise ValueError("too large")
            chunks.append(chunk)
        kind = (response.headers.get_content_type() or "").lower()
        return b"".join(chunks), response.geturl(), kind


def fetch_page(url: str, work: Path, ctx: JobContext, *, start: float, end: float) -> Fetched:
    url = check_url(url)
    host = urlparse(url).hostname or url
    ctx.progress(start, f"Downloading {host}")
    try:
        body, final_url, kind = _download(url, MAX_PAGE_BYTES, ctx)
    except ValueError as exc:
        raise EngineError(ErrorCode.UNSUPPORTED, "The page is larger than 20 MB") from exc
    except urllib.error.HTTPError as exc:
        raise EngineError(
            ErrorCode.INVALID_INPUT, f"The website answered {exc.code} {exc.reason}"
        ) from exc
    except (urllib.error.URLError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise EngineError(
            ErrorCode.INVALID_INPUT,
            f"{host} could not be reached. Check the address and your internet connection "
            f"({reason})",
        ) from exc
    if kind and kind not in HTML_TYPES:
        raise EngineError(
            ErrorCode.UNSUPPORTED, f"That address is not a web page ({kind}); download it instead"
        )

    try:
        doc = lxml_html.document_fromstring(body)
    except (etree.ParserError, ValueError) as exc:
        raise EngineError(ErrorCode.INVALID_INPUT, "The page could not be read") from exc
    base = final_url
    for tag in doc.iter("base"):
        href = tag.get("href")
        if href:
            base = urljoin(final_url, href)
        break
    title = " ".join((doc.findtext(".//title") or "").split())[:120]

    refs: list[tuple[Any, str]] = []
    for img in doc.iter("img"):
        if "srcset" in img.attrib:
            del img.attrib["srcset"]
        src = img.get("src") or img.get("data-src") or ""
        if src and not src.startswith("data:"):
            refs.append((img, "src"))
            img.set("src", src)
    for link in doc.iter("link"):
        if "stylesheet" in (link.get("rel") or "").lower() and link.get("href"):
            refs.append((link, "href"))

    result = Fetched(work / "page.html", final_url, title, bytes=len(body))
    res_dir = work / "res"
    res_dir.mkdir(parents=True, exist_ok=True)
    seen: dict[str, str] = {}
    total = len(body)
    wanted = refs[:MAX_RESOURCES]
    for n, (element, attr) in enumerate(wanted):
        ctx.check_cancelled()
        ctx.progress(start + (end - start) * (n + 1) / (len(wanted) + 1), "Downloading pictures")
        absolute = urldefrag(urljoin(base, element.get(attr, "").strip()))[0]
        if urlparse(absolute).scheme not in ("http", "https"):
            element.set(attr, "")
            continue
        if absolute in seen:
            element.set(attr, seen[absolute])
            continue
        try:
            data, _final, kind = _download(
                absolute, min(MAX_RESOURCE_BYTES, MAX_TOTAL_BYTES - total), ctx
            )
        except (ValueError, urllib.error.URLError, OSError):
            result.failed += 1
            element.set(attr, "")
            continue
        total += len(data)
        name = f"r{n:03d}{_suffix(absolute, kind, attr)}"
        local = res_dir / name
        if attr == "href":
            data = _inline_css_imports(data)
        local.write_bytes(data)
        seen[absolute] = f"res/{name}"
        element.set(attr, f"res/{name}")
        result.resources += 1
    result.failed += max(0, len(refs) - MAX_RESOURCES)
    result.bytes = total
    for tag in list(doc.iter("base")):
        parent = tag.getparent()
        if parent is not None:
            parent.remove(tag)
    result.page.write_bytes(lxml_html.tostring(doc, encoding="utf-8", method="html"))
    return result


def _suffix(url: str, kind: str, attr: str) -> str:
    if attr == "href":
        return ".css"
    guessed = mimetypes.guess_extension(kind or "") if kind else None
    if guessed in (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg"):
        return ".jpg" if guessed == ".jpeg" else guessed
    path_suffix = Path(urlparse(url).path).suffix.lower()
    return path_suffix if re.fullmatch(r"\.\w{2,5}", path_suffix) else ".img"


def _inline_css_imports(css: bytes) -> bytes:
    """``@import`` and ``url()`` inside downloaded style sheets would point online again; drop
    them (html_prep only inlines what is local)."""
    text = css.decode("utf-8", errors="replace")
    text = re.sub(r"@import[^;]+;", "", text)
    text = re.sub(r"url\(\s*['\"]?(?!data:)[^)'\"]*['\"]?\s*\)", "none", text)
    return text.encode("utf-8")
