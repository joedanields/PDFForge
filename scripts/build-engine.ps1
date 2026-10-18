<#
.SYNOPSIS
  Freezes the Python engine with PyInstaller (onedir) and stages it for the Tauri bundle.

.DESCRIPTION
  Output: engine/dist/engine/engine.exe (+ _internal/), copied to
  app/src-tauri/resources/engine/, which tauri.conf.json bundles as <install dir>/engine/.
  The frozen engine is smoke-tested with a `hello` handshake before it is staged.
  If PDFFORGE_SIGN_THUMBPRINT is set, engine.exe is code-signed with signtool.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$engineDir = Join-Path $root 'engine'
$distDir = Join-Path $engineDir 'dist\engine'
$stageDir = Join-Path $root 'app\src-tauri\resources\engine'

function Invoke-Checked([string]$what, [scriptblock]$block) {
    # Native tools log progress to stderr; under 'Stop' Windows PowerShell 5.1 would treat that
    # as a terminating error. Judge success by exit code instead.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $block 2>&1 | ForEach-Object { "$_" } }
    finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

Write-Host '==> Syncing engine environment (uv)' -ForegroundColor Cyan
Push-Location $engineDir
try {
    Invoke-Checked 'uv sync' { uv sync --frozen }

    Write-Host '==> Running PyInstaller (onedir)' -ForegroundColor Cyan
    Invoke-Checked 'PyInstaller' { uv run pyinstaller engine.spec --noconfirm --clean --log-level WARN }
}
finally {
    Pop-Location
}

$engineExe = Join-Path $distDir 'engine.exe'
if (-not (Test-Path $engineExe)) { throw "PyInstaller did not produce $engineExe" }

Write-Host '==> Smoke-testing frozen engine (hello handshake + Echo job in a worker process)' -ForegroundColor Cyan
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $engineExe
$psi.WorkingDirectory = $distDir
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)
$stderrTask = $proc.StandardError.ReadToEndAsync()
$proc.StandardInput.WriteLine('{"id":"build-check","method":"hello"}')
$proc.StandardInput.Flush()
$line = $proc.StandardOutput.ReadLine()
$hello = $line | ConvertFrom-Json
if ($hello.event -ne 'hello' -or $hello.protocol_version -ne 1) {
    $proc.Kill()
    Write-Host $stderrTask.Result
    throw "Unexpected handshake from frozen engine: $line"
}
Write-Host "    engine $($hello.engine_version), protocol $($hello.protocol_version), methods: $($hello.methods -join ', ')"
# A real job: proves the frozen exe can start memory-capped worker processes (freeze_support).
$proc.StandardInput.WriteLine('{"id":"build-echo","method":"echo","params":{"steps":2,"delay_ms":1}}')
$proc.StandardInput.Flush()
$deadline = (Get-Date).AddSeconds(60)
$final = $null
while (-not $final -and (Get-Date) -lt $deadline) {
    $read = $proc.StandardOutput.ReadLineAsync()
    if (-not $read.Wait(60000)) { break }
    if ($null -eq $read.Result) { break }
    $event = $read.Result | ConvertFrom-Json
    if ($event.event -in @('done', 'error')) { $final = $event }
}
$proc.StandardInput.Close()
if (-not $proc.WaitForExit(15000)) { $proc.Kill(); throw 'Frozen engine did not exit after stdin closed' }
if (-not $final -or $final.event -ne 'done') {
    Write-Host $stderrTask.Result
    throw "Frozen engine could not run a job in a worker process: $($final | ConvertTo-Json -Compress)"
}
Write-Host "    echo job in worker process: done in $($final.stats.ms) ms"

if ($env:PDFFORGE_SIGN_THUMBPRINT) {
    $timestamp = if ($env:PDFFORGE_SIGN_TIMESTAMP_URL) { $env:PDFFORGE_SIGN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
    Write-Host '==> Signing engine.exe' -ForegroundColor Cyan
    Invoke-Checked 'signtool' {
        signtool sign /sha1 $env:PDFFORGE_SIGN_THUMBPRINT /fd sha256 /tr $timestamp /td sha256 $engineExe
    }
}

Write-Host "==> Staging engine into $stageDir" -ForegroundColor Cyan
if (Test-Path $stageDir) {
    Get-ChildItem $stageDir -Force | Where-Object { $_.Name -ne '.gitkeep' } | Remove-Item -Recurse -Force
}
else {
    New-Item -ItemType Directory -Path $stageDir | Out-Null
}
Copy-Item -Path (Join-Path $distDir '*') -Destination $stageDir -Recurse -Force

$size = (Get-ChildItem $stageDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("==> Engine ready: {0:N1} MB in {1}" -f $size, $stageDir) -ForegroundColor Green
