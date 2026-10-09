"""Block outbound network access inside the engine (docs/01_PRD.md G2, 05 S1/S2).

No engine tool needs the network. Only loopback connections are allowed (Windows uses them
internally for ``socket.socketpair``). Future network features (HTML from URL) must be explicitly
user-initiated and will get a scoped exception.
"""

from __future__ import annotations

import ipaddress
import socket
from typing import Any


class NetworkBlockedError(OSError):
    pass


_installed = False


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
        if self.family in (socket.AF_INET, socket.AF_INET6) and not _is_loopback(address):
            raise NetworkBlockedError("Network access is disabled in the PDFForge engine")
        original_connect(self, address)

    def guarded_connect_ex(self: socket.socket, address: Any) -> int:
        if self.family in (socket.AF_INET, socket.AF_INET6) and not _is_loopback(address):
            raise NetworkBlockedError("Network access is disabled in the PDFForge engine")
        return original_connect_ex(self, address)

    def guarded_getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
        if host is not None and not _is_loopback(host if isinstance(host, str) else str(host)):
            raise NetworkBlockedError("Network access is disabled in the PDFForge engine")
        return original_getaddrinfo(host, *args, **kwargs)

    socket.socket.connect = guarded_connect  # type: ignore[method-assign,assignment]
    socket.socket.connect_ex = guarded_connect_ex  # type: ignore[method-assign,assignment]
    socket.getaddrinfo = guarded_getaddrinfo
