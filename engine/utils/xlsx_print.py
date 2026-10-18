"""Adjust an XLSX workbook's print setup before LibreOffice prints it (Excel → PDF options).

The workbook XML is edited in place (lxml keeps every namespace prefix, which Office's
``mc:Ignorable`` attributes rely on). Nothing else in the package is touched, so charts,
images and formulas survive — unlike a load/save round trip through openpyxl, which drops
charts and pictures.
"""

from __future__ import annotations

import posixpath
import zipfile
from pathlib import Path

from lxml import etree

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"

# CT_Worksheet child order (ECMA-376 Part 1, §18.3.1.99) — new elements must respect it.
_SHEET_ORDER = [
    "sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "sheetCalcPr",
    "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState",
    "dataConsolidate", "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting",
    "dataValidations", "hyperlinks", "printOptions", "pageMargins", "pageSetup", "headerFooter",
    "rowBreaks", "colBreaks", "customProperties", "cellWatches", "ignoredErrors", "smartTags",
    "drawing", "legacyDrawing", "legacyDrawingHF", "drawingHF", "picture", "oleObjects",
    "controls", "webPublishItems", "tableParts", "extLst",
]  # fmt: skip
_SHEETPR_ORDER = ["tabColor", "outlinePr", "pageSetUpPr"]


def _q(tag: str) -> str:
    return f"{{{NS_MAIN}}}{tag}"


def _local(el: etree._Element) -> str:
    return str(etree.QName(el).localname)


def _insert_ordered(parent: etree._Element, child: etree._Element, order: list[str]) -> None:
    rank = order.index(_local(child))
    for i, existing in enumerate(parent):
        if not isinstance(existing.tag, str):
            continue
        name = _local(existing)
        if name in order and order.index(name) > rank:
            parent.insert(i, child)
            return
    parent.append(child)


def _child(parent: etree._Element, tag: str, order: list[str]) -> etree._Element:
    found = parent.find(_q(tag))
    if found is None:
        found = etree.Element(_q(tag))
        _insert_ordered(parent, found, order)
    return found


def fit_sheet_to_width(sheet_xml: bytes) -> bytes:
    root = etree.fromstring(sheet_xml)
    sheet_pr = _child(root, "sheetPr", _SHEET_ORDER)
    _child(sheet_pr, "pageSetUpPr", _SHEETPR_ORDER).set("fitToPage", "1")
    setup = _child(root, "pageSetup", _SHEET_ORDER)
    setup.set("fitToWidth", "1")
    setup.set("fitToHeight", "0")
    if "scale" in setup.attrib:
        del setup.attrib["scale"]
    return bytes(etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True))


def _sheet_targets(
    workbook: etree._Element, files: dict[str, bytes]
) -> list[tuple[etree._Element, str]]:
    """(``<sheet>`` element, part name) for each worksheet in workbook order."""
    rels = etree.fromstring(files["xl/_rels/workbook.xml.rels"])
    targets = {r.get("Id"): r.get("Target", "") for r in rels.iter(f"{{{NS_PKG_REL}}}Relationship")}
    result = []
    for sheet in workbook.iter(_q("sheet")):
        target = targets.get(sheet.get(f"{{{NS_REL}}}id"), "")
        part = target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target)
        result.append((sheet, posixpath.normpath(part)))
    return result


def adjust_workbook(src: Path, dest: Path, *, fit_width: bool, active_only: bool) -> None:
    """Write a copy of ``src`` with every sheet fitted to one page wide and/or only the active
    sheet left visible (LibreOffice does not print hidden sheets)."""
    with zipfile.ZipFile(src) as zf:
        infos = zf.infolist()
        files = {info.filename: zf.read(info) for info in infos}

    workbook = etree.fromstring(files["xl/workbook.xml"])
    sheets = _sheet_targets(workbook, files)
    if active_only:
        view = workbook.find(f"{_q('bookViews')}/{_q('workbookView')}")
        active = int(view.get("activeTab", "0")) if view is not None else 0
        visible = [i for i, (s, _) in enumerate(sheets) if s.get("state") in (None, "visible")]
        if active not in visible and visible:
            active = visible[0]
        for index in visible:
            if index != active:
                sheets[index][0].set("state", "hidden")
        if view is not None:
            view.set("activeTab", str(active))
            view.set("firstSheet", str(active))
        files["xl/workbook.xml"] = etree.tostring(
            workbook, xml_declaration=True, encoding="UTF-8", standalone=True
        )
    if fit_width:
        for _, part in sheets:
            if part in files:
                files[part] = fit_sheet_to_width(files[part])

    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as out:
        for info in infos:
            out.writestr(info, files[info.filename])
