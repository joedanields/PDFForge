"""Repair PDF (docs/02 B2): qpdf reconstruction, pypdf fallback, honest page accounting."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pikepdf
import pytest

from jobs import Cancelled
from protocol import EngineError, ErrorCode
from tests.fixtures import make_corrupt_pdf, make_encrypted_pdf, make_text_pdf
from tests.helpers import RecordingContext, sha256
from tools.optimize import expected_pages, repair


def run(ctx: RecordingContext, inputs: list[Path], **params: Any) -> Any:
    return repair({"inputs": [str(p) for p in inputs], **params}, ctx)


def damaged(tmp_path: Path, name: str, kind: str, pages: int = 6) -> Path:
    good = make_text_pdf(tmp_path / f"{name}.source.pdf", pages)
    data = good.read_bytes()
    good.unlink()
    if kind == "xref":  # wrong startxref offset: the xref table cannot be found
        data = re.sub(rb"startxref\s+\d+", b"startxref\n999999", data)
    elif kind == "trailer":  # xref table and trailer cut off
        data = data[: data.rfind(b"xref")]
    elif kind == "truncated":  # download stopped at 60 %
        data = data[: int(len(data) * 0.6)]
    path = tmp_path / f"{name}.pdf"
    path.write_bytes(data)
    return path


@pytest.mark.parametrize("kind", ["xref", "trailer"])
def test_rebuilds_broken_structure(tmp_path: Path, ctx: RecordingContext, kind: str) -> None:
    pdf = damaged(tmp_path, "broken", kind)
    before = sha256(pdf)
    result = run(ctx, [pdf])
    out = result.outputs[0]
    assert out == tmp_path / "broken_repaired.pdf"
    assert sha256(pdf) == before
    assert result.stats["status"] == "repaired"
    assert result.stats["pages"] == result.stats["expected_pages"] == 6
    with pikepdf.open(out) as fixed:  # opens cleanly, no recovery needed
        assert len(fixed.pages) == 6
        assert not fixed.get_warnings()


def test_truncated_file_is_partially_recovered(tmp_path: Path, ctx: RecordingContext) -> None:
    result = run(ctx, [damaged(tmp_path, "cut", "truncated")])
    assert result.stats["status"] == "partial"
    assert 1 <= result.stats["pages"] < 6
    assert result.stats["expected_pages"] == 6
    with pikepdf.open(result.outputs[0]) as fixed:
        assert len(fixed.pages) == result.stats["pages"]


def test_intact_file_reports_no_problems(tmp_path: Path, ctx: RecordingContext) -> None:
    result = run(ctx, [make_text_pdf(tmp_path / "fine.pdf", 3)])
    assert result.stats["status"] == "no_problems"
    assert result.stats["pages"] == 3


def test_hopeless_file_cannot_be_repaired(tmp_path: Path, ctx: RecordingContext) -> None:
    with pytest.raises(EngineError) as err:
        run(ctx, [make_corrupt_pdf(tmp_path / "garbage.pdf")])
    assert err.value.code == ErrorCode.CORRUPT_FILE
    assert "could not be repaired" in err.value.message
    assert not (tmp_path / "garbage_repaired.pdf").exists()


def test_several_files_each_get_a_report(tmp_path: Path, ctx: RecordingContext) -> None:
    files = [damaged(tmp_path, "a", "xref", 2), make_text_pdf(tmp_path / "b.pdf", 2)]
    result = run(ctx, files)
    assert [r["status"] for r in result.stats["reports"]] == ["repaired", "no_problems"]
    assert [p.name for p in result.outputs] == ["a_repaired.pdf", "b_repaired.pdf"]


def test_encrypted_damaged_file_keeps_its_protection(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_encrypted_pdf(tmp_path / "secret.pdf", 2, "pw123")
    data = re.sub(rb"startxref\s+\d+", b"startxref\n999999", pdf.read_bytes())
    pdf.write_bytes(data)
    with pytest.raises(EngineError) as err:
        run(ctx, [pdf])
    assert err.value.code == ErrorCode.PASSWORD_REQUIRED
    result = run(RecordingContext(tmp_path / "j2"), [pdf], passwords={str(pdf): "pw123"})
    out = result.outputs[0]
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(out)
    with pikepdf.open(out, password="pw123") as fixed:
        assert len(fixed.pages) == 2


def test_expected_pages_heuristic() -> None:
    assert expected_pages(b"<< /Type /Pages /Kids [1 0 R] /Count 7 >>") == 7
    assert expected_pages(b"<< /Count 3 /Type /Pages >>") == 3
    assert expected_pages(b"<< /Type /Page >> << /Type /Page >> << /Type /Pages >>") == 2
    assert expected_pages(b"nothing here") is None


def test_rejects_non_pdf_and_cancels(tmp_path: Path, ctx: RecordingContext) -> None:
    other = tmp_path / "notes.txt"
    other.write_text("x")
    with pytest.raises(EngineError) as err:
        run(ctx, [other])
    assert err.value.code == ErrorCode.INVALID_INPUT
    with pytest.raises(Cancelled):
        run(RecordingContext(tmp_path / "j", cancel_after=1), [damaged(tmp_path, "c", "xref")])
    assert not (tmp_path / "c_repaired.pdf").exists()
