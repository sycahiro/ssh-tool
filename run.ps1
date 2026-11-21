# Build and launch SSH Tool (debug build).
# Usage: powershell -ExecutionPolicy Bypass -File .\run.ps1
# Re-run this after editing anything under desktop/src or desktop/src-tauri/src.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$tauri = Join-Path $root 'desktop\src-tauri'

Write-Host 'Building...' -ForegroundColor Cyan
Push-Location $tauri
try {
  cargo build
  if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
} finally {
  Pop-Location
}

# Close a running instance first, otherwise the exe is locked.
$running = Get-Process ssh-tool -ErrorAction SilentlyContinue
if ($running) {
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 500
}

Write-Host 'Starting SSH Tool...' -ForegroundColor Green
Start-Process -FilePath (Join-Path $tauri 'target\debug\ssh-tool.exe') -WorkingDirectory $tauri
