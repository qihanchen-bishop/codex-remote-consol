$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Please install Node.js LTS (22 or newer) from https://nodejs.org/en/download and reopen PowerShell.'
  exit 1
}
$Major = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($Major -lt 22) { throw 'Node.js 22 or newer is required.' }
if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) { throw 'OpenSSH client is required.' }
if (-not (Test-Path 'connector.json')) { throw 'Download a connector package from your signed-in workbench first.' }
if (-not (Test-Path 'node_modules')) {
  & npm.cmd ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your npm network access and rerun.' }
}
& node agent-connect.mjs
exit $LASTEXITCODE
