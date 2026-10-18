"""Protect PDF (docs/02 F1, docs/05 S4: passwords never logged)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pytest
from pikepdf._core import EncryptionMethod

from protocol import EngineError
from tests.fixtures import make_encrypted_pdf, make_text_pdf
from tests.helpers import EngineProcess, RecordingContext, sha256
from tools.security import protect


def run(ctx: RecordingContext, src: Path, user: str = "", owner: str = "", **options: Any) -> Any:
    return protect(
        {
            "inputs": [str(src)],
            "options": options,
            "secrets": {"user_password": user, "owner_password": owner},
        },
        ctx,
    )


def content(path: Path, password: str = "") -> list[bytes]:
    with pikepdf.open(path, password=password) as pdf:
        return [p.obj.Contents.read_bytes() for p in pdf.pages]


def test_open_password_aes256(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 2)
    result = run(ctx, src, user="Correct-Horse-7")
    out = result.outputs[0]
    assert out.name == "doc_protect.pdf"
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(out)
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(out, password="wrong")
    with pikepdf.open(out, password="Correct-Horse-7") as pdf:
        assert pdf.encryption.R == 6
        assert pdf.encryption.stream_method == EncryptionMethod.aesv3
    assert content(out, "Correct-Horse-7") == content(src)
    assert result.stats["encryption"] == "aes256"
    assert result.stats["open_password"] is True


def test_aes128(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    out = run(ctx, src, user="pw-128", encryption="aes128").outputs[0]
    with pikepdf.open(out, password="pw-128") as pdf:
        assert pdf.encryption.R == 4
        assert pdf.encryption.stream_method == EncryptionMethod.aes


def test_permissions_only(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    result = run(
        ctx,
        src,
        owner="boss-only",
        allow_print="low",
        allow_copy=False,
        allow_edit=False,
        allow_forms=True,
        allow_annotate=False,
    )
    out = result.outputs[0]
    with pikepdf.open(out) as pdf:  # opens without a password
        assert pdf.is_encrypted
        assert not pdf.owner_password_matched
        allow = pdf.allow
        assert allow.print_lowres and not allow.print_highres
        assert not allow.extract and not allow.modify_other and not allow.modify_assembly
        assert allow.modify_form and not allow.modify_annotation
        assert allow.accessibility
    with pikepdf.open(out, password="boss-only") as pdf:
        assert pdf.owner_password_matched
    assert result.stats["restricted"] is True


def test_open_password_without_owner_still_enforces_permissions(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    out = run(ctx, src, user="open-me", allow_copy=False).outputs[0]
    with pikepdf.open(out, password="open-me") as pdf:
        assert not pdf.owner_password_matched  # owner password is random, unknown
        assert not pdf.allow.extract


def test_no_password_given(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    with pytest.raises(EngineError) as info:
        run(ctx, src)
    assert info.value.code == "INVALID_INPUT"


def test_same_password_twice_refused(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    with pytest.raises(EngineError) as info:
        run(ctx, src, user="same", owner="same")
    assert "different passwords" in info.value.message


def test_overlong_password_refused(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    with pytest.raises(EngineError):
        run(ctx, src, user="x" * 200)


def test_unicode_password(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    out = run(ctx, src, user="பாஸ்வேர்ட்-密码").outputs[0]
    with pikepdf.open(out, password="பாஸ்வேர்ட்-密码") as pdf:
        assert len(pdf.pages) == 1


def test_already_protected_input(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_encrypted_pdf(tmp_path / "old.pdf", 1, "old-pw")
    result = protect(
        {
            "inputs": [str(src)],
            "passwords": {str(src): "old-pw"},
            "secrets": {"user_password": "new-pw"},
        },
        ctx,
    )
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(result.outputs[0], password="old-pw")
    with pikepdf.open(result.outputs[0], password="new-pw") as pdf:
        assert len(pdf.pages) == 1


def test_input_untouched(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    before = sha256(src)
    run(ctx, src, user="pw")
    assert sha256(src) == before


def test_passwords_never_reach_the_logs(engine: EngineProcess, tmp_path: Path) -> None:
    src = make_text_pdf(tmp_path / "doc.pdf", 1)
    secret_user, secret_owner = "Sup3r-S3cret-Open", "Sup3r-S3cret-Owner"
    engine.send(
        {
            "id": "sec1",
            "method": "protect",
            "params": {
                "inputs": [str(src)],
                "options": {"allow_copy": False},
                "secrets": {"user_password": secret_user, "owner_password": secret_owner},
            },
        }
    )
    final = engine.read_until_final("sec1", timeout=60)[-1]
    assert final["event"] == "done"
    engine.close()
    logs = "".join(engine.stderr)
    assert "sec1" in logs  # the job was logged...
    assert secret_user not in logs and secret_owner not in logs  # ...its passwords were not
