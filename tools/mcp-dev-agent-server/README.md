# MCP Dev Agent Server

## Goal

Expose internal development tools through an MCP server for Copilot.

## Example Commands

- `/create-module user-auth`
- `/add-endpoint POST /login`
- `/generate-tests user-service`
- `/analyze-dependencies`
- `/refactor-controller`

## Responsibilities

- Register MCP tools for repo tasks.
- Execute safe file operations.
- Return structured results to Copilot.

## MVP Checklist

- [x] MCP server bootstrap.
- [x] Tool registration and schemas.
- [x] Workspace-safe read/write handlers.
- [x] Logging and error handling.

## Implemented Tools

- repo_architecture
- analyze_dependencies
- create_module
- delete_module

## Quick Start

1. Install dependencies:

	npm install

2. Build:

	npm run build

3. Run server:

	npm start

## One-Command Repo Onboarding

You can configure any project repository with one command:

1. Build this MCP server once:

	npm run build

2. Run installer for a target project:

	npm run install:repo -- --target "C:/path/to/your-project"

Optional flags:

- --name custom-server-name
- --server-dist C:/custom/path/to/dist/index.js

The installer creates or updates .vscode/mcp.json in the target project.

## Public GitHub Onboarding

If your toolkit repo is public, developers can run one command in any target project.

Windows PowerShell command:

```powershell
$env:TOOLKIT_REPO_URL="https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git"; iwr "https://raw.githubusercontent.com/dhananjay09892/vscode-tools-dhananjay-patel/main/scripts/public-install.ps1?v=20260316" -UseBasicParsing | iex
```

After running, verify output includes: `public-install.ps1 version: 2026-03-16.3`

Repo:

- https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git

This command runs:

- scripts/public-install.ps1

It clones this toolkit, builds the MCP server, and installs target-repo .vscode/mcp.json.

Installer behavior:

- Deploys server runtime to target-repo/.copilot-tools/mcp-dev-agent-server
- Builds that local runtime
- Writes mcp.json with a stable path to target-repo/.copilot-tools/.../dist/index.js

This prevents MODULE_NOT_FOUND errors caused by temporary folder cleanup.

## Environment

- Optional: set WORKSPACE_ROOT to analyze a target repository.
- If WORKSPACE_ROOT is not set, the current process directory is used.

## Notes

- create_module defaults to dry-run mode.
- Pass apply=true to write files.
- delete_module defaults to dry-run mode.
- Pass apply=true to remove module folder.
- Path validation prevents writing outside workspace root.

## Copilot MCP Client Setup

For this workspace, MCP client configuration has been added at:

- ../../.vscode/mcp.json

A reusable sample is also available at:

- mcp.client.example.json

Connection flow:

1. Build the server:

	npm run build

2. Ensure Node.js is available in PATH.

3. Open Copilot Chat and refresh MCP servers.

4. Use the server tools:

	- repo_architecture
	- analyze_dependencies
	- create_module
	- delete_module

## Multi-Repo Usage

If you have multiple projects, use one of these patterns.

### Option A: Per-repo local config (recommended)

In each target repo:

1. Copy the MCP client snippet into .vscode/mcp.json.
2. Set args to the built server path you want to use.
3. Set WORKSPACE_ROOT to ${workspaceFolder}.

This makes tools operate on whichever repo is currently open.

Tip: use the one-command installer instead of manual JSON edits.

### Option B: Central shared server path

Keep this server in one central repo and point every project mcp.json to that dist/index.js path.

Example pattern for each repo mcp.json:

- command: node
- args: ["C:/path/to/vscode-tools-dhananjay-patel/tools/mcp-dev-agent-server/dist/index.js"]
- env.WORKSPACE_ROOT: ${workspaceFolder}

Use forward slashes in Windows paths inside JSON.

### Option C: Per-project clone

Copy tools/mcp-dev-agent-server into each repo and build there.

This gives full repo-local versioning at the cost of duplication.
