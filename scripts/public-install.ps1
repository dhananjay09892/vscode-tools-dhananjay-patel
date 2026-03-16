param(
  [string]$ToolkitRepoUrl = $env:TOOLKIT_REPO_URL,
  [string]$TargetRepoPath = (Get-Location).Path,
  [string]$ServerName = 'internal-dev-agent',
  [string]$Branch = 'main',
  [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$InstallerVersion = '2026-03-16.3'

Write-Host "public-install.ps1 version: $InstallerVersion"

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
$installedServerDir = Join-Path $targetFullPath '.copilot-tools/mcp-dev-agent-server'

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

Write-Host "Deploying MCP server to target repo: $installedServerDir"
if (Test-Path $installedServerDir) {
  Remove-Item $installedServerDir -Recurse -Force
}
New-Item -ItemType Directory -Path $installedServerDir -Force | Out-Null
Copy-Item -Path (Join-Path $serverDir '*') -Destination $installedServerDir -Recurse -Force

Write-Host 'Installing server dependencies in target repo...'
npm --prefix $installedServerDir ci

Write-Host 'Building MCP server in target repo...'
npm --prefix $installedServerDir run build

Write-Host "Installing MCP config into target repo: $targetFullPath"
$serverDistPath = Join-Path $installedServerDir 'dist/index.js'
npm --prefix $installedServerDir run install:repo -- --target $targetFullPath --name $ServerName --server-dist $serverDistPath

$mcpConfigPath = Join-Path $targetFullPath '.vscode/mcp.json'
if (-not (Test-Path $mcpConfigPath)) {
  throw "Expected MCP config was not created: $mcpConfigPath"
}

$mcpConfig = Get-Content $mcpConfigPath -Raw | ConvertFrom-Json
$resolvedArg = $mcpConfig.servers.$ServerName.args[0]
if ([string]::IsNullOrWhiteSpace($resolvedArg)) {
  throw "MCP config is missing args[0] for server '$ServerName'"
}

if ($resolvedArg -match 'AppData/Local/Temp|AppData\\Local\\Temp|copilot-tools-[a-f0-9]{32}') {
  throw "Unsafe temp path detected in mcp.json: $resolvedArg"
}

if (-not (Test-Path $resolvedArg)) {
  throw "Configured MCP server file does not exist: $resolvedArg"
}

Write-Host "MCP server path validated: $resolvedArg"

if (-not $KeepTemp) {
  Remove-Item $tempRoot -Recurse -Force
}

Write-Host 'Done. Reload VS Code window and refresh MCP servers in Copilot Chat.'
