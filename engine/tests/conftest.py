from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest

from tests.helpers import EngineProcess, RecordingContext
from utils import netguard


@pytest.fixture(autouse=True, scope="session")
def _no_network() -> None:
    """The whole suite runs with outbound network blocked (docs/07_TESTING.md §3)."""
    netguard.install()


@pytest.fixture(autouse=True, scope="session")
def _cache_dir(tmp_path_factory: pytest.TempPathFactory) -> Iterator[None]:
    """One app cache per test session (the LibreOffice profile template is built once)."""
    previous = os.environ.get("PDFFORGE_CACHE_DIR")
    os.environ["PDFFORGE_CACHE_DIR"] = str(tmp_path_factory.mktemp("app-cache"))
    yield
    if previous is None:
        os.environ.pop("PDFFORGE_CACHE_DIR", None)
    else:
        os.environ["PDFFORGE_CACHE_DIR"] = previous


@pytest.fixture(autouse=True)
def temp_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "engine-temp"
    monkeypatch.setenv("PDFFORGE_TEMP_ROOT", str(root))
    return root


@pytest.fixture
def ctx(tmp_path: Path) -> RecordingContext:
    return RecordingContext(tmp_path / "job-temp")


@pytest.fixture
def engine(temp_root: Path) -> Iterator[EngineProcess]:
    env = {
        **os.environ,
        "PDFFORGE_TEMP_ROOT": str(temp_root),
        "PYTHONIOENCODING": "utf-8",
        "PDFFORGE_CANCEL_GRACE_S": "1",
        "PDFFORGE_JOB_MEMORY_MB": "512",
    }
    proc = EngineProcess(env)
    yield proc
    if proc.proc.poll() is None:
        proc.close()
