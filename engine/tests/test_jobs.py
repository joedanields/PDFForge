"""JobManager unit tests with fake tools."""

from __future__ import annotations

import errno
import threading
from pathlib import Path
from typing import Any

from jobs import JobContext, JobManager, ToolResult
from protocol import EngineError, ErrorCode, Request


class Collector:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.finished = threading.Event()
        self._lock = threading.Lock()

    def __call__(self, event: dict[str, Any]) -> None:
        with self._lock:
            self.events.append(event)
            if event["event"] in ("done", "error"):
                self.finished.set()

    def final(self) -> dict[str, Any]:
        assert self.finished.wait(10)
        return next(e for e in reversed(self.events) if e["event"] in ("done", "error"))


def run_one(tool: Any, params: dict[str, Any] | None = None) -> tuple[Collector, dict[str, Any]]:
    collector = Collector()
    manager = JobManager(collector, {"t": tool}, max_workers=1)
    manager.submit(Request("j1", "t", params or {}))
    final = collector.final()
    manager.shutdown()
    return collector, final


def test_progress_is_deduplicated_and_clamped() -> None:
    def tool(_: dict[str, Any], ctx: JobContext) -> ToolResult:
        for pct in (-5, 10, 10, 10.4, 150):
            ctx.progress(pct, "x")
        return ToolResult([])

    collector, final = run_one(tool)
    assert [e["percent"] for e in collector.events if e["event"] == "progress"] == [0, 10, 100]
    assert final["event"] == "done"


def test_temp_dir_exists_during_job_and_is_removed(temp_root: Path) -> None:
    seen: list[Path] = []

    def tool(_: dict[str, Any], ctx: JobContext) -> ToolResult:
        assert ctx.temp_dir.is_dir()
        assert ctx.temp_dir.parent == temp_root
        (ctx.temp_dir / "scratch.bin").write_bytes(b"1")
        seen.append(ctx.temp_dir)
        return ToolResult([])

    run_one(tool)
    assert seen and not seen[0].exists()


def test_temp_dir_removed_after_failure() -> None:
    seen: list[Path] = []

    def tool(_: dict[str, Any], ctx: JobContext) -> ToolResult:
        seen.append(ctx.temp_dir)
        (ctx.temp_dir / "partial.pdf").write_bytes(b"1")
        raise RuntimeError("boom")

    _, final = run_one(tool)
    assert final["code"] == "INTERNAL"
    assert not seen[0].exists()


def test_unexpected_exception_hides_details() -> None:
    def tool(_: dict[str, Any], __: JobContext) -> ToolResult:
        raise ValueError("secret internal detail C:/Users/someone/file.pdf")

    _, final = run_one(tool)
    assert final["code"] == "INTERNAL"
    assert "secret" not in final["message"]
    assert "Traceback" not in final["message"]


def test_engine_error_is_forwarded_with_file() -> None:
    def tool(_: dict[str, Any], __: JobContext) -> ToolResult:
        raise EngineError(ErrorCode.PASSWORD_REQUIRED, "b.pdf is encrypted", "C:/b.pdf")

    _, final = run_one(tool)
    assert final == {
        "id": "j1",
        "event": "error",
        "code": "PASSWORD_REQUIRED",
        "message": "b.pdf is encrypted",
        "file": "C:/b.pdf",
    }


def test_disk_full_is_mapped() -> None:
    def tool(_: dict[str, Any], __: JobContext) -> ToolResult:
        raise OSError(errno.ENOSPC, "No space left on device")

    _, final = run_one(tool)
    assert final["code"] == "DISK_FULL"


def test_queued_job_cancelled_before_start() -> None:
    gate = threading.Event()
    started = threading.Event()
    collector = Collector()

    def slow(_: dict[str, Any], ctx: JobContext) -> ToolResult:
        started.set()
        gate.wait(5)
        return ToolResult([])

    ran: list[str] = []

    def never(_: dict[str, Any], ctx: JobContext) -> ToolResult:
        ran.append(ctx.job_id)
        return ToolResult([])

    manager = JobManager(collector, {"slow": slow, "never": never}, max_workers=1)
    manager.submit(Request("a", "slow", {}))
    manager.submit(Request("b", "never", {}))
    assert started.wait(5)  # "a" occupies the only worker, so "b" is still queued
    assert manager.cancel("b")
    gate.set()
    while len([e for e in collector.events if e["event"] in ("done", "error")]) < 2:
        collector.finished.wait(0.05)
    manager.shutdown()
    finals = {e["id"]: e for e in collector.events if e["event"] in ("done", "error")}
    assert finals["a"]["event"] == "done"
    assert finals["b"]["code"] == "CANCELLED"
    assert ran == []


def test_id_reusable_after_completion() -> None:
    collector = Collector()
    manager = JobManager(collector, {"t": lambda _p, _c: ToolResult([])}, max_workers=1)
    manager.submit(Request("same", "t", {}))
    collector.final()
    manager.shutdown()
    assert manager.active_ids() == []
