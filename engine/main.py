"""PDFForge engine entry point: JSON-lines RPC loop over stdin/stdout.

stdout carries protocol messages only; logs and any stray library output go to stderr.
The loop ends on stdin EOF (the app closed the pipe): running jobs are cancelled and the
process exits once they have cleaned up.
"""

from __future__ import annotations

import io
import logging
import multiprocessing
import os
import sys
import threading
from pathlib import Path
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


def _take_protocol_streams() -> tuple[TextIO, TextIO]:
    """Move the protocol pipes onto private descriptors.

    stdout: library print()s must never corrupt the protocol, so sys.stdout and fd 1 now point at
    stderr. stdin: on Windows, CreateProcess (used to start job workers) touches the process's
    standard handles and blocks behind a pending synchronous read on the stdin pipe, so worker
    start-up would hang until the next request arrived. fd 0 and the Win32 std handles are
    therefore redirected to NUL / stderr, and the protocol is read from a private duplicate.
    """
    in_fd = os.dup(0)
    out_fd = os.dup(1)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.dup2(2, 1)
    os.close(devnull)
    if sys.platform == "win32":
        import ctypes
        import msvcrt

        k32 = ctypes.WinDLL("kernel32")
        k32.SetStdHandle(-10, msvcrt.get_osfhandle(0))  # STD_INPUT_HANDLE  -> NUL
        k32.SetStdHandle(-11, msvcrt.get_osfhandle(2))  # STD_OUTPUT_HANDLE -> stderr
    sys.stdin = Path(os.devnull).open(encoding="utf-8")  # noqa: SIM115 - process lifetime
    sys.stdout = sys.stderr
    protocol_out = io.TextIOWrapper(os.fdopen(out_fd, "wb"), encoding="utf-8", newline="\n")
    # utf-8-sig: tolerate a BOM before the first line (e.g. Windows PowerShell pipes).
    protocol_in = io.TextIOWrapper(os.fdopen(in_fd, "rb"), encoding="utf-8-sig", errors="replace")
    return protocol_in, protocol_out


def main() -> int:
    in_stream, protocol_out = _take_protocol_streams()

    _configure_logging()
    os.environ["PDFFORGE_ENGINE_PID"] = str(os.getpid())  # inherited by job workers
    netguard.install()
    sweep_temp_root()

    emit = LineWriter(protocol_out)
    # Each job runs in its own memory-capped worker process (docs/05 S6).
    manager = JobManager(emit, TOOLS, max_workers=min(4, os.cpu_count() or 2), isolate=True)
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
    multiprocessing.freeze_support()  # worker processes of the frozen engine.exe
    sys.exit(main())
