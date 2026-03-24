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
- [Webscraper Tool](../tools/webscraper-tool/README.md)
- [Scrape Markdown Tool](../tools/scrape-markdown-tool/README.md)
- [Scrape Pipeline Tool](../tools/scrape-pipeline-tool/README.md)
- [Backend API Contract Guardian](../tools/backend-api-contract-guardian/README.md)
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
  "toolId": "webscraper-tool",
  "docPath": "tools/webscraper-tool/README.md",
  "summary": "MCP server that scrapes web pages and stores normalized structured JSON artifacts.",
  "useCases": [
    "collect internet standards sources",
    "build research corpora for tools",
    "capture URL content into JSON"
  ],
  "keywords": [
    "scrape",
    "web",
    "research",
    "json",
    "url",
    "crawler"
  ]
}
```

```tool-meta
{
  "toolId": "scrape-markdown-tool",
  "docPath": "tools/scrape-markdown-tool/README.md",
  "summary": "MCP server that converts scrape JSON artifacts into organized markdown knowledge packs.",
  "useCases": [
    "convert scraped data to markdown",
    "build indexed knowledge packs",
    "prepare docs for devpilot consumption"
  ],
  "keywords": [
    "markdown",
    "converter",
    "knowledge base",
    "index",
    "scrape"
  ]
}
```

```tool-meta
{
  "toolId": "scrape-pipeline-tool",
  "docPath": "tools/scrape-pipeline-tool/README.md",
  "summary": "MCP orchestration server that performs scrape and markdown conversion in a single pipeline call.",
  "useCases": [
    "one-shot research download",
    "generate json and markdown together",
    "repeatable standards ingestion"
  ],
  "keywords": [
    "pipeline",
    "orchestration",
    "scrape",
    "markdown",
    "automation"
  ]
}
```

```tool-meta
{
  "toolId": "backend-api-contract-guardian",
  "docPath": "tools/backend-api-contract-guardian/README.md",
  "summary": "MCP server that validates backend OpenAPI contracts for governance, security, reliability, and breaking changes.",
  "useCases": [
    "detect breaking changes",
    "enforce API contract policy",
    "validate error and security schemas",
    "generate contract validation reports"
  ],
  "keywords": [
    "openapi",
    "contract",
    "breaking change",
    "api governance",
    "security",
    "spectral",
    "backend"
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
