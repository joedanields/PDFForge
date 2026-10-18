<#
.SYNOPSIS
  Pre-fetches and verifies the tools the Tauri NSIS bundler downloads on first use.

.DESCRIPTION
  `tauri build` downloads NSIS and the WebView2 bootstrapper into %LOCALAPPDATA%\tauri with a
  short timeout, which fails on slow links and CI runners ("timeout: global"). This script puts
  them there first, with retries and long timeouts, and verifies them:
    - NSIS zip and nsis_tauri_utils.dll: SHA-1 hashes pinned by tauri-bundler (same values the
      bundler checks), plus NSIS.exe inside the extracted toolset.
    - MicrosoftEdgeWebview2Setup.exe: valid Authenticode signature by Microsoft (the file is
      updated by Microsoft over time, so a fixed hash would go stale).
  Already-present files that verify are left alone, so it is cheap to run on a CI cache hit.

  The pinned values match tauri-bundler 2.10.x (@tauri-apps/cli 2.12.x). If a newer Tauri
  wants another NSIS version, update the constants below; the bundler would otherwise download
  it itself and this cache is simply unused.
#>
[CmdletBinding()]
param(
    [string]$ToolsDir = (Join-Path $env:LOCALAPPDATA 'tauri')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is very slow with progress on PS 5.1

$NsisVersion = '3.13'
$NsisUrl = "https://github.com/tauri-apps/binary-releases/releases/download/nsis-$NsisVersion/nsis-$NsisVersion.zip"
$NsisZipSha1 = 'DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E'
$NsisExeSha1 = '6D45D4E8CCF18FE1FDAC9164058F356102A2ECF2'
$UtilsUrl = 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll'
$UtilsSha1 = '75197FEE3C6A814FE035788D1C34EAD39349B860'
$WebView2Url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'

function Get-Sha1([string]$path) { (Get-FileHash -Algorithm SHA1 -Path $path).Hash.ToUpperInvariant() }

function Get-File([string]$url, [string]$dest) {
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 600
            return
        }
        catch {
            if ($attempt -eq 4) { throw "Download failed after 4 attempts: $url ($_)" }
            Write-Host "    retry $attempt for $url" -ForegroundColor Yellow
            Start-Sleep -Seconds (5 * $attempt)
        }
    }
}

New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
$nsisDir = Join-Path $ToolsDir 'NSIS'
$utilsPath = Join-Path $nsisDir 'Plugins\x86-unicode\additional\nsis_tauri_utils.dll'
$nsisExe = Join-Path $nsisDir 'NSIS.exe'

# --- NSIS toolset ---------------------------------------------------------------------------
$nsisOk = (Test-Path $nsisExe) -and (Get-Sha1 $nsisExe) -eq $NsisExeSha1 -and
    (Test-Path (Join-Path $nsisDir 'Bin\makensis.exe'))
if ($nsisOk) {
    Write-Host "NSIS ${NsisVersion}: cached and verified"
}
else {
    Write-Host "NSIS ${NsisVersion}: downloading" -ForegroundColor Cyan
    $zip = Join-Path $env:TEMP "nsis-$NsisVersion.zip"
    Get-File $NsisUrl $zip
    $actual = Get-Sha1 $zip
    if ($actual -ne $NsisZipSha1) { throw "NSIS zip SHA-1 mismatch: $actual (expected $NsisZipSha1)" }
    if (Test-Path $nsisDir) { Remove-Item -Recurse -Force $nsisDir }
    $extracted = Join-Path $ToolsDir "nsis-$NsisVersion"
    if (Test-Path $extracted) { Remove-Item -Recurse -Force $extracted }
    Expand-Archive -Path $zip -DestinationPath $ToolsDir -Force
    Rename-Item -Path $extracted -NewName 'NSIS'
    Remove-Item $zip -Force
    if ((Get-Sha1 $nsisExe) -ne $NsisExeSha1) { throw 'NSIS.exe SHA-1 mismatch after extraction' }
}

# --- nsis_tauri_utils plugin ----------------------------------------------------------------
if ((Test-Path $utilsPath) -and (Get-Sha1 $utilsPath) -eq $UtilsSha1) {
    Write-Host 'nsis_tauri_utils.dll: cached and verified'
}
else {
    Write-Host 'nsis_tauri_utils.dll: downloading' -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path (Split-Path $utilsPath) | Out-Null
    Get-File $UtilsUrl $utilsPath
    $actual = Get-Sha1 $utilsPath
    if ($actual -ne $UtilsSha1) {
        Remove-Item $utilsPath -Force
        throw "nsis_tauri_utils.dll SHA-1 mismatch: $actual (expected $UtilsSha1)"
    }
}

# --- WebView2 bootstrapper (embedBootstrapper install mode) ---------------------------------
$bootstrapper = Join-Path $ToolsDir 'MicrosoftEdgeWebview2Setup.exe'
function Test-MicrosoftSigned([string]$path) {
    $sig = Get-AuthenticodeSignature -FilePath $path
    return $sig.Status -eq 'Valid' -and $sig.SignerCertificate.Subject -match 'O=Microsoft Corporation'
}
if ((Test-Path $bootstrapper) -and (Test-MicrosoftSigned $bootstrapper)) {
    Write-Host 'WebView2 bootstrapper: cached and signature verified'
}
else {
    Write-Host 'WebView2 bootstrapper: downloading' -ForegroundColor Cyan
    Get-File $WebView2Url $bootstrapper
    if (-not (Test-MicrosoftSigned $bootstrapper)) {
        Remove-Item $bootstrapper -Force
        throw 'WebView2 bootstrapper is not validly signed by Microsoft'
    }
}

Write-Host "Tauri bundler tools ready in $ToolsDir" -ForegroundColor Green
