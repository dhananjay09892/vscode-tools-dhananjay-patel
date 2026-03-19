# scrape-pipeline-tool

MCP orchestration tool that performs the complete pipeline in one call:

1. Fetch and scrape URLs
2. Save JSON artifact
3. Convert artifact into organized markdown files
4. Produce an index markdown file

## Tool

- `scrape_and_convert_pipeline`

### Arguments

- `urls`: string[] (required)
- `jsonOutputDir`: string (optional, default `.scraped-data`)
- `markdownOutputDir`: string (optional, default `.scraped-markdown`)
- `jsonFileName`: string (optional)
- `indexFileName`: string (optional, default `INDEX.md`)
- `maxCharsPerPage`: number (optional, default `25000`)
- `maxBodyChars`: number (optional, default `12000`)
- `timeoutMs`: number (optional, default `15000`)
