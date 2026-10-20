"""Digital signatures with the user's own certificate (docs/02 F3 "Could": PFX/P12, pyHanko).

The signature is added as an incremental update with an invisible signature field (the
visible part, if any, is what Sign PDF already drew on the page). Nothing is fetched from the
network: no timestamp server, no revocation checks.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives.serialization import pkcs12
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import signers

from protocol import EngineError, ErrorCode

CERT_SUFFIXES = frozenset({".pfx", ".p12"})
MAX_CERT_BYTES = 1024 * 1024


@dataclass(frozen=True)
class CertificateInfo:
    signer: str
    expires: str


def load_certificate(path: Path, password: str) -> tuple[signers.SimpleSigner, CertificateInfo]:
    """Open a PFX/P12 file and check that it can sign today."""
    if path.suffix.lower() not in CERT_SUFFIXES or not path.is_file():
        raise EngineError(
            ErrorCode.INVALID_INPUT, "Choose a certificate file (.pfx or .p12)", str(path)
        )
    data = path.read_bytes()
    if len(data) > MAX_CERT_BYTES:
        raise EngineError(ErrorCode.INVALID_INPUT, f"{path.name} is not a certificate", str(path))
    try:
        key, cert, _extra = pkcs12.load_key_and_certificates(data, password.encode() or None)
    except ValueError as exc:
        message = str(exc).lower()
        if "password" in message or "mac" in message or "decrypt" in message:
            raise EngineError(
                ErrorCode.WRONG_PASSWORD,
                f"The password for {path.name} is incorrect",
                str(path),
            ) from exc
        raise EngineError(
            ErrorCode.INVALID_INPUT, f"{path.name} is not a valid certificate file", str(path)
        ) from exc
    if key is None or cert is None:
        raise EngineError(
            ErrorCode.INVALID_INPUT,
            f"{path.name} has no private key, so it cannot sign",
            str(path),
        )
    now = dt.datetime.now(dt.UTC)
    if cert.not_valid_after_utc < now:
        raise EngineError(
            ErrorCode.INVALID_INPUT,
            f"This certificate expired on {cert.not_valid_after_utc:%Y-%m-%d}",
            str(path),
        )
    if cert.not_valid_before_utc > now:
        raise EngineError(
            ErrorCode.INVALID_INPUT,
            f"This certificate is only valid from {cert.not_valid_before_utc:%Y-%m-%d}",
            str(path),
        )
    signer = signers.SimpleSigner.load_pkcs12(path, passphrase=password.encode() or None)  # type: ignore[no-untyped-call]
    if signer is None:  # pyHanko logs and returns None on failures cryptography accepted
        raise EngineError(
            ErrorCode.INVALID_INPUT, f"{path.name} could not be used to sign", str(path)
        )
    return signer, CertificateInfo(_common_name(cert), f"{cert.not_valid_after_utc:%Y-%m-%d}")


def _common_name(cert: x509.Certificate) -> str:
    names = cert.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
    value = names[0].value if names else cert.subject.rfc4514_string()
    return value if isinstance(value, str) else value.decode(errors="replace")


def sign_pdf(
    src: Path,
    dest: Path,
    signer: signers.SimpleSigner,
    *,
    pdf_password: str = "",
    reason: str = "",
    location: str = "",
) -> None:
    """Write ``src`` plus a signature (incremental update) to ``dest``."""
    with src.open("rb") as inf:
        writer = IncrementalPdfFileWriter(inf, strict=False)
        if writer.security_handler is not None:
            writer.encrypt(pdf_password.encode())  # type: ignore[no-untyped-call]
        meta = signers.PdfSignatureMetadata(
            field_name=_free_field_name(writer),
            md_algorithm="sha256",
            reason=reason or None,
            location=location or None,
        )
        with dest.open("wb") as out:
            signers.sign_pdf(writer, meta, signer=signer, output=out)


def _free_field_name(writer: IncrementalPdfFileWriter) -> str:
    from pyhanko.sign.fields import enumerate_sig_fields

    taken = {name for name, _, _ in enumerate_sig_fields(writer.prev)}
    n = 1
    while f"PDFForgeSignature{n}" in taken:
        n += 1
    return f"PDFForgeSignature{n}"
