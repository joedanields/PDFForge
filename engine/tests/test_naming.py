"""Output naming and atomic never-overwrite commit."""

from __future__ import annotations

from pathlib import Path

import pytest

from protocol import EngineError
from utils.atomic import commit
from utils.naming import candidates, default_output_name, resolve_output, sanitize_stem, unique_path


def test_default_name_pattern() -> None:
    assert default_output_name(Path("C:/docs/report.pdf"), "merge") == "report_merge.pdf"


@pytest.mark.parametrize(
    ("stem", "expected"),
    [("a:b*c", "a_b_c"), ("  name. ", "name"), ("CON", "CON_"), ("", "output"), ("...", "output")],
)
def test_sanitize_stem(stem: str, expected: str) -> None:
    assert sanitize_stem(stem) == expected


def test_resolve_output_precedence(tmp_path: Path) -> None:
    first = tmp_path / "in" / "a.pdf"
    assert resolve_output(None, None, first, "merge") == tmp_path / "in" / "a_merge.pdf"
    assert (
        resolve_output(None, str(tmp_path / "out"), first, "merge")
        == tmp_path / "out" / "a_merge.pdf"
    )
    explicit = str(tmp_path / "x.pdf")
    assert resolve_output(explicit, str(tmp_path / "out"), first, "merge") == Path(explicit)


def test_candidate_sequence() -> None:
    gen = candidates(Path("C:/o/a_merge.pdf"))
    assert [next(gen).name for _ in range(3)] == [
        "a_merge.pdf",
        "a_merge (1).pdf",
        "a_merge (2).pdf",
    ]


def test_unique_path_skips_existing(tmp_path: Path) -> None:
    (tmp_path / "a.pdf").write_bytes(b"1")
    (tmp_path / "a (1).pdf").write_bytes(b"1")
    assert unique_path(tmp_path / "a.pdf") == tmp_path / "a (2).pdf"


def _tmp_file(folder: Path, content: bytes) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    f = folder / "result.pdf"
    f.write_bytes(content)
    return f


def test_commit_never_overwrites(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    desired = out_dir / "a_merge.pdf"
    first = commit(_tmp_file(tmp_path / "t1", b"first"), desired)
    second = commit(_tmp_file(tmp_path / "t2", b"second"), desired)
    assert first.name == "a_merge.pdf"
    assert second.name == "a_merge (1).pdf"
    assert first.read_bytes() == b"first"
    assert second.read_bytes() == b"second"
    assert sorted(p.name for p in out_dir.iterdir()) == ["a_merge (1).pdf", "a_merge.pdf"]


def test_commit_skips_protected_paths(tmp_path: Path) -> None:
    desired = tmp_path / "a.pdf"
    final = commit(_tmp_file(tmp_path / "t", b"x"), desired, protected=[desired])
    assert final.name == "a (1).pdf"


def test_commit_creates_missing_folder(tmp_path: Path) -> None:
    final = commit(_tmp_file(tmp_path / "t", b"x"), tmp_path / "new" / "deeper" / "a.pdf")
    assert final.read_bytes() == b"x"


def test_commit_to_unwritable_location_fails_cleanly(tmp_path: Path) -> None:
    blocker = tmp_path / "file-not-folder"
    blocker.write_bytes(b"")
    src = _tmp_file(tmp_path / "t", b"x")
    with pytest.raises(EngineError) as info:
        commit(src, blocker / "a.pdf")
    assert info.value.code == "INVALID_INPUT"
