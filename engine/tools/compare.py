"""Compare PDF (docs/02_FEATURES.md F5): word-level text differences between two documents.

Words and their boxes come from PDFium's character boxes, converted to fractions of each page
*as displayed* (rotation applied), so the UI can draw them on its page previews. The two word
sequences (all pages) are aligned with difflib; the result is a list of changes — added,
removed or changed — and a report PDF: a summary page followed by the new and the old document
with the changes marked as annotations (green = added, red = removed, orange = changed).
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

import pypdfium2 as pdfium
from pikepdf import Array, Dictionary, Name, Pdf, String
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from jobs import JobContext, ToolResult
from utils.pagecopy import PageCopier
from utils.pageinfo import Matrix, display_matrix, display_rect_to_page, displayed_size
from utils.pdfio import deliver_pdf, open_pdf, save_pdf
from utils.textlayout import Counter
from utils.validation import check_pdf, passwords_map, require_str_list

MAX_CHANGES_LISTED = 500
COLORS = {"added": (0.18, 0.62, 0.27), "removed": (0.88, 0.19, 0.19), "changed": (0.94, 0.55, 0.0)}


@dataclass
class WordBox:
    text: str
    page: int
    x0: float
    y0: float
    x1: float
    y1: float  # display fractions, origin top-left


@dataclass
class Change:
    kind: str  # added | removed | changed
    old_text: str
    new_text: str
    old_boxes: list[dict[str, float]] = field(default_factory=list)
    new_boxes: list[dict[str, float]] = field(default_factory=list)


def _invert(m: Matrix) -> Matrix:
    a, b, c, d, e, f = m
    det = a * d - b * c
    return (d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det)


def extract_words(path: Path, pdf: Pdf) -> list[WordBox]:
    """Words (whitespace-separated) with boxes in display fractions, page by page."""
    words: list[WordBox] = []
    doc = pdfium.PdfDocument(str(path))
    try:
        for index in range(len(doc)):
            textpage = doc[index].get_textpage()
            try:
                words.extend(_page_words(textpage, index, pdf.pages[index]))
            finally:
                textpage.close()
    finally:
        doc.close()
    return words


def _page_words(textpage: Any, index: int, page: Any) -> list[WordBox]:
    width, height = displayed_size(page)
    inverse = _invert(display_matrix(page))
    count = textpage.count_chars()
    text = textpage.get_text_range(0, count) if count else ""
    words: list[WordBox] = []
    boxes: list[tuple[float, float, float, float]] = []
    chars: list[str] = []
    for i, ch in enumerate([*text[:count], " "]):
        if not ch.isspace():
            left, bottom, right, top = textpage.get_charbox(i)
            corners = [_apply(inverse, x, y) for x in (left, right) for y in (bottom, top)]
            boxes.append(
                (
                    min(c[0] for c in corners),
                    min(c[1] for c in corners),
                    max(c[0] for c in corners),
                    max(c[1] for c in corners),
                )
            )
            chars.append(ch)
            continue
        if chars:
            xs = [v for box in boxes for v in (box[0], box[2])]
            ys = [v for box in boxes for v in (box[1], box[3])]
            words.append(
                WordBox(
                    "".join(chars),
                    index,
                    max(0.0, min(xs) / width),
                    max(0.0, 1 - max(ys) / height),
                    min(1.0, max(xs) / width),
                    min(1.0, 1 - min(ys) / height),
                )
            )
        boxes, chars = [], []
    return words


def _apply(m: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return a * x + c * y + e, b * x + d * y + f


def _boxes(words: list[WordBox]) -> list[dict[str, float]]:
    """Merge the words of a change into one box per line."""
    lines: list[WordBox] = []
    for w in words:
        last = lines[-1] if lines else None
        same_line = (
            last is not None
            and last.page == w.page
            and abs((last.y0 + last.y1) / 2 - (w.y0 + w.y1) / 2) < (w.y1 - w.y0) * 0.6
        )
        if last is not None and same_line:
            last.x0, last.x1 = min(last.x0, w.x0), max(last.x1, w.x1)
            last.y0, last.y1 = min(last.y0, w.y0), max(last.y1, w.y1)
        else:
            lines.append(WordBox(w.text, w.page, w.x0, w.y0, w.x1, w.y1))
    return [
        {"page": b.page, "x": b.x0, "y": b.y0, "w": b.x1 - b.x0, "h": b.y1 - b.y0} for b in lines
    ]


def diff_words(old: list[WordBox], new: list[WordBox]) -> list[Change]:
    matcher = difflib.SequenceMatcher(
        a=[w.text for w in old], b=[w.text for w in new], autojunk=False
    )
    changes = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        kind = {"replace": "changed", "delete": "removed", "insert": "added"}[tag]
        changes.append(
            Change(
                kind,
                " ".join(w.text for w in old[i1:i2]),
                " ".join(w.text for w in new[j1:j2]),
                _boxes(old[i1:i2]),
                _boxes(new[j1:j2]),
            )
        )
    return changes


# ── report ────────────────────────────────────────────────────────────────────────────────


def _summary(path: Path, old: Path, new: Path, changes: list[Change], counter: Counter) -> None:
    styles = getSampleStyleSheet()
    story: list[Any] = [
        Paragraph("Comparison report", styles["Title"]),
        Paragraph(escape(counter.clean(f"Old: {old.name}    New: {new.name}")), styles["BodyText"]),
        Spacer(1, 8),
    ]
    counts = {k: sum(1 for c in changes if c.kind == k) for k in ("added", "removed", "changed")}
    story.append(
        Paragraph(
            f"{counts['added']} added, {counts['removed']} removed, {counts['changed']} changed. "
            "Following pages: the new document, then the old one, with the changes marked "
            "(green = added, red = removed, orange = changed).",
            styles["BodyText"],
        )
    )
    story.append(Spacer(1, 10))
    if changes:
        rows: list[list[Any]] = [["", "Page", "Old", "New"]]
        cell = styles["BodyText"]
        for change in changes[:MAX_CHANGES_LISTED]:
            boxes = change.new_boxes or change.old_boxes
            page = str(boxes[0]["page"] + 1) if boxes else ""
            rows.append(
                [
                    change.kind,
                    page,
                    Paragraph(escape(counter.clean(change.old_text[:400])), cell),
                    Paragraph(escape(counter.clean(change.new_text[:400])), cell),
                ]
            )
        table = Table(rows, colWidths=[60, 36, 210, 210], repeatRows=1)
        table.setStyle(
            TableStyle(
                [
                    ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEF2F5")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ]
            )
        )
        story.append(table)
        if len(changes) > MAX_CHANGES_LISTED:
            story.append(
                Paragraph(
                    f"… and {len(changes) - MAX_CHANGES_LISTED} more changes.", styles["BodyText"]
                )
            )
    else:
        story.append(Paragraph("The two documents contain the same text.", styles["BodyText"]))
    SimpleDocTemplate(str(path), pagesize=A4, title="Comparison report").build(story)


def _mark(pdf: Pdf, offset: int, boxes: list[dict[str, float]], kind: str, note: str) -> None:
    for box in boxes:
        page = pdf.pages[offset + int(box["page"])]
        width, height = displayed_size(page)
        rect = display_rect_to_page(
            page,
            (
                box["x"] * width - 1,
                (1 - box["y"] - box["h"]) * height - 1,
                (box["x"] + box["w"]) * width + 1,
                (1 - box["y"]) * height + 1,
            ),
        )
        annot = pdf.make_indirect(
            Dictionary(
                Type=Name.Annot,
                Subtype=Name.Square,
                Rect=Array(list(rect)),
                C=Array(list(COLORS[kind])),
                BS=Dictionary(W=1.5),
                F=4,
                T=String("PDFForge compare"),
                Contents=String(note[:1000]),
                P=page.obj,
            )
        )
        existing = page.obj.get("/Annots")
        page.obj.Annots = Array([*list(existing or []), annot])


def compare(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    paths = [Path(p) for p in require_str_list(params, "inputs", min_len=2, max_len=2)]
    for path in paths:
        check_pdf(path)
    old_path, new_path = paths
    passwords = passwords_map(params)
    work = ctx.temp_dir
    plain = [work / "old.pdf", work / "new.pdf"]
    ctx.progress(5, "Reading both documents")
    with open_pdf(old_path, passwords) as old_pdf, open_pdf(new_path, passwords) as new_pdf:
        old_pdf.save(plain[0])
        new_pdf.save(plain[1])
    with Pdf.open(plain[0]) as old_pdf, Pdf.open(plain[1]) as new_pdf:
        old_words = extract_words(plain[0], old_pdf)
        ctx.check_cancelled()
        new_words = extract_words(plain[1], new_pdf)
        ctx.check_cancelled()
        ctx.progress(40, "Comparing text")
        changes = diff_words(old_words, new_words)
        ctx.check_cancelled()
        ctx.progress(60, "Writing the report")
        counter = Counter()
        summary_path = work / "summary.pdf"
        _summary(summary_path, old_path, new_path, changes, counter)
        report = Pdf.new()
        opened = [Pdf.open(summary_path)]
        try:
            copier = PageCopier(report)
            copier.add(opened[0], range(len(opened[0].pages)))
            new_offset = len(report.pages)
            copier.add(new_pdf, range(len(new_pdf.pages)))
            old_offset = len(report.pages)
            copier.add(old_pdf, range(len(old_pdf.pages)))
            copier.finish()
            for change in changes:
                note = f"{change.kind}: {change.old_text!r} -> {change.new_text!r}"
                if change.new_boxes:
                    _mark(report, new_offset, change.new_boxes, change.kind, note)
                if change.old_boxes:
                    _mark(report, old_offset, change.old_boxes, change.kind, note)
            tmp = work / "report.pdf"
            save_pdf(report, tmp, ctx, start=80)
        finally:
            report.close()
            for pdf in opened:
                pdf.close()
    final = deliver_pdf(tmp, params, new_path, "compared", protected=paths)
    listed = changes[:MAX_CHANGES_LISTED]
    return ToolResult(
        [final],
        {
            "added": sum(1 for c in changes if c.kind == "added"),
            "removed": sum(1 for c in changes if c.kind == "removed"),
            "changed": sum(1 for c in changes if c.kind == "changed"),
            "changes": [
                {
                    "kind": c.kind,
                    "old": c.old_text[:300],
                    "new": c.new_text[:300],
                    "old_boxes": c.old_boxes,
                    "new_boxes": c.new_boxes,
                }
                for c in listed
            ],
            "truncated": len(changes) > MAX_CHANGES_LISTED,
        },
    )
