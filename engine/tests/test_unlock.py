"""Unlock PDF (docs/02 F2, docs/05 S9; docs/07 §3: Protect → Unlock round-trip restores
identical page content)."""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest

from protocol import EngineError
from tests.fixtures import make_encrypted_pdf, make_restricted_pdf, make_text_pdf
from tests.helpers import RecordingContext, sha256
from tools.security import protect, unlock


def page_content(path: Path, password: str = "") -> list[bytes]:
    with pikepdf.open(path, password=password) as pdf:
        return [p.obj.Contents.read_bytes() for p in pdf.pages]


def test_protect_then_unlock_round_trip(tmp_path: Path) -> None:
    """docs/07 §3: Protect → Unlock round-trip restores identical page content."""
    original = make_text_pdf(tmp_path / "report.pdf", 3, bookmarks=True)
    protected = protect(
        {
            "inputs": [str(original)],
            "options": {"allow_copy": False, "allow_print": "none"},
            "secrets": {"user_password": "open-sesame", "owner_password": "boss"},
        },
        RecordingContext(tmp_path / "j1"),
    ).outputs[0]
    result = unlock(
        {"inputs": [str(protected)], "passwords": {str(protected): "open-sesame"}},
        RecordingContext(tmp_path / "j2"),
    )
    unlocked = result.outputs[0]
    assert unlocked.name == "report_protect_unlock.pdf"
    with pikepdf.open(unlocked) as pdf:  # no password needed any more
        assert not pdf.is_encrypted
        assert len(pdf.pages) == 3
        assert [i.title for i in pdf.open_outline().root] == ["report §1", "report §2", "report §3"]
    assert page_content(unlocked) == page_content(original)
    assert result.stats["removed_open_password"] is True
    assert result.stats["removed_restrictions"] is True


def test_owner_restrictions_only(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_restricted_pdf(tmp_path / "restricted.pdf", 2)
    result = unlock({"inputs": [str(src)]}, ctx)
    with pikepdf.open(result.outputs[0]) as pdf:
        assert not pdf.is_encrypted
        assert pdf.allow.extract and pdf.allow.print_highres
    assert result.stats["removed_open_password"] is False
    assert result.stats["removed_restrictions"] is True


def test_open_password_is_required(tmp_path: Path, ctx: RecordingContext) -> None:
    """docs/05 S9: no password, no unlock — and nothing is guessed."""
    src = make_encrypted_pdf(tmp_path / "locked.pdf", 1, "right")
    with pytest.raises(EngineError) as info:
        unlock({"inputs": [str(src)]}, ctx)
    assert (info.value.code, info.value.file) == ("PASSWORD_REQUIRED", str(src))


def test_wrong_password(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_encrypted_pdf(tmp_path / "locked.pdf", 1, "right")
    with pytest.raises(EngineError) as info:
        unlock({"inputs": [str(src)], "passwords": {str(src): "wrong"}}, ctx)
    assert info.value.code == "WRONG_PASSWORD"


def test_unprotected_file(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "plain.pdf", 1)
    with pytest.raises(EngineError) as info:
        unlock({"inputs": [str(src)]}, ctx)
    assert info.value.code == "INVALID_INPUT"
    assert "no password or restrictions" in info.value.message


def test_input_untouched(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_encrypted_pdf(tmp_path / "locked.pdf", 1, "pw")
    before = sha256(src)
    unlock({"inputs": [str(src)], "passwords": {str(src): "pw"}}, ctx)
    assert sha256(src) == before
