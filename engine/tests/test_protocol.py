"""IPC contract tests (docs/07_TESTING.md §1): request/progress/result/error/cancel."""

from __future__ import annotations

import socket
from pathlib import Path

import pytest

from protocol import (
    ENGINE_VERSION,
    PROTOCOL_VERSION,
    ErrorCode,
    ProtocolError,
    encode,
    error_event,
    parse_request,
)
from tests.fixtures import make_text_pdf
from tests.helpers import EngineProcess
from utils.netguard import NetworkBlockedError

# --- parsing ---------------------------------------------------------------------------------


def test_parse_valid_request() -> None:
    req = parse_request('{"id":"j1","method":"merge","params":{"inputs":[]}}')
    assert (req.id, req.method, req.params) == ("j1", "merge", {"inputs": []})


def test_parse_defaults_params() -> None:
    assert parse_request('{"id":"j1","method":"hello"}').params == {}


@pytest.mark.parametrize(
    ("line", "request_id"),
    [
        ("not json", None),
        ("[1,2]", None),
        ('{"method":"merge"}', None),
        ('{"id":"","method":"merge"}', None),
        ('{"id":"j1"}', "j1"),
        ('{"id":"j1","method":"merge","params":[]}', "j1"),
    ],
)
def test_parse_invalid_request(line: str, request_id: str | None) -> None:
    with pytest.raises(ProtocolError) as info:
        parse_request(line)
    assert info.value.request_id == request_id


def test_encode_is_single_line() -> None:
    line = encode(error_event("j1", ErrorCode.INTERNAL, "multi\nline"))
    assert "\n" not in line


def test_error_codes_match_spec() -> None:
    assert {c.value for c in ErrorCode} == {
        "INVALID_INPUT",
        "PASSWORD_REQUIRED",
        "WRONG_PASSWORD",
        "CORRUPT_FILE",
        "UNSUPPORTED",
        "DISK_FULL",
        "TIMEOUT",
        "CANCELLED",
        "INTERNAL",
    }


# --- live engine -----------------------------------------------------------------------------


def test_hello_handshake(engine: EngineProcess) -> None:
    engine.send({"id": "h1", "method": "hello"})
    event = engine.read()
    assert event == {
        "id": "h1",
        "event": "hello",
        "engine_version": ENGINE_VERSION,
        "protocol_version": PROTOCOL_VERSION,
        "methods": ["hello", "cancel", "echo", "merge"],
    }


def test_echo_progress_then_done(engine: EngineProcess) -> None:
    engine.send(
        {"id": "e1", "method": "echo", "params": {"message": "hi", "steps": 3, "delay_ms": 1}}
    )
    events = engine.read_until_final("e1")
    progress = [e for e in events if e["event"] == "progress"]
    assert [e["percent"] for e in progress] == [33, 66, 100]
    assert progress[0]["message"] == "Step 1 of 3"
    done = events[-1]
    assert done["event"] == "done"
    assert done["outputs"] == []
    assert done["stats"]["echo"] == "hi"
    assert isinstance(done["stats"]["ms"], int)


def test_malformed_line_reports_error_and_engine_survives(engine: EngineProcess) -> None:
    engine.send("{oops")
    event = engine.read()
    assert event["event"] == "error"
    assert event["id"] is None
    assert event["code"] == "INVALID_INPUT"
    engine.send({"id": "h2", "method": "hello"})
    assert engine.read()["event"] == "hello"


def test_leading_utf8_bom_is_tolerated(engine: EngineProcess) -> None:
    assert engine.proc.stdin is not None
    bom = chr(0xFEFF)
    engine.proc.stdin.write(bom + '{"id":"bom","method":"hello"}' + chr(10))
    engine.proc.stdin.flush()
    assert engine.read()["event"] == "hello"


def test_unknown_method_is_unsupported(engine: EngineProcess) -> None:
    engine.send({"id": "u1", "method": "teleport"})
    event = engine.read()
    assert (event["id"], event["event"], event["code"]) == ("u1", "error", "UNSUPPORTED")


def test_duplicate_running_id_rejected(engine: EngineProcess) -> None:
    engine.send({"id": "d1", "method": "echo", "params": {"steps": 20, "delay_ms": 50}})
    engine.send({"id": "d1", "method": "echo", "params": {"steps": 1}})
    event = engine.read()
    while event["event"] == "progress":
        event = engine.read()
    assert (event["id"], event["code"]) == ("d1", "INVALID_INPUT")
    engine.send({"id": "d1", "method": "cancel"})


def test_cancel_running_job(engine: EngineProcess) -> None:
    engine.send({"id": "c1", "method": "echo", "params": {"steps": 200, "delay_ms": 20}})
    first = engine.read()
    assert first["event"] == "progress"
    engine.send({"id": "c1", "method": "cancel"})
    events = engine.read_until_final("c1")
    assert events[-1]["event"] == "error"
    assert events[-1]["code"] == "CANCELLED"
    assert not any(e["event"] == "done" for e in events)


def test_cancel_unknown_id_is_ignored(engine: EngineProcess) -> None:
    engine.send({"id": "nope", "method": "cancel"})
    engine.send({"id": "h3", "method": "hello"})
    assert engine.read()["id"] == "h3"


def test_timeout(engine: EngineProcess) -> None:
    engine.send(
        {"id": "t1", "method": "echo", "params": {"steps": 100, "delay_ms": 50, "timeout_s": 0.2}}
    )
    events = engine.read_until_final("t1")
    assert events[-1]["code"] == "TIMEOUT"


def test_tool_error_code_is_forwarded(engine: EngineProcess) -> None:
    engine.send({"id": "f1", "method": "echo", "params": {"steps": 0, "fail": "CORRUPT_FILE"}})
    event = engine.read_until_final("f1")[-1]
    assert (event["event"], event["code"]) == ("error", "CORRUPT_FILE")


def test_invalid_params_are_invalid_input(engine: EngineProcess) -> None:
    engine.send({"id": "p1", "method": "echo", "params": {"steps": "many"}})
    assert engine.read_until_final("p1")[-1]["code"] == "INVALID_INPUT"


def test_concurrent_jobs_are_independent(engine: EngineProcess) -> None:
    for n in range(3):
        engine.send({"id": f"m{n}", "method": "echo", "params": {"steps": 3, "delay_ms": 5}})
    finals: dict[str, str] = {}
    while len(finals) < 3:
        event = engine.read()
        if event["event"] in ("done", "error"):
            finals[event["id"]] = event["event"]
    assert finals == {"m0": "done", "m1": "done", "m2": "done"}


def test_merge_over_the_wire(engine: EngineProcess, tmp_path: Path) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 2)
    b = make_text_pdf(tmp_path / "b.pdf", 3)
    engine.send({"id": "mg1", "method": "merge", "params": {"inputs": [str(a), str(b)]}})
    done = engine.read_until_final("mg1")[-1]
    assert done["event"] == "done", done
    assert done["outputs"] == [str(tmp_path / "a_merge.pdf")]
    assert done["stats"]["pages"] == 5


def test_eof_shuts_down_cleanly(engine: EngineProcess, temp_root: Path) -> None:
    engine.send({"id": "s1", "method": "echo", "params": {"steps": 500, "delay_ms": 20}})
    engine.read()  # first progress: job is running
    assert engine.close() == 0
    leftovers = list(temp_root.iterdir()) if temp_root.exists() else []
    assert leftovers == []


def test_crash_hook_exits_nonzero(engine: EngineProcess) -> None:
    engine.send({"id": "x1", "method": "echo", "params": {"crash": True}})
    assert engine.proc.wait(timeout=10) == 70


def test_startup_sweeps_stale_temp(temp_root: Path) -> None:
    stale = temp_root / "old-job"
    stale.mkdir(parents=True)
    (stale / "half.pdf").write_bytes(b"x")
    import os

    proc = EngineProcess({**os.environ, "PDFFORGE_TEMP_ROOT": str(temp_root)})
    proc.send({"id": "h", "method": "hello"})
    proc.read()
    assert not stale.exists()
    assert proc.close() == 0


# --- network guard (G2) -----------------------------------------------------------------------


def test_outbound_network_is_blocked() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s, pytest.raises(NetworkBlockedError):
        s.connect(("93.184.216.34", 80))
    with pytest.raises(NetworkBlockedError):
        socket.getaddrinfo("example.com", 443)


def test_loopback_still_works() -> None:
    a, b = socket.socketpair()
    with a, b:
        a.sendall(b"ok")
        assert b.recv(2) == b"ok"
