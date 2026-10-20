# Progress log

> Autonomous runs 2026-10-18 → 2026-10-19 (Phases 1–3) and 2026-10-19 → 2026-10-20 (review follow-ups + Phase 4).

## Summary for the owner (latest run 2026-10-19 → 2026-10-20)

**Done: every item of the review list.** 32 product tools are available, and no tile says "Coming soon"; only the three opt-in Intelligence tools (v2) remain unbuilt.

- **Licensing compliance** — The installer ships a `licenses\` folder: JBIG-KIT 2.1 and GNU libiconv 1.17 source (upstream tarballs + MSYS2 recipe + SHA256SUMS) and a 3-year written offer covering every GPL/LGPL/MPL component. `THIRD_PARTY_NOTICES.txt` is regenerated from the real dependency tree (now including pyHanko, the updater and winreg). Settings → About → *Third-party licences* / *Licences and source code* (D-035).
- **Redaction UX** — The Result screen explains that redacted pages became images. "Run OCR on non-redacted areas" is on by default; when it was off, a button restores searchable text afterwards (D-036).
- **Phase 4, in roadmap order:**
  - Batch mode: up to 500 files or a folder, per-file status, retry (D-037).
  - Workflows builder: saved chains, drag-reorder, run on files or a folder (D-038).
  - Fill PDF Forms: fill and optionally flatten (D-039).
  - Explorer context menu: Open / Merge with PDFForge, per user, no admin (D-040).
  - Digital certificate signing: your own PFX/P12, pyHanko (D-041).
  - Tamil and Hindi UI (D-042).
- **Web Page to PDF** — HTML from a URL. This is the only tool that uses the internet: it has a badge and a banner, and asks for confirmation the first time (D-043).
- **Auto-update** — The Tauri updater is fully wired but off: the build has no endpoint and the start-up check is opt-in. What you provide and the exact commands are in [06 §6](06_BUILD_AND_PACKAGING.md#6-auto-update). A dev key pair is in the git-ignored `.keys/` folder; the private key is not committed (D-044).
- **Installer size** — **184.6 MB → 167.5 MB** (176.1 → 159.7 MiB), even with the new features. Three changes did it: debug info stripped from `libtesseract-5.dll` (97 MB → 4 MB), LibreOffice's Libertine G fonts dropped, and a 64 MB LZMA dictionary. I also fixed a LibreOffice profile-cache bug that showed up after updates (D-045).

**Needs you before distributing** (nothing was blocked; these are owner decisions):
1. `licenses/WRITTEN_OFFER.txt` contains `<CONTACT ADDRESS …>`: put a real postal or e-mail address there (09 §4).
2. Updates: create your own release key pair, replace `plugins.updater.pubkey`, and set the endpoint (06 §6). Until then builds never look for updates.
3. Code signing: the build is unsigned; set `PDFFORGE_SIGN_THUMBPRINT` (06 §5).
4. Have a native speaker review the Tamil and Hindi texts. Messages from the PDF engine and the numeric result summaries are still in English (D-042).

**Known limits / not done:**
- Explorer starts one process per selected file, so "Merge with PDFForge" from Explorer works for up to 15 files. For more, use batch mode or "Add a folder" (D-040).
- On Windows 11 the menu entries sit under "Show more options".
- Flattening forms supports Latin text only (D-039).
- The Lite installer with on-demand components (roadmap Phase 4, not in this task list) is not built; D-045 estimates ~70 MB for it.
- PDF/A-1b is still not offered (D-024).
- `vendor/_exp` (~2 GB) holds old LibreOffice trim experiments. It is git-ignored, not shipped, and safe to delete.

**Decisions** — every entry in [DECISIONS.md](DECISIONS.md) (question → see the file for the choice and reason):

  - **D-001** — "Commit Phase 0 as one clean initial commit" vs. the eight Phase 0.1–0.8 commits requested the day before
  - **D-002** — How to apply the per-job memory cap (05 S6) when jobs ran as threads
  - **D-003** — What happens to password/permission protection of inputs
  - **D-004** — Single-file vs. many files for Phase 1 single-document tools
  - **D-005** — Where multi-file results go (Split, Extract "one per page", PDF→Image, Image→PDF "one per image")
  - **D-006** — HEIC support (C1) without GPL code
  - **D-007** — Fonts for page numbers / watermarks
  - **D-008** — Compress when the result is not smaller (02 B1 "keep the original")
  - **D-009** — Compress algorithm without Ghostscript
  - **D-010** — Commit authorship pattern
  - **D-011** — Contents of THIRD_PARTY_NOTICES.txt
  - **D-012** — Which LibreOffice to bundle, and how to unpack it without installing it
  - **D-013** — Where the Tesseract binaries come from
  - **D-014** — LibreOffice took 12–20 s per document
  - **D-015** — Commit granularity in Phase 2
  - **D-016** — File names of format conversions
  - **D-017** — Excel → PDF "fit sheet to page width" and "active sheet only"
  - **D-018** — PDF → Excel modes (02 D4: "detect tables / one sheet per page / one sheet total")
  - **D-019** — PDF → PowerPoint layout (02 D3 "image + extracted text boxes")
  - **D-020** — PDF → Text format
  - **D-021** — Text → PDF with characters outside the standard fonts
  - **D-022** — What counts as "recovered" in Repair (02 B2)
  - **D-023** — HTML → PDF engine (02 C5: "Chromium (WebView2 print) / wkhtmltopdf alternative")
  - **D-024** — PDF/A without Ghostscript (02 D5, 09 §3: "pikepdf + veraPDF validation, or skipped")
  - **D-025** — Job start-up got slower with every Phase 2 tool (each job is a fresh worker process, D-002)
  - **D-026** — OCR without OCRmyPDF / Ghostscript
  - **D-027** — OCR languages and the "language pack manager"
  - **D-028** — Built-in viewer and "Open with PDFForge" (02 §J Should, 06 §4: association with the viewer)
  - **D-029** — How Edit PDF stores what the user adds (02 E1: "flattened into page content (option: keep as annotations)")
  - **D-030** — How signatures are made, stored and applied (02 F3)
  - **D-031** — What Crop does to the content outside the area (02 E4)
  - **D-032** — True redaction without MuPDF (02 F4: "underlying text/images must be removed … verified by test")
  - **D-033** — What Compare compares and produces (02 F5, 04 §2.7)
  - **D-034** — Auto-update for v1.0 (08 Phase 3 exit, 02 §J "opt-in")
  - **D-035** — How to meet the source obligations of the copyleft libraries inside the Tesseract build (JBIG-KIT GPL-2.0, libiconv LGPL-2.1)
  - **D-036** — Redaction UX follow-up to D-032: how to tell users that redacted pages become images, and how to restore search
  - **D-037** — How batch mode runs (02 §H: "select many files → process each independently, with a per-file status list")
  - **D-038** — How workflows are stored and run (02 §G)
  - **D-039** — Fill PDF Forms (02 E5): how fields are read and written
  - **D-040** — Explorer context menu (02 §J) without admin rights
  - **D-041** — Digital certificate signing (02 F3 "Could")
  - **D-042** — Tamil and Hindi UI (02 §J) — what is translated and how
  - **D-043** — HTML → PDF from a URL (02 C5 "URL*: the only feature that may use the network; clearly labeled and user-initiated")
  - **D-044** — Auto-update (02 §J "opt-in", follow-up to D-034)
  - **D-045** — Reducing the 184.6 MB installer without breaking anything

Most important for you: **D-035** (source offer, contact address needed), **D-043** (the one online feature), **D-044** (updater: what you must provide), **D-045** (what was trimmed), **D-042** (translation scope), **D-010** (commit authorship pattern).

**Installer**: `app\src-tauri\target\release\bundle\nsis\PDFForge_0.1.0_x64-setup.exe` — **167.5 MB (159.7 MiB)**, was 184.6 MB. It includes LibreOffice, Tesseract and the `licenses\` folder. The build is unsigned; set `PDFFORGE_SIGN_THUMBPRINT` to sign.

**Run and test the latest build** (PowerShell, repository root):

```powershell
# full rebuild from scratch (vendor download/verify/trim incl. source archives, engine freeze, installer)
.\scripts\build-all.ps1
# all quality gates (engine lint/types/tests, UI lint/types/tests, Rust fmt/clippy/tests)
bash scripts/check.sh
# smoke-test the built app: start it with a debug port, then drive it
cd engine; uv run python -m tests.make_e2e_inputs $env:TEMP\pdfforge-e2e; cd ..
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
Start-Process .\app\src-tauri\target\release\pdfforge.exe
cd app; node e2e/release-smoke.mjs $env:TEMP\pdfforge-e2e      # Echo + 34 tool jobs
# or the full UI smoke against the dev app (pnpm tauri dev with the same debug port):
node e2e/smoke.mjs $env:TEMP\pdfforge-e2e                       # 37 sections
```

Last verified: 2026-10-20. Full gates green (483 pytest, 110 vitest, 37 Rust tests). The release smoke in the final built exe passed for Echo + all 34 tool jobs, including fill-forms, workflow, certificate signing and Web Page to PDF. The full UI smoke passed: 37 sections, 176 checks. The updater check was also verified against a local signed test endpoint.


## Now

- **Current phase:** none — Phases 1–3, the review follow-ups and the requested Phase 4 items are done
- **Working on:** Nothing; waiting for the owner (see "Needs you" above)

## Phase 4 — Power features + review follow-ups (run 2026-10-19)

| Item | Status | Tests | Commit | Notes |
|------|--------|-------|--------|-------|
| 3.7 Licensing compliance: source archives, written offer, licences folder | done | test_licenses (3) | 9e3fc2b | JBIG-KIT + libiconv source shipped in `licenses\source`; contact address left for the owner; D-035 |
| 3.8 Redaction UX: rebuilt-page explanation, "Run OCR on non-redacted areas" | done | test_redact (+1), vitest ResultCard (3), smoke `redact` | ee8ce25 | D-036 |
| 4.1 Batch mode (H) | done | vitest batch (3), Rust list_folder (1), smoke `batch` | f96848e | one job per file, 2 at a time, per-file status, retry failed, add a folder; D-037 |
| 4.2 Workflows builder (G) | done | test_workflow (9), vitest workflows (5), Rust workflows (3), smoke `workflows` | 69ab94c | builder with drag-reorder and inline options, run on files or a folder, example workflow; D-038 |
| 4.3 Fill PDF Forms (E5) | done | test_fill_forms (9), vitest formFields (3), smoke `forms` | c132998 | text, multi-line, check box, radio, choice; only changed fields written; optional flatten; D-039 |
| 4.4 Explorer context menu (per user, no admin) | done | Rust contextmenu (3) + launch (+1), smoke `explorer` | 6fa60e0 | Open / Merge with PDFForge; installer adds, uninstaller removes, Settings toggle; D-040 |
| 4.5 Digital certificate signing (F3, pyHanko) | done | test_cert_sign (7), smoke `certsign` | 8cc9d26 | own PFX/P12, invisible signature after the visible items, offline; D-041 |
| 4.6 Tamil and Hindi UI | done | vitest i18n (5), Rust settings (+1), smoke `language` | 687b797 | language picker; every key, tool and option translated; engine messages stay English; D-042 |
| 4.7 HTML → PDF from URL ("Web Page to PDF") | done | test_url_to_pdf (10), vitest registry, smoke `web` | ab9e29c | the only online tool: badge, banner, first-time confirmation; scoped network allowance; D-043 |
| 4.8 Auto-update (Tauri updater, off by default) | done | Rust updater (2) + settings, smoke `updates` (default and with a signed test endpoint) | 8f43f9d | endpoint + key from config, opt-in start-up check, dev key pair in git-ignored .keys/, owner steps in 06 §6; D-044 |
| 4.9 Installer size + notices + release smoke | done | test_office (+1), release smoke 35 checks, full UI smoke 37 sections | 943238d | 184.6 MB → 167.5 MB: stripped libtesseract debug info, dropped Libertine G fonts, 64 MB LZMA dictionary; LibreOffice profile template keyed to the install; notices regenerated (pyHanko, updater, winreg); D-045 |

## Phase 3 — Editing & security

| Tool | Status | Tests | Commit | Notes |
|------|--------|-------|--------|-------|
| 3.0 Built-in viewer + "Open with PDFForge" (.pdf association) | done | Rust launch (2), smoke `viewer` | 5c70b0d | pdf.js viewer: thumbnails, zoom, find, page navigation, hand-off to tools; D-028 |
| 3.1 Edit PDF (E1) | done | test_edit_pdf (13), vitest editor (7), smoke `edit` | 2cbf204 | editor: text, pictures, shapes, arrows, pen, highlighter, notes, eraser, undo/redo, zoom; flatten or annotations; D-029 |
| 3.2 Sign PDF (F3) | done | test_sign (6), Rust signatures (3), smoke `sign` | f4ba28d | type / draw / upload, initials, date, text; DPAPI-encrypted saved signatures; D-030 |
| 3.3 Crop PDF (E4) | done | test_crop (9), smoke `crop` | e241ba6 | draw the area with corner handles, this page / all pages, auto-trim white margins; D-031 |
| 3.4 Redact PDF (F4) — true redaction | done | test_redact (9), vitest redactSearch (4), smoke `redact` | 2aa1ce9 | redacted pages rebuilt from pixels (+ OCR); search with email/phone/PAN/Aadhaar presets; D-032 |
| 3.5 Compare PDF (F5) | done | test_compare (6), smoke `compare` | 5870417 | word-level diff, synced panes, change list, pixel overlay, annotated report; D-033 |
| 3.6 Phase 3 installer, notices, release smoke (v1.0 exit) | done | full suite + release smoke (Echo + all 31 tools in the built exe) | (this commit) | auto-update deferred to the owner (D-034); dark mode present |

## Phase 2 — Conversions (done)

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
| 2.8 Notices, Phase 2 installer + release smoke | done | full suite + release smoke (Echo + all 25 tools in the built exe) | 820f6da | installer 184.5 MB (176 MiB) incl. LibreOffice + Tesseract; notices cover vendor/ (D-013) |

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

- Review [DECISIONS.md](DECISIONS.md) — in particular D-013 (GPL/LGPL DLLs inside the Tesseract
  build; source now shipped, D-035) and the contact address in `licenses/WRITTEN_OFFER.txt`.
- Added in the 2026-10-19 → 20 run (nothing system-wide):
  - Engine dependency **pyHanko 0.38** (MIT), with pyhanko-certvalidator, asn1crypto, oscrypto,
    tzlocal, uritools (MIT), aiohttp and its helpers (Apache-2.0/MIT) and certifi (MPL-2.0).
  - Rust crates **tauri-plugin-updater 2.14** (Apache-2.0/MIT) and **winreg 0.55** (MIT).
  - Source archives downloaded to `vendor/source-archives` (git-ignored, shipped as
    `licenses/source`).
  - A development updater key pair in `.keys/` (git-ignored).
  - The build now uses GNU `strip` from the existing MinGW toolchain on PATH, with the Rust
    toolchain's `rust-objcopy` as fallback, to strip libtesseract. Nothing new was installed.
- Testing touched per-user state on the dev machine only through the app itself: the dev
  app's settings.json (language/theme switched and restored), and no Explorer registry entries
  (the smoke test only reads the setting).
- Installed for the build (inside the repo, nothing system-wide): 7-Zip 26.04 extracted to
  `vendor/_tools/7zip` (only used to unpack the Tesseract installer). Python packages added to
  the engine: python-docx, python-pptx, openpyxl (+ stub packages lxml-stubs, types-openpyxl
  for type checking). Rust crate added: tauri-plugin-single-instance (MIT/Apache-2.0).
- Development-only validator (not shipped, git-ignored): Eclipse Temurin JRE 21.0.12 (zip,
  SHA-256 checked against Adoptium) in `vendor/_tools/jre` and veraPDF 1.30.3 (headless
  installer) in `vendor/_tools/verapdf`. Tests use them when present to validate PDF/A output.
