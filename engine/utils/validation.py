"""Parameter and input-file validation shared by tools."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from protocol import EngineError, ErrorCode

IMAGE_SUFFIXES = frozenset({".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp", ".gif"})
_PDF_MAGIC = b"%PDF-"
_SNIFF_BYTES = 1024


def require_str_list(params: dict[str, Any], key: str, *, min_len: int, max_len: int) -> list[str]:
    value = params.get(key)
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
        raise EngineError(ErrorCode.INVALID_INPUT, f"'{key}' must be a list of file paths")
    if not min_len <= len(value) <= max_len:
        raise EngineError(
            ErrorCode.INVALID_INPUT, f"'{key}' needs between {min_len} and {max_len} files"
        )
    return value


def optional_str(params: dict[str, Any], key: str) -> str | None:
    value = params.get(key)
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise EngineError(ErrorCode.INVALID_INPUT, f"'{key}' must be a string")
    return value


def options_dict(params: dict[str, Any]) -> dict[str, Any]:
    options = params.get("options", {})
    if not isinstance(options, dict):
        raise EngineError(ErrorCode.INVALID_INPUT, "'options' must be an object")
    return options


def option_bool(options: dict[str, Any], key: str, default: bool) -> bool:
    value = options.get(key, default)
    if not isinstance(value, bool):
        raise EngineError(ErrorCode.INVALID_INPUT, f"Option '{key}' must be true or false")
    return value


def passwords_map(params: dict[str, Any]) -> dict[str, str]:
    """``params.passwords``: {path: password}. Never logged or persisted (S4)."""
    value = params.get("passwords", {})
    if not isinstance(value, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in value.items()
    ):
        raise EngineError(ErrorCode.INVALID_INPUT, "'passwords' must map file paths to strings")
    return value


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_SUFFIXES


def check_readable_file(path: Path) -> None:
    if not path.is_file():
        raise EngineError(ErrorCode.INVALID_INPUT, f"File not found: {path.name}", str(path))
    try:
        with path.open("rb") as fh:
            fh.read(1)
    except OSError as exc:
        raise EngineError(ErrorCode.INVALID_INPUT, f"Cannot read {path.name}", str(path)) from exc


def check_pdf(path: Path) -> None:
    check_readable_file(path)
    with path.open("rb") as fh:
        head = fh.read(_SNIFF_BYTES)
    if _PDF_MAGIC not in head:
        raise EngineError(ErrorCode.INVALID_INPUT, f"{path.name} is not a PDF file", str(path))


def option_choice(options: dict[str, Any], key: str, choices: tuple[Any, ...], default: Any) -> Any:
    value = options.get(key, default)
    if value not in choices or isinstance(value, bool) != isinstance(default, bool):
        allowed = ", ".join(str(c) for c in choices)
        raise EngineError(ErrorCode.INVALID_INPUT, f"Option '{key}' must be one of: {allowed}")
    return value


def option_str(options: dict[str, Any], key: str, default: str, *, max_len: int = 10_000) -> str:
    value = options.get(key, default)
    if not isinstance(value, str) or len(value) > max_len:
        raise EngineError(ErrorCode.INVALID_INPUT, f"Option '{key}' must be text")
    return value


def option_int(options: dict[str, Any], key: str, default: int, *, lo: int, hi: int) -> int:
    value = options.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or not lo <= value <= hi:
        raise EngineError(
            ErrorCode.INVALID_INPUT, f"Option '{key}' must be a whole number from {lo} to {hi}"
        )
    return value


def option_float(
    options: dict[str, Any], key: str, default: float, *, lo: float, hi: float
) -> float:
    value = options.get(key, default)
    if not isinstance(value, int | float) or isinstance(value, bool) or not lo <= value <= hi:
        raise EngineError(
            ErrorCode.INVALID_INPUT, f"Option '{key}' must be a number from {lo:g} to {hi:g}"
        )
    return float(value)
