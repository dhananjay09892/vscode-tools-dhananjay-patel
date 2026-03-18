# MCP Dev Agent Server

## Tool Links

- Architecture Validator: [Folder](../architecture-validator) | [README](../architecture-validator/README.md)
- Code Architecture Toolkit: [Folder](../code-architecture-toolkit) | [README](../code-architecture-toolkit/README.md)
- Tool Reception: [Folder](../tool-reception) | [README](../tool-reception/README.md)
- Playwright Tool: [Folder](../playwright-tool) | [README](../playwright-tool/README.md)

## Goal

Expose internal development tools through an MCP server for Copilot.

## Example Commands

- `/create-module user-auth`
- `/create-module user-auth language=python framework=fastapi`
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
- analyze_dependencies (TypeScript/JavaScript/Python)
- create_module
- delete_module

## analyze_dependencies Output

The dependency analyzer now returns:

- Node, edge, and cycle totals
- Language breakdown
- Internal edge count
- External import package list
- Unresolved import list
- Confidence score (`low`/`medium`/`high`)
- Top coupled files (outbound imports)
- Top imported files (inbound imports)
- Framework hints
- A machine-readable summary JSON block

## Accuracy Boundaries

- TypeScript/JavaScript: best results for relative imports and standard `index` resolution.
- Python: supports `import`, `from ... import ...`, relative imports, and common multi-line import forms.
- Python absolute imports are matched using exact and suffix-based module resolution to better handle layouts like `src/app/...` imported as `app.*`.
- Some unresolved imports may still require alias/root configuration for monorepos and custom package roots.

## Analyzer Regression Suite

Run golden-corpus regression tests for dependency analysis:

	npm run test:golden

Fixture corpus location:

- testdata/golden/js-cycle-unresolved
- testdata/golden/py-absolute-fastapi
- testdata/golden/py-multiline-aliases

Each fixture includes `expected.json` with stable expectations for nodes, edges, cycles, confidence label, unresolved imports, and language breakdown.

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
$env:TOOLKIT_REPO_URL="https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git"; iwr "https://raw.githubusercontent.com/dhananjay09892/vscode-tools-dhananjay-patel/main/scripts/public-install.ps1?v=20260317" -UseBasicParsing | iex
```

Install this tool explicitly with ToolId selector:

```powershell
$env:TOOLKIT_REPO_URL="https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git"; $env:TOOLKIT_TOOL_ID="code-architecture-toolkit"; iwr "https://raw.githubusercontent.com/dhananjay09892/vscode-tools-dhananjay-patel/main/scripts/public-install.ps1?v=20260317" -UseBasicParsing | iex
```

After running, verify output includes: `public-install.ps1 version: 2026-03-16.3`

Repo:

- https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git

This command runs:

- scripts/public-install.ps1

It clones this toolkit, builds the MCP server, and installs target-repo .vscode/mcp.json.

Installer behavior:

- Deploys server runtime to target-repo/.copilot-tools/code-architecture-toolkit
- Builds that local runtime
- Writes mcp.json with a stable path to target-repo/.copilot-tools/.../dist/index.js

This prevents MODULE_NOT_FOUND errors caused by temporary folder cleanup.

## Environment

- Optional: set WORKSPACE_ROOT to analyze a target repository.
- If WORKSPACE_ROOT is not set, the current process directory is used.

## Notes

- create_module defaults to dry-run mode.
- Pass apply=true to write files.
- create_module supports `language=typescript` (default) and `language=python`.
- Python mode uses FastAPI preset files: `routes.py`, `service.py`, `schema.py`, `test_<module>.py`, `__init__.py`.
- Optional `registerRouter=true` appends router include lines (default router file: `src/app/routes.py`; override with `routerFile`).
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
- args: ["C:/path/to/vscode-tools-dhananjay-patel/tools/code-architecture-toolkit/dist/index.js"]
- env.WORKSPACE_ROOT: ${workspaceFolder}

Use forward slashes in Windows paths inside JSON.

### Option C: Per-project clone

Copy tools/code-architecture-toolkit into each repo and build there.

This gives full repo-local versioning at the cost of duplication.

