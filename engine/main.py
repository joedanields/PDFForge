"""PDFForge engine entry point: JSON-lines RPC loop over stdin/stdout.

stdout carries protocol messages only; logs and any stray library output go to stderr.
The loop ends on stdin EOF (the app closed the pipe): running jobs are cancelled and the
process exits once they have cleaned up.
"""

from __future__ import annotations

import io
import logging
import os
import sys
import threading
from typing import Any, TextIO

from jobs import JobManager
from protocol import (
    EngineError,
    ErrorCode,
    ProtocolError,
    encode,
    error_event,
    hello_event,
    parse_request,
)
from tools import TOOLS
from utils import netguard
from utils.paths import sweep_temp_root

log = logging.getLogger("pdfforge.engine")

BUILTIN_METHODS = ("hello", "cancel")


class LineWriter:
    """Thread-safe, line-buffered protocol writer."""

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def __call__(self, message: dict[str, Any]) -> None:
        line = encode(message) + "\n"
        with self._lock:
            self._stream.write(line)
            self._stream.flush()


def serve(in_stream: TextIO, emit: LineWriter, manager: JobManager) -> None:
    methods = [*BUILTIN_METHODS, *sorted(TOOLS)]
    for raw in in_stream:
        line = raw.strip()
        if not line:
            continue
        try:
            request = parse_request(line)
        except ProtocolError as exc:
            emit(error_event(exc.request_id, ErrorCode.INVALID_INPUT, exc.message))
            continue

        if request.method == "hello":
            emit(hello_event(request.id, methods))
        elif request.method == "cancel":
            # Unknown ids are ignored: the job may have finished a moment ago.
            manager.cancel(request.id)
        else:
            try:
                manager.submit(request)
            except EngineError as exc:
                emit(error_event(request.id, exc.code, exc.message, exc.file))


def _configure_logging() -> None:
    logging.basicConfig(
        stream=sys.stderr,
        level=os.environ.get("PDFFORGE_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def main() -> int:
    # Take a private handle on the real stdout, then point sys.stdout at stderr so that a
    # library print() can never corrupt the protocol stream.
    protocol_out = io.TextIOWrapper(
        os.fdopen(os.dup(sys.stdout.fileno()), "wb"), encoding="utf-8", newline="\n"
    )
    sys.stdout = sys.stderr
    # utf-8-sig: tolerate a BOM before the first line (e.g. Windows PowerShell pipes).
    in_stream = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8-sig", errors="replace")

    _configure_logging()
    netguard.install()
    sweep_temp_root()

    emit = LineWriter(protocol_out)
    manager = JobManager(emit, TOOLS, max_workers=min(4, os.cpu_count() or 2))
    log.info("engine ready (pid %d)", os.getpid())
    try:
        serve(in_stream, emit, manager)
    except KeyboardInterrupt:
        pass
    finally:
        manager.shutdown(wait=True)
        log.info("engine stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
