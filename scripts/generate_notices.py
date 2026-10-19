"""Generate THIRD_PARTY_NOTICES.txt from what PDFForge actually ships.

    cd engine
    uv run python ../scripts/generate_notices.py

Sources (run after scripts/build-engine.ps1 so the frozen engine's analysis exists):
- Engine: Python distributions whose modules PyInstaller bundled (engine/build/engine/
  Analysis-00.toc), the Python runtime and the PyInstaller bootloader. Licence texts come from
  each distribution's own licence files (which include the native libraries they bundle).
- UI: production npm dependencies (`pnpm licenses list --prod --json`), incl. the Inter font.
- Shell: Rust crates linked into the app for Windows x64 (`cargo metadata`, normal
  dependencies only — build scripts and dev tools are not shipped).
- Bundled programs: LibreOffice (its own license.txt) and Tesseract with the libraries inside
  its Windows build (texts in third_party/licenses/tesseract-runtime, fetched once by
  scripts/fetch_runtime_licenses.py) — run scripts/fetch-vendor.ps1 first.
- Installer: NSIS stub and the embedded WebView2 bootstrapper.
Identical licence texts are printed once, followed by every component that uses them.
"""

from __future__ import annotations

import hashlib
import importlib.metadata as md
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "THIRD_PARTY_NOTICES.txt"
LICENSE_NAME = re.compile(r"^(licen[cs]e|copying|notice|unlicense)", re.IGNORECASE)
OWN_MODULES = {"main", "jobs", "protocol", "worker", "tools", "utils"}


@dataclass
class Component:
    name: str
    version: str
    license: str
    part: str  # "engine" | "ui" | "shell" | "vendor" | "installer"
    texts: list[tuple[str, str]] = field(default_factory=list)  # (title, text)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").strip()


def run(cmd: list[str], cwd: Path) -> str:
    exe = shutil.which(cmd[0]) or cmd[0]
    return subprocess.run(
        [exe, *cmd[1:]],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout


# ── engine ────────────────────────────────────────────────────────────────────────────────────


def bundled_python_modules() -> set[str]:
    toc = ROOT / "engine" / "build" / "engine" / "Analysis-00.toc"
    if not toc.exists():
        sys.exit("Run scripts/build-engine.ps1 first (needs engine/build/engine/Analysis-00.toc)")
    names = re.findall(r"\('([A-Za-z_][\w.]*)',\s*'", read(toc))
    return {n.split(".")[0] for n in names}


def python_components() -> list[Component]:
    top_levels = bundled_python_modules() - OWN_MODULES
    by_module = md.packages_distributions()
    dists: set[str] = set()
    for module in top_levels:
        dists.update(by_module.get(module, []))
    components: list[Component] = []
    for name in sorted(dists, key=str.lower):
        dist = md.distribution(name)
        meta = dist.metadata
        classifiers = [
            c.split("::")[-1].strip()
            for c in meta.get_all("Classifier") or []
            if c.startswith("License ::")
        ]
        declared = meta.get("License-Expression") or (meta.get("License") or "").strip()
        if not declared or "\n" in declared or len(declared) > 60:
            declared = classifiers[0] if classifiers else "see licence text"
        extra = [c for c in classifiers if "GPL" in c and c not in declared]
        license_name = declared + (f" (bundles {extra[0]} components)" if extra else "")
        texts = []
        for f in dist.files or []:
            path = Path(str(f))
            in_licenses = ".dist-info" in str(f) and (
                "licenses" in path.parts or LICENSE_NAME.match(path.name)
            )
            if in_licenses and path.suffix.lower() in ("", ".txt", ".md", ".rst"):
                located = Path(str(dist.locate_file(f)))
                if located.is_file():
                    texts.append((f"{dist.metadata['Name']}: {path.name}", read(located)))
        components.append(Component(meta["Name"], dist.version, license_name, "engine", texts))

    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    components.append(
        Component(
            "Python runtime (incl. OpenSSL, libffi, zlib, bzip2, xz, expat)",
            sys.version.split()[0],
            "PSF-2.0 (+ bundled library licences)",
            "engine",
            [("Python", read(python_license))] if python_license.exists() else [],
        )
    )
    try:
        pyi = md.distribution("pyinstaller")
        copying = next(
            Path(str(pyi.locate_file(f))) for f in pyi.files or [] if "COPYING" in str(f)
        )
        components.append(
            Component(
                "PyInstaller bootloader",
                pyi.version,
                "GPL-2.0-or-later WITH Bootloader-exception",
                "engine",
                [("PyInstaller", read(copying))],
            )
        )
    except (md.PackageNotFoundError, StopIteration):
        pass
    components.append(
        Component(
            "Microsoft Visual C++ / Universal C Runtime DLLs",
            "",
            "Microsoft redistributable (Visual Studio redistribution terms)",
            "engine",
        )
    )
    return components


# ── ui ────────────────────────────────────────────────────────────────────────────────────────


def bundled_npm_packages() -> set[str]:
    """npm packages that end up in the WebView bundle (from a sourcemapped production build)."""
    out_dir = ROOT / "app" / "node_modules" / ".cache" / "notices-build"
    run(
        [
            "pnpm",
            "exec",
            "vite",
            "build",
            "--sourcemap",
            "--outDir",
            str(out_dir),
            "--emptyOutDir",
        ],
        ROOT / "app",
    )
    names: set[str] = set()
    pattern = re.compile(r"node_modules/((?:@[^/]+/)?[^/]+)/")
    for map_file in out_dir.rglob("*.map"):
        for source in json.loads(map_file.read_text(encoding="utf-8")).get("sources", []):
            matches = pattern.findall(source.replace("\\", "/"))
            if matches:
                names.add(matches[-1])
    if any(out_dir.rglob("inter-*.woff2")):
        names.add("@fontsource-variable/inter")  # font files are copied as assets
    shutil.rmtree(out_dir, ignore_errors=True)
    return names


def npm_components() -> list[Component]:
    shipped = bundled_npm_packages()
    data = json.loads(run(["pnpm", "licenses", "list", "--prod", "--json"], ROOT / "app"))
    components: list[Component] = []
    for license_name, packages in data.items():
        for pkg in packages:
            if pkg["name"] not in shipped:
                continue  # e.g. pdf.js's optional Node canvas: never in the WebView bundle
            for version, path in zip(pkg["versions"], pkg["paths"], strict=False):
                folder = Path(path)
                app = ROOT / "app"
                if not folder.is_dir() and folder.is_relative_to(app):
                    # pnpm 10 prints "<app>/<store entry>/..." without "node_modules/.pnpm".
                    folder = app / "node_modules" / ".pnpm" / folder.relative_to(app)
                texts = (
                    [
                        (f"{pkg['name']}: {f.name}", read(f))
                        for f in sorted(folder.iterdir())
                        if f.is_file() and LICENSE_NAME.match(f.name)
                    ]
                    if folder.is_dir()
                    else []
                )
                components.append(Component(pkg["name"], version, license_name, "ui", texts))
    return components


# ── shell ─────────────────────────────────────────────────────────────────────────────────────


def rust_components() -> list[Component]:
    meta = json.loads(
        run(
            [
                "cargo",
                "metadata",
                "--format-version",
                "1",
                "--filter-platform",
                "x86_64-pc-windows-msvc",
            ],
            ROOT / "app" / "src-tauri",
        )
    )
    packages = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    root = meta["resolve"]["root"]
    shipped: set[str] = set()
    pending = [root]
    while pending:
        current = pending.pop()
        for dep in nodes[current]["deps"]:
            normal = any(k.get("kind") is None for k in dep["dep_kinds"])
            if normal and dep["pkg"] not in shipped:
                shipped.add(dep["pkg"])
                pending.append(dep["pkg"])
    components: list[Component] = []
    for pkg_id in sorted(shipped, key=lambda i: packages[i]["name"]):
        pkg = packages[pkg_id]
        folder = Path(pkg["manifest_path"]).parent
        texts = [
            (f"{pkg['name']}: {f.name}", read(f))
            for f in sorted(folder.iterdir())
            if f.is_file() and LICENSE_NAME.match(f.name)
        ]
        components.append(
            Component(
                pkg["name"],
                pkg["version"],
                pkg.get("license") or "see licence text",
                "shell",
                texts,
            )
        )
    return components


# ── bundled programs (vendor/) ────────────────────────────────────────────────────────────────


def vendor_components() -> list[Component]:
    """LibreOffice and Tesseract as fetched by scripts/fetch-vendor.ps1 (docs/09 §2, D-013)."""
    vendor = ROOT / "vendor"
    components: list[Component] = []
    lo = vendor / "libreoffice"
    if not (lo / ".pdfforge-vendor").exists():
        sys.exit("Run scripts/fetch-vendor.ps1 first (vendor/libreoffice is missing)")
    lo_version = read(lo / ".pdfforge-vendor").split()[0]
    components.append(
        Component(
            "LibreOffice (unmodified, trimmed; incl. its bundled libraries and fonts)",
            lo_version,
            "MPL-2.0 (+ licences of bundled components, see text)",
            "vendor",
            [("LibreOffice", read(lo / "license.txt"))],
        )
    )
    runtime = ROOT / "third_party" / "licenses" / "tesseract-runtime"
    stamp = vendor / "tesseract" / ".pdfforge-vendor"
    if not stamp.exists():
        sys.exit("Run scripts/fetch-vendor.ps1 first (vendor/tesseract is missing)")
    tess_version = read(stamp).split()[0]
    for entry in json.loads(read(runtime / "index.json")):
        version = tess_version if entry["name"] == "Tesseract OCR" else ""
        components.append(
            Component(
                f"{entry['name']} ({entry['files']})",
                version,
                entry["license"],
                "vendor",
                [(entry["name"], read(runtime / entry["text"]))],
            )
        )
    tessdata = vendor / "tesseract" / "tessdata"
    models = sorted(p.stem for p in tessdata.glob("*.traineddata"))
    components.append(
        Component(
            f"Tesseract language data, tessdata_fast ({', '.join(models)})",
            "",
            "Apache-2.0",
            "vendor",
            [("Tesseract", read(runtime / "tesseract-ocr.txt"))],
        )
    )
    return components


# ── installer ─────────────────────────────────────────────────────────────────────────────────


def installer_components() -> list[Component]:
    nsis = Path(os.environ.get("LOCALAPPDATA", "")) / "tauri" / "NSIS" / "COPYING"
    return [
        Component(
            "NSIS (installer stub)",
            "3.13",
            "zlib/libpng, bzip2, CPL-1.0 (see text)",
            "installer",
            [("NSIS", read(nsis))] if nsis.exists() else [],
        ),
        Component(
            "Microsoft Edge WebView2 bootstrapper",
            "",
            "Microsoft Edge WebView2 distribution terms (https://aka.ms/webview2/distribute)",
            "installer",
        ),
    ]


# ── output ────────────────────────────────────────────────────────────────────────────────────

PARTS = {
    "engine": "PDF engine (engine.exe)",
    "ui": "User interface (WebView)",
    "shell": "Application shell (pdfforge.exe)",
    "vendor": "Bundled programs (vendor/: LibreOffice, Tesseract OCR)",
    "installer": "Installer",
}


def fill_standard_texts(components: list[Component]) -> None:
    """Components that ship no licence file get the identical standard text used by another
    component under the same single licence (copyright stays with each package's authors).
    """
    standard: dict[str, str] = {}
    for c in components:
        if len(c.texts) == 1 and re.fullmatch(r"[A-Za-z0-9.\-]+", c.license):
            standard.setdefault(c.license, c.texts[0][1])
    for c in components:
        if c.texts:
            continue
        for spdx in re.split(r"\s+(?:OR|AND)\s+|/", c.license):
            if spdx.strip() in standard:
                c.texts = [
                    (
                        f"{c.name}: {spdx.strip()} (standard text)",
                        standard[spdx.strip()],
                    )
                ]
                break


def write(components: list[Component]) -> None:
    lines = [
        "PDFForge — Third-Party Notices",
        "=" * 30,
        "",
        "PDFForge includes the open-source components listed below. Each is used under its own",
        "licence; the full licence texts follow the list. Generated by scripts/generate_notices.py",
        "from the components actually shipped in this build.",
        "",
        "PDFForge does not include AGPL-licensed software (no Ghostscript, MuPDF/PyMuPDF or",
        "pdf2docx; see docs/09_LICENSING.md §3). LGPL components (img2pdf, libheif, libde265,",
        "libiconv) are used unmodified as separate libraries. LibreOffice (MPL-2.0) and Tesseract",
        "run as separate, unmodified programs; Tesseract's Windows build contains JBIG-KIT",
        "(GPL-2.0). The source code of these components is available from the projects listed,",
        "and on request from the PDFForge authors.",
        "",
    ]
    for part, title in PARTS.items():
        items = [c for c in components if c.part == part]
        if not items:
            continue
        lines += [title, "-" * len(title)]
        width = max(len(c.name) for c in items) + 2
        for c in items:
            lines.append(f"  {c.name.ljust(width)}{c.version.ljust(16)}{c.license}")
        lines.append("")

    groups: dict[str, tuple[str, list[str]]] = {}
    for c in components:
        for _title, text in c.texts:
            key = hashlib.sha256(re.sub(r"\s+", " ", text).encode()).hexdigest()
            label = f"{c.name} {c.version}".strip()
            if key in groups:
                if label not in groups[key][1]:
                    groups[key][1].append(label)
            else:
                groups[key] = (text, [label])
    lines += ["", "LICENCE TEXTS", "=" * 13, ""]
    for text, users in groups.values():
        lines += ["-" * 100, "Used by: " + ", ".join(users), "-" * 100, "", text, ""]
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def main() -> None:
    components = (
        python_components()
        + npm_components()
        + rust_components()
        + vendor_components()
        + installer_components()
    )
    fill_standard_texts(components)
    write(components)
    counts = {p: sum(1 for c in components if c.part == p) for p in PARTS}
    size = OUT.stat().st_size / 1024
    print(f"wrote {OUT.name}: {counts} components, {size:.0f} KB")
    missing = [
        f"{c.part}:{c.name}" for c in components if not c.texts and c.part in ("ui", "shell")
    ]
    if missing:
        print(f"{len(missing)} components without a licence file (licence named in the list):")
        print("  " + ", ".join(missing[:40]))


if __name__ == "__main__":
    main()
