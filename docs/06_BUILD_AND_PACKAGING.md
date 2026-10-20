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
├── vendor/              # NOT committed; fetched by scripts/fetch-vendor.ps1
│   ├── libreoffice/     # portable LibreOffice 26.2 (program/ + share/, trimmed, ~490 MB)
│   ├── tesseract/       # Tesseract 5.4 runtime + tessdata: eng, osd, tam, hin (~134 MB)
│   └── _downloads/      # verified download cache (re-runs are offline)
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
1. `scripts/fetch-vendor.ps1` — download LibreOffice and Tesseract (no Ghostscript, 09 §3); verify SHA-256; trim unneeded LibreOffice components (help, extensions, Java) to shrink size.
   - Every download is pinned to a version and SHA-256 (LibreOffice: the `.sha256` published
     by The Document Foundation; 7-Zip: the GitHub release digest; Tesseract installer and
     tessdata_fast models: hashes recorded when pinned). 3 attempts with resume; a mismatch
     aborts the build. Files are cached in `vendor/_downloads`; each component writes a stamp
     and is skipped while the stamp matches (`-Force` rebuilds, `-Only libreoffice|tesseract`).
   - Nothing is installed system-wide: the LibreOffice MSI is unpacked with an
     administrative extract (`msiexec /a … TARGETDIR=…`, no registry, no elevation) and the
     Tesseract NSIS installer is unpacked with 7-Zip (itself extracted from its MSI the same
     way into `vendor/_tools`); the installers never run.
   - LibreOffice trim: UI translations, dictionaries/extensions, help, Java, the bundled
     Python, Base/Firebird, PDF import, galleries, templates, wizards, macros and all icon
     themes but one are removed. `presets/` must stay (it seeds new user profiles; without it
     LibreOffice hangs on first start). The metric-compatible fonts the MSI would install into
     `C:\Windows\Fonts` (Carlito, Caladea, Liberation…) move to `share/fonts/truetype`, the
     VC++ runtime next to `soffice.bin`.
   - Tesseract trim: only `tesseract.exe` and the DLLs it imports (import closure computed
     with pefile), `pdf.ttf` and `configs` for the text-only PDF renderer, plus the pinned
     tessdata_fast models.
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
   The `vendor/` folders are added for release builds only, by the overlay
   `app/src-tauri/tauri.vendor.conf.json` that `build-all.ps1` passes with `--config`; dev
   builds and CI lint/test jobs therefore compile without the vendor binaries. In the installed
   app they live at `<resources>/vendor/`, next to `<resources>/engine/`; the engine finds them
   relative to `engine.exe` (dev: the repo's `vendor/`; override: `PDFFORGE_VENDOR_DIR`).
   The `.pdf` file association is added together with the built-in viewer (Phase 3), so
   "Open with PDFForge" never lands on a dead end.
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
Implemented with the Tauri updater plugin (`tauri-plugin-updater`, `src-tauri/src/updater.rs`, D-044) and **off by default**, for two reasons:
1. A build only looks for updates when `plugins.updater.endpoints` in `tauri.conf.json` names an endpoint. The repository ships with `"endpoints": []`, and a Rust test fails if an endpoint is committed. Settings → Updates then says "Updates are not set up for this build".
2. With an endpoint, PDFForge still only checks on start if the user turns on **Settings → Updates → Check for updates when PDFForge starts**. "Check now" is always manual.

Installing is always user-initiated ("Install … and restart"). It is refused while a job is running, stops the engine, runs the NSIS installer in passive mode (per user, no admin) and restarts. Every update is verified against `plugins.updater.pubkey` (minisign) and must carry its signed version (`requireSignedVersion: true`), so an old genuine release cannot be served as a "new" one.

### What the owner provides
| Item | Where it goes |
|------|---------------|
| **Update signing key pair** (your own, *not* the dev key) | Public key → `plugins.updater.pubkey` in `app/src-tauri/tauri.conf.json` (commit it). Private key + password → a password manager / CI secret, **never** the repository. |
| **Endpoint URL** that serves `latest.json` | `plugins.updater.endpoints` in `tauri.conf.json`, or per build with `$env:PDFFORGE_UPDATE_ENDPOINT`. GitHub Releases: `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`. Own server: any HTTPS URL; `{{target}}`, `{{arch}}` and `{{current_version}}` placeholders are allowed. |
| **Hosting** for each release | The installer `PDFForge_<version>_x64-setup.exe`, its `.sig` and `latest.json`, at the URLs named in `latest.json`. |

### Commands
```powershell
# 1. Once: create your release key pair (keep the password; losing key or password ends updates)
cd app
pnpm tauri signer generate -w $HOME\.pdfforge\updater.key        # prompts for a password
Get-Content $HOME\.pdfforge\updater.key.pub                       # -> plugins.updater.pubkey

# 2. Every release: build with the private key -> installer + .sig
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $HOME\.pdfforge\updater.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<password>'
$env:PDFFORGE_UPDATE_ENDPOINT = 'https://github.com/<owner>/<repo>/releases/latest/download/latest.json'  # unless set in tauri.conf.json
powershell -File scripts\build-all.ps1

# 3. Write latest.json for this version, then upload installer, .sig and latest.json
python scripts\make_update_manifest.py --base-url https://github.com/<owner>/<repo>/releases/download/v<version> --notes "What changed"
$nsis = 'app\src-tauri\target\release\bundle\nsis'
gh release create v<version> "$nsis\PDFForge_<version>_x64-setup.exe" "$nsis\PDFForge_<version>_x64-setup.exe.sig" "$nsis\latest.json"
```
`build-all.ps1` adds `bundle.createUpdaterArtifacts` only when `TAURI_SIGNING_PRIVATE_KEY` is set, so ordinary builds need no key.

**Development key.** A throw-away pair was generated on the development machine: `.keys/updater-dev.key` (password `pdfforge-dev-only`) and `.keys/updater-dev.key.pub`. `.keys/` is git-ignored. Its public half is what `tauri.conf.json` holds today, so dev builds can test the full flow against a local server. **Replace the public key with your own before the first public release.**

## 7. Versioning & release
- SemVer. Single source of version in `tauri.conf.json`; engine reports its version at handshake and the app refuses mismatched engines.
- Release checklist: all tests green → build on clean CI runner → sign → smoke test installer on clean Win 10 & Win 11 VMs → publish notes + `THIRD_PARTY_NOTICES.txt`.

## 8. CI (GitHub Actions, `windows-latest`)
- Jobs: lint → engine unit tests → UI unit tests → fetch vendor (cached) → build engine → tauri build → E2E smoke on built app → upload installer artifact.
- Tauri bundler tools: `tauri build` downloads the NSIS toolset and the WebView2 bootstrapper
  into `%LOCALAPPDATA%\tauri` with a short timeout, which fails on slow links
  (`failed to bundle project: timeout: global`). CI caches that folder (`actions/cache`, key =
  hash of `scripts/fetch-tauri-tools.ps1`) and runs `scripts/fetch-tauri-tools.ps1` on every
  build, hit or miss. The script downloads missing files with retries and verifies them: the
  NSIS zip, `NSIS.exe` and `nsis_tauri_utils.dll` against the SHA-1 values pinned by
  tauri-bundler, and the bootstrapper by its Microsoft Authenticode signature (Microsoft updates
  that file, so a fixed hash would go stale). `build-all.ps1` runs the same script locally.
  When Tauri is upgraded, update the pinned NSIS version and hashes in the script.
