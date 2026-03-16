param(
  [string]$ToolkitRepoUrl = $env:TOOLKIT_REPO_URL,
  [string]$TargetRepoPath = (Get-Location).Path,
  [string]$ServerName = 'internal-dev-agent',
  [string]$Branch = 'main',
  [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'

function Assert-CommandExists {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

if ([string]::IsNullOrWhiteSpace($ToolkitRepoUrl)) {
  throw 'Toolkit repo URL is required. Set TOOLKIT_REPO_URL env var or pass -ToolkitRepoUrl.'
}

Assert-CommandExists -Name 'git'
Assert-CommandExists -Name 'npm'

$targetFullPath = (Resolve-Path -Path $TargetRepoPath).Path
$tempRoot = Join-Path $env:TEMP ("copilot-tools-" + [Guid]::NewGuid().ToString('N'))

Write-Host "Preparing toolkit source at temp path: $tempRoot"

if (Test-Path $ToolkitRepoUrl) {
  $sourcePath = (Resolve-Path -Path $ToolkitRepoUrl).Path
  Write-Host "Using local toolkit source path: $sourcePath"
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  Copy-Item -Path (Join-Path $sourcePath '*') -Destination $tempRoot -Recurse -Force
} else {
  Write-Host "Cloning toolkit repo: $ToolkitRepoUrl"
  git clone --depth 1 --branch $Branch $ToolkitRepoUrl $tempRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to clone toolkit repo: $ToolkitRepoUrl"
  }
}

$serverDir = Join-Path $tempRoot 'tools/mcp-dev-agent-server'
if (-not (Test-Path $serverDir)) {
  throw "Server folder not found: $serverDir"
}

Write-Host 'Installing server dependencies...'
npm --prefix $serverDir ci

Write-Host 'Building MCP server...'
npm --prefix $serverDir run build

Write-Host "Installing MCP config into target repo: $targetFullPath"
npm --prefix $serverDir run install:repo -- --target $targetFullPath --name $ServerName

if (-not $KeepTemp) {
  Remove-Item $tempRoot -Recurse -Force
}

Write-Host 'Done. Reload VS Code window and refresh MCP servers in Copilot Chat.'
