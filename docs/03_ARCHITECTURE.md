# 03 — Architecture & Tech Stack

## 1. Recommended stack

| Layer | Choice | Why |
|-------|--------|-----|
| Desktop shell | **Tauri 2** (Rust) | Small binary, uses Windows WebView2, native installer (NSIS/MSI), sidecar support |
| UI | **React 18 + TypeScript + Vite** | Rich drag-drop UIs, large ecosystem |
| UI libs | Tailwind CSS, shadcn/ui (Radix), dnd-kit (drag reorder), Zustand (state), i18next | |
| In-UI PDF rendering | **pdf.js** (thumbnails, viewer, editor canvas) | |
| In-UI PDF writing (editor) | **pdf-lib** | Add text/images/shapes client-side |
| Processing engine | **Python 3.12 sidecar**, frozen with PyInstaller into `engine.exe` | Best PDF library ecosystem |
| PDF core | pikepdf (qpdf), pypdf, pypdfium2 | merge/split/rotate/encrypt/render |
| Extraction | pdfplumber, camelot (optional) | text & tables |
| Conversion | pdf2docx, python-pptx, openpyxl, img2pdf, Pillow, ReportLab | |
| OCR | OCRmyPDF + Tesseract 5 (bundled) | |
| Office → PDF | **LibreOffice** portable, headless (`soffice --headless --convert-to pdf`) | No MS Office needed |
| Compression / PDF/A | **Ghostscript** (bundled `gswin64c.exe`) — check AGPL implications (09) | |
| Signing (crypto) | pyHanko | |
| Local DB | SQLite (history, recents, settings) via Rust `rusqlite` or Tauri SQL plugin | |

### Alternative stack (simpler, single language)
**Python + PySide6 (Qt)** for UI, same Python engine libraries, packaged with PyInstaller + Inno Setup. Faster to start if you only know Python; UI is less flexible and installer slightly bigger. Electron + Node is another option but is heavier and has weaker PDF libraries.

## 2. Process model

```
┌──────────────────────────────┐
│  Tauri main process (Rust)   │  window mgmt, file dialogs, settings, SQLite,
│                              │  spawns + supervises engine, updater
└──────────┬───────────────────┘
           │ IPC (Tauri commands / events)
┌──────────▼───────────────────┐
│  WebView2 UI (React)         │  tool screens, thumbnails (pdf.js), editor
└──────────────────────────────┘
           │ (via Rust) JSON-RPC over stdin/stdout
┌──────────▼───────────────────┐
│  engine.exe (Python sidecar) │  job queue, runs tools, progress events
│   ├─ libreoffice/ (soffice)  │  spawned per Office job
│   ├─ ghostscript/ (gs)       │
│   └─ tesseract/              │
└──────────────────────────────┘
```

- One long-lived engine process started at app launch (lazy-start acceptable).
- Jobs run in a worker pool inside the engine (process pool for CPU-heavy tasks: OCR, compress, render).
- Rust watchdog restarts the engine if it crashes; in-flight job reported as failed.

## 3. Engine IPC protocol (JSON lines)

Request:
```json
{"id":"job-123","method":"merge","params":{"inputs":["C:/a.pdf","C:/b.pdf"],"output":"C:/out/merged.pdf","options":{"bookmarks":true}}}
```
Progress event:
```json
{"id":"job-123","event":"progress","percent":42,"message":"Merging file 2 of 5"}
```
Result:
```json
{"id":"job-123","event":"done","outputs":["C:/out/merged.pdf"],"stats":{"pages":18,"bytes":1048576,"ms":812}}
```
Error:
```json
{"id":"job-123","event":"error","code":"PASSWORD_REQUIRED","message":"b.pdf is encrypted","file":"C:/b.pdf"}
```
Cancel: `{"id":"job-123","method":"cancel"}`

Standard error codes: `INVALID_INPUT`, `PASSWORD_REQUIRED`, `WRONG_PASSWORD`, `CORRUPT_FILE`, `UNSUPPORTED`, `DISK_FULL`, `TIMEOUT`, `CANCELLED`, `INTERNAL`.

## 4. Engine module layout

```
engine/
├── main.py                # JSON-RPC loop, dispatcher
├── jobs.py                # queue, cancellation tokens, progress
├── tools/
│   ├── organize.py        # merge, split, remove, extract, organize, rotate
│   ├── optimize.py        # compress, repair, ocr
│   ├── to_pdf.py          # image, office, html, text
│   ├── from_pdf.py        # images, word, ppt, excel, pdfa, text
│   ├── edit.py            # page numbers, watermark, crop, apply-annotations, forms
│   ├── security.py        # protect, unlock, sign, redact
│   └── compare.py
├── adapters/
│   ├── libreoffice.py     # temp profile dir, timeout, kill on cancel
│   ├── ghostscript.py
│   └── tesseract.py
├── utils/ (paths, naming, temp files, page ranges parser, validation)
└── tests/
```

Each tool = a function `run(params, ctx) -> Result` where `ctx` provides `progress()`, `is_cancelled()`, `temp_dir`.

## 5. UI module layout

```
src/
├── app/ (router, providers, theme)
├── pages/
│   ├── Home.tsx           # tool grid, category chips, search
│   ├── Tool.tsx           # generic tool page driven by tool registry
│   ├── Viewer.tsx
│   ├── Editor.tsx
│   ├── Workflows.tsx
│   └── Settings.tsx
├── tools/registry.ts      # tool metadata: id, name, category, icon, accepts, optionsSchema
├── components/ (DropZone, FileList, ThumbnailGrid, OptionsForm, ProgressPanel, ResultCard)
├── engine/client.ts       # typed wrapper around Tauri commands
└── i18n/
```

**Tool registry** drives the home grid and auto-generates options forms from a schema (e.g., zod), so adding a tool = registry entry + engine function.

## 6. Data & storage
- `%APPDATA%\PDFForge\settings.json`
- `%APPDATA%\PDFForge\app.db` (SQLite: history, recents)
- `%APPDATA%\PDFForge\workflows\`
- `%APPDATA%\PDFForge\signatures\` (encrypted with Windows DPAPI)
- Temp: `%TEMP%\PDFForge\{job-id}\` — deleted after each job and on startup.

## 7. Key design decisions
- Lossless operations (merge/split/rotate) never re-render pages.
- Large files: stream page-by-page; thumbnails generated lazily and cached.
- All external binaries invoked with absolute paths from the install dir (never from PATH).
- LibreOffice runs with an isolated `-env:UserInstallation` profile per job to avoid lock conflicts.
