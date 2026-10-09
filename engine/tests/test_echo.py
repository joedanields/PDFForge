"""Echo tool, in-process (the subprocess path is covered by test_protocol.py)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from jobs import Cancelled
from protocol import EngineError
from tests.helpers import RecordingContext
from tools.debug import echo


def test_echo_returns_message(ctx: RecordingContext) -> None:
    result = echo({"message": "ping", "steps": 2, "delay_ms": 0}, ctx)
    assert result.outputs == []
    assert result.stats == {"steps": 2, "echo": "ping"}
    assert [e["percent"] for e in ctx.events] == [50, 100]


def test_echo_zero_steps(ctx: RecordingContext) -> None:
    assert echo({"steps": 0}, ctx).stats["steps"] == 0
    assert ctx.events == []


@pytest.mark.parametrize(
    "params",
    [{"message": 1}, {"steps": -1}, {"steps": True}, {"steps": 1001}, {"delay_ms": "x"}],
)
def test_echo_rejects_bad_params(params: dict[str, Any], ctx: RecordingContext) -> None:
    with pytest.raises(EngineError) as info:
        echo(params, ctx)
    assert info.value.code == "INVALID_INPUT"


@pytest.mark.parametrize(("fail", "code"), [("DISK_FULL", "DISK_FULL"), ("bogus", "INTERNAL")])
def test_echo_fail_hook(fail: str, code: str, ctx: RecordingContext) -> None:
    with pytest.raises(EngineError) as info:
        echo({"steps": 1, "delay_ms": 0, "fail": fail}, ctx)
    assert info.value.code == code


def test_echo_cancel(tmp_path: Path) -> None:
    ctx = RecordingContext(tmp_path / "job", cancel_after=1)
    with pytest.raises(Cancelled):
        echo({"steps": 10, "delay_ms": 0}, ctx)
    assert len(ctx.events) == 1
