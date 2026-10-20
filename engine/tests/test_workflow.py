"""Workflows (docs/02 §G): a chain of tools run in one job."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest

from protocol import EngineError, ErrorCode
from tests.fixtures import make_encrypted_pdf, make_text_pdf
from tests.helpers import RecordingContext, sha256
from tools.workflow import STEP_KINDS, check_chain, workflow


def step(tool: str, **options: Any) -> dict[str, Any]:
    return {"tool": tool, "options": options}


def run(
    ctx: RecordingContext, inputs: list[Path], steps: list[dict[str, Any]], **params: Any
) -> Any:
    return workflow(
        {
            "inputs": [str(p) for p in inputs],
            "options": {"name": params.pop("name", "Tidy"), "steps": steps},
            **params,
        },
        ctx,
    )


def text_of(path: Path, password: str = "") -> list[str]:
    doc = pdfium.PdfDocument(str(path), password=password or None)
    try:
        return [str(page.get_textpage().get_text_range()) for page in doc]
    finally:
        doc.close()


def test_merge_number_protect_gives_one_protected_file(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 2)
    b = make_text_pdf(tmp_path / "b.pdf", 1)
    before = sha256(a), sha256(b)
    result = run(
        ctx,
        [a, b],
        [
            step("merge"),
            step("page-numbers", position="bottom-center", format="n"),
            step("protect"),
        ],
        secrets={"steps": [None, None, {"user_password": "s3cret!"}]},
        name="Board pack",
    )
    [out] = result.outputs
    assert out == tmp_path / "a_Board pack.pdf"
    assert (sha256(a), sha256(b)) == before
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(out)
    pages = text_of(out, "s3cret!")
    assert len(pages) == 3
    assert "a page 1" in pages[0] and "b page 1" in pages[2]
    assert pages[2].strip().endswith("3")
    assert result.stats["steps"] == 3
    messages = [e["message"] for e in ctx.events if e["event"] == "progress"]
    assert any(m.startswith("Step 2 of 3") for m in messages)
    assert [e["percent"] for e in ctx.events] == sorted(e["percent"] for e in ctx.events)


def test_per_file_steps_keep_files_apart(tmp_path: Path, ctx: RecordingContext) -> None:
    a = make_text_pdf(tmp_path / "a.pdf", 1)
    b = make_text_pdf(tmp_path / "b.pdf", 2)
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    result = run(
        ctx,
        [a, b],
        [step("rotate", angle=90, pages="all"), step("watermark", kind="text", text="DRAFT")],
        output_dir=str(out_dir),
    )
    assert sorted(p.name for p in result.outputs) == ["a_Tidy.pdf", "b_Tidy.pdf"]
    with pikepdf.open(out_dir / "b_Tidy.pdf") as pdf:
        assert [int(p.obj.get("/Rotate", 0)) for p in pdf.pages] == [90, 90]
    assert "DRAFT" in text_of(out_dir / "a_Tidy.pdf")[0]


def test_split_makes_a_folder_and_later_steps_run_on_each_part(
    tmp_path: Path, ctx: RecordingContext
) -> None:
    src = make_text_pdf(tmp_path / "book.pdf", 3)
    result = run(ctx, [src], [step("split", mode="fixed", every=1), step("compress")])
    folder = tmp_path / "book_Tidy"
    assert result.stats["folder"] == str(folder)
    assert len(result.outputs) == 3
    assert all(p.parent == folder for p in result.outputs)


def test_step_with_nothing_to_do_passes_the_file_on(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "small.pdf", 1)
    before = sha256(src)
    result = run(ctx, [src], [step("compress")])  # nothing to gain on a tiny text PDF
    [out] = result.outputs
    assert out.name == "small_Tidy.pdf"
    assert src.is_file() and sha256(src) == before  # the original was copied, not moved


def test_password_of_the_input_is_carried_through(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_encrypted_pdf(tmp_path / "locked.pdf", 2, "pw")
    result = run(
        ctx,
        [src],
        [step("page-numbers"), step("unlock"), step("pdf-to-text")],
        passwords={str(src): "pw"},
    )
    [out] = result.outputs
    assert out.suffix == ".txt"
    assert "locked page 2" in out.read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("tools", "message"),
    [
        (["pdf-to-word", "compress"], "can only be the last step"),
        (["compress", "word-to-pdf"], "can only be the first step"),
        (["compress", "image-to-pdf"], "can only be the first step"),
    ],
)
def test_chain_rules(tools: list[str], message: str) -> None:
    with pytest.raises(EngineError) as info:
        check_chain(tools)
    assert info.value.code == ErrorCode.INVALID_INPUT
    assert message in info.value.message


def test_tools_that_need_the_editor_are_refused(tmp_path: Path, ctx: RecordingContext) -> None:
    src = make_text_pdf(tmp_path / "a.pdf", 1)
    for tool in ("redact", "sign", "organize", "workflow"):
        assert tool not in STEP_KINDS
        with pytest.raises(EngineError) as info:
            run(ctx, [src], [step(tool)])
        assert info.value.code == ErrorCode.UNSUPPORTED
    with pytest.raises(EngineError):
        run(ctx, [src], [])
