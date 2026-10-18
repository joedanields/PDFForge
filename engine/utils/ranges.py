"""Page-range syntax shared by Rotate, Remove, Extract, Split and PDF→Image.

Syntax (1-based, comma separated): ``5``, ``1-3``, ``8-`` (8 to the last page), ``-3`` (first
three pages), ``all``. Whitespace is ignored. The UI has the same parser in
app/src/lib/pageRanges.ts so ranges are validated live (docs/02 A2).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from protocol import EngineError, ErrorCode

_PART = re.compile(r"^(\d*)\s*-\s*(\d*)$|^(\d+)$")


@dataclass(frozen=True, slots=True)
class PageRange:
    """Inclusive, 1-based."""

    first: int
    last: int

    def pages(self) -> list[int]:
        return list(range(self.first, self.last + 1))

    def label(self) -> str:
        return str(self.first) if self.first == self.last else f"{self.first}-{self.last}"


def parse_ranges(text: str, page_count: int) -> list[PageRange]:
    """Parse ``text`` into ranges, in the order written (INVALID_INPUT with a plain message)."""
    cleaned = text.strip().lower()
    if cleaned in ("", "all", "*"):
        return [PageRange(1, page_count)] if page_count > 0 else []
    ranges: list[PageRange] = []
    for raw in cleaned.split(","):
        part = raw.strip()
        if not part:
            continue
        match = _PART.match(part)
        if not match:
            raise EngineError(ErrorCode.INVALID_INPUT, f"“{raw.strip()}” is not a page or range")
        if match.group(3):
            first = last = int(match.group(3))
        else:
            first = int(match.group(1)) if match.group(1) else 1
            last = int(match.group(2)) if match.group(2) else page_count
        if first < 1 or last < 1:
            raise EngineError(ErrorCode.INVALID_INPUT, "Page numbers start at 1")
        if first > last:
            raise EngineError(
                ErrorCode.INVALID_INPUT, f"“{part}” runs backwards; write it as {last}-{first}"
            )
        if last > page_count:
            raise EngineError(
                ErrorCode.INVALID_INPUT,
                f"Page {last} doesn't exist — this document has {page_count} pages",
            )
        ranges.append(PageRange(first, last))
    if not ranges:
        raise EngineError(ErrorCode.INVALID_INPUT, "No pages selected")
    return ranges


def parse_page_set(text: str, page_count: int) -> list[int]:
    """Selected pages as sorted, unique, 0-based indices."""
    return sorted({p - 1 for r in parse_ranges(text, page_count) for p in r.pages()})


def format_ranges(pages: list[int]) -> str:
    """Compress 1-based page numbers into range text: [1, 2, 3, 5] -> "1-3,5"."""
    out: list[str] = []
    ordered = sorted(set(pages))
    i = 0
    while i < len(ordered):
        j = i
        while j + 1 < len(ordered) and ordered[j + 1] == ordered[j] + 1:
            j += 1
        out.append(str(ordered[i]) if i == j else f"{ordered[i]}-{ordered[j]}")
        i = j + 1
    return ",".join(out)
