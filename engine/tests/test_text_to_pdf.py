"""Text / Markdown → PDF (docs/02 C6)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pdfplumber
import pytest

from protocol import EngineError, ErrorCode
from tests.helpers import RecordingContext, sha256
from tools.to_pdf import read_text_file, text_to_pdf
from utils.textlayout import Counter, inline_markup


def run(ctx: RecordingContext, inputs: list[Path], **options: Any) -> Any:
    return text_to_pdf({"inputs": [str(p) for p in inputs], "options": options}, ctx)


def pdf_text(path: Path) -> list[str]:
    with pdfplumber.open(str(path)) as pdf:
        return [page.extract_text() or "" for page in pdf.pages]


def fonts_used(path: Path) -> set[str]:
    with pdfplumber.open(str(path)) as pdf:
        return {c["fontname"] for page in pdf.pages for c in page.chars}


def test_plain_text_keeps_lines_and_indentation(tmp_path: Path, ctx: RecordingContext) -> None:
    txt = tmp_path / "notes.txt"
    txt.write_text("First line\n    indented line\n\nAfter a blank line\n", encoding="utf-8")
    before = sha256(txt)
    result = run(ctx, [txt])
    out = result.outputs[0]
    assert out == tmp_path / "notes.pdf"
    assert sha256(txt) == before
    with pdfplumber.open(str(out)) as pdf:
        words = pdf.pages[0].extract_words()
    first = next(w for w in words if w["text"] == "First")
    indented = next(w for w in words if w["text"] == "indented")
    assert indented["x0"] > first["x0"] + 10
    assert result.stats == {"files": 1, "pages": 1}


def test_long_text_flows_onto_more_pages_and_form_feed_breaks(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    txt = tmp_path / "long.txt"
    txt.write_text("\n".join(f"Line {n}" for n in range(150)) + "\fNew page", encoding="utf-8")
    out = run(ctx, [txt]).outputs[0]
    pages = pdf_text(out)
    assert len(pages) >= 3
    assert pages[-1].strip() == "New page"


def test_font_size_and_page_size_options(tmp_path: Path, ctx: RecordingContext) -> None:
    txt = tmp_path / "code.txt"
    txt.write_text("monospace", encoding="utf-8")
    out = run(ctx, [txt], font="courier", size=14, page_size="letter").outputs[0]
    assert fonts_used(out) == {"Courier"}
    with pdfplumber.open(str(out)) as pdf:
        page = pdf.pages[0]
        assert (round(page.width), round(page.height)) == (612, 792)
        assert round(page.chars[0]["size"]) == 14


def test_markdown_structure(tmp_path: Path, ctx: RecordingContext) -> None:
    md = tmp_path / "readme.md"
    md.write_text(
        "# Title\n\nSome **bold** and *italic* text with `code`.\n\n"
        "- first item\n- second item\n\n1. one\n2. two\n\n> quoted words\n\n"
        "```\nprint('hi')\n```\n\n---\n\n## Section\n\nSee [the site](https://example.com).\n",
        encoding="utf-8",
    )
    out = run(ctx, [md]).outputs[0]
    text = pdf_text(out)[0]
    for expected in ["Title", "Some bold and italic text with code.", "first item", "quoted words"]:
        assert expected in text
    assert "print('hi')" in text
    assert "**" not in text and "```" not in text and "# " not in text
    with pdfplumber.open(str(out)) as pdf:
        chars = pdf.pages[0].chars
        title = next(c for c in chars if c["text"] == "T")
        body = next(c for c in chars if c["text"] == "S")
        assert title["size"] > body["size"] * 1.5
        assert "Helvetica-Bold" in {c["fontname"] for c in chars}
        assert "Helvetica-Oblique" in {c["fontname"] for c in chars}
        assert "Courier" in {c["fontname"] for c in chars}
        assert any(a.get("uri") == "https://example.com" for a in pdf.pages[0].hyperlinks)


def test_inline_markup_escapes_html() -> None:
    counter = Counter()
    assert inline_markup("a < b & **c**", counter) == "a &lt; b &amp; <b>c</b>"
    assert inline_markup("snake_case_name", counter) == "snake_case_name"
    assert inline_markup("`<tag>`", counter) == '<font face="Courier">&lt;tag&gt;</font>'


def test_unsupported_characters_are_replaced_and_counted(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    txt = tmp_path / "mixed.txt"
    txt.write_text("Café “quotes” € — வணக்கம் 😀", encoding="utf-8")
    result = run(ctx, [txt])
    text = pdf_text(result.outputs[0])[0]
    assert "Café “quotes” € —" in text
    assert result.stats["replaced_characters"] == 8  # 7 Tamil code points + 1 emoji


def test_text_encodings(tmp_path: Path) -> None:
    (tmp_path / "a.txt").write_bytes("Grüße".encode("utf-16"))
    (tmp_path / "b.txt").write_bytes("Grüße".encode("cp1252"))
    (tmp_path / "c.txt").write_bytes(b"\xef\xbb\xbf" + "Grüße".encode())
    for name in ("a.txt", "b.txt", "c.txt"):
        assert read_text_file(tmp_path / name) == "Grüße"


def test_empty_file_gives_one_blank_page(tmp_path: Path, ctx: RecordingContext) -> None:
    txt = tmp_path / "empty.txt"
    txt.write_text("", encoding="utf-8")
    assert run(ctx, [txt]).stats["pages"] == 1


def test_rejects_other_files(tmp_path: Path, ctx: RecordingContext) -> None:
    other = tmp_path / "data.csv"
    other.write_text("a,b")
    with pytest.raises(EngineError) as err:
        run(ctx, [other])
    assert err.value.code == ErrorCode.INVALID_INPUT
