"""Headless LibreOffice conversions (docs/03_ARCHITECTURE.md §6, 05 S6).

- Each job gets its own LibreOffice user profile (``-env:UserInstallation``) in its temp
  folder, so parallel jobs never fight over profile locks. The profile is seeded from a cached
  template (``%LOCALAPPDATA%\\PDFForge\\cache``): a brand-new profile costs several seconds of
  first-start work, a copied one does not.
- The profile is preset for untrusted input: macros disabled at the highest security level,
  links never updated, and all internet access sent to a dead local proxy (offline rule).
- LibreOffice works on a copy of the input with a plain ASCII name in the job folder; the
  user's file is never opened for writing and no lock files appear next to it.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any

from jobs import JobContext
from protocol import EngineError, ErrorCode
from utils.paths import temp_root
from utils.process import run_helper
from utils.vendor import require, soffice_path

log = logging.getLogger("pdfforge.libreoffice")

DEFAULT_TIMEOUT_S = 5 * 60
PROFILE_REVISION = "1"

_SCRIPTING = "/org.openoffice.Office.Common/Security/Scripting"
# Conversions need no printer and no GPU. Querying the system's printers made every document
# load wait ~10 s on a machine whose default printer was an unplugged USB printer; with these
# switches a one-page DOCX converts in about a second.
HELPER_ENV = {
    "SAL_DISABLE_PRINTERLIST": "1",
    "SAL_DISABLE_DEFAULTPRINTER": "1",
    "SAL_DISABLE_OPENCL": "1",
    "SAL_DISABLESKIA": "1",
    "SAL_DISABLEGL": "1",
}

_SETTINGS: list[tuple[str, str, str, str]] = [
    # (node path, property, type, value)
    (_SCRIPTING, "MacroSecurityLevel", "int", "3"),
    (_SCRIPTING, "DisableMacrosExecution", "boolean", "true"),
    (_SCRIPTING, "BlockUntrustedRefererLinks", "boolean", "true"),
    ("/org.openoffice.Office.Writer/Content/Update", "Link", "short", "2"),
    ("/org.openoffice.Office.Calc/Content/Update", "Link", "short", "2"),
    ("/org.openoffice.Inet/Settings", "ooInetProxyType", "short", "1"),
    ("/org.openoffice.Inet/Settings", "ooInetHTTPProxyName", "string", "127.0.0.1"),
    ("/org.openoffice.Inet/Settings", "ooInetHTTPProxyPort", "int", "9"),
    ("/org.openoffice.Inet/Settings", "ooInetHTTPSProxyName", "string", "127.0.0.1"),
    ("/org.openoffice.Inet/Settings", "ooInetHTTPSProxyPort", "int", "9"),
    ("/org.openoffice.Inet/Settings", "ooInetFTPProxyName", "string", "127.0.0.1"),
    ("/org.openoffice.Inet/Settings", "ooInetFTPProxyPort", "int", "9"),
    ("/org.openoffice.Inet/Settings", "ooInetNoProxy", "string", ""),
    ("/org.openoffice.Office.Common/Misc", "FirstRun", "boolean", "false"),
    ("/org.openoffice.Office.Common/Misc", "ShowTipOfTheDay", "boolean", "false"),
]


def _registry_xml() -> str:
    items = "\n".join(
        f'<item oor:path="{path}"><prop oor:name="{name}" oor:op="fuse" oor:type="xs:{kind}">'
        f"<value>{value}</value></prop></item>"
        for path, name, kind, value in _SETTINGS
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<oor:items xmlns:oor="http://openoffice.org/2001/registry" '
        'xmlns:xs="http://www.w3.org/2001/XMLSchema" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
        f"{items}\n</oor:items>\n"
    )


def cache_root() -> Path:
    override = os.environ.get("PDFFORGE_CACHE_DIR")
    if override:
        return Path(override)
    base = os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()
    return Path(base) / "PDFForge" / "cache"


def _template_dir() -> Path:
    return cache_root() / f"lo-profile-{PROFILE_REVISION}"


def _prepare_profile() -> Path:
    """A private profile for one LibreOffice run, under a deliberately short path.

    LibreOffice silently fails when its profile path gets long (it nests deep folders inside),
    so profiles live in ``%TEMP%/PDFForge/lo/<8 hex>`` rather than in the job folder.
    """
    profile = temp_root() / "lo" / uuid.uuid4().hex[:8]
    template = _template_dir()
    if template.is_dir():
        try:
            shutil.copytree(template, profile)
        except OSError:
            log.warning("could not copy the LibreOffice profile template", exc_info=True)
            shutil.rmtree(profile, ignore_errors=True)
    user = profile / "user"
    user.mkdir(parents=True, exist_ok=True)
    # Always (re)write our settings: they must win over anything in the template.
    (user / "registrymodifications.xcu").write_text(_registry_xml(), encoding="utf-8")
    return profile


def _save_template(profile: Path) -> None:
    """Keep a successfully used fresh profile as the template for later jobs (best effort)."""
    template = _template_dir()
    if template.exists():
        return
    staging = template.with_name(f"{template.name}.{os.getpid()}.tmp")
    try:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.copytree(profile, staging, ignore=shutil.ignore_patterns("*.lock", ".lock"))
        staging.rename(template)
    except OSError:
        shutil.rmtree(staging, ignore_errors=True)


def _profile_url(profile: Path) -> str:
    return profile.resolve().as_uri()


def filter_spec(target: str, filter_name: str | None, options: dict[str, Any] | None) -> str:
    """``pdf:writer_pdf_Export:{json}`` — LibreOffice's ``--convert-to`` argument."""
    if not filter_name:
        return target
    if not options:
        return f"{target}:{filter_name}"

    def typed(value: Any) -> dict[str, str]:
        if isinstance(value, bool):
            return {"type": "boolean", "value": str(value).lower()}
        if isinstance(value, int):
            return {"type": "long", "value": str(value)}
        return {"type": "string", "value": str(value)}

    spec = {key: typed(value) for key, value in options.items()}
    return f"{target}:{filter_name}:{json.dumps(spec, separators=(',', ':'))}"


def convert(
    source: Path,
    work_dir: Path,
    ctx: JobContext,
    *,
    target: str = "pdf",
    filter_name: str | None = None,
    filter_options: dict[str, Any] | None = None,
    infilter: str | None = None,
    shown: Path | None = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> Path:
    """Convert ``source`` with LibreOffice; returns the produced file in ``work_dir``.

    ``source`` should already be a private copy (see ``private_copy``); ``shown`` is the file
    the user picked, for error messages.
    """
    soffice = require(soffice_path(), "LibreOffice")
    shown = shown or source
    profile_fresh = not _template_dir().is_dir()
    profile = _prepare_profile()
    try:
        return _run(
            soffice,
            profile,
            source,
            work_dir,
            ctx,
            target,
            filter_name,
            filter_options,
            infilter,
            shown,
            timeout_s,
            profile_fresh,
        )
    finally:
        shutil.rmtree(profile, ignore_errors=True)


def _run(
    soffice: Path,
    profile: Path,
    source: Path,
    work_dir: Path,
    ctx: JobContext,
    target: str,
    filter_name: str | None,
    filter_options: dict[str, Any] | None,
    infilter: str | None,
    shown: Path,
    timeout_s: float,
    profile_fresh: bool,
) -> Path:
    out_dir = work_dir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    args: list[str | Path] = [
        soffice,
        "--headless",
        "--invisible",
        "--norestore",
        "--nolockcheck",
        "--nologo",
        "--nodefault",
        f"-env:UserInstallation={_profile_url(profile)}",
    ]
    if infilter:
        args.append(f"--infilter={infilter}")
    args += ["--convert-to", filter_spec(target, filter_name, filter_options)]
    args += ["--outdir", out_dir, source]
    result = run_helper(
        args, ctx, timeout_s=timeout_s, what="LibreOffice", cwd=work_dir, env=HELPER_ENV
    )
    produced = out_dir / f"{source.stem}.{target}"
    if result.returncode != 0 or not produced.is_file() or produced.stat().st_size == 0:
        log.warning(
            "LibreOffice failed (exit %s): %s %s",
            result.returncode,
            result.stdout.strip()[-500:],
            result.stderr.strip()[-500:],
        )
        raise EngineError(
            ErrorCode.CORRUPT_FILE,
            f"{shown.name} could not be converted. It may be damaged or in an unsupported format.",
            str(shown),
        )
    if profile_fresh:
        _save_template(profile)
    return produced


def private_copy(path: Path, work_dir: Path, name: str = "input") -> Path:
    """Copy the user's file into the job folder under a plain name (keeps the extension)."""
    work_dir.mkdir(parents=True, exist_ok=True)
    dest = work_dir / f"{name}{path.suffix.lower()}"
    shutil.copyfile(path, dest)
    return dest
