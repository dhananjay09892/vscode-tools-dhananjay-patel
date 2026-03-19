# scrape-markdown-tool

MCP tool to convert web scrape JSON artifacts into clean markdown files and an index document.

## What it does

- Reads a scrape artifact produced by webscraper-tool.
- Creates one markdown file per source.
- Adds source metadata and summary.
- Writes a master index file to navigate all generated docs.

## Tool

- `scrape_json_to_markdown`

### Arguments

- `inputFile`: string (required)
- `outputDir`: string (optional, default `.scraped-markdown`)
- `indexFileName`: string (optional, default `INDEX.md`)
- `maxBodyChars`: number (optional, default `12000`)

## Build and smoke test

```bash
npm install
npm run build
npm run smoke
```
