"""Echo: a dummy tool that exercises the full job pipeline (docs/08_ROADMAP.md Phase 0 exit)."""

from __future__ import annotations

import os
import signal
import time
from typing import Any

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode

_MAX_STEPS = 1000


def echo(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Report ``steps`` progress events ``delay_ms`` apart, then return ``message`` in stats.

    Test hooks: ``fail`` (an error code) fails the job; ``crash: true`` kills the job's worker
    process; ``crash: "engine"`` kills the engine itself (for the app's watchdog);
    ``allocate_mb`` allocates that much memory (for the per-job memory cap); ``block_s`` sleeps
    without checking for cancellation (for the forced-kill path).
    """
    message = params.get("message", "")
    steps = params.get("steps", 5)
    delay_ms = params.get("delay_ms", 100)
    if not isinstance(message, str):
        raise EngineError(ErrorCode.INVALID_INPUT, "'message' must be a string")
    if not isinstance(steps, int) or isinstance(steps, bool) or not 0 <= steps <= _MAX_STEPS:
        raise EngineError(ErrorCode.INVALID_INPUT, f"'steps' must be an integer 0-{_MAX_STEPS}")
    if not isinstance(delay_ms, int) or isinstance(delay_ms, bool) or not 0 <= delay_ms <= 10_000:
        raise EngineError(ErrorCode.INVALID_INPUT, "'delay_ms' must be an integer 0-10000")

    crash = params.get("crash")
    if crash == "engine":
        engine_pid = int(os.environ.get("PDFFORGE_ENGINE_PID", os.getppid()))
        os.kill(engine_pid, signal.SIGTERM)
        os._exit(70)
    if crash is True:
        os._exit(70)
    allocate_mb = params.get("allocate_mb")
    if isinstance(allocate_mb, int) and not isinstance(allocate_mb, bool) and allocate_mb > 0:
        hog = bytearray(allocate_mb * 1024 * 1024)  # zero-filled: committed memory
        hog[::4096] = b"x" * len(hog[::4096])
        del hog
    block_s = params.get("block_s")
    if isinstance(block_s, int | float) and not isinstance(block_s, bool) and block_s > 0:
        time.sleep(min(float(block_s), 600))

    fail = params.get("fail")
    for i in range(steps):
        ctx.check_cancelled()
        time.sleep(delay_ms / 1000)
        ctx.progress((i + 1) * 100 / steps, f"Step {i + 1} of {steps}")

    if isinstance(fail, str):
        try:
            code = ErrorCode(fail)
        except ValueError:
            code = ErrorCode.INTERNAL
        raise EngineError(code, f"Echo failed on request ({code})")

    ctx.check_cancelled()
    return ToolResult(outputs=[], stats={"steps": steps, "echo": message})
