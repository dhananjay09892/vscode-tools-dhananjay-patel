# Tool Reception

## Goal

Provide a single entry point that helps developers discover all tools and get recommendations.

## Implemented Tool

- tool_reception

## What It Does

- Returns a full tool catalog when no objective is provided.
- Recommends best-fit tools based on user objective.
- Explains why each recommendation matched.
- Returns both human-readable output and machine-readable JSON.
- Supports explicit slash-trigger mode so users control when this tool runs.

## Recommended User Experience

- Run this tool only when user text starts with `/tool-reception`.
- If user does not use that trigger, keep normal Copilot/LLM response flow.
- This prevents accidental tool routing and chat irritation.

### Trigger Examples

- `/tool-reception validate architecture layers before PR`
- `/tool-reception find dependency cycle risks in this repo`

### Non-Trigger Example

- `How can I improve this PR?`
- Expected behavior: normal LLM response, no forced tool routing.

## Quick Start

1. Install dependencies:

\tnpm install

2. Build:

\tnpm run build

3. Run smoke test:

\tnpm run smoke

4. Run objective-to-tool golden tests:

	npm run test:golden

5. Sync local snapshot and metadata from root registry:

	npm run sync:catalog

6. Validate docs index coverage (fails if registry tool is undocumented):

	npm run check:docs-index

Docs metadata source of truth:

- `docs/tool-docs-index.md`
- Include one `tool-meta` JSON block per tool.

## MCP Install Into Target Repo

Run from this tool folder:

\tnpm run install:repo -- --target "C:/path/to/project"

## Input Contract

- Preferred input: `userInput` with slash format.
- Optional input: `objective` (used only when `force=true` or for internal automation).
- Optional input: `topK` (default 3, max 10).
- Optional input: `force=true` for tests/automation to bypass slash check.

Trigger rules:

- Normal mode (`force=false`): recommendation objectives must come from `userInput` with `/tool-reception ...`.
- Automation mode (`force=true`): direct `objective` is accepted.

Example payload:

```json
{
	"userInput": "/tool-reception validate architecture layers before PR",
	"topK": 2
}
```
