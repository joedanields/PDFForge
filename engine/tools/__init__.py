"""Method name -> tool function. Adding a tool = an entry here + the UI registry entry."""

from __future__ import annotations

from collections.abc import Mapping

from jobs import ToolFn
from tools import debug, organize

TOOLS: Mapping[str, ToolFn] = {
    "echo": debug.echo,
    "extract-pages": organize.extract_pages,
    "merge": organize.merge,
    "organize": organize.organize,
    "remove-pages": organize.remove_pages,
    "rotate": organize.rotate,
    "split": organize.split,
}
