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
- PDF/A (D5): pikepdf + veraPDF validation, or skipped if that is not reliable enough.
- PDF → Word (D2): own converter on pdfplumber + python-docx.
- OCR (B3) and camelot: use only code paths that do not require Ghostscript (re-check in Phase 2).
- New dependencies are checked against this rule before they are added.

## 4. Obligations checklist
- [ ] Ship `THIRD_PARTY_NOTICES.txt` with all licenses; show it in Settings → About.
- [ ] Provide source/offer for any LGPL/MPL/AGPL components as required.
- [ ] Privacy policy stating local-only processing (needed for any store listing).
- [ ] EULA in the installer.
- [ ] Unlock tool limited to files the user has the password/right to open.
