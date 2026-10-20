"""Workflows (docs/02 §G): run a saved chain of tools on the input files in one job.

Every step reads the previous step's results from the job's temp folder; only the last step's
files are delivered, as ``{original}_{workflow name}{ext}`` (several files from one original go
into a folder of that name). Per-file steps run once per file; "combining" steps (Merge,
Image → PDF) take all files at once. A step that has nothing to do (Compress that can't gain,
OCR on pages that already have text) passes its file on unchanged.
"""

from __future__ import annotations

import shutil
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode
from tools import TOOLS
from utils.atomic import commit
from utils.naming import sanitize_stem
from utils.validation import optional_str, options_dict, passwords_map, require_str_list

MAX_STEPS = 20
MAX_INPUTS = 500


@dataclass(frozen=True)
class StepKind:
    accepts: str  # "pdf" or "source" (the tool's own input formats; first step only)
    produces: str  # "pdf" or "other" (last step only)
    combines: bool = False


STEP_KINDS: dict[str, StepKind] = {
    "merge": StepKind("pdf", "pdf", combines=True),
    "image-to-pdf": StepKind("source", "pdf", combines=True),
    "word-to-pdf": StepKind("source", "pdf"),
    "powerpoint-to-pdf": StepKind("source", "pdf"),
    "excel-to-pdf": StepKind("source", "pdf"),
    "text-to-pdf": StepKind("source", "pdf"),
    "html-to-pdf": StepKind("source", "pdf"),
    "rotate": StepKind("pdf", "pdf"),
    "remove-pages": StepKind("pdf", "pdf"),
    "extract-pages": StepKind("pdf", "pdf"),
    "split": StepKind("pdf", "pdf"),
    "compress": StepKind("pdf", "pdf"),
    "repair": StepKind("pdf", "pdf"),
    "ocr": StepKind("pdf", "pdf"),
    "pdf-to-pdfa": StepKind("pdf", "pdf"),
    "page-numbers": StepKind("pdf", "pdf"),
    "watermark": StepKind("pdf", "pdf"),
    "protect": StepKind("pdf", "pdf"),
    "unlock": StepKind("pdf", "pdf"),
    "pdf-to-image": StepKind("pdf", "other"),
    "pdf-to-word": StepKind("pdf", "other"),
    "pdf-to-powerpoint": StepKind("pdf", "other"),
    "pdf-to-excel": StepKind("pdf", "other"),
    "pdf-to-text": StepKind("pdf", "other"),
}


@dataclass(frozen=True)
class Step:
    tool: str
    options: dict[str, Any]
    secrets: dict[str, Any]


@dataclass(frozen=True)
class Item:
    """A file between steps: where it is, which original it came from, its open password."""

    path: Path
    origin: Path
    password: str


def parse_steps(params: dict[str, Any]) -> list[Step]:
    options = options_dict(params)
    raw = options.get("steps")
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_STEPS:
        raise EngineError(
            ErrorCode.INVALID_INPUT, f"A workflow needs between 1 and {MAX_STEPS} steps"
        )
    bag = params.get("secrets", {})
    step_secrets = bag.get("steps", []) if isinstance(bag, dict) else []
    if not isinstance(step_secrets, list):
        raise EngineError(ErrorCode.INVALID_INPUT, "'secrets.steps' must be a list")
    steps: list[Step] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict) or not isinstance(entry.get("tool"), str):
            raise EngineError(ErrorCode.INVALID_INPUT, f"Step {index + 1} is not valid")
        tool = entry["tool"]
        if tool not in STEP_KINDS:
            raise EngineError(
                ErrorCode.UNSUPPORTED, f"Step {index + 1}: '{tool}' can't be used in a workflow"
            )
        step_options = entry.get("options", {})
        if not isinstance(step_options, dict):
            raise EngineError(
                ErrorCode.INVALID_INPUT, f"Step {index + 1}: options must be an object"
            )
        secret = step_secrets[index] if index < len(step_secrets) else None
        steps.append(Step(tool, step_options, secret if isinstance(secret, dict) else {}))
    check_chain([s.tool for s in steps])
    return steps


def check_chain(tools: list[str]) -> None:
    """Every step after the first must take PDFs; every step before the last must make PDFs."""
    for index, tool in enumerate(tools):
        kind = STEP_KINDS[tool]
        if index > 0 and kind.accepts != "pdf":
            raise EngineError(
                ErrorCode.INVALID_INPUT, f"Step {index + 1} ({tool}) can only be the first step"
            )
        if index < len(tools) - 1 and kind.produces != "pdf":
            raise EngineError(
                ErrorCode.INVALID_INPUT, f"Step {index + 1} ({tool}) can only be the last step"
            )


def workflow(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    steps = parse_steps(params)
    name = optional_str(options_dict(params), "name") or "workflow"
    inputs = [Path(p) for p in require_str_list(params, "inputs", min_len=1, max_len=MAX_INPUTS)]
    passwords = passwords_map(params)
    items = [Item(p, p, passwords.get(str(p), "")) for p in inputs]

    span = 95 / len(steps)
    for index, step in enumerate(steps):
        ctx.check_cancelled()
        label = f"Step {index + 1} of {len(steps)}"
        run = _runner(TOOLS[step.tool], step, ctx, index, label, index * span, (index + 1) * span)
        if STEP_KINDS[step.tool].combines and len(items) > 1:
            items = run(items, 0, 1)
        elif STEP_KINDS[step.tool].combines and step.tool == "merge":
            continue  # merging one file changes nothing
        else:
            items = [out for j, item in enumerate(items) for out in run([item], j, len(items))]
        if not items:
            raise EngineError(ErrorCode.INTERNAL, f"{label} produced no files")

    ctx.progress(96, "Saving")
    outputs, extra = _deliver(items, params, name, inputs, ctx)
    ctx.progress(100, "Done")
    return ToolResult(outputs, {"steps": len(steps), "files": len(outputs), **extra})


def _runner(
    tool: Callable[[dict[str, Any], JobContext], ToolResult],
    step: Step,
    ctx: JobContext,
    index: int,
    label: str,
    start: float,
    end: float,
) -> Callable[[list[Item], int, int], list[Item]]:
    """Run ``step`` on some items (call ``part`` of ``parts`` of this step)."""

    def run(items: list[Item], part: int, parts: int) -> list[Item]:
        base = ctx.temp_dir / f"step{index + 1:02d}-{part:04d}"
        out_dir, scratch = base / "out", base / "tmp"
        out_dir.mkdir(parents=True)
        scratch.mkdir()
        width = (end - start) / parts
        sub = ctx.scoped(scratch, start + part * width, start + (part + 1) * width, label)
        result = tool(
            {
                "inputs": [str(i.path) for i in items],
                "passwords": {str(i.path): i.password for i in items if i.password},
                "options": step.options,
                "secrets": step.secrets,
                "output_dir": str(out_dir),
            },
            sub,
        )
        if not result.outputs:
            return items  # nothing to do for this file: pass it on unchanged
        password = _password_after(step, items[0].password)
        return [Item(p, items[0].origin, password) for p in result.outputs if p.is_file()]

    return run


def _password_after(step: Step, before: str) -> str:
    if step.tool == "unlock":
        return ""
    if step.tool == "protect":
        user = step.secrets.get("user_password")
        return user if isinstance(user, str) else ""
    return before


def _owned(item: Item, ctx: JobContext) -> Item:
    """Delivery moves files: a file no step changed may still be the user's own input, so
    deliver a copy of it instead."""
    if item.path.is_relative_to(ctx.temp_dir):
        return item
    copy = ctx.temp_dir / "__unchanged__" / uuid.uuid4().hex
    copy.mkdir(parents=True)
    target = copy / item.path.name
    shutil.copy2(item.path, target)
    return Item(target, item.origin, item.password)


def _deliver(
    items: list[Item], params: dict[str, Any], name: str, inputs: list[Path], ctx: JobContext
) -> tuple[list[Path], dict[str, Any]]:
    out_dir = optional_str(params, "output_dir")
    tag = sanitize_stem(name)
    groups: dict[Path, list[Item]] = {}
    for item in items:
        groups.setdefault(item.origin, []).append(item)
    outputs: list[Path] = []
    folders: list[Path] = []
    for origin, group in groups.items():
        ctx.check_cancelled()
        group = [_owned(item, ctx) for item in group]
        parent = Path(out_dir) if out_dir else origin.parent
        stem = f"{sanitize_stem(origin.stem)}_{tag}"
        if len(group) == 1:
            only = group[0].path
            outputs.append(commit(only, parent / f"{stem}{only.suffix}", protected=inputs))
            continue
        bundle = ctx.temp_dir / "__bundle__" / stem
        bundle.mkdir(parents=True)
        for item in group:
            target = bundle / item.path.name
            n = 1
            while target.exists():
                target = bundle / f"{item.path.stem} ({n}){item.path.suffix}"
                n += 1
            shutil.move(str(item.path), str(target))
        final_dir = commit(bundle, parent / stem, protected=inputs)
        folders.append(final_dir)
        outputs.extend(sorted(p for p in final_dir.iterdir() if p.is_file()))
    extra: dict[str, Any] = (
        {"folder": str(folders[0])} if len(folders) == 1 and len(groups) == 1 else {}
    )
    return outputs, extra
