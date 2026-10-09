"""Well-known engine locations."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

APP_NAME = "PDFForge"


def temp_root() -> Path:
    """``%TEMP%\\PDFForge`` — parent of all per-job temp folders (overridable for tests)."""
    override = os.environ.get("PDFFORGE_TEMP_ROOT")
    return Path(override) if override else Path(tempfile.gettempdir()) / APP_NAME


def job_temp_dir(job_id: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in job_id)[:64]
    return temp_root() / safe


def sweep_temp_root() -> None:
    """Delete leftovers from earlier runs (docs/05_NON_FUNCTIONAL.md S3).

    Folders still in use by another running instance fail to delete on Windows and are skipped.
    """
    root = temp_root()
    if not root.is_dir():
        return
    for child in root.iterdir():
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)
