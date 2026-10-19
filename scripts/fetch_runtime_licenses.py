"""One-off helper: fetch the licence texts of the libraries inside the bundled Tesseract build.

The UB Mannheim installer (D-013) ships its DLLs (built by MSYS2) without their licence files.
This script downloads each project's own licence file and stores it under
third_party/licenses/tesseract-runtime/, which is committed, so generating
THIRD_PARTY_NOTICES.txt stays offline. Re-run only when the Tesseract build changes.

    uv run --no-project python scripts/fetch_runtime_licenses.py
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "third_party" / "licenses" / "tesseract-runtime"
GH = "https://raw.githubusercontent.com"

# (component, DLLs, SPDX licence, licence file URL)
LIBRARIES = [
    ("Tesseract OCR", "tesseract.exe, libtesseract-5.dll", "Apache-2.0",
     f"{GH}/tesseract-ocr/tesseract/5.4.0/LICENSE"),
    ("Leptonica", "libleptonica-6.dll", "BSD-2-Clause",
     f"{GH}/DanBloomberg/leptonica/master/leptonica-license.txt"),
    ("libarchive", "libarchive-13.dll", "BSD-2-Clause",
     f"{GH}/libarchive/libarchive/master/COPYING"),
    ("BLAKE2 (libb2)", "libb2-1.dll", "CC0-1.0", f"{GH}/BLAKE2/libb2/master/COPYING"),
    ("bzip2", "libbz2-1.dll", "bzip2-1.0.6",
     "https://sourceware.org/git/?p=bzip2.git;a=blob_plain;f=LICENSE;hb=HEAD"),
    ("OpenSSL", "libcrypto-3-x64.dll", "Apache-2.0",
     f"{GH}/openssl/openssl/openssl-3.3.1/LICENSE.txt"),
    ("libdeflate", "libdeflate.dll", "MIT", f"{GH}/ebiggers/libdeflate/master/COPYING"),
    ("Expat", "libexpat-1.dll", "MIT", f"{GH}/libexpat/libexpat/master/expat/COPYING"),
    ("GCC runtime (libgcc, libstdc++)", "libgcc_s_seh-1.dll, libstdc++-6.dll",
     "GPL-3.0-or-later WITH GCC-exception-3.1",
     f"{GH}/gcc-mirror/gcc/master/COPYING.RUNTIME"),
    ("GIFLIB", "libgif-7.dll", "MIT", "https://sourceforge.net/p/giflib/code/ci/master/tree/COPYING?format=raw"),
    ("GNU libiconv", "libiconv-2.dll", "LGPL-2.1-or-later",
     "https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt"),
    ("JBIG-KIT", "libjbig-0.dll", "GPL-2.0-or-later",
     "https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt"),
    ("libjpeg-turbo", "libjpeg-8.dll", "IJG AND BSD-3-Clause AND Zlib",
     f"{GH}/libjpeg-turbo/libjpeg-turbo/main/LICENSE.md"),
    ("LERC", "libLerc.dll", "Apache-2.0", f"{GH}/Esri/lerc/master/LICENSE"),
    ("LZ4", "liblz4.dll", "BSD-2-Clause", f"{GH}/lz4/lz4/v1.9.4/lib/LICENSE"),
    ("XZ Utils (liblzma)", "liblzma-5.dll", "0BSD", f"{GH}/tukaani-project/xz/v5.6.2/COPYING"),
    ("OpenJPEG", "libopenjp2-7.dll", "BSD-2-Clause", f"{GH}/uclouvain/openjpeg/master/LICENSE"),
    ("libpng", "libpng16-16.dll", "libpng-2.0", f"{GH}/pnggroup/libpng/libpng16/LICENSE"),
    ("libwebp (incl. sharpyuv)", "libwebp-7.dll, libwebpmux-3.dll, libsharpyuv-0.dll",
     "BSD-3-Clause", f"{GH}/webmproject/libwebp/main/COPYING"),
    ("LibTIFF", "libtiff-6.dll", "libtiff", "https://gitlab.com/libtiff/libtiff/-/raw/master/LICENSE.md"),
    ("MinGW-w64 winpthreads", "libwinpthread-1.dll", "MIT AND BSD-3-Clause",
     "https://raw.githubusercontent.com/mingw-w64/mingw-w64/master/mingw-w64-libraries/winpthreads/COPYING"),
    ("Zstandard", "libzstd.dll", "BSD-3-Clause", f"{GH}/facebook/zstd/dev/LICENSE"),
    ("zlib", "zlib1.dll", "Zlib", f"{GH}/madler/zlib/master/LICENSE"),
]  # fmt: skip


def slug(name: str) -> str:
    return "".join(c.lower() if c.isalnum() else "-" for c in name).strip("-").replace("--", "-")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    failed = []
    for name, dlls, spdx, url in LIBRARIES:
        target = OUT / f"{slug(name)}.txt"
        if not target.exists():
            for _attempt in range(3):
                try:
                    request = urllib.request.Request(url, headers={"User-Agent": "PDFForge-build"})
                    with urllib.request.urlopen(request, timeout=60) as response:
                        text = response.read().decode("utf-8", errors="replace")
                    target.write_bytes(text.replace("\r\n", "\n").encode("utf-8"))
                    break
                except OSError as exc:
                    error = exc
            else:
                failed.append(f"{name}: {error}")
                continue
        index.append(
            {"name": name, "files": dlls, "license": spdx, "text": target.name, "source": url}
        )
    (OUT / "index.json").write_bytes((json.dumps(index, indent=2) + "\n").encode("utf-8"))
    print(f"{len(index)} licence texts in {OUT}")
    if failed:
        print("FAILED:\n  " + "\n  ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
