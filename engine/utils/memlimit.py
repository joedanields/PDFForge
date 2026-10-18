"""Per-job memory cap (docs/05_NON_FUNCTIONAL.md S6).

Windows: each job's worker process is placed in its own Job Object with
JOB_OBJECT_LIMIT_PROCESS_MEMORY (commit charge), so allocations beyond the cap fail with
MemoryError instead of exhausting the machine, plus KILL_ON_JOB_CLOSE so a worker can never
outlive the engine. Elsewhere the worker lowers its own RLIMIT_AS (see ``limit_self``).

Default 2048 MB; override with the PDFFORGE_JOB_MEMORY_MB environment variable or the
``memory_limit_mb`` request parameter.
"""

from __future__ import annotations

import ctypes
import logging
import os
import sys
from ctypes import wintypes
from typing import Any

log = logging.getLogger("pdfforge.memlimit")

DEFAULT_LIMIT_MB = 2048
MIN_LIMIT_MB = 128
MAX_LIMIT_MB = 64 * 1024


def default_limit_mb() -> int:
    raw = os.environ.get("PDFFORGE_JOB_MEMORY_MB", "")
    try:
        value = int(raw) if raw else DEFAULT_LIMIT_MB
    except ValueError:
        log.warning("ignoring invalid PDFFORGE_JOB_MEMORY_MB=%r", raw)
        value = DEFAULT_LIMIT_MB
    return clamp_mb(value)


def clamp_mb(value: int) -> int:
    return max(MIN_LIMIT_MB, min(MAX_LIMIT_MB, value))


def limit_from_params(params: dict[str, Any]) -> int:
    value = params.get("memory_limit_mb")
    if isinstance(value, int) and not isinstance(value, bool):
        return clamp_mb(value)
    return default_limit_mb()


def limit_self(limit_mb: int) -> None:
    """POSIX fallback, called inside the worker. No-op on Windows (Job Object is used)."""
    if sys.platform == "win32":
        return
    try:
        import resource

        limit = limit_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except (ImportError, ValueError, OSError):  # pragma: no cover - platform dependent
        log.warning("could not apply memory limit")


# --- Windows Job Objects ------------------------------------------------------------------------

_JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
_JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
_JOB_OBJECT_ASSOCIATE_COMPLETION_PORT_CLASS = 7
_JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT = 9
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_PROCESS_SET_QUOTA = 0x0100
_PROCESS_TERMINATE = 0x0001


class _IoCounters(ctypes.Structure):
    _fields_ = [
        (name, ctypes.c_ulonglong)
        for name in (
            "ReadOperationCount",
            "WriteOperationCount",
            "OtherOperationCount",
            "ReadTransferCount",
            "WriteTransferCount",
            "OtherTransferCount",
        )
    ]


class _BasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _ExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimitInformation),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class _AssociateCompletionPort(ctypes.Structure):
    _fields_ = [("CompletionKey", ctypes.c_void_p), ("CompletionPort", wintypes.HANDLE)]


class JobObjectLimit:
    """A Job Object holding one worker process. Closing it kills the process if still alive."""

    def __init__(self, handle: int, port: int, limit_bytes: int) -> None:
        self._handle = handle
        self._port = port
        self.limit_bytes = limit_bytes
        self._hit = False

    def peak_bytes(self) -> int:
        info = _ExtendedLimitInformation()
        ok = _kernel32().QueryInformationJobObject(
            self._handle,
            _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            ctypes.byref(info),
            ctypes.sizeof(info),
            None,
        )
        return int(info.PeakProcessMemoryUsed) if ok else 0

    def hit_limit(self) -> bool:
        """True once Windows has reported that the worker ran into its memory cap.

        A refused allocation is never committed, so peak usage cannot show this; the job's
        completion port receives JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT instead.
        """
        if self._hit or not self._port:
            return self._hit
        k32 = _kernel32()
        message = wintypes.DWORD()
        key = ctypes.c_void_p()
        overlapped = ctypes.c_void_p()
        while k32.GetQueuedCompletionStatus(
            self._port, ctypes.byref(message), ctypes.byref(key), ctypes.byref(overlapped), 0
        ):
            if message.value == _JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT:
                self._hit = True
        return self._hit

    def close(self) -> None:
        k32 = _kernel32()
        if self._handle:
            k32.CloseHandle(self._handle)
            self._handle = 0
        if self._port:
            k32.CloseHandle(self._port)
            self._port = 0


def _kernel32() -> Any:
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    k32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    k32.QueryInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.c_void_p,
    ]
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.CreateIoCompletionPort.restype = wintypes.HANDLE
    k32.CreateIoCompletionPort.argtypes = [
        wintypes.HANDLE,
        wintypes.HANDLE,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    k32.GetQueuedCompletionStatus.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
        wintypes.DWORD,
    ]
    return k32


def attach(pid: int, limit_mb: int) -> JobObjectLimit | None:
    """Put process ``pid`` in a new Job Object capped at ``limit_mb``. Windows only."""
    if sys.platform != "win32":
        return None
    k32 = _kernel32()
    job = k32.CreateJobObjectW(None, None)
    if not job:
        log.warning("CreateJobObject failed (%d)", ctypes.get_last_error())
        return None
    limit_bytes = limit_mb * 1024 * 1024
    info = _ExtendedLimitInformation()
    info.BasicLimitInformation.LimitFlags = (
        _JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | _JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
    )
    info.ProcessMemoryLimit = limit_bytes
    port = k32.CreateIoCompletionPort(_INVALID_HANDLE_VALUE, None, None, 1) or 0
    if port:
        assoc = _AssociateCompletionPort(None, port)
        if not k32.SetInformationJobObject(
            job,
            _JOB_OBJECT_ASSOCIATE_COMPLETION_PORT_CLASS,
            ctypes.byref(assoc),
            ctypes.sizeof(assoc),
        ):
            k32.CloseHandle(port)
            port = 0
    process = k32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, pid)
    try:
        if not process or not k32.SetInformationJobObject(
            job,
            _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")
        if not k32.AssignProcessToJobObject(job, process):
            raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")
    except OSError as exc:
        log.warning("could not apply memory limit to worker %d: %s", pid, exc)
        k32.CloseHandle(job)
        if port:
            k32.CloseHandle(port)
        return None
    finally:
        if process:
            k32.CloseHandle(process)
    return JobObjectLimit(job, port, limit_bytes)
