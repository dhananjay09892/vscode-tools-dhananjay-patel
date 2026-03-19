import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const SERVER_NAME = 'scrape-pipeline-tool';
const SERVER_VERSION = '0.0.1';
const DEFAULT_JSON_OUTPUT_DIR = '.scraped-data';
const DEFAULT_MARKDOWN_OUTPUT_DIR = '.scraped-markdown';
const DEFAULT_INDEX_FILE = 'INDEX.md';
const DEFAULT_MAX_PAGE_CHARS = 25000;
const DEFAULT_MAX_BODY_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 15000;

type ToolArgs = Record<string, unknown>;

interface ScrapedSource {
  url: string;
  title: string;
  summary: string;
  headings: string[];
  text: string;
  fetchedAt: string;
}

interface ScrapeArtifact {
  generatedAt: string;
  sourceCount: number;
  sources: ScrapedSource[];
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item)).filter((item) => item.length > 0);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function getWorkspaceRoot(): string {
  const root = process.env.WORKSPACE_ROOT;
  if (root && root.trim().length > 0) {
    return path.resolve(root);
  }
  return process.cwd();
}

function resolveInWorkspace(inputPath: string): string {
  const workspaceRoot = path.resolve(getWorkspaceRoot());
  const absolute = path.isAbsolute(inputPath) ? inputPath : path.resolve(workspaceRoot, inputPath);
  const normalized = path.resolve(absolute);

  if (!normalized.startsWith(workspaceRoot)) {
    throw new Error('Path must be inside workspace root');
  }

  return normalized;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html: string, url: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match?.[1]?.replace(/\s+/g, ' ').trim();
  return title && title.length > 0 ? title : url;
}

function extractSummary(html: string, text: string): string {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i);
  const metaSummary = match?.[1]?.replace(/\s+/g, ' ').trim();
  return metaSummary && metaSummary.length > 0 ? metaSummary : text.slice(0, 240);
}

function extractHeadings(html: string): string[] {
  const matches = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)];
  return matches
    .map((m) => stripHtml(m[1] ?? ''))
    .map((h) => h.trim())
    .filter((h) => h.length > 0)
    .slice(0, 20);
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : parsed.hostname;
  } catch {
    return 'source';
  }
}

function markdownEscape(value: string): string {
  return value.replace(/\|/g, '\\|');
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function buildMarkdown(source: ScrapedSource, maxBodyChars: number): string {
  const safeTitle = source.title?.trim() || titleFromUrl(source.url);
  const headings = (source.headings ?? []).filter((h) => h.trim().length > 0).slice(0, 20);
  const body = (source.text ?? '').trim().slice(0, maxBodyChars);

  const lines: string[] = [];
  lines.push(`# ${safeTitle}`);
  lines.push('');
  lines.push('## Source Metadata');
  lines.push('');
  lines.push(`- URL: ${source.url}`);
  lines.push(`- Fetched At: ${source.fetchedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(source.summary?.trim() || 'No summary available.');
  lines.push('');

  if (headings.length > 0) {
    lines.push('## Headings');
    lines.push('');
    for (const heading of headings) {
      lines.push(`- ${heading}`);
    }
    lines.push('');
  }

  lines.push('## Normalized Content');
  lines.push('');
  lines.push(body.length > 0 ? body : 'No content extracted.');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function jsonFileName(customName: string | undefined): string {
  if (customName) {
    return sanitizeFileName(customName.endsWith('.json') ? customName : `${customName}.json`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `scrape-${stamp}.json`;
}

function markdownIndexName(customName: string | undefined): string {
  const raw = sanitizeFileName(customName ?? DEFAULT_INDEX_FILE).replace(/\.md$/, '');
  return `${raw}.md`;
}

async function runPipeline(args: ToolArgs) {
  const urls = asStringArray(args.urls);
  if (urls.length === 0) {
    return {
      content: [{ type: 'text', text: 'No URLs provided. Pass urls as a non-empty string array.' }],
      isError: true
    };
  }

  const jsonOutputDir = resolveInWorkspace(asOptionalString(args.jsonOutputDir) ?? DEFAULT_JSON_OUTPUT_DIR);
  const markdownOutputDir = resolveInWorkspace(asOptionalString(args.markdownOutputDir) ?? DEFAULT_MARKDOWN_OUTPUT_DIR);
  const jsonName = jsonFileName(asOptionalString(args.jsonFileName));
  const indexName = markdownIndexName(asOptionalString(args.indexFileName));
  const maxCharsPerPage = asPositiveNumber(args.maxCharsPerPage, DEFAULT_MAX_PAGE_CHARS);
  const maxBodyChars = asPositiveNumber(args.maxBodyChars, DEFAULT_MAX_BODY_CHARS);
  const timeoutMs = asPositiveNumber(args.timeoutMs, DEFAULT_TIMEOUT_MS);

  const sources: ScrapedSource[] = [];
  const failures: string[] = [];

  for (const url of urls) {
    try {
      const html = await fetchWithTimeout(url, timeoutMs);
      const text = stripHtml(html).slice(0, maxCharsPerPage);
      sources.push({
        url,
        title: extractTitle(html, url),
        summary: extractSummary(html, text),
        headings: extractHeadings(html),
        text,
        fetchedAt: new Date().toISOString()
      });
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const artifact: ScrapeArtifact = {
    generatedAt: new Date().toISOString(),
    sourceCount: sources.length,
    sources
  };

  await fs.mkdir(jsonOutputDir, { recursive: true });
  await fs.mkdir(markdownOutputDir, { recursive: true });

  const artifactPath = path.join(jsonOutputDir, jsonName);
  await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');

  const writtenFiles: string[] = [];
  for (const source of sources) {
    const baseName = sanitizeFileName(source.title || titleFromUrl(source.url) || 'source');
    const fileName = baseName.length > 0 ? `${baseName}.md` : `source-${writtenFiles.length + 1}.md`;
    const absolute = path.join(markdownOutputDir, fileName);
    await fs.writeFile(absolute, buildMarkdown(source, maxBodyChars), 'utf-8');
    writtenFiles.push(absolute);
  }

  const indexLines: string[] = [];
  indexLines.push('# Scraped Knowledge Index');
  indexLines.push('');
  indexLines.push(`- Generated At: ${new Date().toISOString()}`);
  indexLines.push(`- Artifact Source: ${artifactPath}`);
  indexLines.push(`- Documents: ${writtenFiles.length}`);
  indexLines.push('');
  indexLines.push('| Title | File | URL |');
  indexLines.push('|---|---|---|');

  for (let i = 0; i < sources.length; i += 1) {
    const src = sources[i];
    const fileName = path.basename(writtenFiles[i]);
    indexLines.push(`| ${markdownEscape(src.title || 'Untitled')} | [${fileName}](./${fileName}) | ${markdownEscape(src.url)} |`);
  }

  const indexPath = path.join(markdownOutputDir, indexName);
  await fs.writeFile(indexPath, `${indexLines.join('\n')}\n`, 'utf-8');

  return {
    content: [
      {
        type: 'text',
        text: [
          'Pipeline completed.',
          `Artifact: ${artifactPath}`,
          `Markdown directory: ${markdownOutputDir}`,
          `Index file: ${indexPath}`,
          `Success: ${sources.length}`,
          `Failed: ${failures.length}`,
          failures.length > 0 ? `Failure details:\n- ${failures.join('\n- ')}` : 'Failure details: none'
        ].join('\n')
      }
    ]
  };
}

const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'scrape_and_convert_pipeline',
        description: 'End-to-end pipeline: scrape URLs to JSON and convert to organized markdown files in one run.',
        inputSchema: {
          type: 'object',
          properties: {
            urls: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of HTTP/HTTPS URLs to process.'
            },
            jsonOutputDir: {
              type: 'string',
              description: `JSON artifact directory. Default ${DEFAULT_JSON_OUTPUT_DIR}.`
            },
            markdownOutputDir: {
              type: 'string',
              description: `Markdown output directory. Default ${DEFAULT_MARKDOWN_OUTPUT_DIR}.`
            },
            jsonFileName: {
              type: 'string',
              description: 'Optional JSON artifact file name.'
            },
            indexFileName: {
              type: 'string',
              description: `Optional markdown index file name. Default ${DEFAULT_INDEX_FILE}.`
            },
            maxCharsPerPage: {
              type: 'number',
              description: `Max normalized characters saved per page. Default ${DEFAULT_MAX_PAGE_CHARS}.`
            },
            maxBodyChars: {
              type: 'number',
              description: `Max content characters per markdown document. Default ${DEFAULT_MAX_BODY_CHARS}.`
            },
            timeoutMs: {
              type: 'number',
              description: `Fetch timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`
            }
          },
          required: ['urls']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as ToolArgs;

  if (name === 'scrape_and_convert_pipeline') {
    return runPipeline(args);
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true
  };
});

const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error(`${SERVER_NAME} failed to start:`, error);
  process.exit(1);
});
