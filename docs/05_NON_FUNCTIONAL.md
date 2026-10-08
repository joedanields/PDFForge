# 05 — Non-Functional Requirements

## 1. Performance
| ID | Requirement |
|----|-------------|
| P1 | Cold start to interactive Home ≤ 3 s (SSD, 8 GB RAM, 4-core CPU) |
| P2 | First thumbnail visible ≤ 500 ms after drop for a 100-page PDF |
| P3 | Merge 10 × 10-page PDFs ≤ 2 s; split 500-page PDF into single pages ≤ 10 s |
| P4 | Compress 50 MB image-heavy PDF (Recommended) ≤ 30 s |
| P5 | DOCX (50 pages) → PDF ≤ 15 s incl. LibreOffice start |
| P6 | OCR ≤ 4 s/page at 300 dpi, using all cores |
| P7 | Handle files up to 2 GB / 5,000 pages without crashing (streaming, no full-file RAM load where possible) |
| P8 | Idle RAM ≤ 250 MB; engine idle CPU ≈ 0% |

## 2. Privacy & security
| ID | Requirement |
|----|-------------|
| S1 | No document content, file names or metadata leave the device. No telemetry by default; any crash reporting is opt-in and strips paths. |
| S2 | Only network uses: update check (opt-in), HTML-from-URL, optional AI features — each clearly labeled. |
| S3 | Temp files written to per-job folder, deleted on completion/cancel and swept at startup. |
| S4 | Passwords never logged or persisted. Saved signatures encrypted via Windows DPAPI. |
| S5 | Redaction removes underlying content (verified by tests). |
| S6 | Treat input files as untrusted: run parsing in the sandboxed engine process, enforce per-job timeouts and memory caps, disable JavaScript execution in PDFs, disable LibreOffice macros (`--norestore`, macro security high). |
| S7 | External binaries resolved from install dir only; installer and all executables code-signed. |
| S8 | Tauri: strict CSP, allowlist only required commands, no remote content in the main WebView. |
| S9 | Unlock tool requires the correct password for user-password files; no brute-force features. |

## 3. Reliability
- Crash-free sessions ≥ 99.5%.
- Engine crash → auto-restart, user sees "Job failed, please retry" — app stays open.
- Outputs written to a temp name then atomically renamed (no half-written files).
- Never modify input files in place.

## 4. Compatibility
- Windows 10 21H2+ / Windows 11, x64 (ARM64 later).
- WebView2 runtime: bootstrapper bundled in installer.
- PDF input: versions 1.0–2.0, linearized, encrypted (RC4/AES), with XFA (read-only, may be unsupported for edit).
- Output PDFs open correctly in Acrobat Reader, Edge, Chrome, Foxit.

## 5. Usability
- Any tool usable without reading docs; first-run tooltip tour (skippable).
- All text externalized for localization; RTL-safe layout not required in v1.

## 6. Maintainability
- Tool registry pattern: new tool = registry entry + engine function + tests.
- Code style: ESLint + Prettier (TS), Ruff + Black + mypy (Python), clippy (Rust).
- ≥ 80% unit-test coverage on engine `tools/`.
- Structured logs (`%APPDATA%\PDFForge\logs`, rotating, 7 days, no document content).

## 7. Installability
- Per-user install without admin by default; optional all-users install.
- Clean uninstall removes program files; asks whether to delete settings/history.
- Installer ≤ 450 MB; offer "Lite" installer without LibreOffice/OCR (≈ 80 MB) with on-demand component download (Could).
