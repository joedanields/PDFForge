"""Create the sample files used by app/e2e/smoke.mjs.

cd engine
uv run python -m tests.make_e2e_inputs <output-folder>
"""

from __future__ import annotations

import sys
from pathlib import Path

from reportlab.lib.pagesizes import A4, landscape

from tests.fixtures import (
    make_docx,
    make_encrypted_pdf,
    make_exif_rotated_jpeg,
    make_heic,
    make_image,
    make_image_pdf,
    make_pptx,
    make_text_pdf,
    make_xlsx,
)


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for old in out.iterdir():
        if old.is_file():
            old.unlink()
    make_text_pdf(out / "Chapter 1.pdf", 3, bookmarks=True)
    make_text_pdf(out / "Chapter 2.pdf", 2, page_sizes=[landscape(A4)])
    make_image(out / "cover.png", (600, 800), "RGB", (20, 120, 110))
    make_encrypted_pdf(out / "secret.pdf", 2, "pw123")
    # 5 pages alternating portrait / landscape, for page tools and orientation filters
    make_text_pdf(out / "mixed.pdf", 5, page_sizes=[A4, landscape(A4)])
    make_exif_rotated_jpeg(out / "photo.jpg", (800, 400))  # displays portrait
    make_heic(out / "phone.heic")
    make_image_pdf(out / "scan.pdf", 2, (400, 500))
    make_image_pdf(out / "bigscan.pdf", 2, (1654, 2339), quality=95, grain=3)  # 200 dpi
    make_docx(out / "report.docx", pages=3)
    make_pptx(out / "deck.pptx", slides=3)
    make_xlsx(out / "book.xlsx", columns=30)
    print(f"e2e inputs written to {out}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m tests.make_e2e_inputs <output-folder>")
    main(Path(sys.argv[1]))
