<#
.SYNOPSIS
  Downloads and verifies third-party binaries into vendor/.

.DESCRIPTION
  Phase 0 placeholder: only creates the empty vendor folders. Real downloads with
  SHA-256 verification (LibreOffice, Tesseract) are added in Phase 2. The vendor
  folders are not referenced from tauri.conf.json until then.
  vendor/ghostscript stays empty on purpose: the project is AGPL-free until a
  licensing decision is recorded in docs/09_LICENSING.md §3.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root 'vendor'

foreach ($name in @('libreoffice', 'ghostscript', 'tesseract')) {
    $dir = Join-Path $vendor $name
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
}

Write-Host "fetch-vendor: Phase 0 placeholder - no binaries downloaded." -ForegroundColor Yellow
