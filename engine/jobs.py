"""Job queue, progress reporting and cooperative cancellation."""

from __future__ import annotations

import logging
import shutil
import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from protocol import (
    EngineError,
    ErrorCode,
    Request,
    done_event,
    error_event,
    progress_event,
)
from utils.atomic import is_disk_full
from utils.paths import job_temp_dir

log = logging.getLogger("pdfforge.jobs")

Emit = Callable[[dict[str, Any]], None]

DEFAULT_TIMEOUT_S = 15 * 60
MAX_TIMEOUT_S = 6 * 60 * 60


class CancelReason(StrEnum):
    USER = "user"
    TIMEOUT = "timeout"
    SHUTDOWN = "shutdown"


class Cancelled(Exception):
    """Raised inside a tool by ``JobContext.check_cancelled``."""


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

    def __init__(self, job_id: str, temp_dir: Path, token: CancelToken, emit: Emit) -> None:
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


ToolFn = Callable[[dict[str, Any], JobContext], ToolResult]


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
    ) -> None:
        self._emit = emit
        self._tools = tools
        self._default_timeout_s = default_timeout_s
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
                raise Cancelled
            temp_dir.mkdir(parents=True, exist_ok=True)
            timer.start()
            ctx = JobContext(request.id, temp_dir, job.token, self._emit)
            result = self._tools[request.method](request.params, ctx)
            stats = {**result.stats, "ms": int((time.perf_counter() - started) * 1000)}
            self._emit(done_event(request.id, [str(p) for p in result.outputs], stats))
            log.info("job %s done in %d ms", request.id, stats["ms"])
        except Cancelled:
            if job.token.reason is CancelReason.TIMEOUT:
                self._emit(error_event(request.id, ErrorCode.TIMEOUT, "The job took too long"))
            else:
                self._emit(error_event(request.id, ErrorCode.CANCELLED, "Cancelled"))
            log.info("job %s cancelled (%s)", request.id, job.token.reason)
        except EngineError as exc:
            self._emit(error_event(request.id, exc.code, exc.message, exc.file))
            log.info("job %s failed: %s", request.id, exc.code)
        except OSError as exc:
            if is_disk_full(exc):
                self._emit(error_event(request.id, ErrorCode.DISK_FULL, "Not enough disk space"))
            else:
                log.exception("job %s: unexpected OS error", request.id)
                self._emit(
                    error_event(request.id, ErrorCode.INTERNAL, "Unexpected file system error")
                )
        except MemoryError:
            log.exception("job %s: out of memory", request.id)
            self._emit(error_event(request.id, ErrorCode.INTERNAL, "Not enough memory"))
        except Exception:
            log.exception("job %s: unexpected error", request.id)
            self._emit(
                error_event(request.id, ErrorCode.INTERNAL, "Unexpected error while processing")
            )
        finally:
            timer.cancel()
            shutil.rmtree(temp_dir, ignore_errors=True)
            with self._lock:
                self._jobs.pop(request.id, None)
