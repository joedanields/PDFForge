# 09 — Licensing, Branding & Legal

> Not legal advice — verify each license yourself (and with a lawyer if you plan to sell the app).

## 1. Branding / IP
- Build the **functionality** only. Do **not** reuse: the iLovePDF name or any confusingly similar name, the heart logo, their icon designs, their exact color scheme/layout styling, or their marketing text.
- Create original: app name, logo, icons (or use an openly licensed set such as Lucide — ISC, Phosphor — MIT), illustrations, copy.
- Check your chosen name for trademarks (e.g., IP India / WIPO Global Brand Database) and domain availability.

## 2. Third-party components
| Component | License | Notes |
|-----------|---------|-------|
| Tauri | MIT / Apache-2.0 | ✅ |
| React, Vite, Tailwind, Radix, dnd-kit, Zustand | MIT | ✅ |
| pdf.js | Apache-2.0 | ✅ |
| pdf-lib | MIT | ✅ |
| pikepdf | MPL-2.0 | ✅ keep notices; modifications to its files must stay MPL |
| qpdf | Apache-2.0 | ✅ |
| pypdf | BSD-3 | ✅ |
| pypdfium2 / PDFium | Apache-2.0 / BSD | ✅ |
| pdfplumber, pdfminer.six | MIT | ✅ |
| pdf2docx | MIT* | ⚠️ depends on **PyMuPDF (AGPL-3.0)** |
| PyMuPDF / MuPDF | AGPL-3.0 or commercial | ⚠️ |
| Ghostscript | AGPL-3.0 or commercial | ⚠️ |
| OCRmyPDF | MPL-2.0 | ✅ (uses Ghostscript for some features ⚠️) |
| Tesseract | Apache-2.0 | ✅ |
| LibreOffice | MPL-2.0 | ✅ redistribute unmodified with notices |
| python-docx, python-pptx, openpyxl | MIT | ✅ |
| Pillow | MIT-CMU (HPND) | ✅ |
| img2pdf | LGPL-3.0 | ✅ as separate library; keep notices |
| ReportLab (open source) | BSD | ✅ |
| pyHanko | MIT | ✅ |
| camelot | MIT | ✅ (may need Ghostscript ⚠️) |
| PyInstaller | GPL with bootloader exception | ✅ for distributing frozen apps |
| pi-heif (HEIC decoding) | BSD-3-Clause; bundles libheif + libde265 (LGPL-3.0) | ✅ decode-only build — no GPL x265 encoder (pillow-heif is used only in tests) |
| lxml (pikepdf dependency) | BSD-3-Clause; bundles libxml2/libxslt (MIT) | ✅ |
| charset-normalizer (ReportLab dependency) | MIT | ✅ |
| MinGW runtime DLLs (libgcc, libstdc++, libwinpthread; inside pikepdf / pi-heif wheels) | GPL-3.0 with GCC Runtime Library Exception 3.1 / MIT | ✅ runtime exception permits redistribution |
| Python runtime incl. OpenSSL, libffi, zlib | PSF-2.0, Apache-2.0, MIT, zlib | ✅ |
| Inter font (@fontsource-variable/inter) | OFL-1.1 | ✅ |
| Lucide icons, cmdk, dnd-kit, Zustand, zod, Radix | ISC / MIT | ✅ |
| Rust crates linked into the app (~250, incl. rusqlite/SQLite) | mostly MIT / Apache-2.0; a few BSD-3-Clause, MPL-2.0, Unicode-3.0 | ✅ |
| NSIS installer stub | zlib/libpng, bzip2, CPL-1.0 | ✅ |
| WebView2 bootstrapper (embedded in the installer) | Microsoft distribution terms | ✅ permitted redistribution |
| LibreOffice 26.2 (bundled in `vendor/`, Phase 2) | MPL-2.0 + bundled third-party licences | ✅ unmodified (only unused parts removed), runs as a separate program; its own license.txt is included in the notices |
| Liberation / Carlito / Caladea fonts (part of LibreOffice) | SIL OFL 1.1 | ✅ also embedded into PDF/A results as metric-compatible replacements for standard fonts (OFL permits embedding) |
| Tesseract OCR 5.4 + tessdata_fast models (eng, osd, tam, hin) | Apache-2.0 | ✅ separate program |
| Libraries inside the Tesseract Windows build (Leptonica, libtiff, libpng, libjpeg-turbo, libwebp, OpenJPEG, giflib, zlib, zstd, xz, lz4, bzip2, libarchive, libb2, libdeflate, expat, LERC, OpenSSL, GCC runtime, winpthreads) | BSD / MIT / zlib / libpng / IJG / Apache-2.0 / GPL-3.0 with GCC runtime exception | ✅ texts in `third_party/licenses/tesseract-runtime` |
| GNU libiconv (inside the Tesseract build) | LGPL-2.1-or-later | ✅ unmodified, separate library; source offer (§4) |
| JBIG-KIT (`libjbig`, inside the Tesseract build, pulled in by libtiff) | GPL-2.0-or-later | ⚠️ acceptable as part of a separate program (aggregation), **source offer required** (§4); see DECISIONS D-013 — replace with a libtiff built without JBIG if the owner prefers |
| python-docx, python-pptx, openpyxl, et-xmlfile | MIT | ✅ (Phase 2) |

`THIRD_PARTY_NOTICES.txt` is generated from what a build actually ships by
`scripts/generate_notices.py` (engine bundle analysis, production UI bundle, Rust dependency
graph, the vendored LibreOffice and Tesseract, installer parts). Since Phase 2 pdfplumber,
pdfminer.six and pypdf are used by tools and therefore shipped.

## 3. AGPL decision (choose one)
1. **Open-source your app under AGPL-3.0** — simplest if it's a free/personal project.
2. **Buy commercial licenses** from Artifex for Ghostscript and MuPDF — if selling closed-source.
3. **Avoid AGPL components:**
   - Compression → pikepdf + Pillow image recompression (no Ghostscript).
   - PDF/A → skip or implement with veraPDF validation + pikepdf.
   - PDF → Word → write your own converter on pdfplumber + python-docx instead of pdf2docx.

**Decision (recorded before Phase 1): option 3 — stay AGPL-free.**
- Not used or bundled: Ghostscript, MuPDF / PyMuPDF, pdf2docx (and anything that pulls them in).
- Compress (B1): pikepdf + Pillow — downsample images to the level's DPI, re-encode JPEG,
  optional grayscale, strip metadata, remove unused objects.
- PDF/A (D5): pikepdf (PDF/A-2b/3b); results validated with veraPDF on the development
  machine (not shipped: it needs Java). Files needing re-rendering are refused (DECISIONS D-024).
- PDF → Word (D2): own converter on pdfplumber + python-docx.
- OCR (B3): own pipeline — PDFium rendering + Tesseract's text-only PDF output laid over the
  page with pikepdf; no OCRmyPDF (it needs Ghostscript) (D-026). camelot is not used (its
  lattice mode needs Ghostscript); PDF → Excel uses pdfplumber (D-018).
- New dependencies are checked against this rule before they are added.

## 4. Obligations checklist
- [x] Ship `THIRD_PARTY_NOTICES.txt` with all licenses (generated from the real dependency tree by `scripts/generate_notices.py`, bundled in the installer); Settings → About → *Third-party licences* opens it.
- Tesseract: debug information is stripped from `libtesseract-5.dll` (Apache-2.0, allowed); the GPL/LGPL libraries are shipped unmodified (D-045).
- [x] Source / written offer for the copyleft components (D-035). The installer ships a `licenses\` folder (repo: `licenses/`, Settings → About → *Licences and source code* opens it):
  - `licenses\source\` — JBIG-KIT 2.1 upstream tarball + the MSYS2 `mingw-w64-jbigkit-2.1-5` recipe, GNU libiconv 1.17 upstream tarball + GNU signature, `SHA256SUMS.txt` (fetched and hash-checked by `scripts/fetch-vendor.ps1` into `vendor/source-archives`);
  - `licenses\WRITTEN_OFFER.txt` — 3-year written offer for the exact corresponding source of every GPL/LGPL/MPL component (JBIG-KIT, libiconv, GCC runtime, libheif/libde265, img2pdf, LibreOffice, pikepdf).
  - **Owner action:** replace `<CONTACT ADDRESS …>` in `licenses/WRITTEN_OFFER.txt` with a real postal or e-mail address before distributing.
- [ ] Privacy policy stating local-only processing (needed for any store listing).
- [ ] EULA in the installer.
- [ ] Unlock tool limited to files the user has the password/right to open.
