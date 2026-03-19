# webscraper-tool

MCP tool to scrape one or more web URLs and save structured JSON artifacts for later processing.

## What it does

- Accepts URL list and output directory.
- Fetches each page.
- Extracts title, summary, headings, and normalized text.
- Writes a single JSON artifact for all pages.

## Tool

- `web_scrape_to_json`

### Arguments

- `urls`: string[] (required)
- `outputDir`: string (optional, default `.scraped-data`)
- `outputFileName`: string (optional, default auto generated)
- `maxCharsPerPage`: number (optional, default `25000`)
- `timeoutMs`: number (optional, default `15000`)

### Output

Writes one JSON file with this shape:

```json
{
  "generatedAt": "2026-03-19T10:00:00.000Z",
  "sourceCount": 2,
  "sources": [
    {
      "url": "https://example.com",
      "title": "Example",
      "summary": "...",
      "headings": ["Intro"],
      "text": "...",
      "fetchedAt": "..."
    }
  ]
}
```

## Build and smoke test

```bash
npm install
npm run build
npm run smoke
```
