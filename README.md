# VS Code Internal Tools Workspace

This workspace organizes each internal tool idea into a separate folder so your team can build and maintain them independently.

## Our Philosophy

We are here to help software developers.

We will continue creating new tools based on real needs from the software developer community.

We truly love and respect the software developer community, and this project is our small step to help developers work faster with less stress.

## Tool Folders

- `tools/codebase-integration-tool`
- `tools/internal-api-generator`
- `tools/repo-intelligence-tool`
- `tools/code-quality-enforcer`
- `tools/architecture-validator`
- `tools/dependency-analyzer`
- `tools/code-architecture-toolkit`
- `tools/tool-reception`
- `tools/playwright-tool`

## Suggested Build Order

1. Build a shared extension shell or MCP server foundation.
2. Implement one tool end-to-end (recommended: internal API generator).
3. Reuse shared logic for file scanning, code edits, and validation across all tools.

## New Developer Integration

For developer-friendly adoption across multiple repos, use MCP as the first delivery model.

### Recommended rollout

1. Keep one shared MCP server in this repo.
2. Give developers a one-command installer to connect their repo.
3. Add a lightweight website/internal docs page with that command.

### One-line commands

Use these copy-ready commands.

Install MCP server into a target repo (from this workspace):

```powershell
npm --prefix tools/code-architecture-toolkit run build; npm --prefix tools/code-architecture-toolkit run install:repo -- --target "C:/path/to/project"
```

Public GitHub onboarding (default tool):

Default tool is `tool-reception`.

```powershell
$env:TOOLKIT_REPO_URL="https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git"; $u="https://raw.githubusercontent.com/dhananjay09892/vscode-tools-dhananjay-patel/main/scripts/public-install.ps1?v=20260317"; $s=Join-Path $env:TEMP "public-install.ps1"; iwr $u -UseBasicParsing -OutFile $s; & $s
```

## Single Tool commands

Public GitHub onboarding (code-architecture-toolkit override):

```powershell
$env:TOOLKIT_REPO_URL="https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git"; $env:TOOLKIT_TOOL_ID="code-architecture-toolkit"; $u="https://raw.githubusercontent.com/dhananjay09892/vscode-tools-dhananjay-patel/main/scripts/public-install.ps1?v=20260317"; $s=Join-Path $env:TEMP "public-install.ps1"; iwr $u -UseBasicParsing -OutFile $s; & $s
```

Public GitHub onboarding (architecture-validator):

```powershell
$env:TOOLKIT_REPO_URL="https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git"; $env:TOOLKIT_TOOL_ID="architecture-validator"; $u="https://raw.githubusercontent.com/dhananjay09892/vscode-tools-dhananjay-patel/main/scripts/public-install.ps1?v=20260317"; $s=Join-Path $env:TEMP "public-install.ps1"; iwr $u -UseBasicParsing -OutFile $s; & $s
```

Public GitHub onboarding (playwright-tool):

```powershell
$env:TOOLKIT_REPO_URL="https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git"; $env:TOOLKIT_TOOL_ID="playwright-tool"; $u="https://raw.githubusercontent.com/dhananjay09892/vscode-tools-dhananjay-patel/main/scripts/public-install.ps1?v=20260317"; $s=Join-Path $env:TEMP "public-install.ps1"; iwr $u -UseBasicParsing -OutFile $s; & $s
```


### Multiple one-line commands for multiple tools

Build MCP server and extension tool together from this workspace:

```powershell
npm --prefix tools/code-architecture-toolkit run build; npm --prefix tools/architecture-validator run compile
```

Run MCP smoke and golden tests in one line:

```powershell
npm --prefix tools/code-architecture-toolkit run smoke; npm --prefix tools/code-architecture-toolkit run test:golden
```

Tool registry is manifest-driven at `scripts/tool-registry.json`, so adding more tools does not require installer logic changes.

Installer note:

- `public-install.ps1` now auto-selects a unique MCP server name per tool (`<tool-id>-server`) when `-ServerName` is not provided.
- This prevents one tool install from overwriting another in `.vscode/mcp.json`.

### One command (current)

From this repo:

1. Build server:

	npm --prefix tools/code-architecture-toolkit run build

2. Install into a target repo:

	npm --prefix tools/code-architecture-toolkit run install:repo -- --target "C:/path/to/project"

This writes target-repo/.vscode/mcp.json and connects Copilot to your tools.

### NPM package approach (next)

If you want true npm install onboarding, publish the installer script as a package (or private registry package), then developers run:

- npx your-toolkit-install --target .

### VS Code extension approach (later)

Build an extension when you want:

- UI buttons and settings
- team policy controls
- bundled onboarding inside VS Code

Best pattern for teams: Extension as UX layer + MCP server as execution layer.

## Public GitHub Onboarding

If this repo is public, developers can onboard from a single command without cloning manually.

Prerequisites:

- Node.js
- npm
- git

### One command from website or README (Windows PowerShell)

Run in the target project folder:

```powershell
$env:TOOLKIT_REPO_URL="https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git"; $u="https://raw.githubusercontent.com/dhananjay09892/vscode-tools-dhananjay-patel/main/scripts/public-install.ps1?v=20260317"; $s=Join-Path $env:TEMP "public-install.ps1"; iwr $u -UseBasicParsing -OutFile $s; & $s
```

This installs default ToolId `tool-reception`.

Install a specific tool only:

```powershell
$env:TOOLKIT_REPO_URL="https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git"; $env:TOOLKIT_TOOL_ID="code-architecture-toolkit"; $u="https://raw.githubusercontent.com/dhananjay09892/vscode-tools-dhananjay-patel/main/scripts/public-install.ps1?v=20260317"; $s=Join-Path $env:TEMP "public-install.ps1"; iwr $u -UseBasicParsing -OutFile $s; & $s
```

Current supported ToolId values:

- code-architecture-toolkit
- architecture-validator
- tool-reception
- playwright-tool

After running, verify output includes: `public-install.ps1 version: 2026-03-17.1`

Repo:

- https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git

What this does:

1. Clones toolkit repo to a temp folder.
2. Copies selected tool runtime into target-repo/.copilot-tools/<tool-id>.
3. Builds server in that persistent folder.
4. Writes target project .vscode/mcp.json.
5. Connects Copilot MCP tools to that project.

This avoids broken temp paths like AppData/Local/Temp/.../dist/index.js.

Script location:

- scripts/public-install.ps1

