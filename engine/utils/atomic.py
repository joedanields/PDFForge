"""Atomic, never-overwrite output commit (docs/05_NON_FUNCTIONAL.md §3).

Tools write into the job temp dir; ``commit`` moves the finished file next to its destination
under a hidden ``.part`` name, then claims the first free ``name (n).pdf`` with a rename that
fails instead of replacing an existing file. Readers never see a half-written output and no
existing file (including inputs) is ever replaced.
"""

from __future__ import annotations

import errno
import os
import shutil
import uuid
from collections.abc import Iterable
from pathlib import Path

from protocol import EngineError, ErrorCode
from utils.naming import candidates

_MAX_ATTEMPTS = 10_000
_WIN_DISK_FULL = {39, 112}  # ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL


def is_disk_full(exc: OSError) -> bool:
    return exc.errno == errno.ENOSPC or getattr(exc, "winerror", None) in _WIN_DISK_FULL


def _rename_no_replace(src: Path, dst: Path) -> None:
    """Rename that raises FileExistsError when ``dst`` exists, on every platform."""
    if os.name == "nt":
        src.rename(dst)  # MoveFileExW without REPLACE_EXISTING: fails if dst exists
    else:
        os.link(src, dst)  # link() refuses to overwrite; then drop the temp name
        src.unlink()


def _norm(p: Path) -> str:
    return os.path.normcase(str(p.absolute()))


def commit(tmp_file: Path, desired: Path, protected: Iterable[Path] = ()) -> Path:
    """Move ``tmp_file`` to the first free candidate of ``desired`` and return the final path."""
    blocked = {_norm(p) for p in protected}
    folder = desired.parent
    try:
        folder.mkdir(parents=True, exist_ok=True)
        part = folder / f".{desired.stem}.{uuid.uuid4().hex[:8]}.part"
        shutil.move(str(tmp_file), str(part))
    except OSError as exc:
        if is_disk_full(exc):
            raise EngineError(
                ErrorCode.DISK_FULL, "Not enough disk space to save the output"
            ) from exc
        raise EngineError(
            ErrorCode.INVALID_INPUT, f"Cannot write to output folder: {folder}", str(folder)
        ) from exc

    try:
        for attempt, candidate in enumerate(candidates(desired)):
            if attempt >= _MAX_ATTEMPTS:
                break
            if _norm(candidate) in blocked:
                continue
            try:
                _rename_no_replace(part, candidate)
            except FileExistsError:
                continue
            return candidate
        raise EngineError(ErrorCode.INTERNAL, "Could not find a free output file name")
    except BaseException:
        part.unlink(missing_ok=True)
        raise
