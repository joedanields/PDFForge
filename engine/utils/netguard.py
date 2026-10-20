"""Block outbound network access inside the engine (docs/01_PRD.md G2, 05 S1/S2).

Only loopback connections are allowed (Windows uses them internally for
``socket.socketpair``). The one exception is "Web page to PDF" (D-043): the user types an
address and confirms, and that tool opens connections inside ``allowed()`` only.
"""

from __future__ import annotations

import ipaddress
import socket
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any


class NetworkBlockedError(OSError):
    pass


_installed = False
_allowance = threading.local()


@contextmanager
def allowed() -> Iterator[None]:
    """Permit outbound connections from this thread for the duration of the block."""
    previous = getattr(_allowance, "on", False)
    _allowance.on = True
    try:
        yield
    finally:
        _allowance.on = previous


def _permitted(address: Any) -> bool:
    return bool(getattr(_allowance, "on", False)) or _is_loopback(address)


def _is_loopback(address: Any) -> bool:
    host = address[0] if isinstance(address, tuple) else address
    if not isinstance(host, str):
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def install() -> None:
    global _installed
    if _installed:
        return
    _installed = True

    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_getaddrinfo = socket.getaddrinfo

    def guarded_connect(self: socket.socket, address: Any) -> None:
        if self.family in (socket.AF_INET, socket.AF_INET6) and not _permitted(address):
            raise NetworkBlockedError("Network access is disabled in the PDFForge engine")
        original_connect(self, address)

    def guarded_connect_ex(self: socket.socket, address: Any) -> int:
        if self.family in (socket.AF_INET, socket.AF_INET6) and not _permitted(address):
            raise NetworkBlockedError("Network access is disabled in the PDFForge engine")
        return original_connect_ex(self, address)

    def guarded_getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
        if host is not None and not _permitted(host if isinstance(host, str) else str(host)):
            raise NetworkBlockedError("Network access is disabled in the PDFForge engine")
        return original_getaddrinfo(host, *args, **kwargs)

    socket.socket.connect = guarded_connect  # type: ignore[method-assign,assignment]
    socket.socket.connect_ex = guarded_connect_ex  # type: ignore[method-assign,assignment]
    socket.getaddrinfo = guarded_getaddrinfo
