# Playwright Tool

## Goal

Provide focused Playwright testing guidance and guide recommendations for E2E, API, component, CI, migration, and CLI use cases.

## Implemented Tool

- playwright_skill_advisor

## What It Does

- Returns a complete guide catalog grouped by category when no objective is provided.
- Recommends best-fit Playwright guides for a developer objective.
- Supports explicit slash-trigger mode so users control when this tool runs.
- Returns both human-readable output and machine-readable JSON.
- Bundles Playwright skill content inside this tool folder so installs are self-contained.

## Bundled Content

- Source bundle path: playwright-guides/
- This folder is packaged with the tool during public-install deployment.
- No dependency on external workspace paths like Other Data/playwright-skill-main at runtime.

## Recommended User Experience

- Run this tool when user text starts with /playwright-tool.
- If user does not use that trigger, keep normal Copilot/LLM flow.

### Trigger Examples

- /playwright-tool stabilize flaky tests in GitHub Actions
- /playwright-tool test Next.js auth flows with storage state

### Non-Trigger Example

- How should I test login?
- Expected behavior: normal LLM response, no forced tool routing.

## Quick Start

1. Install dependencies:

\tnpm install

2. Build:

\tnpm run build

3. Run smoke test:

\tnpm run smoke

## MCP Install Into Target Repo

Run from this tool folder:

\tnpm run install:repo -- --target "C:/path/to/project"

## Input Contract

- Preferred input: userInput with slash format.
- Optional input: objective (direct objective text).
- Optional input: topK (default 5, max 15).
- Optional input: force=true for tests or automation.

Example payload:

```json
{
  "userInput": "/playwright-tool stabilize flaky tests in CI",
  "topK": 4
}
```
