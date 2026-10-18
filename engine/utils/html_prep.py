"""Prepare a local HTML file for conversion by LibreOffice (HTML → PDF, docs/02 C5).

LibreOffice gets a private, self-contained copy of the page:
- local pictures and style sheets are inlined (``data:`` URIs / ``<style>``), because the
  hardened LibreOffice profile refuses to follow links out of an untrusted document;
- remote resources are left out (offline rule, 05 S2) and counted so the UI can say so;
- scripts, frames and plug-ins are removed (nothing in the page ever runs, 05 S6);
- the user's page size, orientation and margins are appended as ``@page`` CSS (later rules
  win over the page's own), and backgrounds can be stripped.
"""

from __future__ import annotations

import base64
import mimetypes
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

from lxml import etree
from lxml import html as lxml_html

MAX_INLINE_BYTES = 20 * 1024 * 1024
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp", "image/svg+xml"}
PAGE_SIZES = {"a4": ("210mm", "297mm"), "letter": ("8.5in", "11in"), "legal": ("8.5in", "14in")}
MARGINS = {"none": "0", "small": "10mm", "normal": "20mm", "large": "30mm"}
_BACKGROUND = re.compile(r"background(-color|-image)?\s*:[^;}\"]*;?", re.I)
_DROP = ("script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet")


@dataclass
class Prepared:
    html: bytes
    images_inlined: int = 0
    remote_skipped: int = 0
    missing: int = 0


def _drop(element: Any) -> None:
    """Remove an element but keep the text that follows it (lxml.html's drop_tree)."""
    element.drop_tree()


def _local_path(ref: str, base_dir: Path) -> Path | None:
    """The local file an ``src``/``href`` points to, or None for remote / data / anchors."""
    ref = ref.strip()
    if not ref or ref.startswith(("#", "data:", "javascript:", "mailto:")):
        return None
    parsed = urlparse(ref)
    if parsed.scheme in ("http", "https", "ftp", "//") or ref.startswith("//"):
        return None
    if parsed.scheme == "file":
        return Path(url2pathname(unquote(parsed.path)))
    if len(parsed.scheme) == 1:  # "C:\images\x.png" parses with scheme "c"
        return Path(ref)
    if parsed.scheme:
        return None
    return (base_dir / unquote(parsed.path)).resolve()


def _is_remote(ref: str) -> bool:
    return ref.strip().lower().startswith(("http:", "https:", "ftp:", "//"))


def _data_uri(path: Path) -> str | None:
    try:
        if not path.is_file() or path.stat().st_size > MAX_INLINE_BYTES:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    mime = mimetypes.guess_type(path.name)[0]
    if mime not in IMAGE_TYPES:
        return None
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def page_css(page_size: str, orientation: str, margins: str) -> str:
    width, height = PAGE_SIZES[page_size]
    if orientation == "landscape":
        width, height = height, width
    return f"@page {{ size: {width} {height}; margin: {MARGINS[margins]}; }}"


def prepare(
    source: Path,
    *,
    page_size: str = "a4",
    orientation: str = "portrait",
    margins: str = "normal",
    background: bool = True,
) -> Prepared:
    raw = source.read_bytes()
    try:
        doc = lxml_html.document_fromstring(raw)
    except (etree.ParserError, ValueError):
        doc = lxml_html.document_fromstring("<html><body></body></html>")
    base_dir = source.parent
    result = Prepared(b"")

    for el in list(doc.iter(*_DROP)):
        _drop(el)
    for el in doc.iter():
        if not isinstance(el.tag, str):
            continue
        for attr in [str(a) for a in el.attrib if str(a).lower().startswith("on")]:
            del el.attrib[attr]  # inline event handlers
    for base in list(doc.iter("base")):
        _drop(base)

    for img in doc.iter("img"):
        src = img.get("src", "")
        if _is_remote(src):
            result.remote_skipped += 1
            img.set("src", "")
            continue
        path = _local_path(src, base_dir)
        if path is None:
            continue
        uri = _data_uri(path)
        if uri is None:
            result.missing += 1
            continue
        img.set("src", uri)
        result.images_inlined += 1

    for link in list(doc.iter("link")):
        rel = (link.get("rel") or "").lower()
        href = link.get("href", "")
        if "stylesheet" not in rel:
            continue
        if _is_remote(href):
            result.remote_skipped += 1
            _drop(link)
            continue
        path = _local_path(href, base_dir)
        css = None
        if path is not None and path.is_file() and path.stat().st_size <= MAX_INLINE_BYTES:
            css = path.read_text(encoding="utf-8", errors="replace")
        if css is None:
            result.missing += 1
            _drop(link)
            continue
        style = etree.Element("style")
        style.text = css
        link.addprevious(style)
        _drop(link)

    head = doc.find("head")
    if head is None:
        head = etree.Element("head")
        doc.insert(0, head)
    for meta in list(head.iter("meta")):
        if meta.get("charset") or (meta.get("http-equiv") or "").lower() == "content-type":
            _drop(meta)
    charset = etree.Element("meta")
    charset.set("charset", "utf-8")
    head.insert(0, charset)

    if not background:
        for style in doc.iter("style"):
            style.text = _BACKGROUND.sub("", style.text or "")
        for el in doc.iter():
            if not isinstance(el.tag, str):
                continue
            for attr in ("bgcolor", "background"):
                if attr in el.attrib:
                    del el.attrib[attr]
            if "style" in el.attrib:
                el.set("style", _BACKGROUND.sub("", el.get("style", "")))
    ours = etree.SubElement(head, "style")
    ours.text = page_css(page_size, orientation, margins)

    result.html = lxml_html.tostring(
        doc, encoding="utf-8", method="html", doctype="<!DOCTYPE html>"
    )
    return result
