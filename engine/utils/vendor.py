"""Bundled third-party programs (``vendor/``, fetched by scripts/fetch-vendor.ps1).

Layout (docs/06_BUILD_AND_PACKAGING.md §1):
    installed app:  <resources>/engine/engine.exe  and  <resources>/vendor/{libreoffice,tesseract}
    development:    <repo>/engine/...              and  <repo>/vendor/{libreoffice,tesseract}
``PDFFORGE_VENDOR_DIR`` overrides the location (tests, portable setups).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from protocol import EngineError, ErrorCode


def vendor_root() -> Path:
    override = os.environ.get("PDFFORGE_VENDOR_DIR")
    if override:
        return Path(override)
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent.parent / "vendor"
    return Path(__file__).resolve().parents[2] / "vendor"


def soffice_path() -> Path:
    """LibreOffice's console launcher (waits for the conversion and forwards its output)."""
    return vendor_root() / "libreoffice" / "program" / "soffice.com"


def tesseract_path() -> Path:
    return vendor_root() / "tesseract" / "tesseract.exe"


def bundled_tessdata() -> Path:
    return vendor_root() / "tesseract" / "tessdata"


def require(path: Path, component: str) -> Path:
    """``path`` if the component is installed, else a clear UNSUPPORTED error."""
    if not path.is_file():
        raise EngineError(
            ErrorCode.UNSUPPORTED,
            f"{component} is not included in this copy of PDFForge. "
            "Reinstall PDFForge to restore it.",
        )
    return path
