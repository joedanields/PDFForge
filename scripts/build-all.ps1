<#
.SYNOPSIS
  End-to-end release build: vendor -> engine -> UI + Rust -> NSIS installer.

.DESCRIPTION
  Steps (docs/06_BUILD_AND_PACKAGING.md §4):
    1. scripts/fetch-vendor.ps1
    2. scripts/build-engine.ps1
    3. pnpm install + pnpm tauri build (NSIS)
  Output: app/src-tauri/target/release/bundle/nsis/PDFForge_<version>_x64-setup.exe

  Code signing: set PDFFORGE_SIGN_THUMBPRINT (SHA-1 thumbprint of a certificate in the
  Windows certificate store) to sign engine.exe, the app exe and the installer.
  Optional PDFFORGE_SIGN_TIMESTAMP_URL (default http://timestamp.digicert.com).
  Without a thumbprint the build is UNSIGNED and SmartScreen will warn on install.
#>
[CmdletBinding()]
param(
    [switch]$SkipEngine
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $root 'app'
$signed = [bool]$env:PDFFORGE_SIGN_THUMBPRINT

function Invoke-Checked([string]$what, [scriptblock]$block) {
    # Native tools log progress to stderr; under 'Stop' Windows PowerShell 5.1 would treat that
    # as a terminating error. Judge success by exit code instead.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $block 2>&1 | ForEach-Object { "$_" } }
    finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

function Write-UnsignedWarning {
    Write-Host ''
    Write-Host '#####################################################################' -ForegroundColor Yellow
    Write-Host '#  UNSIGNED BUILD - PDFFORGE_SIGN_THUMBPRINT is not set.            #' -ForegroundColor Yellow
    Write-Host '#  The installer and executables are not code-signed; Windows       #' -ForegroundColor Yellow
    Write-Host '#  SmartScreen will warn users. Do not distribute this build.       #' -ForegroundColor Yellow
    Write-Host '#####################################################################' -ForegroundColor Yellow
    Write-Host ''
}

# --- version consistency (06 §7: tauri.conf.json is the single source) ---------------------
$conf = Get-Content (Join-Path $appDir 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = $conf.version
$cargoVersion = (Select-String -Path (Join-Path $appDir 'src-tauri\Cargo.toml') -Pattern '^version = "(.+)"' | Select-Object -First 1).Matches.Groups[1].Value
$pkgVersion = (Get-Content (Join-Path $appDir 'package.json') -Raw | ConvertFrom-Json).version
$engineVersion = (Select-String -Path (Join-Path $root 'engine\protocol.py') -Pattern '^ENGINE_VERSION = "(.+)"').Matches.Groups[1].Value
$mismatch = @{ 'Cargo.toml' = $cargoVersion; 'package.json' = $pkgVersion; 'engine/protocol.py' = $engineVersion }.GetEnumerator() |
    Where-Object { $_.Value -ne $version }
if ($mismatch) {
    $details = ($mismatch | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', '
    throw "Version mismatch: tauri.conf.json=$version but $details"
}
Write-Host "==> Building PDFForge $version" -ForegroundColor Cyan
if (-not $signed) { Write-UnsignedWarning }

# --- 1. vendor ----------------------------------------------------------------------------
& (Join-Path $PSScriptRoot 'fetch-vendor.ps1')

# --- 2. engine ----------------------------------------------------------------------------
if ($SkipEngine) {
    Write-Host '==> Skipping engine build (-SkipEngine)' -ForegroundColor Yellow
}
else {
    & (Join-Path $PSScriptRoot 'build-engine.ps1')
}
if (-not (Test-Path (Join-Path $appDir 'src-tauri\resources\engine\engine.exe'))) {
    throw 'Staged engine missing: run scripts/build-engine.ps1 first.'
}

# --- 3. app + installer -------------------------------------------------------------------
# NSIS + WebView2 bootstrapper, verified, so the bundler never hits its download timeout.
& (Join-Path $PSScriptRoot 'fetch-tauri-tools.ps1')
Push-Location $appDir
try {
    Write-Host '==> Installing UI dependencies' -ForegroundColor Cyan
    Invoke-Checked 'pnpm install' { pnpm install --frozen-lockfile }

    # Release builds bundle vendor/ (LibreOffice, Tesseract) through an overlay config, so
    # dev builds and CI lint/test jobs do not need the ~600 MB of vendor binaries.
    foreach ($component in @('libreoffice', 'tesseract', 'source-archives')) {
        if (-not (Test-Path (Join-Path $root "vendor\$component\.pdfforge-vendor"))) {
            throw "vendor/$component missing: run scripts/fetch-vendor.ps1"
        }
    }
    $tauriArgs = @('tauri', 'build', '--bundles', 'nsis', '--config', 'src-tauri/tauri.vendor.conf.json')
    # Auto-update (docs/06 §6, D-044): with an updater signing key, also produce the signed
    # update artifacts (installer + .sig); PDFFORGE_UPDATE_ENDPOINT puts the endpoint into this
    # build only. Without them the build has no update endpoint and never looks for updates.
    $updaterConfig = @{}
    if ($env:TAURI_SIGNING_PRIVATE_KEY) {
        $updaterConfig.bundle = @{ createUpdaterArtifacts = $true }
        Write-Host '==> Updater artifacts: on (TAURI_SIGNING_PRIVATE_KEY is set)' -ForegroundColor Cyan
    }
    if ($env:PDFFORGE_UPDATE_ENDPOINT) {
        $updaterConfig.plugins = @{ updater = @{ endpoints = @($env:PDFFORGE_UPDATE_ENDPOINT) } }
        Write-Host "==> Update endpoint: $env:PDFFORGE_UPDATE_ENDPOINT" -ForegroundColor Cyan
    }
    if ($updaterConfig.Count -gt 0) {
        $updaterConfigPath = Join-Path $env:TEMP 'pdfforge-updater.conf.json'
        Set-Content -Path $updaterConfigPath -Value ($updaterConfig | ConvertTo-Json -Depth 6 -Compress) -Encoding utf8
        $tauriArgs += @('--config', $updaterConfigPath)
    }
    if ($signed) {
        $timestamp = if ($env:PDFFORGE_SIGN_TIMESTAMP_URL) { $env:PDFFORGE_SIGN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
        $signConfig = @{
            bundle = @{
                windows = @{
                    certificateThumbprint = $env:PDFFORGE_SIGN_THUMBPRINT
                    digestAlgorithm       = 'sha256'
                    timestampUrl          = $timestamp
                }
            }
        } | ConvertTo-Json -Depth 5 -Compress
        $signConfigPath = Join-Path $env:TEMP 'pdfforge-sign.conf.json'
        Set-Content -Path $signConfigPath -Value $signConfig -Encoding utf8
        $tauriArgs += @('--config', $signConfigPath)
        Write-Host '==> Building app + installer (signed)' -ForegroundColor Cyan
    }
    else {
        Write-Host '==> Building app + installer (UNSIGNED)' -ForegroundColor Cyan
    }
    Invoke-Checked 'tauri build' { pnpm @tauriArgs }
}
finally {
    Pop-Location
}

$installer = Get-ChildItem (Join-Path $appDir "src-tauri\target\release\bundle\nsis") -Filter "PDFForge_${version}_x64-setup.exe" |
    Select-Object -First 1
if (-not $installer) { throw 'Installer not found in target/release/bundle/nsis' }

Write-Host ''
Write-Host ("==> Installer: {0} ({1:N1} MB)" -f $installer.FullName, ($installer.Length / 1MB)) -ForegroundColor Green
if ($signed) {
    $sig = Get-AuthenticodeSignature $installer.FullName
    Write-Host "    Signature: $($sig.Status) ($($sig.SignerCertificate.Subject))"
}
else {
    Write-UnsignedWarning
}
