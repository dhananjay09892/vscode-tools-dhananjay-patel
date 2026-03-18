# Tool Documentation Index

This file is the canonical documentation index for Tool Reception metadata.

Rules:
- One `tool-meta` JSON block per tool.
- `toolId`, `docPath`, `summary`, `useCases`, and `keywords` are required.
- `toolId` must match a tool in `scripts/tool-registry.json`.

## Documents

- [Architecture Validator](../tools/architecture-validator/README.md)
- [Code Architecture Toolkit](../tools/code-architecture-toolkit/README.md)
- [Playwright Tool](../tools/playwright-tool/README.md)
- [Tool Reception](../tools/tool-reception/README.md)

```tool-meta
{
  "toolId": "architecture-validator",
  "docPath": "tools/architecture-validator/README.md",
  "summary": "VS Code extension that validates architecture boundaries and layer policies.",
  "useCases": [
    "layer policy checks",
    "pre-merge architecture validation",
    "import boundary rules"
  ],
  "keywords": [
    "layer",
    "validator",
    "import policy",
    "architecture rule"
  ]
}
```

```tool-meta
{
  "toolId": "code-architecture-toolkit",
  "docPath": "tools/code-architecture-toolkit/README.md",
  "summary": "MCP server for dependency analysis, architecture views, and scaffolding.",
  "useCases": [
    "analyze imports",
    "find cycles",
    "scaffold module",
    "repo architecture overview"
  ],
  "keywords": [
    "dependency",
    "cycle",
    "module",
    "architecture",
    "fastapi",
    "mcp"
  ]
}
```

```tool-meta
{
  "toolId": "playwright-tool",
  "docPath": "tools/playwright-tool/README.md",
  "summary": "Playwright skill advisor for E2E, CI, flakiness reduction, and migration guidance.",
  "useCases": [
    "stabilize flaky tests",
    "recommend Playwright guides",
    "CI pipeline setup",
    "Cypress to Playwright migration"
  ],
  "keywords": [
    "playwright",
    "e2e",
    "flaky",
    "trace",
    "ci",
    "test automation",
    "cypress migration"
  ]
}
```

```tool-meta
{
  "toolId": "tool-reception",
  "docPath": "tools/tool-reception/README.md",
  "summary": "Tool discovery entry point that recommends the best internal tool for a task.",
  "useCases": [
    "discover available tools",
    "route objective to best tool",
    "tool onboarding guidance"
  ],
  "keywords": [
    "discover",
    "recommend",
    "tooling",
    "onboarding",
    "catalog"
  ]
}
```
