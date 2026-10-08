# 01 — Product Requirements Document (PRD)

## 1. Vision
Give everyday users and professionals one fast, private desktop app that does every common PDF task in a few clicks — fully offline, with no file ever leaving the machine.

## 2. Problem
- Online PDF tools require uploading sensitive documents to third-party servers.
- Free tiers impose file-size limits, task limits, watermarks and ads.
- Desktop alternatives (e.g., full Acrobat) are expensive and heavy.

## 3. Goals
| ID | Goal | Metric |
|----|------|--------|
| G1 | Cover the core tool set of online PDF suites | ≥ 25 tools at v1.0 |
| G2 | 100% offline processing | Zero network calls during processing (verified by test) |
| G3 | Fast | Merge 10 × 10-page PDFs < 2 s on a mid-range PC |
| G4 | Simple | Any tool completable in ≤ 4 clicks after file selection |
| G5 | Easy to install | Single `.exe` installer, no admin rights required (per-user install) |

## 4. Non-goals (v1)
- Cloud storage, accounts, sync, team features.
- Mobile apps / "Scan to PDF" from phone camera.
- Full desktop-publishing-level PDF editing (reflowing existing text).
- macOS/Linux builds (architecture keeps them possible later).

## 5. Target users
| Persona | Needs |
|---------|-------|
| Office worker | Merge reports, convert Word/Excel ↔ PDF, compress for email |
| Student | Combine scans, convert slides, add page numbers |
| Legal / HR / Finance | Protect, redact, sign, watermark, compare versions — privately |
| Power user | Batch processing, workflows (chained tools), keyboard shortcuts |

## 6. Tool scope (summary — details in 02_FEATURES.md)

**Organize:** Merge, Split, Remove pages, Extract pages, Organize/Reorder, Rotate
**Optimize:** Compress, Repair, OCR
**Convert to PDF:** JPG/PNG/Image → PDF, Word → PDF, PowerPoint → PDF, Excel → PDF, HTML → PDF
**Convert from PDF:** PDF → JPG/PNG, PDF → Word, PDF → PowerPoint, PDF → Excel, PDF → PDF/A, PDF → Text
**Edit:** Edit PDF (add text/images/shapes/draw), Add page numbers, Add watermark, Crop, Fill forms
**Security:** Protect (password), Unlock, Sign, Redact, Compare
**Workflows:** Chain multiple tools into a saved, reusable pipeline
**Intelligence (optional, v2):** Summarize, Translate — via a local model or user-supplied API key, off by default

## 7. Priority (MoSCoW)
- **Must:** Merge, Split, Remove/Extract pages, Organize, Rotate, Compress, Image↔PDF, Word/PPT/Excel→PDF, PDF→Word, Protect, Unlock, Page numbers, Watermark
- **Should:** OCR, PDF→Excel, PDF→PowerPoint, PDF/A, Repair, Edit PDF, Sign, Crop, HTML→PDF
- **Could:** Redact, Compare, Workflows, Batch mode, Fill forms
- **Won't (v1):** AI summarize/translate, scan from phone

## 8. User stories (representative)
- As a user, I drag 5 PDFs into the Merge tool, reorder thumbnails, click **Merge**, and get one PDF saved next to the originals.
- As a user, I compress a 40 MB PDF to under 10 MB choosing "Recommended" level and see the before/after size.
- As a user, I convert a `.docx` to PDF without having Microsoft Office installed.
- As a user, I protect a PDF with a password and choose whether printing/copying is allowed.
- As a user, I open recent outputs from the Home screen.
- As a power user, I build a workflow "Merge → Compress → Add page numbers → Protect" and re-run it on new files.

## 9. Success metrics
- Crash-free sessions ≥ 99.5%.
- Tool success rate ≥ 98% on the test corpus (07_TESTING.md).
- Installer size ≤ 450 MB (LibreOffice is the main contributor; see 06).
- Cold start ≤ 3 s.

## 10. Assumptions & constraints
- Target OS: Windows 10 (21H2+) and Windows 11, x64.
- Must work with no internet after install.
- Third-party engines must have licenses compatible with distribution (09_LICENSING.md).
