# 02 — Feature Specifications

Each tool follows the same contract:

```
Input files  →  Options panel  →  [Run]  →  Progress  →  Result screen (Open / Show in folder / Process again / Chain to another tool)
```

Common rules for **all** tools:
- Accept files by drag-and-drop, file picker, or "Open with PDFForge" from Explorer.
- Validate type and readability before enabling **Run**; show a clear error per bad file.
- Password-protected input → prompt for password (except Unlock, which is its purpose).
- Default output: same folder as first input, name pattern `{original}_{tool}.pdf`; never overwrite silently (append `(1)`, `(2)`…).
- Every job is cancellable; cancelling leaves no partial output.
- Each tool logs a job record (tool, inputs, options, duration, status) to local history.

Engine column = suggested library (see 03_ARCHITECTURE.md).

---

## A. Organize PDF

### A1. Merge PDF — Must
- **Input:** 2–500 PDFs (images also accepted, auto-converted).
- **Options:** order (drag thumbnails, sort by name/date), include bookmarks (Y/N), add bookmark per source file (Y/N).
- **Output:** 1 PDF.
- **Engine:** pikepdf.
- **Acceptance:** page count = sum of inputs; order respected; links/bookmarks preserved when enabled.

### A2. Split PDF — Must
- **Modes:**
  - *By ranges* — e.g. `1-3, 4-7, 8`; option to merge all ranges into one file.
  - *Fixed size* — every N pages.
  - *Extract all* — one file per page.
  - *By file size* — chunks ≤ X MB.
  - *By bookmarks* — top-level outlines (Should).
- **Output:** multiple PDFs (optionally zipped).
- **Acceptance:** range syntax validated live; invalid ranges highlighted.

### A3. Remove Pages — Must
- Thumbnail grid; click to mark pages for deletion, or type ranges.
- **Acceptance:** cannot remove all pages (button disabled with message).

### A4. Extract Pages — Must
- Select pages → new PDF containing only those (single file or one per page).

### A5. Organize PDF — Must
- Thumbnail grid of all pages of 1+ PDFs: drag to reorder, rotate individual pages, delete, duplicate, insert blank page, insert pages from another PDF.
- Undo/redo (Ctrl+Z / Ctrl+Y).

### A6. Rotate PDF — Must
- Rotate all or selected pages by 90° / 180° / 270°; filter "portrait only / landscape only".
- Lossless (sets `/Rotate`, no re-render).

---

## B. Optimize PDF

### B1. Compress PDF — Must
- **Levels:**
  - *Extreme* — 72 dpi images, high JPEG compression.
  - *Recommended* (default) — 150 dpi.
  - *Low* — 300 dpi, minimal quality loss.
  - *Custom* — DPI, JPEG quality, grayscale toggle, remove metadata.
- **Output:** shows original vs new size and % saved. If output is larger than input, keep the original and tell the user.
- **Engine:** pikepdf + Pillow (AGPL-free, see 09 §3): downsample each image to the level's DPI
  based on its displayed size, re-encode as JPEG, optional grayscale, strip metadata, remove
  unused objects and recompress streams. Vector content and fonts are kept as they are.

### B2. Repair PDF — Should
- Attempt to rebuild xref/trailer and recover pages from damaged files.
- **Engine:** qpdf/pikepdf, fallback pypdf re-write (no Ghostscript, see 09 §3).
- Report: "Repaired / Partially recovered (N of M pages) / Could not repair".

### B3. OCR PDF — Should
- Make scanned PDFs searchable (invisible text layer).
- **Options:** language(s) (bundle eng + user-installable language packs, incl. Tamil/Hindi), deskew, rotate pages automatically, force OCR on pages that already have text.
- **Engine:** OCRmyPDF + Tesseract.

---

## C. Convert to PDF

| ID | Tool | Input | Options | Engine | Priority |
|----|------|-------|---------|--------|----------|
| C1 | Image → PDF | JPG, PNG, BMP, TIFF, WEBP, HEIC | orientation, page size (A4/Letter/Fit), margin, one image per page or merge all | img2pdf + Pillow | Must |
| C2 | Word → PDF | DOC, DOCX, ODT, RTF | — | LibreOffice headless | Must |
| C3 | PowerPoint → PDF | PPT, PPTX, ODP | include notes (Y/N) | LibreOffice headless | Must |
| C4 | Excel → PDF | XLS, XLSX, ODS, CSV | fit sheet to page width, all sheets / active sheet | LibreOffice headless | Must |
| C5 | HTML → PDF | local `.html` file or URL* | page size, margins, include background | Chromium (WebView2 print) / wkhtmltopdf alternative | Should |
| C6 | Text → PDF | TXT, MD | font, size | ReportLab | Could |

\* URL fetch is the only feature that may use the network; it must be clearly labeled and user-initiated.

**Acceptance (C2–C4):** works with no Microsoft Office installed; fonts substituted gracefully; conversion of a 50-page DOCX < 15 s.

---

## D. Convert from PDF

| ID | Tool | Output | Options | Engine | Priority |
|----|------|--------|---------|--------|----------|
| D1 | PDF → JPG/PNG | images (zip optional) | mode: *every page* or *extract embedded images*; DPI 72/150/300; format | pypdfium2 (render), pikepdf (extract) | Must |
| D2 | PDF → Word | DOCX | with OCR for scanned (Y/N) | pdf2docx | Must |
| D3 | PDF → PowerPoint | PPTX | one slide per page (image + extracted text boxes) | python-pptx + pypdfium2 | Should |
| D4 | PDF → Excel | XLSX | detect tables automatically / one sheet per page / one sheet total | pdfplumber or camelot + openpyxl | Should |
| D5 | PDF → PDF/A | PDF/A-1b, 2b, 3b | conformance level | pikepdf + veraPDF validation (no Ghostscript, see 09 §3) | Should |
| D6 | PDF → Text | TXT | keep layout (Y/N) | pdfplumber | Could |

**Acceptance (D2):** text, paragraphs, basic tables and images preserved for digitally created PDFs; layout fidelity is "best effort" and must be stated in UI.

---

## E. Edit PDF

### E1. Edit PDF — Should
- Page viewer with tools: **Text box** (font, size, color, bold/italic), **Image** (insert, resize, move), **Shapes** (rectangle, ellipse, line, arrow; stroke/fill), **Freehand draw** (pen, highlighter), **Comment/sticky note**, **Eraser** for added objects.
- Added objects are editable until **Save**; then flattened into page content (option: keep as annotations).
- Undo/redo, zoom, page navigation.
- Note: editing *existing* text is out of scope for v1 (whiteout + new text box as workaround).
- **Engine:** pdf.js (render in UI) + pdf-lib (write) or pikepdf on save.

### E2. Add Page Numbers — Must
- Position (9-grid), margin, first number, page range, format (`1`, `Page 1`, `1 of N`, `Page 1 of N`, custom `{n}/{total}`), font, size, color, single vs facing pages (mirror left/right), skip first page.

### E3. Add Watermark — Must
- **Text** (font, size, color, opacity, rotation) or **Image** (scale, opacity).
- Position (9-grid or tiled/mosaic), layer (over/under content), page range.

### E4. Crop PDF — Should
- Draw crop box on a page preview; apply to current page / all pages; or auto-trim white margins.

### E5. Fill PDF Forms — Could
- Detect AcroForm fields, fill in UI, option to flatten.

---

## F. PDF Security

### F1. Protect PDF — Must
- Set open (user) password and/or permissions (owner) password.
- Permissions: printing, copying, editing, form filling, annotating.
- Encryption: AES-256 (default), AES-128.
- Password strength meter; confirm field.
- **Engine:** pikepdf.

### F2. Unlock PDF — Must
- Remove password when user knows it; remove owner-only restrictions.
- Must **not** include password-cracking/brute-force features.

### F3. Sign PDF — Should
- Signature creation: type (choose font), draw (mouse/pen), upload image. Saved signatures stored locally (encrypted).
- Place signature, initials, date, name, text on pages; drag/resize.
- **Optional (Could):** cryptographic digital signature with a user's PFX/P12 certificate (pyHanko).

### F4. Redact PDF — Could
- Mark areas or search text (incl. regex presets: email, phone, PAN/Aadhaar-style numbers) → black boxes.
- **True redaction**: underlying text/images must be removed, not just covered. Verified by test (text extraction of redacted region returns nothing).

### F5. Compare PDF — Could
- Side-by-side view of two PDFs; text diff highlighted (added/removed/changed), synced scrolling; optional visual (pixel) diff overlay.

---

## G. Workflows — Could
- Build a pipeline from tools (e.g. Merge → Compress → Page numbers → Protect) with saved options.
- Save, rename, duplicate, delete workflows; run on new files; batch-run on a folder.
- Stored as JSON (`%APPDATA%\PDFForge\workflows\*.json`).

## H. Batch Mode — Could
- For single-file tools (Compress, Rotate, Protect, convert tools…), select many files → process each independently, with a per-file status list.

## I. PDF Intelligence — Won't (v1), v2 candidate
- Summarize, Translate, Chat-with-PDF.
- Off by default; requires either a local model download or a user-entered API key; clear privacy notice that text leaves the device when using an API.

---

## J. App-level features
| Feature | Priority |
|---------|----------|
| Home dashboard with tool grid + category filter chips + search | Must |
| Recent files / recent outputs | Must |
| Built-in PDF viewer (open any PDF, thumbnails, zoom, search) | Should |
| Settings: default output folder, naming pattern, theme (light/dark/system), language, compress defaults, OCR languages | Must |
| Explorer context menu "Open with PDFForge / Merge with PDFForge" | Could |
| Keyboard shortcuts (Ctrl+O open, Ctrl+K tool search, Ctrl+Enter run) | Should |
| Localization (English first; Tamil, Hindi later) | Should |
| Auto-update (opt-in) | Should |
| Job history with re-run | Could |
