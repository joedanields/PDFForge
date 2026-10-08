# 07 — Testing Strategy

## 1. Test levels
| Level | Tooling | Scope |
|-------|---------|-------|
| Engine unit | pytest, pytest-xdist | Each tool function, page-range parser, naming, error codes |
| Engine golden | pytest + reference outputs | Compare page counts, text extraction, rendered-page image hashes (perceptual) against goldens |
| UI unit | Vitest + React Testing Library | Components, registry, options validation |
| IPC contract | pytest + Rust integration tests | Request/progress/result/error/cancel messages |
| E2E | WebdriverIO + tauri-driver (or Playwright on WebView2) | Full flows on the built app |
| Performance | pytest-benchmark | Targets in 05_NON_FUNCTIONAL P1–P8 |
| Security | fuzzing (atheris on parsers), malicious-PDF corpus | No crash/hang beyond timeout |
| Manual | Checklist on clean VMs | Install, uninstall, file association, SmartScreen, offline mode |

## 2. Test corpus (`tests/corpus/`)
- Simple text PDF (1, 10, 500 pages)
- Scanned image PDF (for OCR, compress)
- Mixed portrait/landscape, mixed page sizes
- Encrypted: user password, owner-only, AES-256, RC4
- Corrupted: truncated file, broken xref
- With forms (AcroForm), annotations, bookmarks, links, attachments
- PDF/A, PDF 2.0, linearized
- Huge file (≥ 1 GB, generated in CI, not committed)
- Office: DOCX with tables/images/headers, PPTX with notes, XLSX multi-sheet, legacy DOC/XLS/PPT
- Images: JPG (EXIF rotated), PNG with alpha, TIFF multi-page, HEIC, WEBP
- Non-Latin text: Tamil, Hindi, Chinese, Arabic

Only use files you created yourself or that are explicitly free to redistribute.

## 3. Key acceptance tests (examples)
- Merge: output pages == sum; page 1 of output renders identical to page 1 of first input.
- Split by range `1-3,5`: 2 files with 3 and 1 pages.
- Rotate is lossless: content stream bytes unchanged, only `/Rotate` differs.
- Compress: output < input for scanned corpus; if not, original kept and flagged.
- Protect → Unlock round-trip restores identical page content.
- Redact: extracting text inside redacted rectangles returns empty; underlying image pixels replaced.
- Word → PDF works on a machine without MS Office.
- Network test: run full suite with network disabled (firewall rule) — all non-network tools pass.
- Cancel mid-job: no output file, temp folder removed.
- Never-overwrite: running a tool twice produces `name_tool.pdf` and `name_tool (1).pdf`.

## 4. Quality gates
- Engine coverage ≥ 80%; no failing goldens; no P1/P2 bugs open; perf within 20% of targets.
