"""Create the sample files used by app/e2e/smoke.mjs.

cd engine
uv run python -m tests.make_e2e_inputs <output-folder>
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas

from tests.fixtures import (
    make_document_pdf,
    make_docx,
    make_encrypted_pdf,
    make_exif_rotated_jpeg,
    make_full_form_pdf,
    make_heic,
    make_image,
    make_image_pdf,
    make_pptx,
    make_scanned_text_pdf,
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
    make_document_pdf(out / "annual.pdf", pages=2)
    make_scanned_text_pdf(out / "invoice-scan.pdf")
    make_full_form_pdf(out / "application.pdf")
    (out / "notes.md").write_text(
        "# Meeting notes\n\n- **Budget** approved\n- Next review in *May*\n", encoding="utf-8"
    )
    (out / "site").mkdir(exist_ok=True)
    make_image(out / "site" / "logo.png", (240, 120), "RGB", (30, 90, 160))
    (out / "site" / "index.html").write_text(
        "<!doctype html><html><head><title>Site</title></head><body><h1>Offline page</h1>"
        '<img src="logo.png"><img src="https://example.com/remote.png"></body></html>',
        encoding="utf-8",
    )
    statement = canvas.Canvas(str(out / "statement.pdf"), pagesize=A4)
    statement.setFont("Helvetica", 14)
    for n, line in enumerate(
        ["Customer statement", "Email: ravi.kumar@example.com", "PAN: ABCDE1234F", "Balance 1,200"]
    ):
        statement.drawString(72, A4[1] - 100 - n * 30, line)
    statement.showPage()
    statement.save()
    for name, lines in (
        ("contract v1.pdf", ["Rent: 15000 per month", "Deposit: two months", "No pets"]),
        ("contract v2.pdf", ["Rent: 18000 per month", "Deposit: two months", "Parking included"]),
    ):
        version = canvas.Canvas(str(out / name), pagesize=A4)
        version.setFont("Helvetica", 16)
        for n, line in enumerate(lines):
            version.drawString(72, A4[1] - 100 - n * 30, line)
        version.showPage()
        version.save()
    broken = make_text_pdf(out / "damaged.pdf", 3).read_bytes()
    (out / "damaged.pdf").write_bytes(re.sub(rb"startxref\s+\d+", b"startxref\n999999", broken))
    print(f"e2e inputs written to {out}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m tests.make_e2e_inputs <output-folder>")
    main(Path(sys.argv[1]))
