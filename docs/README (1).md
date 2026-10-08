# PDFForge — Requirements Pack

> Working name: **PDFForge** (placeholder — pick your own). A desktop, offline-first PDF toolkit for Windows, distributed as an `.exe` installer, offering the common feature set of online PDF suites (merge, split, compress, convert, edit, secure).

## Documents in this pack

| # | File | What it covers |
|---|------|----------------|
| 1 | [01_PRD.md](01_PRD.md) | Product vision, goals, users, scope, success metrics |
| 2 | [02_FEATURES.md](02_FEATURES.md) | Every tool: inputs, options, outputs, acceptance criteria |
| 3 | [03_ARCHITECTURE.md](03_ARCHITECTURE.md) | Tech stack, process model, modules, data flow, folder layout |
| 4 | [04_UI_UX.md](04_UI_UX.md) | Screens, navigation, components, interaction flows |
| 5 | [05_NON_FUNCTIONAL.md](05_NON_FUNCTIONAL.md) | Performance, security, privacy, reliability, accessibility |
| 6 | [06_BUILD_AND_PACKAGING.md](06_BUILD_AND_PACKAGING.md) | Dev setup, bundling dependencies, building the `.exe`, signing, updates |
| 7 | [07_TESTING.md](07_TESTING.md) | Test strategy, test corpus, CI |
| 8 | [08_ROADMAP.md](08_ROADMAP.md) | Phased milestones (MVP → v1.0 → v2) |
| 9 | [09_LICENSING.md](09_LICENSING.md) | Third-party licenses, branding/IP rules |

## One-paragraph summary

A Tauri 2 desktop app (React + TypeScript UI) talks to a bundled Python "engine" process that performs PDF operations using open-source libraries (pikepdf/qpdf, pypdf, pdfplumber, pdf2docx, Pillow, OCRmyPDF/Tesseract) plus bundled LibreOffice (Office → PDF) and Ghostscript (compression, PDF/A). Everything runs locally — no uploads, no account. Output is a signed Windows installer (`PDFForge-Setup-x.y.z.exe`) built with the Tauri bundler (NSIS).

## Important note on branding

Recreate the **functionality**, not the brand. Do not copy the iLovePDF name, heart logo, icons, color scheme, or marketing copy. See [09_LICENSING.md](09_LICENSING.md).
