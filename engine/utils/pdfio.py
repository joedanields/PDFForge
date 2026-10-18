"""Opening, saving and delivering PDFs: the plumbing every tool shares."""

from __future__ import annotations

import shutil
import zipfile
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pikepdf
from pikepdf import Pdf

from jobs import Cancelled, JobContext
from protocol import EngineError, ErrorCode
from utils.atomic import commit
from utils.naming import resolve_output, sanitize_stem
from utils.validation import (
    check_pdf,
    option_bool,
    optional_str,
    require_str_list,
)


def open_pdf(path: Path, passwords: dict[str, str], *, source: Path | None = None) -> Pdf:
    """Open a PDF, mapping password and damage problems to protocol errors.

    ``source`` is the file the user picked when ``path`` is a converted temp copy; it is used
    for password lookup and error messages.
    """
    shown = source or path
    password = passwords.get(str(shown), "")
    try:
        return Pdf.open(path, password=password)
    except pikepdf.PasswordError as exc:
        if password:
            raise EngineError(
                ErrorCode.WRONG_PASSWORD, f"The password for {shown.name} is incorrect", str(shown)
            ) from exc
        raise EngineError(
            ErrorCode.PASSWORD_REQUIRED, f"{shown.name} is password protected", str(shown)
        ) from exc
    except pikepdf.PdfError as exc:
        raise EngineError(
            ErrorCode.CORRUPT_FILE, f"{shown.name} is damaged and could not be read", str(shown)
        ) from exc


def single_pdf_input(params: dict[str, Any]) -> Path:
    """The one input PDF of a single-file tool, validated."""
    path = Path(require_str_list(params, "inputs", min_len=1, max_len=1)[0])
    check_pdf(path)
    return path


def save_pdf(
    pdf: Pdf,
    dest: Path,
    ctx: JobContext,
    *,
    start: float = 90,
    end: float = 100,
    message: str = "Saving",
    keep_encryption: bool = False,
    **save_kwargs: Any,
) -> None:
    """Save with progress mapped onto ``start..end`` and cancellation checked while writing.

    ``keep_encryption``: tools that edit a document in place keep its password/permissions
    exactly (pikepdf otherwise drops encryption on save).
    """
    if keep_encryption and pdf.is_encrypted:
        save_kwargs.setdefault("encryption", True)

    def on_save(pct: int) -> None:
        if ctx.is_cancelled():
            raise Cancelled
        ctx.progress(start + (end - start) * pct / 100, message)

    ctx.progress(start, message)
    pdf.save(dest, progress=on_save, **save_kwargs)


def deliver_pdf(
    tmp: Path, params: dict[str, Any], source: Path, tool: str, protected: Sequence[Path]
) -> Path:
    """Commit a single result next to the source (or to output/output_dir), never overwriting."""
    desired = resolve_output(
        optional_str(params, "output"), optional_str(params, "output_dir"), source, tool, tmp.suffix
    )
    return commit(tmp, desired, protected=protected)


def deliver_converted(
    tmp: Path, params: dict[str, Any], source: Path, protected: Sequence[Path]
) -> Path:
    """Commit a format conversion as ``{original}{new suffix}`` (report.docx -> report.pdf)
    beside its source or in ``output_dir``; the new extension already tells them apart.
    Never overwrites (``report (1).pdf``)."""
    out_dir = optional_str(params, "output_dir")
    folder = Path(out_dir) if out_dir else source.parent
    return commit(tmp, folder / f"{sanitize_stem(source.stem)}{tmp.suffix}", protected=protected)


def deliver_many(
    files: Sequence[Path],
    params: dict[str, Any],
    source: Path,
    tool: str,
    ctx: JobContext,
    protected: Sequence[Path],
) -> tuple[list[Path], dict[str, Any]]:
    """Deliver several result files: one file as is, else a new folder ``{stem}_{tool}`` or, with
    option ``zip``, ``{stem}_{tool}.zip``. Returns (outputs, extra stats)."""
    if not files:
        raise EngineError(ErrorCode.INTERNAL, "The tool produced no output")
    out_dir = optional_str(params, "output_dir")
    folder_parent = Path(out_dir) if out_dir else source.parent
    base = f"{sanitize_stem(source.stem)}_{tool}"
    options = params.get("options", {})
    as_zip = option_bool(options if isinstance(options, dict) else {}, "zip", False)

    ctx.check_cancelled()
    if len(files) == 1 and not as_zip:
        only = files[0]
        final = commit(only, folder_parent / only.name, protected=protected)
        return [final], {}
    if as_zip:
        archive = ctx.temp_dir / f"{base}.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for f in files:
                zf.write(f, arcname=f.name)
        final = commit(archive, folder_parent / archive.name, protected=protected)
        return [final], {"files": len(files)}
    bundle = ctx.temp_dir / "__bundle__" / base
    bundle.mkdir(parents=True)
    for f in files:
        shutil.move(str(f), str(bundle / f.name))
    final_dir = commit(bundle, folder_parent / base, protected=protected)
    outputs = [final_dir / f.name for f in files]
    return outputs, {"folder": str(final_dir), "files": len(outputs)}
