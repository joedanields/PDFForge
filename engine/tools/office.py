"""Office documents → PDF via the bundled LibreOffice (docs/02_FEATURES.md C2-C4).

Each input becomes its own PDF beside the source (``report.docx`` → ``report.pdf``). Works
without Microsoft Office; missing fonts are substituted by LibreOffice (metric-compatible
Carlito/Caladea/Liberation fonts are bundled).
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from pikepdf import Pdf

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils import libreoffice
from utils.pdfio import deliver_converted
from utils.validation import (
    check_readable_file,
    option_bool,
    option_choice,
    options_dict,
    require_str_list,
)
from utils.xlsx_print import adjust_workbook

OFFICE_MAX = 100
WORD_SUFFIXES = (".doc", ".docx", ".odt", ".rtf")
POWERPOINT_SUFFIXES = (".ppt", ".pptx", ".odp")
EXCEL_SUFFIXES = (".xls", ".xlsx", ".ods", ".csv")
_OOXML = (".docx", ".pptx", ".xlsx")
_OLE_MAGIC = bytes.fromhex("D0CF11E0A1B11AE1")
# CSV: comma separated, double quotes, UTF-8, start at line 1 (LibreOffice CSV filter tokens).
CSV_INFILTER = "CSV:44,34,76,1"

# (source copy, work dir, user's file) -> produced PDF in the work dir
Converter = Callable[[Path, Path, Path], Path]


def _inputs(params: dict[str, Any], suffixes: tuple[str, ...], kind: str) -> list[Path]:
    paths = [Path(p) for p in require_str_list(params, "inputs", min_len=1, max_len=OFFICE_MAX)]
    for path in paths:
        if path.suffix.lower() not in suffixes:
            raise EngineError(ErrorCode.INVALID_INPUT, f"{path.name} is not a {kind}", str(path))
        check_readable_file(path)
        _refuse_encrypted(path)
    return paths


def _refuse_encrypted(path: Path) -> None:
    """Password-protected DOCX/XLSX/PPTX files are OLE containers, not ZIPs."""
    if path.suffix.lower() not in _OOXML:
        return
    with path.open("rb") as f:
        head = f.read(8)
    if head == _OLE_MAGIC:
        raise EngineError(
            ErrorCode.UNSUPPORTED,
            f"{path.name} is password protected. Remove the password in its own app first.",
            str(path),
        )


def _run(
    inputs: list[Path], params: dict[str, Any], ctx: JobContext, convert: Converter
) -> ToolResult:
    outputs: list[Path] = []
    pages = 0
    for n, source in enumerate(inputs):
        ctx.check_cancelled()
        ctx.progress(n * 95 / len(inputs), f"Converting {source.name}")
        work = ctx.temp_dir / f"doc_{n:03d}"
        copy = libreoffice.private_copy(source, work)
        produced = convert(copy, work, source)
        try:
            with Pdf.open(produced) as pdf:
                pages += len(pdf.pages)
        except Exception as exc:  # pikepdf raises several types for a broken PDF
            raise EngineError(
                ErrorCode.CORRUPT_FILE, f"{source.name} could not be converted", str(source)
            ) from exc
        tmp = work / "result" / f"{source.stem[:150]}.pdf"
        tmp.parent.mkdir()
        produced.replace(tmp)
        ctx.check_cancelled()
        outputs.append(deliver_converted(tmp, params, source, protected=inputs))
    ctx.progress(100, "Done")
    stats: dict[str, Any] = {"files": len(outputs), "pages": pages}
    if len(outputs) == 1:
        stats["bytes"] = outputs[0].stat().st_size
    return ToolResult(outputs, stats)


def word_to_pdf(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    inputs = _inputs(params, WORD_SUFFIXES, "Word document")

    def convert(copy: Path, work: Path, source: Path) -> Path:
        return libreoffice.convert(copy, work, ctx, filter_name="writer_pdf_Export", shown=source)

    return _run(inputs, params, ctx, convert)


def powerpoint_to_pdf(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    inputs = _inputs(params, POWERPOINT_SUFFIXES, "presentation")
    notes = option_bool(options_dict(params), "include_notes", False)
    export_options: dict[str, Any] = {"ExportNotesPages": True} if notes else {}

    def convert(copy: Path, work: Path, source: Path) -> Path:
        return libreoffice.convert(
            copy,
            work,
            ctx,
            filter_name="impress_pdf_Export",
            filter_options=export_options,
            shown=source,
        )

    return _run(inputs, params, ctx, convert)


def excel_to_pdf(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    inputs = _inputs(params, EXCEL_SUFFIXES, "spreadsheet")
    options = options_dict(params)
    fit_width = option_bool(options, "fit_width", False)
    active_only = option_choice(options, "sheets", ("all", "active"), "all") == "active"

    def convert(copy: Path, work: Path, source: Path) -> Path:
        infilter = CSV_INFILTER if copy.suffix == ".csv" else None
        if fit_width or active_only:
            # Print settings are edited in XLSX form; other formats are converted to XLSX first.
            xlsx = copy
            if copy.suffix != ".xlsx":
                xlsx = libreoffice.convert(
                    copy,
                    work / "xlsx",
                    ctx,
                    target="xlsx",
                    filter_name="Calc MS Excel 2007 XML",
                    infilter=infilter,
                    shown=source,
                )
                infilter = None
            copy = work / "adjusted.xlsx"
            try:
                adjust_workbook(xlsx, copy, fit_width=fit_width, active_only=active_only)
            except Exception as exc:  # zip/XML errors: the workbook is damaged
                raise EngineError(
                    ErrorCode.CORRUPT_FILE, f"{source.name} is damaged", str(source)
                ) from exc
        return libreoffice.convert(
            copy, work, ctx, filter_name="calc_pdf_Export", infilter=infilter, shown=source
        )

    return _run(inputs, params, ctx, convert)
