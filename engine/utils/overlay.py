"""Stamping text/images onto pages as they are *displayed* (page numbers, watermarks).

Overlays are drawn with ReportLab on a canvas the size of the page **as the reader sees it**
(after /Rotate, within the CropBox), in display coordinates: origin bottom-left, x right, y up.
pikepdf's ``add_overlay``/``add_underlay`` (qpdf ``placeFormXObject`` with inverted
transformations) then maps that canvas onto the visible area of the page and undoes the page's
rotation, so stamps land in the right corner and read upright on rotated or cropped pages. The
existing page content is not touched.
"""

from __future__ import annotations

from dataclasses import dataclass

from pikepdf import Page

from utils.pageinfo import displayed_size


@dataclass(frozen=True)
class Frame:
    """Size of a page as displayed (after /Rotate), in points."""

    width: float
    height: float

    @property
    def size(self) -> tuple[float, float]:
        return self.width, self.height


def frame_of(page: Page) -> Frame:
    width, height = displayed_size(page)
    return Frame(width, height)


GRID_POSITIONS = (
    "top-left",
    "top-center",
    "top-right",
    "middle-left",
    "middle-center",
    "middle-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
)


def anchor_point(
    position: str,
    display: tuple[float, float],
    box: tuple[float, float],
    margin: float,
) -> tuple[float, float]:
    """Bottom-left display point of a ``box`` (w, h) placed at a 9-grid ``position``."""
    width, height = display
    bw, bh = box
    vertical, horizontal = position.split("-")
    x = {"left": margin, "center": (width - bw) / 2, "right": width - margin - bw}[horizontal]
    y = {"bottom": margin, "middle": (height - bh) / 2, "top": height - margin - bh}[vertical]
    return x, y


def mirror(position: str) -> str:
    """Left ↔ right, for facing pages."""
    if position.endswith("-left"):
        return position.removesuffix("-left") + "-right"
    if position.endswith("-right"):
        return position.removesuffix("-right") + "-left"
    return position
