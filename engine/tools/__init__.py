"""Method name -> tool function. Adding a tool = an entry here + the UI registry entry.

Tools are resolved lazily: a job's worker process imports only the module of the tool it
runs. Importing every tool up front (python-docx, python-pptx, openpyxl, pdfplumber, lxml,
ReportLab, PDFium …) cost every job ~2.5 s of start-up.
"""

from __future__ import annotations

import importlib
from collections.abc import Iterator, Mapping

from jobs import ToolFn

_TARGETS: dict[str, str] = {
    "compare": "compare:compare",
    "compress": "optimize:compress",
    "crop": "edit:crop",
    "echo": "debug:echo",
    "edit-pdf": "editor:edit_pdf",
    "excel-to-pdf": "office:excel_to_pdf",
    "extract-pages": "organize:extract_pages",
    "fill-forms": "forms:fill_forms",
    "html-to-pdf": "to_pdf:html_to_pdf",
    "image-to-pdf": "to_pdf:image_to_pdf",
    "merge": "organize:merge",
    "ocr": "ocr:ocr",
    "organize": "organize:organize",
    "page-numbers": "edit:page_numbers",
    "pdf-to-excel": "pdf_office:pdf_to_excel",
    "pdf-to-image": "from_pdf:pdf_to_image",
    "pdf-to-pdfa": "pdfa:pdf_to_pdfa",
    "pdf-to-powerpoint": "pdf_office:pdf_to_powerpoint",
    "pdf-to-text": "pdf_office:pdf_to_text",
    "pdf-to-word": "pdf_office:pdf_to_word",
    "powerpoint-to-pdf": "office:powerpoint_to_pdf",
    "protect": "security:protect",
    "redact": "redact:redact",
    "remove-pages": "organize:remove_pages",
    "repair": "optimize:repair",
    "rotate": "organize:rotate",
    "sign": "editor:sign",
    "split": "organize:split",
    "text-to-pdf": "to_pdf:text_to_pdf",
    "unlock": "security:unlock",
    "watermark": "edit:watermark",
    "word-to-pdf": "office:word_to_pdf",
    "workflow": "workflow:workflow",
}


class _LazyTools(Mapping[str, ToolFn]):
    def __getitem__(self, method: str) -> ToolFn:
        module, function = _TARGETS[method].split(":")
        tool: ToolFn = getattr(importlib.import_module(f"tools.{module}"), function)
        return tool

    def __iter__(self) -> Iterator[str]:
        return iter(_TARGETS)

    def __len__(self) -> int:
        return len(_TARGETS)


TOOLS: Mapping[str, ToolFn] = _LazyTools()
