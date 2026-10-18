"""Entry point of a job worker process (one process per job).

The engine spawns this with multiprocessing ("spawn") so each job gets its own memory cap
(utils/memlimit.py) and can be killed if it ignores cancellation. Messages to the parent go
through a multiprocessing Queue:

    ("progress", <progress event dict>)
    ("log", <levelno>, <message>)
    ("done", [output paths], {stats})
    ("cancelled",)
    ("error", <code>, <message>, <file or None>)
"""

from __future__ import annotations

import contextlib
import logging
import sys
from multiprocessing.queues import Queue
from multiprocessing.synchronize import Event
from pathlib import Path
from typing import Any

from jobs import Cancelled, JobContext, describe_failure
from utils import memlimit, netguard


class _EventToken:
    """Adapts a multiprocessing Event to the ``cancelled`` property JobContext expects."""

    def __init__(self, event: Event) -> None:
        self._event = event

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()


class _QueueLogHandler(logging.Handler):
    def __init__(self, queue: Queue[Any]) -> None:
        super().__init__()
        self._queue = queue

    def emit(self, record: logging.LogRecord) -> None:
        with contextlib.suppress(Exception):  # logging must never break the job
            self._queue.put(("log", record.levelno, self.format(record)))


def child_main(
    job_id: str,
    method: str,
    params: dict[str, Any],
    temp_dir: str,
    queue: Queue[Any],
    cancel_event: Event,
    limit_mb: int,
) -> None:
    # The worker has no protocol channel of its own: keep stray prints off stdout.
    sys.stdout = sys.stderr
    root = logging.getLogger()
    root.handlers[:] = [_QueueLogHandler(queue)]
    root.setLevel(logging.INFO)
    memlimit.limit_self(limit_mb)
    netguard.install()

    from tools import TOOLS  # imported here so the parent stays light

    ctx = JobContext(job_id, Path(temp_dir), _EventToken(cancel_event), _progress_sender(queue))
    try:
        result = TOOLS[method](params, ctx)
        queue.put(("done", [str(p) for p in result.outputs], result.stats))
    except Cancelled:
        queue.put(("cancelled",))
    except BaseException as exc:
        code, message, file = describe_failure(exc, limit_mb)
        with contextlib.suppress(Exception):  # parent falls back to exit-code handling
            queue.put(("error", code.value, message, file))
    finally:
        queue.close()
        queue.join_thread()


def _progress_sender(queue: Queue[Any]) -> Any:
    def send(event: dict[str, Any]) -> None:
        queue.put(("progress", event))

    return send
