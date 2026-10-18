"""Method name -> tool function. Adding a tool = an entry here + the UI registry entry."""

from __future__ import annotations

from collections.abc import Mapping

from jobs import ToolFn
from tools import debug, from_pdf, organize, security, to_pdf

TOOLS: Mapping[str, ToolFn] = {
    "echo": debug.echo,
    "extract-pages": organize.extract_pages,
    "image-to-pdf": to_pdf.image_to_pdf,
    "merge": organize.merge,
    "organize": organize.organize,
    "pdf-to-image": from_pdf.pdf_to_image,
    "protect": security.protect,
    "remove-pages": organize.remove_pages,
    "rotate": organize.rotate,
    "split": organize.split,
}
