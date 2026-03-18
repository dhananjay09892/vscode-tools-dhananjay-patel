param(
  [string]$ToolkitRepoUrl = $env:TOOLKIT_REPO_URL,
  [string]$TargetRepoPath = (Get-Location).Path,
  [string]$ToolId = $env:TOOLKIT_TOOL_ID,
  [string]$ServerName = $env:TOOLKIT_SERVER_NAME,
  [string]$Branch = 'main',
  [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$InstallerVersion = '2026-03-17.1'

Write-Host "public-install.ps1 version: $InstallerVersion"

function Assert-CommandExists {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function ConvertTo-Hashtable {
  param([Parameter(Mandatory = $true)]$InputObject)

  if ($null -eq $InputObject) {
    return $null
  }

  if ($InputObject -is [System.Collections.IDictionary]) {
    $hash = @{}
    foreach ($key in $InputObject.Keys) {
      $hash[$key] = ConvertTo-Hashtable -InputObject $InputObject[$key]
    }
    return $hash
  }

  if ($InputObject -is [pscustomobject]) {
    $hash = @{}
    foreach ($prop in $InputObject.PSObject.Properties) {
      $hash[$prop.Name] = ConvertTo-Hashtable -InputObject $prop.Value
    }
    return $hash
  }

  if (($InputObject -is [System.Collections.IEnumerable]) -and -not ($InputObject -is [string])) {
    $list = @()
    foreach ($item in $InputObject) {
      $list += ,(ConvertTo-Hashtable -InputObject $item)
    }
    return $list
  }

  return $InputObject
}

function Get-ToolRegistry {
  param([string]$RepoRoot)

  $registryPath = Join-Path $RepoRoot 'scripts/tool-registry.json'
  if (-not (Test-Path $registryPath)) {
    throw "Tool registry file not found: $registryPath"
  }

  $registryRaw = Get-Content -Path $registryPath -Raw
  $registryObj = $registryRaw | ConvertFrom-Json
  return ConvertTo-Hashtable -InputObject $registryObj
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

$registry = Get-ToolRegistry -RepoRoot $tempRoot
$supportedTools = $registry.tools
if ($null -eq $supportedTools -or $supportedTools.Count -eq 0) {
  throw 'Tool registry is empty. Add tools in scripts/tool-registry.json.'
}

if ([string]::IsNullOrWhiteSpace($ToolId)) {
  $ToolId = $registry.defaultToolId
}

if ([string]::IsNullOrWhiteSpace($ServerName)) {
  # Use a stable per-tool server name so installing multiple tools does not overwrite mcp.json entries.
  $ServerName = "$ToolId-server"
}

if (-not $supportedTools.ContainsKey($ToolId)) {
  $allowed = ($supportedTools.Keys | Sort-Object) -join ', '
  throw "Unknown ToolId '$ToolId'. Supported values: $allowed"
}

$toolSpec = $supportedTools[$ToolId]
$sourceToolSubPath = $toolSpec.sourceSubPath
$installToolSubPath = $toolSpec.installSubPath
$toolKind = $toolSpec.kind
$installCommand = if ($toolSpec.installCommand) { $toolSpec.installCommand } else { 'ci' }
$buildCommand = if ($toolSpec.buildCommand) { $toolSpec.buildCommand } else { 'build' }
$installedToolDir = Join-Path $targetFullPath $installToolSubPath

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
npm --prefix $installedToolDir run --if-present preinstall
npm --prefix $installedToolDir $installCommand

Write-Host "Building '$ToolId' in target repo..."
npm --prefix $installedToolDir run $buildCommand

if ($toolKind -eq 'mcp-server') {
  Write-Host "Installing MCP config into target repo: $targetFullPath"
  $serverDistPath = Join-Path $installedToolDir 'dist/index.js'
  npm --prefix $installedToolDir run install:repo -- --target $targetFullPath --name $ServerName --server-dist $serverDistPath
}

if ($toolKind -eq 'mcp-server') {
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
}

if (-not $KeepTemp) {
  Remove-Item $tempRoot -Recurse -Force
}

Write-Host 'Done. Reload VS Code window and refresh MCP servers in Copilot Chat.'

