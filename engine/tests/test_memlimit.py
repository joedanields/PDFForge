"""Windows Job Object memory cap (utils/memlimit.py)."""

from __future__ import annotations

import subprocess
import sys

import pytest

from utils import memlimit

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="Job Objects are Windows-only")

_HOG = "import time; time.sleep(1); b = bytearray({mb} * 1024 * 1024); print('allocated')"


def _python(code: str) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )


@windows_only
def test_allocation_beyond_cap_fails() -> None:
    proc = _python(_HOG.format(mb=600))
    limit = memlimit.attach(proc.pid, 256)
    assert limit is not None
    out, err = proc.communicate(timeout=60)
    assert proc.returncode != 0
    assert "MemoryError" in err
    assert "allocated" not in out
    assert limit.hit_limit()
    limit.close()


@windows_only
def test_allocation_within_cap_succeeds() -> None:
    proc = _python(_HOG.format(mb=50))
    limit = memlimit.attach(proc.pid, 512)
    assert limit is not None
    out, _ = proc.communicate(timeout=60)
    assert proc.returncode == 0
    assert "allocated" in out
    assert not limit.hit_limit()
    limit.close()


@windows_only
def test_closing_the_job_kills_the_worker() -> None:
    proc = _python("import time; time.sleep(60)")
    limit = memlimit.attach(proc.pid, 512)
    assert limit is not None
    limit.close()
    proc.wait(timeout=10)  # would sleep 60 s if it were not killed with its job


def test_limit_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PDFFORGE_JOB_MEMORY_MB", raising=False)
    assert memlimit.default_limit_mb() == 2048
    monkeypatch.setenv("PDFFORGE_JOB_MEMORY_MB", "4096")
    assert memlimit.default_limit_mb() == 4096
    monkeypatch.setenv("PDFFORGE_JOB_MEMORY_MB", "lots")
    assert memlimit.default_limit_mb() == 2048
    monkeypatch.setenv("PDFFORGE_JOB_MEMORY_MB", "1")
    assert memlimit.default_limit_mb() == memlimit.MIN_LIMIT_MB
    assert memlimit.limit_from_params({"memory_limit_mb": 300}) == 300
    assert memlimit.limit_from_params({"memory_limit_mb": True}) == memlimit.MIN_LIMIT_MB
