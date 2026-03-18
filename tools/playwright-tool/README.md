# Playwright Tool

## Purpose

Playwright Tool is an MCP server that recommends the most relevant Playwright guides for a developer objective.

It helps teams move faster by turning vague requests (for example, "stabilize flaky tests in CI") into focused implementation guidance backed by curated docs.

Implemented MCP tool:

- playwright_skill_advisor

## Why This Is Useful In Real Projects

### For coding with Copilot

- Reduces trial-and-error in test authoring by pointing to the right patterns early.
- Gives Copilot stronger context, so generated code follows stable Playwright practices.
- Improves consistency across engineers (selectors, waits, fixtures, CI settings).
- Helps junior developers produce production-ready test code faster.

### For automation quality

- Speeds up flaky test triage and stabilization.
- Standardizes CI pipeline setup, traces, retries, and artifacts.
- Supports migration plans from Cypress and Selenium.
- Improves maintainability via architecture and abstraction guidance.

## How It Works

The tool uses a two-stage recommendation flow:

1. Candidate retrieval from an internal guide catalog.
2. Ranking strategy:
   - Keyword ranking (default)
   - Optional hybrid ranking with external LLM reranking

Response includes:

- Human-readable recommendation list
- Machine-readable JSON output
- Optional golden rules checklist
- Selection strategy and LLM fallback details (when applicable)

## Trigger Behavior

Recommended usage is explicit slash trigger.

- Trigger format: /playwright-tool <objective>
- If no slash trigger is used, normal Copilot conversation remains uninterrupted.

Examples:

- /playwright-tool stabilize flaky tests in GitHub Actions
- /playwright-tool test Next.js auth flows with storage state
- /playwright-tool design POM structure for checkout journey

## Guide Coverage

The bundled guide catalog includes:

- Core testing topics (locators, waiting, fixtures, auth, mocking, debugging)
- CI topics (parallelization, sharding, containers, artifacts, coverage)
- POM and architecture decisions
- Migration tracks (Cypress and Selenium)
- Playwright CLI workflows

Catalog source is bundled under playwright-guides so runtime does not depend on external workspace folders.

## Quick Start (Local Development)

Run from tools/playwright-tool:

1. Install dependencies:

```bash
npm install
```

2. Build:

```bash
npm run build
```

3. Run smoke test:

```bash
npm run smoke
```

## Install Into A Target Repo

From tools/playwright-tool:

```bash
npm run install:repo -- --target "C:/path/to/project"
```

This updates target-repo/.vscode/mcp.json with a stdio server entry for this tool.

## Input Contract

Supported arguments:

- userInput: preferred, slash format text
- objective: direct objective (optional)
- topK: number of recommendations (default 5, max 15)
- includeRules: include golden rules (default true)
- force: bypass slash-trigger guard (useful for tests/automation)
- llmMode:
  - off (default)
  - external (keyword retrieval plus external LLM rerank)
- llmTopN: number of keyword candidates sent to LLM reranker (optional)
- orgDocsPath: optional path to organization guide JSON file
- orgDocsFolder: optional folder path containing organization markdown docs

Example:

```json
{
  "userInput": "/playwright-tool stabilize flaky tests in CI",
  "topK": 5,
  "llmMode": "external",
  "llmTopN": 12
}
```

## Add Organization Documentation

Yes, users can add their own internal documentation to this tool.

How it works:

- The tool merges organization guides with built-in guides.
- If an organization guide uses the same id as a built-in guide, the organization guide overrides it.
- Organization load info appears in output so users can confirm custom docs were used.

Supported load options:

1. Per request using orgDocsPath argument
2. Environment variable PLAYWRIGHT_TOOL_ORG_DOCS_PATH
3. Default file path under workspace root: .playwright-tool/org-guides.json
4. Per request using orgDocsFolder argument (markdown folder)
5. Environment variable PLAYWRIGHT_TOOL_ORG_DOCS_DIR

Docs folder mode:

- Tool scans .md files recursively in orgDocsFolder.
- It auto-generates title, summary, keywords, and category inference from path/content.
- Use this mode when your organization already maintains markdown docs and you do not want to maintain a separate JSON catalog.

### Organization Guide File Format

File must be a JSON array.

```json
[
  {
    "id": "org-checkout-flow",
    "category": "core",
    "path": "docs/testing/checkout-flow.md",
    "title": "Checkout Flow Testing",
    "summary": "Org-standard checkout automation flow with payment fallback and fraud checks.",
    "keywords": [
      "checkout",
      "payment",
      "fraud",
      "order confirmation",
      "retry"
    ]
  },
  {
    "id": "ci-github-actions",
    "category": "ci",
    "path": "docs/testing/ci-playwright-policy.md",
    "title": "Org CI Playwright Policy",
    "summary": "Team policy for retries, trace retention, and flaky quarantine in GitHub Actions.",
    "keywords": ["ci", "github actions", "retry policy", "trace", "quarantine"]
  }
]
```

Allowed category values:

- core
- ci
- pom
- migration
- playwright-cli
- architecture

Required fields per entry:

- id
- category
- path
- title
- summary
- keywords (non-empty array)

### Usage Examples

Per call:

```json
{
  "userInput": "/playwright-tool build automation for checkout and refund flow",
  "orgDocsPath": ".playwright-tool/org-guides.json",
  "topK": 5
}
```

Environment variable setup:

```powershell
$env:PLAYWRIGHT_TOOL_ORG_DOCS_PATH = "C:/repo/.playwright-tool/org-guides.json"
```

This lets each organization inject its own standards, architecture rules, and domain workflows into recommendations used by Copilot.

### Example asked by users

User prompt:

- /playwright-tool can i add docs folder in tool ?

Answer in tool flow:

- Yes. Set orgDocsFolder to your docs directory and the tool will ingest markdown files.

Example payload:

```json
{
  "userInput": "/playwright-tool create automation flow for checkout app",
  "orgDocsFolder": "docs/testing/playwright",
  "topK": 5
}
```

## Optional LLM Mode

Use llmMode=external when you want better intent understanding than keyword-only matching.

Required environment variables:

- PLAYWRIGHT_TOOL_LLM_API_URL
- PLAYWRIGHT_TOOL_LLM_API_KEY

Optional environment variables:

- PLAYWRIGHT_TOOL_LLM_MODEL (default: gpt-4o-mini)
- PLAYWRIGHT_TOOL_LLM_MODE (off or external)

Behavior guarantees:

- If LLM config is missing, invalid, or request fails, tool falls back to keyword ranking.
- Recommendation output includes fallback reason for observability.

## How Developers Should Use This With Copilot

Use this as a context-builder before or during coding.

Suggested workflow:

1. Ask with objective:
   - /playwright-tool stabilize flaky login tests in CI
2. Read top recommended guide paths and key reasons.
3. Ask Copilot to implement changes based on those specific guides.
4. Re-run tests and refine with a second objective if needed.

Prompt patterns that work well:

- Use recommended guides from playwright-tool and generate resilient locators and waits for this test file.
- Based on the selected CI guides, update playwright.config and GitHub Actions workflow for retries and trace retention.
- Apply migration guidance to convert this Cypress spec into Playwright test plus fixtures.

## Real-World Scenarios

### Scenario 1: Flaky CI tests

Input:

- /playwright-tool stabilize flaky tests in ci with retries and traces

Outcome:

- Prioritizes flaky-tests, assertions-and-waiting, debugging, and CI artifact guides.
- Teams get a structured stabilization plan instead of random fixes.

### Scenario 2: Auth and role coverage

Input:

- /playwright-tool test multi-role auth flows with storage state reuse

Outcome:

- Surfaces authentication and auth-flow guides with fixture recommendations.
- Developers generate cleaner login setup and avoid repeated login logic.

### Scenario 3: Cypress migration

Input:

- /playwright-tool migrate cypress suite to playwright incrementally

Outcome:

- Recommends migration docs plus architecture guidance.
- Helps define phased migration with less delivery risk.

## Best Practices For Teams

- Keep slash-trigger usage explicit for predictable behavior.
- Use llmMode=external in complex objectives; use off for deterministic and low-cost operation.
- Save recurring objective templates for common incidents (flaky, auth, CI failures).
- Pair recommendations with coding standards in your repo.
- Review top guide recommendations in PR reviews when test strategy changes.

## Troubleshooting

### Tool returns skip message

Cause:

- Input was missing /playwright-tool trigger and force was not set.

Fix:

- Use slash-trigger format or pass force=true in automation.

### LLM rerank did not run

Cause:

- Missing env vars or external API error.

Fix:

- Set PLAYWRIGHT_TOOL_LLM_API_URL and PLAYWRIGHT_TOOL_LLM_API_KEY.
- Confirm endpoint is OpenAI-compatible for chat completions style payload.

### Recommendations feel generic

Fix options:

- Provide more specific objective text (framework, CI system, failure pattern).
- Increase topK and llmTopN.
- Add more guide-specific keywords and summaries in source catalog.

## Validation Commands

From repo root:

```bash
npm --prefix tools/playwright-tool run build
npm --prefix tools/playwright-tool run smoke
```

## Summary

Playwright Tool improves how teams use Copilot for test coding and automation by guiding the model and the developer toward the right implementation docs first. That leads to faster delivery, fewer flaky patterns, and more consistent test architecture across projects.
