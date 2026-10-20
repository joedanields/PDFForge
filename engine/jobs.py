"""Job queue, progress reporting and cancellation.

Two execution modes:
- isolated (the engine): every job runs in its own worker process (worker.py), capped by a
  Windows Job Object (utils/memlimit.py) and killed if it ignores cancellation or its timeout
  for longer than a grace period.
- in-process threads: used by unit tests with fake tools.
"""

from __future__ import annotations

import logging
import multiprocessing
import os
import queue as queue_mod
import shutil
import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

from protocol import (
    EngineError,
    ErrorCode,
    Request,
    done_event,
    error_event,
    progress_event,
)
from utils import memlimit
from utils.atomic import is_disk_full
from utils.paths import job_temp_dir

log = logging.getLogger("pdfforge.jobs")

Emit = Callable[[dict[str, Any]], None]

DEFAULT_TIMEOUT_S = 15 * 60
MAX_TIMEOUT_S = 6 * 60 * 60
DEFAULT_CANCEL_GRACE_S = 5.0


class CancelReason(StrEnum):
    USER = "user"
    TIMEOUT = "timeout"
    SHUTDOWN = "shutdown"


class Cancelled(Exception):
    """Raised inside a tool by ``JobContext.check_cancelled``."""


class SupportsCancel(Protocol):
    @property
    def cancelled(self) -> bool: ...


class CancelToken:
    def __init__(self) -> None:
        self._event = threading.Event()
        self.reason: CancelReason | None = None

    def cancel(self, reason: CancelReason = CancelReason.USER) -> None:
        if not self._event.is_set():
            self.reason = reason
            self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()


@dataclass
class ToolResult:
    outputs: list[Path]
    stats: dict[str, Any] = field(default_factory=dict)


class JobContext:
    """What a tool sees: ``progress()``, ``is_cancelled()`` and ``temp_dir`` (03 §4)."""

    def __init__(self, job_id: str, temp_dir: Path, token: SupportsCancel, emit: Emit) -> None:
        self.job_id = job_id
        self.temp_dir = temp_dir
        self._token = token
        self._emit = emit
        self._last: tuple[int, str] | None = None

    def progress(self, percent: float, message: str = "") -> None:
        pct = max(0, min(100, int(percent)))
        if self._last == (pct, message):
            return
        self._last = (pct, message)
        self._emit(progress_event(self.job_id, pct, message))

    def is_cancelled(self) -> bool:
        return self._token.cancelled

    def check_cancelled(self) -> None:
        if self._token.cancelled:
            raise Cancelled

    def scoped(self, temp_dir: Path, start: float, end: float, label: str) -> JobContext:
        """A context for one part of this job (a workflow step): its own ``temp_dir``, progress
        mapped onto ``start..end`` and prefixed with ``label``; same cancellation."""
        return _ScopedContext(self, temp_dir, start, end, label)


class _ScopedContext(JobContext):
    def __init__(
        self, parent: JobContext, temp_dir: Path, start: float, end: float, label: str
    ) -> None:
        super().__init__(parent.job_id, temp_dir, parent._token, parent._emit)
        self._parent = parent
        self._start = start
        self._end = end
        self._label = label

    def progress(self, percent: float, message: str = "") -> None:
        pct = max(0.0, min(100.0, percent))
        text = f"{self._label} · {message}" if message else self._label
        self._parent.progress(self._start + (self._end - self._start) * pct / 100, text)


ToolFn = Callable[[dict[str, Any], JobContext], ToolResult]


def memory_message(limit_mb: int | None) -> str:
    if limit_mb:
        return f"This job needed more than {limit_mb} MB of memory. " "Try fewer or smaller files."
    return "Not enough memory"


def describe_failure(
    exc: BaseException, limit_mb: int | None = None
) -> tuple[ErrorCode, str, str | None]:
    """Map an exception raised by a tool onto (code, plain-language message, file)."""
    if isinstance(exc, EngineError):
        return exc.code, exc.message, exc.file
    if isinstance(exc, MemoryError):
        log.warning("job ran out of memory")
        return ErrorCode.INTERNAL, memory_message(limit_mb), None
    if isinstance(exc, OSError):
        if is_disk_full(exc):
            return ErrorCode.DISK_FULL, "Not enough disk space", None
        log.error("unexpected OS error", exc_info=exc)
        return ErrorCode.INTERNAL, "Unexpected file system error", None
    log.error("unexpected error", exc_info=exc)
    return ErrorCode.INTERNAL, "Unexpected error while processing", None


@dataclass
class _Outcome:
    kind: str  # "done" | "cancelled" | "error"
    outputs: list[str] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)
    code: ErrorCode = ErrorCode.INTERNAL
    message: str = ""
    file: str | None = None


@dataclass
class _Job:
    request: Request
    token: CancelToken = field(default_factory=CancelToken)


class JobManager:
    def __init__(
        self,
        emit: Emit,
        tools: Mapping[str, ToolFn],
        *,
        max_workers: int = 2,
        default_timeout_s: float = DEFAULT_TIMEOUT_S,
        isolate: bool = False,
        cancel_grace_s: float | None = None,
    ) -> None:
        self._emit = emit
        self._tools = tools
        self._default_timeout_s = default_timeout_s
        self._isolate = isolate
        grace_env = os.environ.get("PDFFORGE_CANCEL_GRACE_S")
        self._grace_s = (
            cancel_grace_s
            if cancel_grace_s is not None
            else float(grace_env) if grace_env else DEFAULT_CANCEL_GRACE_S
        )
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="job")
        self._jobs: dict[str, _Job] = {}
        self._lock = threading.Lock()

    def submit(self, request: Request) -> None:
        if request.method not in self._tools:
            raise EngineError(ErrorCode.UNSUPPORTED, f"Unknown method '{request.method}'")
        job = _Job(request)
        with self._lock:
            if request.id in self._jobs:
                raise EngineError(
                    ErrorCode.INVALID_INPUT, f"Job id '{request.id}' is already in use"
                )
            self._jobs[request.id] = job
        self._pool.submit(self._run, job)

    def cancel(self, job_id: str, reason: CancelReason = CancelReason.USER) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            return False
        job.token.cancel(reason)
        return True

    def active_ids(self) -> list[str]:
        with self._lock:
            return list(self._jobs)

    def shutdown(self, *, wait: bool = True) -> None:
        for job_id in self.active_ids():
            self.cancel(job_id, CancelReason.SHUTDOWN)
        self._pool.shutdown(wait=wait, cancel_futures=False)

    def _timeout_for(self, request: Request) -> float:
        value = request.params.get("timeout_s")
        if isinstance(value, int | float) and not isinstance(value, bool) and value > 0:
            return float(min(value, MAX_TIMEOUT_S))
        return self._default_timeout_s

    # --- running ---------------------------------------------------------------------------

    def _run(self, job: _Job) -> None:
        request = job.request
        started = time.perf_counter()
        temp_dir = job_temp_dir(request.id)
        timer = threading.Timer(
            self._timeout_for(request), job.token.cancel, (CancelReason.TIMEOUT,)
        )
        timer.daemon = True
        log.info("job %s started: %s", request.id, request.method)  # never log params (S4)
        try:
            if job.token.cancelled:
                outcome = _Outcome("cancelled")
            else:
                temp_dir.mkdir(parents=True, exist_ok=True)
                timer.start()
                outcome = (
                    self._run_isolated(job, temp_dir)
                    if self._isolate
                    else self._run_inline(job, temp_dir)
                )
        finally:
            timer.cancel()
            shutil.rmtree(temp_dir, ignore_errors=True)

        ms = int((time.perf_counter() - started) * 1000)
        if outcome.kind == "done":
            self._emit(done_event(request.id, outcome.outputs, {**outcome.stats, "ms": ms}))
            log.info("job %s done in %d ms", request.id, ms)
        elif outcome.kind == "cancelled":
            if job.token.reason is CancelReason.TIMEOUT:
                self._emit(error_event(request.id, ErrorCode.TIMEOUT, "The job took too long"))
            else:
                self._emit(error_event(request.id, ErrorCode.CANCELLED, "Cancelled"))
            log.info("job %s cancelled (%s)", request.id, job.token.reason)
        else:
            self._emit(error_event(request.id, outcome.code, outcome.message, outcome.file))
            log.info("job %s failed: %s", request.id, outcome.code)
        with self._lock:
            self._jobs.pop(request.id, None)

    def _run_inline(self, job: _Job, temp_dir: Path) -> _Outcome:
        request = job.request
        ctx = JobContext(request.id, temp_dir, job.token, self._emit)
        try:
            result = self._tools[request.method](request.params, ctx)
        except Cancelled:
            return _Outcome("cancelled")
        except Exception as exc:
            code, message, file = describe_failure(exc)
            return _Outcome("error", code=code, message=message, file=file)
        return _Outcome("done", [str(p) for p in result.outputs], result.stats)

    def _run_isolated(self, job: _Job, temp_dir: Path) -> _Outcome:
        import worker

        request = job.request
        ctx = multiprocessing.get_context("spawn")
        messages: Any = ctx.Queue()
        cancel_event = ctx.Event()
        limit_mb = memlimit.limit_from_params(request.params)
        proc = ctx.Process(
            target=worker.child_main,
            args=(
                request.id,
                request.method,
                request.params,
                str(temp_dir),
                messages,
                cancel_event,
                limit_mb,
            ),
            name=f"job-{request.id}",
            daemon=True,
        )
        proc.start()
        limiter = memlimit.attach(proc.pid or 0, limit_mb)
        final: tuple[Any, ...] | None = None
        cancel_sent_at: float | None = None
        killed = False
        try:
            while final is None:
                if job.token.cancelled and cancel_sent_at is None:
                    cancel_event.set()
                    cancel_sent_at = time.monotonic()
                msg = self._next_message(messages, 0.05)
                if msg is not None:
                    final = self._handle_message(request.id, msg)
                    continue
                if not proc.is_alive():
                    # The worker exited: collect anything it wrote just before.
                    while final is None and (msg := self._next_message(messages, 0.3)):
                        final = self._handle_message(request.id, msg)
                    break
                if cancel_sent_at is not None and time.monotonic() - cancel_sent_at > self._grace_s:
                    log.warning("job %s ignored cancellation; killing worker", request.id)
                    proc.kill()
                    killed = True
                    break
        finally:
            proc.join(timeout=5)
            if proc.is_alive():
                proc.kill()
                proc.join(timeout=5)
            hit_limit = limiter.hit_limit() if limiter else False
            if limiter:
                limiter.close()
            messages.cancel_join_thread()
            messages.close()

        if final is not None:
            kind = final[0]
            if kind == "done":
                return _Outcome("done", list(final[1]), dict(final[2]))
            if kind == "cancelled":
                return _Outcome("cancelled")
            return _Outcome("error", code=ErrorCode(final[1]), message=final[2], file=final[3])
        if killed:
            return _Outcome("cancelled")
        if hit_limit:
            return _Outcome("error", message=memory_message(limit_mb))
        log.error("job %s: worker exited with code %s", request.id, proc.exitcode)
        return _Outcome("error", message="The job stopped unexpectedly. Please try again.")

    @staticmethod
    def _next_message(messages: Any, timeout: float) -> tuple[Any, ...] | None:
        try:
            msg: tuple[Any, ...] = messages.get(timeout=timeout)
        except (queue_mod.Empty, EOFError, OSError):
            return None
        return msg

    def _handle_message(self, job_id: str, msg: tuple[Any, ...]) -> tuple[Any, ...] | None:
        """Forward progress/log messages; return the message if it is the final one."""
        if msg[0] == "progress":
            self._emit(msg[1])
            return None
        if msg[0] == "log":
            log.log(msg[1], "[%s] %s", job_id, msg[2])
            return None
        return msg
