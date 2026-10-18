"""Running bundled helper programs (LibreOffice, Tesseract) from a job.

The helper inherits the job's Windows Job Object (memory cap, killed with the worker), runs
without a console window, and is killed together with its child processes when the job is
cancelled or the helper exceeds its own timeout.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from jobs import Cancelled, JobContext
from protocol import EngineError, ErrorCode

log = logging.getLogger("pdfforge.process")

_POLL_S = 0.1
CREATE_NO_WINDOW = 0x08000000


@dataclass
class Completed:
    returncode: int
    stdout: str
    stderr: str


def kill_tree(proc: subprocess.Popen[bytes]) -> None:
    """Kill ``proc`` and everything it started (soffice.com -> soffice.bin)."""
    if proc.poll() is not None:
        return
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True,
            creationflags=CREATE_NO_WINDOW,
            check=False,
        )
    proc.kill()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:  # pragma: no cover - only if the OS refuses to kill
        log.warning("helper process %s did not exit after kill", proc.pid)


def run_helper(
    args: Sequence[str | Path],
    ctx: JobContext,
    *,
    timeout_s: float,
    what: str,
    env: Mapping[str, str] | None = None,
    cwd: Path | None = None,
) -> Completed:
    """Run a helper to completion, honouring job cancellation and ``timeout_s``.

    Raises ``Cancelled`` when the job is cancelled and TIMEOUT when the helper takes too long;
    the helper is killed in both cases. The caller judges the exit code.
    """
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    proc = subprocess.Popen(
        [str(a) for a in args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=full_env,
        cwd=str(cwd) if cwd else None,
        creationflags=CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            out, err = proc.communicate(timeout=_POLL_S)
            break
        except subprocess.TimeoutExpired:
            if ctx.is_cancelled():
                kill_tree(proc)
                proc.communicate()
                raise Cancelled from None
            if time.monotonic() > deadline:
                kill_tree(proc)
                proc.communicate()
                raise EngineError(
                    ErrorCode.TIMEOUT, f"{what} took longer than {int(timeout_s)} seconds"
                ) from None
    return Completed(
        proc.returncode,
        out.decode("utf-8", "replace"),
        err.decode("utf-8", "replace"),
    )
