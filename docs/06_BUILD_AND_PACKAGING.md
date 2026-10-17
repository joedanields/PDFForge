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
2. `scripts/build-engine.ps1` — freezes the engine with PyInstaller in **onedir** mode
   (faster start than onefile), smoke-tests it with a `hello` handshake, and stages the whole
   folder for bundling:
   ```powershell
   cd engine
   uv sync --frozen
   uv run pyinstaller engine.spec --noconfirm --clean
   # output: dist/engine/engine.exe + dist/engine/_internal/
   # copied to app/src-tauri/resources/engine/ (git-ignored except .gitkeep)
   ```
   The engine is **not** a Tauri `externalBin` sidecar: a onedir `engine.exe` cannot run without
   its `_internal/` folder, so the whole folder ships as a resource and the Rust shell starts
   `resource_dir()/engine/engine.exe` itself (with `CREATE_NO_WINDOW`).
   In dev builds (`pnpm tauri dev`) the shell instead runs `uv run python main.py` in `engine/`.
3. `app/src-tauri/tauri.conf.json` (relevant parts):
   ```json
   {
     "productName": "PDFForge",
     "identifier": "com.joedaniel.pdfforge",
     "bundle": {
       "active": true,
       "targets": ["nsis"],
       "resources": {
         "resources/engine/": "engine/",
         "../../THIRD_PARTY_NOTICES.txt": "THIRD_PARTY_NOTICES.txt"
       },
       "windows": {
         "webviewInstallMode": { "type": "embedBootstrapper" },
         "nsis": { "installMode": "currentUser", "languages": ["English"] }
       }
     }
   }
   ```
   Phase 0: the `vendor/` folders (LibreOffice, Tesseract; Ghostscript pending the AGPL decision
   in 09 §3) are added to `resources` in Phase 2. The `.pdf` file association is added together
   with the built-in viewer (Phase 3), so "Open with PDFForge" never lands on a dead end.
4. `cd app && pnpm install --frozen-lockfile && pnpm tauri build --bundles nsis`
5. Output: `app/src-tauri/target/release/bundle/nsis/PDFForge_x.y.z_x64-setup.exe`

`scripts/build-all.ps1` runs steps 1–4 end to end, after checking that the version in
`tauri.conf.json` matches `Cargo.toml`, `package.json` and `engine/protocol.py`
(`-SkipEngine` reuses an already staged engine).

## 5. Code signing
- Obtain an OV/EV code-signing certificate (or Azure Trusted Signing) — unsigned installers trigger SmartScreen warnings.
- Sign `engine.exe`, the app exe, and the installer (`signtool sign /fd sha256 /tr <timestamp-url> /td sha256 ...`). Tauri can sign automatically via `bundle.windows.certificateThumbprint` or a custom `signCommand`.
- Implemented as opt-in: builds are **unsigned by default**. Set `PDFFORGE_SIGN_THUMBPRINT`
  (SHA-1 thumbprint of a certificate in the Windows store; optional `PDFFORGE_SIGN_TIMESTAMP_URL`,
  default DigiCert) and `build-engine.ps1` signs `engine.exe` with signtool while `build-all.ps1`
  passes `certificateThumbprint` to `tauri build`, which signs the app exe and the installer.
  Without it the scripts print an **UNSIGNED BUILD** warning before and after the build.

## 6. Auto-update
- Tauri updater plugin with a signed `latest.json` hosted on GitHub Releases or your server.
- Opt-in in Settings; never auto-restart during a running job.

## 7. Versioning & release
- SemVer. Single source of version in `tauri.conf.json`; engine reports its version at handshake and the app refuses mismatched engines.
- Release checklist: all tests green → build on clean CI runner → sign → smoke test installer on clean Win 10 & Win 11 VMs → publish notes + `THIRD_PARTY_NOTICES.txt`.

## 8. CI (GitHub Actions, `windows-latest`)
- Jobs: lint → engine unit tests → UI unit tests → fetch vendor (cached) → build engine → tauri build → E2E smoke on built app → upload installer artifact.
