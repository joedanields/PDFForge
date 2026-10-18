"""Plain text and Markdown → ReportLab flowables (Text → PDF, docs/02 C6).

Fonts are the PDF standard fonts (D-007), which cover Windows-1252 (Western European text,
curly quotes, dashes, the euro sign). Other characters are replaced by '?' and counted, so
the user is told instead of silently getting missing glyphs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    HRFlowable,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    Preformatted,
    Spacer,
)

FAMILIES = {
    "helvetica": ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"),
    "times": ("Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"),
    "courier": ("Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"),
}


@dataclass
class Styles:
    family: str
    size: float
    body: ParagraphStyle = field(init=False)
    code: ParagraphStyle = field(init=False)
    quote: ParagraphStyle = field(init=False)
    headings: list[ParagraphStyle] = field(init=False)

    def __post_init__(self) -> None:
        regular, bold, _italic, _bold_italic = FAMILIES[self.family]
        leading = self.size * 1.35
        self.body = ParagraphStyle(
            "body",
            fontName=regular,
            fontSize=self.size,
            leading=leading,
            spaceAfter=self.size * 0.6,
        )
        self.code = ParagraphStyle(
            "code",
            fontName="Courier",
            fontSize=self.size * 0.9,
            leading=self.size * 1.2,
            backColor=colors.HexColor("#F2F2F2"),
            borderPadding=4,
            spaceBefore=4,
            spaceAfter=self.size,
        )
        self.quote = ParagraphStyle(
            "quote",
            parent=self.body,
            leftIndent=self.size * 1.5,
            textColor=colors.HexColor("#555555"),
        )
        scale = [2.0, 1.6, 1.3, 1.15, 1.0, 0.9]
        self.headings = [
            ParagraphStyle(
                f"h{n + 1}",
                fontName=bold,
                fontSize=self.size * s,
                leading=self.size * s * 1.25,
                spaceBefore=self.size * (1.2 if n < 2 else 0.8),
                spaceAfter=self.size * 0.5,
                keepWithNext=True,
            )
            for n, s in enumerate(scale)
        ]


@dataclass
class Counter:
    replaced: int = 0

    def clean(self, text: str) -> str:
        """Keep what the standard fonts can show (cp1252); replace and count the rest."""
        out = []
        for ch in text:
            if ch in "\t\n":
                out.append(ch)
                continue
            try:
                ch.encode("cp1252")
                out.append(ch)
            except UnicodeEncodeError:
                self.replaced += 1
                out.append("?")
        return "".join(out)


def plain_text_flowables(text: str, styles: Styles, counter: Counter) -> list[Any]:
    """Each line keeps its line break and leading spaces; long lines wrap; form feeds break."""
    story: list[Any] = []
    for page_no, page in enumerate(text.split("\f")):
        if page_no:
            story.append(PageBreak())
        for raw in page.split("\n"):
            line = counter.clean(raw.rstrip("\r")).expandtabs(4)
            if not line.strip():
                story.append(Spacer(1, styles.body.leading))
                continue
            stripped = line.lstrip(" ")
            indent = len(line) - len(stripped)
            markup = "&nbsp;" * indent + escape(stripped)
            story.append(Paragraph(markup, _tight(styles.body)))
    return story


def _tight(style: ParagraphStyle) -> ParagraphStyle:
    return ParagraphStyle(f"{style.name}-tight", parent=style, spaceAfter=0)


# ── Markdown (CommonMark subset) ──────────────────────────────────────────────────────────

_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_BULLET = re.compile(r"^(\s*)[-*+]\s+(.*)$")
_NUMBERED = re.compile(r"^(\s*)(\d{1,9})[.)]\s+(.*)$")
_FENCE = re.compile(r"^\s*(```|~~~)")
_RULE = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
_CODE_SPAN = re.compile(r"`([^`]+)`")
_BOLD = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1")
_ITALIC = re.compile(r"(?<![*\w])([*_])(?=\S)(.+?)(?<=\S)\1(?![*\w])")
_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")


def inline_markup(text: str, counter: Counter) -> str:
    """Markdown inline syntax -> ReportLab paragraph markup (escaped)."""
    text = counter.clean(text)
    codes: list[str] = []

    def keep_code(m: re.Match[str]) -> str:
        codes.append(f'<font face="Courier">{escape(m.group(1))}</font>')
        return f"\x00{len(codes) - 1}\x00"

    text = _CODE_SPAN.sub(keep_code, text)
    text = _IMAGE.sub(lambda m: f"[{m.group(1) or 'image'}]", text)
    text = escape(text)
    text = _LINK.sub(
        lambda m: f'<link href="{m.group(2)}" color="#1A5FB4"><u>{m.group(1)}</u></link>', text
    )
    text = _BOLD.sub(r"<b>\2</b>", text)
    text = _ITALIC.sub(r"<i>\2</i>", text)
    return re.sub("\x00(\\d+)\x00", lambda m: codes[int(m.group(1))], text)


def markdown_flowables(text: str, styles: Styles, counter: Counter) -> list[Any]:
    story: list[Any] = []
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    paragraph: list[str] = []
    items: list[tuple[str, int | None, str]] = []  # (kind, start, text)

    def flush_paragraph() -> None:
        if paragraph:
            markup = inline_markup(" ".join(paragraph), counter)
            story.append(
                Paragraph(markup.replace("\x01 ", "<br/>").replace("\x01", ""), styles.body)
            )
            paragraph.clear()

    def flush_list() -> None:
        if not items:
            return
        numbered = items[0][0] == "ol"
        flowables = [
            ListItem(Paragraph(inline_markup(t, counter), _tight(styles.body))) for _, _, t in items
        ]
        story.append(
            ListFlowable(
                flowables,
                bulletType="1" if numbered else "bullet",
                start=items[0][1] if numbered else None,
                bulletFontName=styles.body.fontName,
                bulletFontSize=styles.body.fontSize,
                leftIndent=styles.size * 1.6,
                spaceAfter=styles.size * 0.6,
            )
        )
        items.clear()

    i = 0
    while i < len(lines):
        line = lines[i]
        if _FENCE.match(line):
            flush_paragraph()
            flush_list()
            fence = _FENCE.match(line)
            assert fence is not None
            code: list[str] = []
            i += 1
            while i < len(lines) and not lines[i].lstrip().startswith(fence.group(1)):
                code.append(counter.clean(lines[i]).expandtabs(4))
                i += 1
            story.append(Preformatted("\n".join(code) or " ", styles.code))
            i += 1
            continue
        if not line.strip():
            flush_paragraph()
            flush_list()
            i += 1
            continue
        if line.strip() == "\f":
            flush_paragraph()
            flush_list()
            story.append(PageBreak())
            i += 1
            continue
        heading = _HEADING.match(line)
        if heading:
            flush_paragraph()
            flush_list()
            level = len(heading.group(1))
            story.append(
                Paragraph(inline_markup(heading.group(2), counter), styles.headings[level - 1])
            )
            i += 1
            continue
        if _RULE.match(line):
            flush_paragraph()
            flush_list()
            story.append(
                HRFlowable(
                    width="100%", thickness=0.7, color=colors.grey, spaceBefore=4, spaceAfter=8
                )
            )
            i += 1
            continue
        if line.lstrip().startswith(">"):
            flush_paragraph()
            flush_list()
            quote: list[str] = []
            while i < len(lines) and lines[i].lstrip().startswith(">"):
                quote.append(lines[i].lstrip()[1:].strip())
                i += 1
            story.append(Paragraph(inline_markup(" ".join(quote), counter), styles.quote))
            continue
        bullet = _BULLET.match(line)
        numbered = _NUMBERED.match(line)
        if bullet or numbered:
            flush_paragraph()
            kind = "ul" if bullet else "ol"
            if items and items[0][0] != kind:
                flush_list()
            if bullet:
                items.append(("ul", None, bullet.group(2)))
            elif numbered:
                items.append(("ol", int(numbered.group(2)), numbered.group(3)))
            i += 1
            continue
        if items and line.startswith((" ", "\t")):  # continuation of a list item
            kind, start, prev = items[-1]
            items[-1] = (kind, start, f"{prev} {line.strip()}")
            i += 1
            continue
        flush_list()
        # A line ending in two spaces (or a backslash) is a hard break.
        if line.endswith("  ") or line.endswith("\\"):
            paragraph.append(line.rstrip(" \\") + "\x01")
        else:
            paragraph.append(line.strip())
        i += 1
    flush_paragraph()
    flush_list()
    return story
