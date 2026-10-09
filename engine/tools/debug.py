"""Echo: a dummy tool that exercises the full job pipeline (docs/08_ROADMAP.md Phase 0 exit)."""

from __future__ import annotations

import os
import time
from typing import Any

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode

_MAX_STEPS = 1000


def echo(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Report ``steps`` progress events ``delay_ms`` apart, then return ``message`` in stats.

    Test hooks: ``fail`` (an error code) fails the job; ``crash: true`` kills the engine process
    so the app's watchdog can be exercised.
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

    if params.get("crash") is True:
        os._exit(70)

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
