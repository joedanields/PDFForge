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
| Compression / PDF/A | **pikepdf + Pillow** image recompression; PDF/A via pikepdf + veraPDF | AGPL-free by decision (09 §3): no Ghostscript, MuPDF/PyMuPDF or pdf2docx |
| Signing (crypto) | pyHanko | |
| Local storage | Settings in `settings.json`; history and recent outputs in SQLite `app.db` via Rust `rusqlite` (see §6) | |

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
│   └─ tesseract/              │
└──────────────────────────────┘
```

- One long-lived engine process started at app launch (lazy-start acceptable).
- Each job runs in its own worker process (multiprocessing `spawn`), at most 4 at a time. On
  Windows the worker is placed in a Job Object capped at 2 GB of committed memory (05 S6);
  allocations beyond the cap fail with `INTERNAL` "This job needed more than N MB of memory"
  instead of exhausting the PC. The cap is set by `PDFFORGE_JOB_MEMORY_MB` or per request
  (`memory_limit_mb`, 128–65536). Closing the Job Object kills the worker, so workers never
  outlive the engine. A worker that ignores Cancel or its timeout is killed after a 5 s grace
  period (`PDFFORGE_CANCEL_GRACE_S`).
- The engine reads the protocol from private copies of its stdin/stdout handles and points the
  process's standard handles at NUL/stderr; otherwise starting a worker deadlocks behind the
  pending stdin read on Windows.
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

Handshake (sent by the app right after spawning the engine; the app refuses an engine whose
`protocol_version` or `engine_version` does not match, see 06 §7):
```json
{"id":"__hello","method":"hello"}
{"id":"__hello","event":"hello","engine_version":"0.1.0","protocol_version":1,"methods":["hello","cancel","echo","merge"]}
```

Rules (protocol version 1):
- One JSON object per line, UTF-8, on stdin (requests) and stdout (events). stdout carries
  protocol messages only; logs go to stderr, which the app writes to its log file.
- Every job ends with exactly one `done` or `error` event. Job ids are chosen by the app
  (`[A-Za-z0-9_-]{1,64}`); reusing the id of a running job is `INVALID_INPUT`.
- A line that cannot be parsed gets `{"id":null,"event":"error","code":"INVALID_INPUT",...}`;
  an unknown method gets `UNSUPPORTED`. Neither stops the engine.
- `cancel` for an unknown or finished id is ignored (no reply). Cancelled jobs answer
  `CANCELLED` and leave no output.
- Optional `params.timeout_s` (default 900, max 21600) ends a job with `TIMEOUT`; optional
  `params.memory_limit_mb` overrides the per-job memory cap (§2).
- Common params: `inputs` (paths), `options` (tool options), `passwords` (`{path: password}`,
  never logged or stored), `output` (explicit file) or `output_dir` (folder; default = folder of
  the first input). The engine never overwrites: it picks `name.pdf`, `name (1).pdf`, ... and
  reports the real path in `outputs`.
- Closing stdin (EOF) cancels running jobs and exits the engine with code 0. Any other exit is
  a crash: the app reports in-flight jobs as `INTERNAL` errors and restarts the engine with
  backoff (1 s doubling to 30 s). After 5 consecutive crashes that each happen within a minute
  of starting, it stops retrying and shows "engine failed" with a Retry button.
- `echo` is a diagnostic tool (`message`, `steps`, `delay_ms`) used by the engine self-test;
  test-only hooks: `fail`, `crash` (`true` = worker, `"engine"` = whole engine),
  `allocate_mb`, `block_s`.

## 4. Engine module layout

```
engine/
├── main.py                # JSON-RPC loop, dispatcher
├── jobs.py                # queue, cancellation tokens, progress
├── worker.py              # per-job worker process (Job Object memory cap)
├── tools/                 # __init__.py maps method → module:function, imported lazily
│   ├── organize.py        # merge, split, remove, extract, organize, rotate
│   ├── optimize.py        # compress, repair
│   ├── ocr.py             # OCR (Tesseract text layer, auto-rotate, deskew)
│   ├── to_pdf.py          # image, html, text/markdown
│   ├── office.py          # word, powerpoint, excel → pdf (LibreOffice)
│   ├── from_pdf.py        # pdf → images
│   ├── pdf_office.py      # pdf → word, excel, powerpoint, text
│   ├── pdfa.py            # pdf → pdf/a
│   ├── edit.py            # page numbers, watermark, crop
│   ├── editor.py          # edit pdf + sign (objects in display coordinates)
│   ├── redact.py          # true redaction (pages rebuilt from pixels)
│   ├── compare.py         # word-level diff + annotated report
│   ├── security.py        # protect, unlock
│   └── debug.py           # echo self-test
├── utils/
│   ├── libreoffice.py     # hardened per-run profile, short paths, kill on cancel
│   ├── tesseract.py       # OCR runs, language folders
│   ├── process.py         # helper programs inside the job (cancel / timeout kill)
│   ├── vendor.py          # where vendor/ is (installed vs dev)
│   ├── layout.py          # page text → lines / paragraphs for PDF → Office
│   └── …                  # paths, naming, atomic commit, page ranges, validation, overlays
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
  The profile is copied from a cached template (`%LOCALAPPDATA%\PDFForge\cache`) into a short
  path (`%TEMP%\PDFForge\lo\<8 hex>` — LibreOffice fails silently on long profile paths) and
  is preset for untrusted input: macros off at the highest security level, links never
  updated, all internet access sent to a dead local proxy. `SAL_DISABLE_PRINTERLIST` /
  `SAL_DISABLE_DEFAULTPRINTER` (plus GPU/OpenCL off) stop LibreOffice from querying the
  system printers, which otherwise stalls every document load by ~10 s when the default
  printer is offline. Helpers (LibreOffice, Tesseract) run inside the job's Job Object, so the
  memory cap and kill-on-close apply to them too, and are killed with their children on
  cancel or timeout.
