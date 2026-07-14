# Starts the Risk Copilot backend (which also serves the integrated frontend).
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Join-Path $ScriptDir "..\app"
$ServerDir = Join-Path $AppDir "server"
$LogDir = Join-Path $AppDir "logs"
$PidFile = Join-Path $AppDir ".server.pid"
$Port = if ($env:PORT) { $env:PORT } else { "5050" }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (Test-Path $PidFile) {
    $existingPid = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
        Write-Host "Risk Copilot is already running (PID $existingPid) at http://localhost:$Port"
        exit 0
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node is not on PATH. Install Node.js 18+ and retry."
    exit 1
}

Write-Host "Starting Risk Copilot backend on port $Port..."

$env:PORT = $Port
$proc = Start-Process -FilePath "node" `
    -ArgumentList "`"$ServerDir\server.js`"" `
    -WorkingDirectory $ServerDir `
    -RedirectStandardOutput (Join-Path $LogDir "server.out") `
    -RedirectStandardError (Join-Path $LogDir "server.err") `
    -PassThru -WindowStyle Hidden

$proc.Id | Out-File -FilePath $PidFile -Encoding ascii -NoNewline

Start-Sleep -Seconds 1
$running = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "Risk Copilot is running (PID $($proc.Id))"
    Write-Host "URL: http://localhost:$Port"
    Write-Host "Logs: $LogDir\server.out (stdout), $LogDir\server.err (stderr)"
    Write-Host "Audit trail: $LogDir\mcp-audit.jsonl"
} else {
    Write-Error "Failed to start. Check $LogDir\server.err"
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    exit 1
}
