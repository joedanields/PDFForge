# 06 — Build, Packaging & Release (.exe)

## 1. Developer prerequisites (Windows)
- Node.js 20 LTS + pnpm
- Rust (stable, MSVC toolchain) + `cargo install tauri-cli --version "^2"`
- Visual Studio 2022 Build Tools (C++ workload)
- Python 3.12 (64-bit) + `uv` or `pip`/venv
- Git
- WebView2 runtime (preinstalled on Win 11)

## 2. Repository layout
```
pdfforge/
├── app/                 # Tauri + React
│   ├── src/             # React UI
│   ├── src-tauri/       # Rust, tauri.conf.json, icons, capabilities
│   └── package.json
├── engine/              # Python sidecar (see 03)
│   ├── pyproject.toml
│   └── engine.spec      # PyInstaller spec
├── vendor/              # NOT committed; fetched by script
│   ├── libreoffice/     # portable LibreOffice (program/ only, trimmed)
│   ├── ghostscript/
│   └── tesseract/       # + tessdata (eng by default)
├── scripts/
│   ├── fetch-vendor.ps1 # downloads + checksums vendor binaries
│   ├── build-engine.ps1
│   └── build-all.ps1
├── tests/corpus/        # sample PDFs/Office files (07)
└── docs/                # this requirements pack
```

## 3. Engine dependencies (`engine/pyproject.toml`)
```
pikepdf, pypdf, pypdfium2, pdfplumber, pdf2docx, python-docx,
python-pptx, openpyxl, img2pdf, Pillow, pillow-heif, reportlab,
ocrmypdf, pyhanko, camelot-py (optional)
```

## 4. Build steps
1. `scripts/fetch-vendor.ps1` — download LibreOffice, Ghostscript, Tesseract; verify SHA-256; trim unneeded LibreOffice components (help, extensions, Java) to shrink size.
2. `scripts/build-engine.ps1`
   ```powershell
   cd engine
   pyinstaller engine.spec --noconfirm
   # output: dist/engine/engine.exe (onedir is faster to start than onefile)
   copy dist\engine\engine.exe ..\app\src-tauri\binaries\engine-x86_64-pc-windows-msvc.exe
   ```
   Tauri sidecars require the target-triple suffix in the file name.
3. Configure `app/src-tauri/tauri.conf.json`:
   ```json
   {
     "productName": "PDFForge",
     "identifier": "com.yourname.pdfforge",
     "bundle": {
       "active": true,
       "targets": ["nsis"],
       "externalBin": ["binaries/engine"],
       "resources": {
         "../../vendor/libreoffice": "vendor/libreoffice",
         "../../vendor/ghostscript": "vendor/ghostscript",
         "../../vendor/tesseract": "vendor/tesseract"
       },
       "fileAssociations": [{ "ext": ["pdf"], "name": "PDF Document", "role": "Viewer" }],
       "windows": {
         "webviewInstallMode": { "type": "embedBootstrapper" },
         "nsis": { "installMode": "currentUser", "languages": ["English"] }
       }
     }
   }
   ```
   (If PyInstaller is built in *onedir* mode, ship the whole `engine/` folder as a resource and launch it via its path instead of `externalBin`.)
4. `cd app && pnpm install && pnpm tauri build`
5. Output: `app/src-tauri/target/release/bundle/nsis/PDFForge_x.y.z_x64-setup.exe`

`scripts/build-all.ps1` runs steps 1–4 end to end.

## 5. Code signing
- Obtain an OV/EV code-signing certificate (or Azure Trusted Signing) — unsigned installers trigger SmartScreen warnings.
- Sign `engine.exe`, the app exe, and the installer (`signtool sign /fd sha256 /tr <timestamp-url> /td sha256 ...`). Tauri can sign automatically via `bundle.windows.certificateThumbprint` or a custom `signCommand`.

## 6. Auto-update
- Tauri updater plugin with a signed `latest.json` hosted on GitHub Releases or your server.
- Opt-in in Settings; never auto-restart during a running job.

## 7. Versioning & release
- SemVer. Single source of version in `tauri.conf.json`; engine reports its version at handshake and the app refuses mismatched engines.
- Release checklist: all tests green → build on clean CI runner → sign → smoke test installer on clean Win 10 & Win 11 VMs → publish notes + `THIRD_PARTY_NOTICES.txt`.

## 8. CI (GitHub Actions, `windows-latest`)
- Jobs: lint → engine unit tests → UI unit tests → fetch vendor (cached) → build engine → tauri build → E2E smoke on built app → upload installer artifact.
