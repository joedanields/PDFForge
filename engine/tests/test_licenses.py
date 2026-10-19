"""The licences folder shipped with the installer (docs/09 §4, D-035)."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LICENSES = ROOT / "licenses"


def test_written_offer_names_every_copyleft_component() -> None:
    offer = (LICENSES / "WRITTEN_OFFER.txt").read_text(encoding="utf-8")
    for name in ("JBIG-KIT", "libiconv", "GCC runtime", "libheif", "img2pdf", "LibreOffice"):
        assert name in offer
    assert "three (3) years" in offer


def test_source_archives_are_fetched_and_bundled() -> None:
    fetch = (ROOT / "scripts" / "fetch-vendor.ps1").read_text(encoding="utf-8")
    readme = (LICENSES / "README.txt").read_text(encoding="utf-8")
    archives = re.findall(r"'([\w.-]+\.tar\.(?:gz|zst))'\s*=\s*@\{", fetch)
    assert {"jbigkit-2.1.tar.gz", "libiconv-1.17.tar.gz"} <= set(archives)
    for name in archives:
        assert name in readme

    for conf in ("tauri.conf.json", "tauri.vendor.conf.json"):
        resources = json.loads((ROOT / "app" / "src-tauri" / conf).read_text(encoding="utf-8"))[
            "bundle"
        ]["resources"]
        assert resources["../../licenses/"] == "licenses/"
    vendor = json.loads(
        (ROOT / "app" / "src-tauri" / "tauri.vendor.conf.json").read_text(encoding="utf-8")
    )
    assert vendor["bundle"]["resources"]["../../vendor/source-archives/"] == "licenses/source/"


def test_notices_point_to_the_source_folder() -> None:
    notices = (ROOT / "THIRD_PARTY_NOTICES.txt").read_text(encoding="utf-8")
    assert "licenses\\source" in notices
    assert "WRITTEN_OFFER.txt" in notices
