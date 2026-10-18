<#
.SYNOPSIS
  Downloads, verifies and trims the third-party binaries bundled with PDFForge into vendor/.

.DESCRIPTION
  docs/06_BUILD_AND_PACKAGING.md Â§4 step 1. Produces:
    vendor/libreoffice/   portable LibreOffice (program/ + share/, trimmed) for Office -> PDF
    vendor/tesseract/     Tesseract OCR runtime (exe + DLLs it needs) + tessdata
  Every download is pinned to an exact version and SHA-256; a mismatch aborts the build.
  Downloads are cached in vendor/_downloads, so a re-run without changes is offline and cheap
  (each component writes a stamp file and is skipped while the stamp matches).

  No system-wide installation happens:
    - LibreOffice's MSI is unpacked with an *administrative* extract (msiexec /a into a folder),
      which copies files only â€” no registry entries, no shortcuts, no elevation.
    - Tesseract's NSIS installer is unpacked with 7-Zip (also fetched + verified into
      vendor/_tools via an administrative extract of its MSI); the installer itself never runs.

  No Ghostscript, MuPDF or other AGPL components (docs/09_LICENSING.md Â§3).

.PARAMETER Force
  Rebuild the components even when their stamp matches.
.PARAMETER Only
  Limit to 'libreoffice' or 'tesseract'.
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [ValidateSet('', 'libreoffice', 'tesseract')]
    [string]$Only = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root 'vendor'
$downloads = Join-Path $vendor '_downloads'
$staging = Join-Path $vendor '_staging'
$tools = Join-Path $vendor '_tools'

# --- pinned components ---------------------------------------------------------------------
# LibreOffice "still" branch (mature). SHA-256 published next to the file on
# download.documentfoundation.org (<file>.sha256).
$LibreOffice = @{
    Version = '26.2.6'
    File    = 'LibreOffice_26.2.6_Win_x86-64.msi'
    Url     = 'https://download.documentfoundation.org/libreoffice/stable/26.2.6/win/x86_64/LibreOffice_26.2.6_Win_x86-64.msi'
    Sha256  = 'F9877032FD908BEB9C0DDF06DF4AF5C2E85F419C42E14876C4CCE5AAE5FB2660'
}
# 7-Zip (only used at build time to unpack the Tesseract installer). Digest from the GitHub release.
$SevenZip = @{
    File   = '7z2604-x64.msi'
    Url    = 'https://github.com/ip7z/7zip/releases/download/26.04/7z2604-x64.msi'
    Sha256 = '0B01334A418654293513449F61D6BFC99E5196CA371E3C3DC961EDA57CD535C6'
}
# Tesseract 5.4.0 Windows build by UB Mannheim (the build tesseract-ocr links to for Windows).
$Tesseract = @{
    Version = '5.4.0.20240606'
    File    = 'tesseract-ocr-w64-setup-5.4.0.20240606.exe'
    Url     = 'https://github.com/UB-Mannheim/tesseract/releases/download/v5.4.0.20240606/tesseract-ocr-w64-setup-5.4.0.20240606.exe'
    Sha256  = 'C885FFF6998E0608BA4BB8AB51436E1C6775C2BAFC2559A19B423E18678B60C9'
}
# Language models from tesseract-ocr/tessdata_fast, pinned to a commit (Apache-2.0).
$TessdataCommit = '87416418657359cb625c412a48b6e1d6d41c29bd'
$Tessdata = [ordered]@{
    eng = '7D4322BD2A7749724879683FC3912CB542F19906C83BCC1A52132556427170B2'
    osd = '9CF5D576FCC47564F11265841E5CA839001E7E6F38FF7F7AACF46D15A96B00FF'
    tam = 'D02FBEC24BE4B07E32E80D0CCFC3B6B67A3C5D61C9D0A7C8532677990912C6EC'
    hin = '4C73FFC59D497C186B19D1E90F5D721D678EA6B2E277B719BEE4E2AF12271825'
}
# Bump when the trimming rules below change, so existing vendor folders are rebuilt.
$TrimRevision = 3

# --- helpers -------------------------------------------------------------------------------
function Get-Sha256([string]$path) { (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToUpperInvariant() }

function Get-Verified([string]$url, [string]$file, [string]$sha256) {
    <# Download into the cache (resuming, 3 attempts) and verify; returns the local path. #>
    New-Item -ItemType Directory -Force -Path $downloads | Out-Null
    $dest = Join-Path $downloads $file
    if ((Test-Path $dest) -and (Get-Sha256 $dest) -eq $sha256) {
        Write-Host "    $file (cached, verified)"
        return $dest
    }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Write-Host "    downloading $file (attempt $attempt)" -ForegroundColor Cyan
        & curl.exe -sSfL --connect-timeout 30 --retry 2 --retry-all-errors -C - -o $dest $url
        if ($LASTEXITCODE -eq 0 -and (Get-Sha256 $dest) -eq $sha256) { return $dest }
        if ($LASTEXITCODE -eq 0) {
            # Complete but wrong: never resume onto a bad file.
            Write-Host "    SHA-256 mismatch for $file" -ForegroundColor Yellow
            Remove-Item $dest -Force
        }
        Start-Sleep -Seconds (5 * $attempt)
    }
    if (Test-Path $dest) { Remove-Item $dest -Force }
    throw "Download failed or did not verify after 3 attempts: $url"
}

function Expand-MsiAdministrative([string]$msi, [string]$target) {
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @('/a', "`"$msi`"", '/qn', "TARGETDIR=`"$target`"")
    if ($p.ExitCode -ne 0) { throw "msiexec /a failed for $msi (exit $($p.ExitCode))" }
}

function Test-Stamp([string]$dir, [string]$expected) {
    $stamp = Join-Path $dir '.pdfforge-vendor'
    return (-not $Force) -and (Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $expected)
}

function Set-Stamp([string]$dir, [string]$value) {
    Set-Content -Path (Join-Path $dir '.pdfforge-vendor') -Value $value -Encoding ascii
}

function Remove-Paths([string]$base, [string[]]$patterns) {
    foreach ($pattern in $patterns) {
        Get-Item -Path (Join-Path $base $pattern) -Force -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force
    }
}

function Get-FolderMB([string]$dir) {
    (Get-ChildItem -Recurse -File $dir | Measure-Object Length -Sum).Sum / 1MB
}

New-Item -ItemType Directory -Force -Path $vendor | Out-Null

# --- LibreOffice ---------------------------------------------------------------------------
function Install-LibreOffice {
    $dir = Join-Path $vendor 'libreoffice'
    $stampValue = "$($LibreOffice.Version) $($LibreOffice.Sha256) trim$TrimRevision"
    if (Test-Stamp $dir $stampValue) {
        Write-Host "LibreOffice $($LibreOffice.Version): up to date"
        return
    }
    Write-Host "LibreOffice $($LibreOffice.Version):" -ForegroundColor Cyan
    $msi = Get-Verified $LibreOffice.Url $LibreOffice.File $LibreOffice.Sha256
    $unpacked = Join-Path $staging 'libreoffice'
    Write-Host '    unpacking (administrative extract, ~2 min)'
    Expand-MsiAdministrative $msi $unpacked

    Write-Host '    trimming'
    # Only conversion is needed: drop UI translations, dictionaries/extensions, help, Java,
    # the bundled Python, Base/Firebird, PDF import, galleries, templates, wizards and macros.
    # presets/ seeds every new user profile: without it LibreOffice hangs on first start.
    Remove-Paths $unpacked @('help', 'readmes', '*.msi', 'update-settings.ini')
    Remove-Paths (Join-Path $unpacked 'program') @(
        'python-core-*', 'python.exe', 'python3*.dll', 'python*.dll', 'pyuno.pyd', 'pythonloader*',
        'uno.py', 'unohelper.py', 'officehelper.py', 'msgbox.py', 'mailmerge.py', 'scriptforge.py',
        'classes', 'shlxthdl', 'wizards', 'opengl', 'updater*', 'update_service*', 'soffice_safe*',
        'Engine12.dll', 'fbclient.dll', 'ib_util.dll', 'firebird*', 'xpdfimport.exe', 'sbase.*', 'smath.*'
    )
    Get-ChildItem (Join-Path $unpacked 'program\resource') -Directory |
        Where-Object { $_.Name -ne 'common' } | Remove-Item -Recurse -Force
    $share = Join-Path $unpacked 'share'
    Remove-Paths $share @(
        'extensions\*', 'gallery', 'template', 'wizards', 'autotext', 'autocorr', 'Scripts', 'basic',
        'firebird', 'xpdfimport', 'tipoftheday', 'labels', 'toolbarmode', 'glade', 'classification',
        'fingerprint', 'wordbook', 'uno_packages'
    )
    Get-ChildItem (Join-Path $share 'config') -Filter 'images_*.zip' |
        Where-Object { $_.Name -ne 'images_colibre.zip' } | Remove-Item -Force
    $registry = Join-Path $share 'registry'
    Get-ChildItem $registry -Filter 'Langpack-*.xcd' |
        Where-Object { $_.Name -ne 'Langpack-en-US.xcd' } | Remove-Item -Force
    Get-ChildItem (Join-Path $registry 'res') -Filter '*.xcd' |
        Where-Object { $_.Name -notmatch '_en-US\.xcd$' } | Remove-Item -Force
    Remove-Paths $registry @('*.sample', 'onlineupdate.xcd', 'librelogo.xcd', 'pdfimport.xcd')

    # Fonts the MSI would install into C:\Windows\Fonts (metric-compatible Carlito/Caladea/
    # Liberation etc.) go where a portable LibreOffice finds them.
    $fontDir = Join-Path $share 'fonts\truetype'
    New-Item -ItemType Directory -Force -Path $fontDir | Out-Null
    Get-ChildItem (Join-Path $unpacked 'Fonts') -File | Move-Item -Destination $fontDir -Force
    # Visual C++ runtime the MSI would install system-wide: keep it next to soffice.bin.
    Get-ChildItem (Join-Path $unpacked 'System64') -File | Move-Item -Destination (Join-Path $unpacked 'program') -Force
    Remove-Paths $unpacked @('Fonts', 'System', 'System64')

    if (-not (Test-Path (Join-Path $unpacked 'program\soffice.com'))) { throw 'soffice.com missing after trim' }
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    Move-Item $unpacked $dir
    Set-Stamp $dir $stampValue
    Write-Host ("    vendor/libreoffice: {0:N0} MB" -f (Get-FolderMB $dir)) -ForegroundColor Green
}

# --- Tesseract -----------------------------------------------------------------------------
function Get-SevenZip {
    $exe = Join-Path $tools '7zip\Files\7-Zip\7z.exe'
    if (Test-Path $exe) { return $exe }
    $msi = Get-Verified $SevenZip.Url $SevenZip.File $SevenZip.Sha256
    Expand-MsiAdministrative $msi (Join-Path $tools '7zip')
    if (-not (Test-Path $exe)) { throw '7z.exe missing after extracting the 7-Zip MSI' }
    return $exe
}

# DLLs tesseract.exe actually loads (import closure, computed with pefile); the rest of the
# installer is training tools, documentation, Java viewers and Pango/Cairo/ICU for text2image.
$TesseractRuntime = @(
    'tesseract.exe', 'libtesseract-5.dll', 'libleptonica-6.dll', 'libarchive-13.dll', 'libb2-1.dll',
    'libbz2-1.dll', 'libcrypto-3-x64.dll', 'libdeflate.dll', 'libexpat-1.dll', 'libgcc_s_seh-1.dll',
    'libgif-7.dll', 'libiconv-2.dll', 'libjbig-0.dll', 'libjpeg-8.dll', 'libLerc.dll', 'liblz4.dll',
    'liblzma-5.dll', 'libopenjp2-7.dll', 'libpng16-16.dll', 'libsharpyuv-0.dll', 'libstdc++-6.dll',
    'libtiff-6.dll', 'libwebp-7.dll', 'libwebpmux-3.dll', 'libwinpthread-1.dll', 'libzstd.dll',
    'zlib1.dll'
)

function Install-Tesseract {
    $dir = Join-Path $vendor 'tesseract'
    $langs = ($Tessdata.Keys -join ',')
    $stampValue = "$($Tesseract.Version) $($Tesseract.Sha256) $TessdataCommit $langs trim$TrimRevision"
    if (Test-Stamp $dir $stampValue) {
        Write-Host "Tesseract $($Tesseract.Version): up to date"
        return
    }
    Write-Host "Tesseract $($Tesseract.Version):" -ForegroundColor Cyan
    $setup = Get-Verified $Tesseract.Url $Tesseract.File $Tesseract.Sha256
    $sevenZip = Get-SevenZip
    $unpacked = Join-Path $staging 'tesseract-setup'
    if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
    & $sevenZip x -y -bso0 -bsp0 "-o$unpacked" $setup
    if ($LASTEXITCODE -ne 0) { throw "7-Zip failed to unpack $($Tesseract.File)" }

    $out = Join-Path $staging 'tesseract'
    if (Test-Path $out) { Remove-Item -Recurse -Force $out }
    New-Item -ItemType Directory -Force -Path (Join-Path $out 'tessdata') | Out-Null
    foreach ($name in $TesseractRuntime) {
        Copy-Item (Join-Path $unpacked $name) $out
    }
    # pdf.ttf: the glyphless font of the text-only PDF renderer; configs: textonly_pdf etc.
    Copy-Item (Join-Path $unpacked 'tessdata\pdf.ttf') (Join-Path $out 'tessdata')
    Copy-Item -Recurse (Join-Path $unpacked 'tessdata\configs') (Join-Path $out 'tessdata\configs')
    foreach ($lang in $Tessdata.Keys) {
        $file = "tessdata_fast-$lang.traineddata"
        $url = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$TessdataCommit/$lang.traineddata"
        $model = Get-Verified $url $file $Tessdata[$lang]
        Copy-Item $model (Join-Path $out "tessdata\$lang.traineddata")
    }
    Remove-Item -Recurse -Force $unpacked

    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    Move-Item $out $dir
    Set-Stamp $dir $stampValue
    Write-Host ("    vendor/tesseract: {0:N0} MB" -f (Get-FolderMB $dir)) -ForegroundColor Green
}

if ($Only -eq '' -or $Only -eq 'libreoffice') { Install-LibreOffice }
if ($Only -eq '' -or $Only -eq 'tesseract') { Install-Tesseract }
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
Write-Host "Vendor components ready in $vendor" -ForegroundColor Green
