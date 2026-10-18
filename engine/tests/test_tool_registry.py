"""The engine's tool registry: lazy, complete, and frozen-build safe."""

from __future__ import annotations

import re
import subprocess
import sys

from tests.helpers import ENGINE_DIR
from tools import _TARGETS, TOOLS


def test_every_method_resolves_to_a_callable() -> None:
    assert len(TOOLS) == len(_TARGETS)
    for method in TOOLS:
        assert callable(TOOLS[method]), method


def test_every_tool_module_is_a_pyinstaller_hidden_import() -> None:
    """Tools are imported by name at run time, so PyInstaller cannot see them on its own."""
    spec = (ENGINE_DIR / "engine.spec").read_text(encoding="utf-8")
    hidden = set(re.findall(r'"(tools\.\w+)"', spec))
    modules = {f"tools.{target.split(':')[0]}" for target in _TARGETS.values()}
    assert modules <= hidden, modules - hidden


def test_importing_the_registry_stays_light() -> None:
    """A job's worker must not pay for every tool's dependencies (D-025)."""
    code = (
        "import sys, tools; heavy = {'docx', 'pptx', 'openpyxl', 'pdfplumber', 'reportlab',"
        " 'pypdfium2'}; print(sorted(heavy & set(sys.modules)))"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=ENGINE_DIR, capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == "[]"
