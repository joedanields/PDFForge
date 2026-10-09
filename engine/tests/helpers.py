"""Shared test helpers: an in-process recording JobContext and a real engine subprocess."""

from __future__ import annotations

import hashlib
import json
import queue
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

from jobs import CancelToken, JobContext

ENGINE_DIR = Path(__file__).resolve().parent.parent


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class RecordingContext(JobContext):
    """JobContext that records events and can cancel itself after N progress events."""

    def __init__(self, temp_dir: Path, cancel_after: int | None = None) -> None:
        self.events: list[dict[str, Any]] = []
        self.token = CancelToken()
        self._cancel_after = cancel_after
        temp_dir.mkdir(parents=True, exist_ok=True)
        super().__init__("test-job", temp_dir, self.token, self._record)

    def _record(self, event: dict[str, Any]) -> None:
        self.events.append(event)
        if self._cancel_after is not None and len(self.events) >= self._cancel_after:
            self.token.cancel()


class EngineProcess:
    """The real engine (``python main.py``) driven over stdin/stdout."""

    def __init__(self, env: dict[str, str]) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, "-u", str(ENGINE_DIR / "main.py")],
            cwd=ENGINE_DIR,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        self.lines: queue.Queue[str] = queue.Queue()
        self.stderr: list[str] = []
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stdout(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.lines.put(line)

    def _pump_stderr(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            self.stderr.append(line)

    def send(self, message: dict[str, Any] | str) -> None:
        assert self.proc.stdin is not None
        line = message if isinstance(message, str) else json.dumps(message)
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def read(self, timeout: float = 10) -> dict[str, Any]:
        line = self.lines.get(timeout=timeout)
        parsed: dict[str, Any] = json.loads(line)  # every stdout line must be valid JSON
        return parsed

    def read_until_final(self, job_id: str, timeout: float = 20) -> list[dict[str, Any]]:
        """All events for ``job_id`` up to and including its done/error event."""
        events: list[dict[str, Any]] = []
        while True:
            event = self.read(timeout)
            if event.get("id") != job_id:
                continue
            events.append(event)
            if event["event"] in ("done", "error"):
                return events

    def close(self) -> int:
        if self.proc.stdin and not self.proc.stdin.closed:
            self.proc.stdin.close()
        try:
            return self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            raise
