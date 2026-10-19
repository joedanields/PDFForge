"""Compare PDF (docs/02 F5): word-level differences and an annotated report."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas

from tests.fixtures import make_encrypted_pdf
from tests.helpers import RecordingContext, sha256
from tools.compare import compare


def make_version(path: Path, lines: list[str], *, rotate: int = 0) -> Path:
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica", 14)
    for n, line in enumerate(lines):
        c.drawString(72, A4[1] - 100 - n * 24, line)
    c.showPage()
    c.save()
    if rotate:
        with pikepdf.open(path, allow_overwriting_input=True) as pdf:
            pdf.pages[0].obj.Rotate = rotate
            pdf.save(path)
    return path


OLD = ["The rent is 15000 per month.", "Deposit two months.", "Pets are not allowed."]
NEW = ["The rent is 18000 per month.", "Deposit two months.", "Parking is included."]


def run(ctx: RecordingContext, old: Path, new: Path, **params: Any) -> Any:
    return compare({"inputs": [str(old), str(new)], **params}, ctx)


def test_finds_changed_removed_and_added_words(tmp_path: Path, ctx: RecordingContext) -> None:
    old = make_version(tmp_path / "lease v1.pdf", OLD)
    new = make_version(tmp_path / "lease v2.pdf", NEW)
    before = (sha256(old), sha256(new))
    result = run(ctx, old, new)
    assert (sha256(old), sha256(new)) == before
    changes = result.stats["changes"]
    texts = [(c["kind"], c["old"], c["new"]) for c in changes]
    assert ("changed", "15000", "18000") in texts
    assert any(k == "changed" and "Pets" in o and "Parking" in n for k, o, n in texts)
    assert result.stats["changed"] >= 2
    rent = next(c for c in changes if c["old"] == "15000")
    box = rent["new_boxes"][0]
    assert box["page"] == 0
    # "18000" is on the first line, about 100 pt from the top of an A4 page.
    assert 0.08 < box["y"] < 0.13
    assert 0.15 < box["x"] < 0.35


def test_report_has_summary_and_marked_copies(tmp_path: Path, ctx: RecordingContext) -> None:
    old = make_version(tmp_path / "v1.pdf", OLD)
    new = make_version(tmp_path / "v2.pdf", NEW)
    out = run(ctx, old, new).outputs[0]
    assert out == tmp_path / "v2_compared.pdf"
    with pikepdf.open(out) as report:
        assert len(report.pages) == 3  # summary + new + old
        new_annots: Any = report.pages[1].obj.get("/Annots") or []
        old_annots: Any = report.pages[2].obj.get("/Annots") or []
        assert len(new_annots) >= 2 and len(old_annots) >= 2
        assert all(a.Subtype == pikepdf.Name.Square for a in new_annots)
    doc = pdfium.PdfDocument(str(out))
    try:
        summary = doc[0].get_textpage().get_text_range()
    finally:
        doc.close()
    assert "Comparison report" in summary and "18000" in summary


def test_identical_documents(tmp_path: Path, ctx: RecordingContext) -> None:
    old = make_version(tmp_path / "a.pdf", OLD)
    new = make_version(tmp_path / "b.pdf", OLD)
    result = run(ctx, old, new)
    assert result.stats["changes"] == []
    assert (result.stats["added"], result.stats["removed"], result.stats["changed"]) == (0, 0, 0)


def test_boxes_follow_page_rotation(tmp_path: Path, ctx: RecordingContext) -> None:
    old = make_version(tmp_path / "a.pdf", OLD, rotate=90)
    new = make_version(tmp_path / "b.pdf", NEW, rotate=90)
    rent = next(c for c in run(ctx, old, new).stats["changes"] if c["old"] == "15000")
    box = rent["new_boxes"][0]
    # Rotated 90° clockwise: the first line (top of the page) is now on the right side.
    assert box["x"] > 0.8
    assert box["h"] > box["w"]  # the word now runs downwards


def test_encrypted_inputs_need_passwords(tmp_path: Path, ctx: RecordingContext) -> None:
    old = make_encrypted_pdf(tmp_path / "a.pdf", 1, "pw")
    new = make_version(tmp_path / "b.pdf", NEW)
    with pytest.raises(Exception, match="password"):
        run(ctx, old, new)
    result = run(RecordingContext(tmp_path / "j2"), old, new, passwords={str(old): "pw"})
    assert result.outputs


def test_landscape_page_size_is_kept(tmp_path: Path, ctx: RecordingContext) -> None:
    path = tmp_path / "wide.pdf"
    c = canvas.Canvas(str(path), pagesize=landscape(A4))
    c.drawString(72, 500, "Wide page text")
    c.showPage()
    c.save()
    out = run(ctx, path, path).outputs[0]
    with pikepdf.open(out) as report:
        box = [float(v) for v in report.pages[1].mediabox]
        assert box[2] > box[3]
