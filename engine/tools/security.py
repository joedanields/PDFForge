"""PDF security (docs/02_FEATURES.md §F). Phase 1: Protect (F1) and Unlock (F2).

Passwords arrive in ``params.secrets`` (new passwords) and ``params.passwords`` (passwords of
input files); both are never logged or stored (docs/05 S4). Unlock never guesses passwords
(S9): a file with an open password needs the correct one.
"""

from __future__ import annotations

import secrets
from typing import Any

import pikepdf

from jobs import JobContext, ToolResult
from protocol import EngineError, ErrorCode
from utils.pdfio import deliver_pdf, open_pdf, save_pdf, single_pdf_input
from utils.validation import option_bool, option_choice, options_dict, passwords_map

MAX_PASSWORD = 127  # PDF 2.0 limit for AES-256 passwords (UTF-8 bytes)


def _secret(params: dict[str, Any], key: str) -> str:
    bag = params.get("secrets", {})
    if not isinstance(bag, dict):
        raise EngineError(ErrorCode.INVALID_INPUT, "'secrets' must be an object")
    value = bag.get(key, "")
    if not isinstance(value, str):
        raise EngineError(ErrorCode.INVALID_INPUT, "Passwords must be text")
    if len(value.encode("utf-8")) > MAX_PASSWORD:
        raise EngineError(ErrorCode.INVALID_INPUT, "Passwords can be at most 127 bytes long")
    return value


def protect(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    source = single_pdf_input(params)
    options = options_dict(params)
    user = _secret(params, "user_password")
    owner = _secret(params, "owner_password")
    if not user and not owner:
        raise EngineError(
            ErrorCode.INVALID_INPUT,
            "Set a password to open the file, a permissions password, or both",
        )
    if user and owner and user == owner:
        raise EngineError(
            ErrorCode.INVALID_INPUT,
            "Use different passwords for opening the file and for changing permissions",
        )
    method = option_choice(options, "encryption", ("aes256", "aes128"), "aes256")
    allow_print = option_choice(options, "allow_print", ("none", "low", "high"), "high")
    permissions = pikepdf.Permissions(
        accessibility=True,  # screen readers may always extract text
        extract=option_bool(options, "allow_copy", True),
        modify_annotation=option_bool(options, "allow_annotate", True),
        modify_assembly=option_bool(options, "allow_edit", True),
        modify_form=option_bool(options, "allow_forms", True),
        modify_other=option_bool(options, "allow_edit", True),
        print_lowres=allow_print in ("low", "high"),
        print_highres=allow_print == "high",
    )
    # Without a permissions password the restrictions are enforced by a random owner password
    # nobody knows; with the same password for both, anyone who can open could lift them.
    owner_password = owner or secrets.token_urlsafe(32)
    encryption = pikepdf.Encryption(
        user=user,
        owner=owner_password,
        R=6 if method == "aes256" else 4,
        aes=True,
        allow=permissions,
    )
    tmp = ctx.temp_dir / "protected.pdf"
    with open_pdf(source, passwords_map(params)) as pdf:
        ctx.progress(20, "Encrypting")
        save_pdf(pdf, tmp, ctx, start=30, message="Encrypting", encryption=encryption)
        pages = len(pdf.pages)
    ctx.check_cancelled()
    final = deliver_pdf(tmp, params, source, "protect", protected=[source])
    restricted = not all(
        getattr(permissions, name)
        for name in (
            "extract",
            "modify_annotation",
            "modify_form",
            "modify_other",
            "print_highres",
        )
    )
    return ToolResult(
        [final],
        {
            "pages": pages,
            "encryption": method,
            "open_password": bool(user),
            "restricted": restricted,
            "bytes": final.stat().st_size,
        },
    )


def unlock(params: dict[str, Any], ctx: JobContext) -> ToolResult:
    """Remove the open password (the correct one must be supplied — no guessing, docs/05 S9)
    and/or owner restrictions from a PDF."""
    source = single_pdf_input(params)
    passwords = passwords_map(params)
    tmp = ctx.temp_dir / "unlocked.pdf"
    with open_pdf(source, passwords) as pdf:
        if not pdf.is_encrypted:
            raise EngineError(
                ErrorCode.INVALID_INPUT,
                f"{source.name} has no password or restrictions to remove",
                str(source),
            )
        had_open_password = bool(pdf.encryption.user_password)
        allow = pdf.allow
        had_restrictions = not all(
            (
                allow.extract,
                allow.modify_annotation,
                allow.modify_form,
                allow.modify_other,
                allow.modify_assembly,
                allow.print_highres,
            )
        )
        ctx.progress(20, "Removing protection")
        save_pdf(pdf, tmp, ctx, start=30, message="Removing protection", encryption=False)
        pages = len(pdf.pages)
    ctx.check_cancelled()
    final = deliver_pdf(tmp, params, source, "unlock", protected=[source])
    return ToolResult(
        [final],
        {
            "pages": pages,
            "removed_open_password": had_open_password,
            "removed_restrictions": had_restrictions,
            "bytes": final.stat().st_size,
        },
    )
