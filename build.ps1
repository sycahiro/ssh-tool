# Build SSH Tool and copy the binary to dist\SSH-Tool.exe
# Usage: powershell -ExecutionPolicy Bypass -File .\build.ps1

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

Write-Host 'Building (release)...' -ForegroundColor Cyan
Push-Location (Join-Path $root 'desktop\src-tauri')
try {
  cargo build --release
  if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
} finally {
  Pop-Location
}

$src = Join-Path $root 'desktop\src-tauri\target\release\ssh-tool.exe'
if (-not (Test-Path $src)) { throw "Build output not found: $src" }

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$dst = Join-Path $dist 'SSH-Tool.exe'
Copy-Item $src $dst -Force

$size = [math]::Round((Get-Item $dst).Length / 1MB, 1)
Write-Host ''
Write-Host "Done: $dst ($size MB)" -ForegroundColor Green
Write-Host 'Double-click to run. Single file; frontend assets are embedded.'
