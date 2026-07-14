# Stops the Risk Copilot backend started by start.ps1.
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Join-Path $ScriptDir "..\app"
$PidFile = Join-Path $AppDir ".server.pid"

if (-not (Test-Path $PidFile)) {
    Write-Host "No PID file found - Risk Copilot doesn't look like it's running (via this script)."
    exit 0
}

$existingPid = Get-Content $PidFile -ErrorAction SilentlyContinue
if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $existingPid -Force
    Write-Host "Stopped Risk Copilot (PID $existingPid)."
} else {
    Write-Host "Process $existingPid is not running; clearing stale PID file."
}

Remove-Item $PidFile -ErrorAction SilentlyContinue
