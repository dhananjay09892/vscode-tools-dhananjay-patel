param(
  [string]$ToolkitRepoUrl = $env:TOOLKIT_REPO_URL,
  [string]$TargetRepoPath = (Get-Location).Path,
  [string]$ToolId = $env:TOOLKIT_TOOL_ID,
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

if ([string]::IsNullOrWhiteSpace($ToolId)) {
  $ToolId = 'mcp-dev-agent-server'
}

$supportedTools = @{
  'mcp-dev-agent-server' = @{
    SourceSubPath = 'tools/mcp-dev-agent-server'
    InstallSubPath = '.copilot-tools/mcp-dev-agent-server'
    Kind = 'mcp-server'
  }
}

if (-not $supportedTools.ContainsKey($ToolId)) {
  $allowed = ($supportedTools.Keys | Sort-Object) -join ', '
  throw "Unknown ToolId '$ToolId'. Supported values: $allowed"
}

Assert-CommandExists -Name 'git'
Assert-CommandExists -Name 'npm'

$targetFullPath = (Resolve-Path -Path $TargetRepoPath).Path
$tempRoot = Join-Path $env:TEMP ("copilot-tools-" + [Guid]::NewGuid().ToString('N'))
$toolSpec = $supportedTools[$ToolId]
$sourceToolSubPath = $toolSpec.SourceSubPath
$installToolSubPath = $toolSpec.InstallSubPath
$toolKind = $toolSpec.Kind
$installedToolDir = Join-Path $targetFullPath $installToolSubPath

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

$toolDir = Join-Path $tempRoot $sourceToolSubPath
if (-not (Test-Path $toolDir)) {
  throw "Tool folder not found for '$ToolId': $toolDir"
}

Write-Host "Deploying tool '$ToolId' to target repo: $installedToolDir"
if (Test-Path $installedToolDir) {
  Remove-Item $installedToolDir -Recurse -Force
}
New-Item -ItemType Directory -Path $installedToolDir -Force | Out-Null
Copy-Item -Path (Join-Path $toolDir '*') -Destination $installedToolDir -Recurse -Force

Write-Host "Installing '$ToolId' dependencies in target repo..."
npm --prefix $installedToolDir ci

Write-Host "Building '$ToolId' in target repo..."
npm --prefix $installedToolDir run build

if ($toolKind -eq 'mcp-server') {
  Write-Host "Installing MCP config into target repo: $targetFullPath"
  $serverDistPath = Join-Path $installedToolDir 'dist/index.js'
  npm --prefix $installedToolDir run install:repo -- --target $targetFullPath --name $ServerName --server-dist $serverDistPath
}

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
