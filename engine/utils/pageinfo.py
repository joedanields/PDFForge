"""Page geometry with PDF inheritance rules (/Rotate, /MediaBox, /CropBox may live on parents)."""

from __future__ import annotations

from typing import Any

from pikepdf import Array, Page

_MAX_DEPTH = 64


def inherited(page: Page, key: str) -> Any:
    node: Any = page.obj
    for _ in range(_MAX_DEPTH):
        if node is None:
            return None
        if key in node:
            return node[key]
        node = node.get("/Parent")
    return None


def rotation(page: Page) -> int:
    """Effective clockwise rotation in degrees: 0, 90, 180 or 270."""
    value = inherited(page, "/Rotate")
    try:
        return int(value) % 360 if value is not None else 0
    except (TypeError, ValueError):
        return 0


def set_rotation(page: Page, degrees: int) -> None:
    page.obj.Rotate = degrees % 360


def _box(page: Page, key: str) -> tuple[float, float, float, float] | None:
    value = inherited(page, key)
    if not isinstance(value, Array) or len(value) != 4:
        return None
    x0, y0, x1, y1 = (float(v) for v in value)
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


def visible_box(page: Page) -> tuple[float, float, float, float]:
    """CropBox clipped to MediaBox (what viewers show), in unrotated user space."""
    media = _box(page, "/MediaBox") or (0.0, 0.0, 612.0, 792.0)
    crop = _box(page, "/CropBox")
    if crop is None:
        return media
    x0, y0 = max(media[0], crop[0]), max(media[1], crop[1])
    x1, y1 = min(media[2], crop[2]), min(media[3], crop[3])
    return (x0, y0, x1, y1) if x1 > x0 and y1 > y0 else media


def displayed_size(page: Page) -> tuple[float, float]:
    """Width and height as shown on screen (after /Rotate)."""
    x0, y0, x1, y1 = visible_box(page)
    w, h = x1 - x0, y1 - y0
    return (h, w) if rotation(page) in (90, 270) else (w, h)


def is_landscape(page: Page) -> bool:
    w, h = displayed_size(page)
    return w > h
