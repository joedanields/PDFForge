"""Wire protocol: JSON lines over stdin/stdout (docs/03_ARCHITECTURE.md §3).

Every line is one JSON object. Requests carry ``id`` + ``method`` (+ ``params``);
the engine answers with events carrying the same ``id``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

ENGINE_VERSION = "0.1.0"
PROTOCOL_VERSION = 1


class ErrorCode(StrEnum):
    INVALID_INPUT = "INVALID_INPUT"
    PASSWORD_REQUIRED = "PASSWORD_REQUIRED"
    WRONG_PASSWORD = "WRONG_PASSWORD"
    CORRUPT_FILE = "CORRUPT_FILE"
    UNSUPPORTED = "UNSUPPORTED"
    DISK_FULL = "DISK_FULL"
    TIMEOUT = "TIMEOUT"
    CANCELLED = "CANCELLED"
    INTERNAL = "INTERNAL"


class EngineError(Exception):
    """An error that maps directly onto a protocol error event."""

    def __init__(self, code: ErrorCode, message: str, file: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.file = file


@dataclass(frozen=True, slots=True)
class Request:
    id: str
    method: str
    params: dict[str, Any] = field(default_factory=dict)


class ProtocolError(Exception):
    """A line that is not a valid request. ``request_id`` is set when it could be read."""

    def __init__(self, message: str, request_id: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.request_id = request_id


def parse_request(line: str) -> Request:
    try:
        raw = json.loads(line)
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"Malformed JSON: {exc.msg}") from exc
    if not isinstance(raw, dict):
        raise ProtocolError("Request must be a JSON object")

    request_id = raw.get("id")
    if not isinstance(request_id, str) or not request_id:
        raise ProtocolError("Request 'id' must be a non-empty string")
    method = raw.get("method")
    if not isinstance(method, str) or not method:
        raise ProtocolError("Request 'method' must be a non-empty string", request_id)
    params = raw.get("params", {})
    if not isinstance(params, dict):
        raise ProtocolError("Request 'params' must be an object", request_id)
    return Request(id=request_id, method=method, params=params)


def encode(message: dict[str, Any]) -> str:
    """Serialise one message as a single line (no embedded newlines)."""
    return json.dumps(message, ensure_ascii=False, separators=(",", ":"))


def hello_event(request_id: str, methods: list[str]) -> dict[str, Any]:
    return {
        "id": request_id,
        "event": "hello",
        "engine_version": ENGINE_VERSION,
        "protocol_version": PROTOCOL_VERSION,
        "methods": methods,
    }


def progress_event(request_id: str, percent: int, message: str) -> dict[str, Any]:
    return {"id": request_id, "event": "progress", "percent": percent, "message": message}


def done_event(request_id: str, outputs: list[str], stats: dict[str, Any]) -> dict[str, Any]:
    return {"id": request_id, "event": "done", "outputs": outputs, "stats": stats}


def error_event(
    request_id: str | None, code: ErrorCode, message: str, file: str | None = None
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "id": request_id,
        "event": "error",
        "code": str(code),
        "message": message,
    }
    if file is not None:
        event["file"] = file
    return event
