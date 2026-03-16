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
- `tools/mcp-dev-agent-server`

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

### One command (current)

From this repo:

1. Build server:

	npm --prefix tools/mcp-dev-agent-server run build

2. Install into a target repo:

	npm --prefix tools/mcp-dev-agent-server run install:repo -- --target "C:/path/to/project"

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
$env:TOOLKIT_REPO_URL="https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git"; iwr "https://raw.githubusercontent.com/dhananjay09892/vscode-tools-dhananjay-patel/main/scripts/public-install.ps1?v=20260316" -UseBasicParsing | iex
```

Install a specific tool only:

```powershell
$env:TOOLKIT_REPO_URL="https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git"; $env:TOOLKIT_TOOL_ID="mcp-dev-agent-server"; iwr "https://raw.githubusercontent.com/dhananjay09892/vscode-tools-dhananjay-patel/main/scripts/public-install.ps1?v=20260316" -UseBasicParsing | iex
```

Current supported ToolId values:

- mcp-dev-agent-server

After running, verify output includes: `public-install.ps1 version: 2026-03-16.3`

Repo:

- https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git

What this does:

1. Clones toolkit repo to a temp folder.
2. Copies MCP server into target-repo/.copilot-tools/mcp-dev-agent-server.
3. Builds server in that persistent folder.
4. Writes target project .vscode/mcp.json.
5. Connects Copilot MCP tools to that project.

This avoids broken temp paths like AppData/Local/Temp/.../dist/index.js.

Script location:

- scripts/public-install.ps1
