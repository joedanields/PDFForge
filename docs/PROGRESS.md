# Progress log

> Autonomous run started 2026-10-18. Final summary for the owner will be written here at the top.

## Now

- **Current phase:** Phase 2 — Conversions
- **Working on:** 2.0 fetch-vendor.ps1 (LibreOffice + Tesseract)

## Phase 1 — Core PDF tools

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
| 1.13 Notices, release smoke, installer | done | full suite + release smoke (Echo + 13 tools in built exe) | (see git log) | installer 25.0 MB |

## For the owner (decide / do on return)

- Review [DECISIONS.md](DECISIONS.md).
