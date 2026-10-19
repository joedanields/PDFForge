# Progress log

> Autonomous run started 2026-10-18. Final summary for the owner will be written here at the top.

## Now

- **Current phase:** Phase 3 — Editing & security (Phase 2 done)
- **Working on:** Phase 3.0 — built-in viewer

## Phase 2 — Conversions

| Tool | Status | Tests | Commit | Notes |
|------|--------|-------|--------|-------|
| 2.0 Vendor: LibreOffice + Tesseract fetch/verify/trim, helper runner | done | test_vendor (10) | bf15a1a | LibreOffice 26.2.6 (~490 MB), Tesseract 5.4.0 + eng/osd/tam/hin (~134 MB); D-012–D-015 |
| 2.1 Word / PowerPoint / Excel → PDF (C2–C4) | done | test_office (17), smoke `office` | d38f7c3 | LibreOffice headless; 50-page DOCX well under 15 s; D-016, D-017 |
| 2.2 PDF → Word / Excel / PowerPoint / Text (D2–D4, D6) | done | test_pdf_to_word (10), test_pdf_to_office (11), smoke `frompdf` | eb20478 | own converter on pdfplumber (no pdf2docx); OCR mode for scans; D-018–D-020 |
| 2.3 Text / Markdown → PDF (C6) | done | test_text_to_pdf (9), smoke `text` | f34a8eb | ReportLab; D-021 |
| 2.4 Repair (B2) | done | test_repair (9), smoke `repair` | 9162f9f | qpdf + pypdf fallback; D-022 |
| 2.5 HTML → PDF (C5) | done | test_html_to_pdf (6), smoke `html` | 8723d7b | LibreOffice on a self-contained, script-free copy; local files only; D-023 |
| 2.6 PDF → PDF/A (D5) | done | test_pdfa (7, veraPDF-validated on the dev machine), smoke `pdfa` | 09dc272 | PDF/A-2b/3b with pikepdf, no Ghostscript; CMYK / unembeddable fonts refused; D-024. Also: lazy tool loading cuts ~2.4 s off every job (D-025) |
| 2.7 OCR (B3) + OCR languages in Settings | done | test_ocr (11), Rust ocr (3), vitest ocrLanguages (4), smoke `ocr` | b7137bc | Tesseract text-only layer, auto-rotate, deskew, parallel pages (P6 met); D-026, D-027 |
| 2.8 Notices, Phase 2 installer + release smoke | done | full suite + release smoke (Echo + all 25 tools in the built exe) | (this commit) | installer 184.5 MB (176 MiB) incl. LibreOffice + Tesseract; notices cover vendor/ (D-013) |

## Phase 1 — Core PDF tools (done)

| Tool | Status | Tests | Commit | Notes |
|------|--------|-------|--------|-------|
| 1.0 Housekeeping, AGPL decision, memory cap | done | pytest + Rust | 75037c2 | Job Object cap 2 GB (D-002) |
| 1.1 Rotate + ThumbnailGrid | done | pytest, vitest, smoke | 0467712 | |
| 1.2 Remove pages | done | pytest, smoke | ad74cd1 | |
| 1.3 Extract pages | done | pytest, smoke | e5a990a | |
| 1.4 Split | done | pytest, smoke | c92f04b | ranges / every N / bookmarks / size |
| 1.5 Organize | done | pytest, vitest, smoke | 6b01073 | |
| 1.6 Image → PDF | done | pytest, smoke | 3a9efce | HEIC via pi-heif (D-006) |
| 1.7 PDF → Image | done | pytest, smoke | 3336bca | |
| 1.8 Protect | done | pytest, smoke | 033bb28 | |
| 1.9 Unlock | done | pytest, smoke | fbbcddd | |
| 1.10 Page numbers | done | pytest, smoke | 0fa9c69 | Latin text only (D-007) |
| 1.11 Watermark | done | pytest, smoke | 0102785 | |
| 1.12 Compress | done | pytest, smoke | 09ae5f7 | AGPL-free (D-008, D-009) |
| 1.13 Notices, release smoke, installer | done | full suite + release smoke (Echo + 13 tools in built exe) | a9c6dc7 | installer 25.0 MB |

## For the owner (decide / do on return)

- Review [DECISIONS.md](DECISIONS.md) — in particular D-013 (GPL/LGPL DLLs inside the Tesseract build).
- Installed for the build (inside the repo, nothing system-wide): 7-Zip 26.04 extracted to
  `vendor/_tools/7zip` (only used to unpack the Tesseract installer). Python packages added to
  the engine: python-docx, python-pptx, openpyxl (+ stub packages lxml-stubs, types-openpyxl
  for type checking).
- Development-only validator (not shipped, git-ignored): Eclipse Temurin JRE 21.0.12 (zip,
  SHA-256 checked against Adoptium) in `vendor/_tools/jre` and veraPDF 1.30.3 (headless
  installer) in `vendor/_tools/verapdf`. Tests use them when present to validate PDF/A output.
