"""Sign PDF with the user's certificate (docs/02 F3 "Could": PFX/P12 via pyHanko)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pytest
from cryptography.hazmat.primitives.serialization import pkcs12
from pyhanko.keys import load_cert_from_pemder
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext

from protocol import EngineError, ErrorCode
from tests.fixtures import make_encrypted_pdf, make_pkcs12, make_text_pdf
from tests.helpers import RecordingContext, sha256
from tools.editor import sign

PASSWORD = "Cert-Pass-1"


def run(
    ctx: RecordingContext,
    pdf: Path,
    cert: Path,
    password: str = PASSWORD,
    objects: list[dict[str, Any]] | None = None,
    **params: Any,
) -> Any:
    return sign(
        {
            "inputs": [str(pdf)],
            "options": {
                "objects": objects or [],
                "certificate": str(cert),
                "reason": "Approved",
                "location": "Chennai",
            },
            "secrets": {"certificate_password": password},
            **params,
        },
        ctx,
    )


def check_signature(path: Path, cert_file: Path, pdf_password: str = "") -> Any:
    _key, cert, _extra = pkcs12.load_key_and_certificates(cert_file.read_bytes(), PASSWORD.encode())
    assert cert is not None
    from cryptography.hazmat.primitives.serialization import Encoding

    root = load_cert_from_pemder(_write(path.with_suffix(".cer"), cert.public_bytes(Encoding.DER)))  # type: ignore[no-untyped-call]
    with path.open("rb") as f:
        reader = PdfFileReader(f)
        if pdf_password:
            reader.decrypt(pdf_password)
        [embedded] = reader.embedded_signatures
        status = validate_pdf_signature(
            embedded, ValidationContext(trust_roots=[root], allow_fetching=False)
        )
        return embedded, status


def _write(path: Path, data: bytes) -> str:
    path.write_bytes(data)
    return str(path)


def test_certificate_signature_without_page_items(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "contract.pdf", 2)
    cert = make_pkcs12(tmp_path / "me.pfx", PASSWORD)
    before = sha256(pdf)
    result = run(ctx, pdf, cert)
    [out] = result.outputs
    assert out.name == "contract_signed.pdf"
    assert sha256(pdf) == before
    assert result.stats["digital_signature"] is True
    assert result.stats["signer"] == "Asha Raman"
    embedded, status = check_signature(out, cert)
    assert status.intact and status.valid and status.trusted
    assert embedded.sig_object["/Reason"] == "Approved"
    assert embedded.sig_object["/Location"] == "Chennai"
    assert embedded.coverage.name == "ENTIRE_FILE"


def test_page_items_and_certificate_together(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "contract.pdf", 1)
    cert = make_pkcs12(tmp_path / "me.p12", PASSWORD)
    text = {"page": 0, "kind": "text", "x": 0.5, "y": 0.8, "w": 0.3, "h": 0.03, "text": "Asha"}
    result = run(ctx, pdf, cert, objects=[text])
    assert result.stats["objects"] == 1
    _embedded, status = check_signature(result.outputs[0], cert)
    assert status.intact and status.valid


def test_encrypted_pdf_stays_encrypted(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_encrypted_pdf(tmp_path / "locked.pdf", 1, "pw")
    cert = make_pkcs12(tmp_path / "me.pfx", PASSWORD)
    out = run(ctx, pdf, cert, passwords={str(pdf): "pw"}).outputs[0]
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(out)
    _embedded, status = check_signature(out, cert, pdf_password="pw")
    assert status.intact and status.valid


def test_wrong_certificate_password(tmp_path: Path, ctx: RecordingContext) -> None:
    pdf = make_text_pdf(tmp_path / "a.pdf", 1)
    cert = make_pkcs12(tmp_path / "me.pfx", PASSWORD)
    with pytest.raises(EngineError) as info:
        run(ctx, pdf, cert, password="nope")
    assert info.value.code == ErrorCode.WRONG_PASSWORD
    assert info.value.file == str(cert)


@pytest.mark.parametrize("problem", ["expired", "garbage", "suffix"])
def test_unusable_certificates_are_refused(
    tmp_path: Path, ctx: RecordingContext, problem: str
) -> None:
    pdf = make_text_pdf(tmp_path / "a.pdf", 1)
    if problem == "expired":
        cert = make_pkcs12(tmp_path / "old.pfx", PASSWORD, expired=True)
    elif problem == "garbage":
        cert = tmp_path / "junk.pfx"
        cert.write_bytes(b"not a certificate")
    else:
        cert = make_pkcs12(tmp_path / "me.pem", PASSWORD)
    with pytest.raises(EngineError) as info:
        run(ctx, pdf, cert)
    assert info.value.code == ErrorCode.INVALID_INPUT
    if problem == "expired":
        assert "expired" in info.value.message
