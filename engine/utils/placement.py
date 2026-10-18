"""How large each image is actually drawn, so Compress can downsample to a target DPI.

Walks every page's content stream tracking the current transformation matrix (q / Q / cm) and
records, for each image XObject painted with ``Do``, the largest size it is drawn at (in points).
Form XObjects are followed recursively with their /Matrix. Inline images are ignored (they are
small by definition).
"""

from __future__ import annotations

import math
from typing import Any

import pikepdf
from pikepdf import Dictionary, Matrix, Name, Page

MAX_FORM_DEPTH = 12
MAX_OPERATORS = 2_000_000  # safety valve for pathological content

Sizes = dict[tuple[int, int], tuple[float, float]]


def _scale(m: Matrix) -> tuple[float, float]:
    """Drawn width/height of the unit square under ``m`` (images are painted into it)."""
    return math.hypot(m.a, m.b), math.hypot(m.c, m.d)


def _record(sizes: Sizes, key: tuple[int, int], width: float, height: float) -> None:
    old = sizes.get(key)
    if old is None or width * height > old[0] * old[1]:
        sizes[key] = (width, height)


def _walk(
    stream: Any,
    resources: Any,
    ctm: Matrix,
    sizes: Sizes,
    depth: int,
    budget: list[int],
) -> None:
    if depth > MAX_FORM_DEPTH:
        return
    try:
        # Only the operators that matter here (also skips inline images).
        operations = pikepdf.parse_content_stream(stream, "q Q cm Do")
    except pikepdf.PdfError:
        return
    xobjects = resources.get("/XObject") if isinstance(resources, Dictionary) else None
    stack: list[Matrix] = []
    current = ctm
    for instruction in operations:
        budget[0] -= 1
        if budget[0] <= 0:
            return
        operands = instruction.operands
        op = str(instruction.operator)
        if op == "q":
            stack.append(current)
        elif op == "Q":
            current = stack.pop() if stack else ctm
        elif op == "cm" and len(operands) == 6:
            try:
                current = Matrix(*(float(v) for v in operands)) @ current
            except (TypeError, ValueError):
                continue
        elif op == "Do" and operands and isinstance(xobjects, Dictionary):
            xobject = xobjects.get(str(operands[0]))
            if not isinstance(xobject, pikepdf.Stream):
                continue
            subtype = xobject.get("/Subtype")
            if subtype == Name.Image:
                _record(sizes, xobject.objgen, *_scale(current))
            elif subtype == Name.Form:
                matrix = xobject.get("/Matrix")
                form_ctm = current
                if isinstance(matrix, pikepdf.Array) and len(matrix) == 6:
                    form_ctm = Matrix(*(float(v) for v in matrix)) @ current
                form_resources = xobject.get("/Resources", resources)
                _walk(xobject, form_resources, form_ctm, sizes, depth + 1, budget)


def image_display_sizes(pdf: pikepdf.Pdf) -> Sizes:
    """objgen of each placed image XObject → largest drawn (width, height) in points."""
    sizes: Sizes = {}
    budget = [MAX_OPERATORS]
    for page in pdf.pages:
        _walk_page(page, sizes, budget)
    return sizes


def _walk_page(page: Page, sizes: Sizes, budget: list[int]) -> None:
    resources = page.obj.get("/Resources")
    _walk(page, resources, Matrix(), sizes, 0, budget)
