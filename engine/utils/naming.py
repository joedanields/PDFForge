"""Output naming: ``{original}_{tool}.pdf``, never overwriting (02_FEATURES.md common rules)."""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

_INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10))}
_RESERVED |= {f"LPT{i}" for i in range(1, 10)}


def sanitize_stem(stem: str) -> str:
    """Make ``stem`` safe as a Windows file name stem."""
    cleaned = _INVALID_CHARS.sub("_", stem).strip().rstrip(".")
    if not cleaned:
        cleaned = "output"
    if cleaned.upper() in _RESERVED:
        cleaned = f"{cleaned}_"
    return cleaned[:180]


def default_output_name(first_input: Path, tool: str, suffix: str = ".pdf") -> str:
    return f"{sanitize_stem(first_input.stem)}_{tool}{suffix}"


def resolve_output(
    params_output: str | None,
    params_output_dir: str | None,
    first_input: Path,
    tool: str,
    suffix: str = ".pdf",
) -> Path:
    """Desired output path before collision handling.

    Precedence: explicit ``output`` > ``output_dir`` + default name > first input's folder.
    """
    if params_output:
        return Path(params_output)
    folder = Path(params_output_dir) if params_output_dir else first_input.parent
    return folder / default_output_name(first_input, tool, suffix)


def candidates(desired: Path, *, is_dir: bool = False) -> Iterator[Path]:
    """``name.pdf``, ``name (1).pdf``, ``name (2).pdf``, ... (docs/07_TESTING.md §3).

    Folders get the counter at the end of the whole name (``v1.2_split (1)``).
    """
    yield desired
    n = 1
    while True:
        if is_dir:
            yield desired.with_name(f"{desired.name} ({n})")
        else:
            yield desired.with_name(f"{desired.stem} ({n}){desired.suffix}")
        n += 1


def unique_path(desired: Path) -> Path:
    """First free candidate. Advisory only: ``atomic.commit`` is what claims a name."""
    return next(p for p in candidates(desired) if not p.exists())
