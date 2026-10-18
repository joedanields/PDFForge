"""Method name -> tool function. Adding a tool = an entry here + the UI registry entry."""

from __future__ import annotations

from collections.abc import Mapping

from jobs import ToolFn
from tools import (
    debug,
    edit,
    from_pdf,
    office,
    optimize,
    organize,
    security,
    to_pdf,
)

TOOLS: Mapping[str, ToolFn] = {
    "compress": optimize.compress,
    "echo": debug.echo,
    "excel-to-pdf": office.excel_to_pdf,
    "extract-pages": organize.extract_pages,
    "image-to-pdf": to_pdf.image_to_pdf,
    "merge": organize.merge,
    "organize": organize.organize,
    "page-numbers": edit.page_numbers,
    "pdf-to-image": from_pdf.pdf_to_image,
    "powerpoint-to-pdf": office.powerpoint_to_pdf,
    "protect": security.protect,
    "remove-pages": organize.remove_pages,
    "rotate": organize.rotate,
    "split": organize.split,
    "unlock": security.unlock,
    "watermark": edit.watermark,
    "word-to-pdf": office.word_to_pdf,
}
