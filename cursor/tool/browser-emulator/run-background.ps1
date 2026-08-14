param(
  [string]$ConfigPath = ".\config.json"
)

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $projectRoot "output"
if (-not (Test-Path $logDir)) {
  New-Item -Path $logDir -ItemType Directory | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "emulator-bg-$timestamp.log"
$pidPath = Join-Path $logDir "emulator-bg.pid"
$metaPath = Join-Path $logDir "emulator-bg-meta.json"

if (Test-Path $pidPath) {
  $existingPid = (Get-Content $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($existingPid) {
    $activeProcess = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($activeProcess) {
      Write-Output "Background emulator is already active (PID: $existingPid)."
      if (Test-Path $metaPath) {
        $meta = Get-Content $metaPath -Raw | ConvertFrom-Json
        Write-Output "Existing log file: $($meta.logPath)"
      }
      exit 0
    }
  }
}

$process = Start-Process -FilePath "node" `
  -ArgumentList "emulator.js run --background --config `"$ConfigPath`"" `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $logPath `
  -RedirectStandardError $logPath `
  -PassThru

Set-Content -Path $pidPath -Value $process.Id
@{
  pid = $process.Id
  startedAt = (Get-Date).ToString("o")
  logPath = $logPath
} | ConvertTo-Json | Set-Content -Path $metaPath

Write-Output "Background emulator started (PID: $($process.Id))."
Write-Output "Log file: $logPath"
