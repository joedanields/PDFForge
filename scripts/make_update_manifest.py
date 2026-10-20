"""Write latest.json, the update manifest the Tauri updater reads (docs/06 §6, D-044).

Run after a signed release build (TAURI_SIGNING_PRIVATE_KEY set), then upload the installer,
its .sig and latest.json to the release:

    python scripts/make_update_manifest.py --base-url https://github.com/OWNER/REPO/releases/download/v0.2.0 \
        [--notes "What changed"] [--out latest.json]

The installer must be published at <base-url>/<installer file name>.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
NSIS = ROOT / "app" / "src-tauri" / "target" / "release" / "bundle" / "nsis"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base-url", required=True, help="where the installer is downloaded")
    parser.add_argument("--notes", default="", help="release notes shown in the app")
    parser.add_argument("--out", type=Path, default=NSIS / "latest.json")
    args = parser.parse_args()

    conf = json.loads((ROOT / "app" / "src-tauri" / "tauri.conf.json").read_text("utf-8"))
    version = conf["version"]
    installer = NSIS / f"PDFForge_{version}_x64-setup.exe"
    signature = installer.with_name(installer.name + ".sig")
    if not installer.is_file() or not signature.is_file():
        raise SystemExit(
            f"{installer.name} or its .sig is missing: build with TAURI_SIGNING_PRIVATE_KEY set"
        )
    manifest = {
        "version": version,
        "notes": args.notes,
        "pub_date": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": {
            "windows-x86_64": {
                "signature": signature.read_text("utf-8").strip(),
                "url": f"{args.base_url.rstrip('/')}/{quote(installer.name)}",
            }
        },
    }
    args.out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
