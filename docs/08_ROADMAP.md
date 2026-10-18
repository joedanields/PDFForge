# 08 — Roadmap & Milestones

Estimates assume 1–2 developers working full time.

## Phase 0 — Foundations (2 weeks)
- Repo, CI, Tauri + React skeleton, Python engine with JSON-RPC, sidecar launch & watchdog.
- Tool registry, Home grid with category chips & search, generic Tool page, DropZone, progress & result screens.
- Settings + SQLite recents.
- **Exit:** a dummy "Echo" tool runs end-to-end inside a built `.exe`.

## Phase 1 — MVP (4–5 weeks)
- Merge, Split, Remove pages, Extract pages, Rotate, Organize (thumbnail grid).
- Compress (pikepdf + Pillow), Image → PDF, PDF → JPG.
- Protect, Unlock, Add page numbers, Add watermark.
- NSIS installer, code signing.
- **Exit:** 13 tools, installer tested on Win 10/11 clean VMs.

## Phase 2 — Conversions (3–4 weeks)
- Bundle LibreOffice: Word/PPT/Excel → PDF.
- PDF → Word, PDF → Excel, PDF → PowerPoint, PDF → PDF/A, HTML → PDF.
- Repair, OCR (Tesseract + language pack manager).
- **Exit:** 24 tools.

## Phase 3 — Editing & security (4–5 weeks)
- Built-in viewer.
- Edit PDF (text, image, shapes, draw), Sign (typed/drawn/image), Crop.
- Redact (true redaction), Compare.
- **Exit: v1.0 release** — ~29 tools, auto-update, dark mode.

## Phase 4 — Power features (v1.x)
- Workflows builder, batch mode, Explorer context menu, Fill forms, digital certificate signing, localization (Tamil, Hindi), Lite installer with on-demand components.

## Phase 5 — v2 candidates
- PDF Intelligence (summarize/translate/chat) via local model or user API key.
- macOS & Linux builds (Tauri supports both).
- ARM64 Windows.

## Risks
| Risk | Mitigation |
|------|-----------|
| Installer too big (LibreOffice) | Trim LO; Lite installer + on-demand download |
| PDF → Word fidelity complaints | Set expectations in UI; offer "OCR mode" for scans |
| AGPL (Ghostscript/PyMuPDF) obligations | Decided: AGPL-free alternatives only (09 §3) |
| WebView2 missing on old Win 10 | Embed bootstrapper |
| SmartScreen warnings | Code-signing certificate early |
