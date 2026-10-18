# Progress log

> Autonomous run started 2026-10-18. Final summary for the owner will be written here at the top.

## Now

- **Current phase:** Phase 2 — Conversions
- **Working on:** 2.2 PDF → Word / Excel / PowerPoint / Text

## Phase 2 — Conversions

| Tool | Status | Tests | Commit | Notes |
|------|--------|-------|--------|-------|
| 2.0 Vendor: LibreOffice + Tesseract fetch/verify/trim, helper runner | done | test_vendor (10) | bf15a1a | LibreOffice 26.2.6 (~490 MB), Tesseract 5.4.0 + eng/osd/tam/hin (~134 MB); D-012–D-015 |
| 2.1 Word / PowerPoint / Excel → PDF (C2–C4) | done | test_office (17), smoke `office` | (this commit) | LibreOffice headless; 50-page DOCX well under 15 s; D-016, D-017 |
| 2.2 PDF → Word / Excel / PowerPoint / Text (D2–D4, D6) | todo | | | |
| 2.3 Text / Markdown → PDF (C6) | todo | | | |
| 2.4 Repair (B2) | todo | | | |
| 2.5 HTML → PDF (C5) | todo | | | |
| 2.6 PDF → PDF/A (D5) — best effort, no Ghostscript | todo | | | |
| 2.7 OCR (B3) + OCR languages in Settings | todo | | | |
| 2.8 Notices, Phase 2 installer + release smoke | todo | | | |

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
