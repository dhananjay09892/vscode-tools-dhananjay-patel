import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const SERVER_NAME = 'webscraper-tool';
const SERVER_VERSION = '0.0.1';
const DEFAULT_OUTPUT_DIR = '.scraped-data';
const DEFAULT_MAX_CHARS = 25000;
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
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
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
  if (title && title.length > 0) {
    return title;
  }
  return url;
}

function extractSummary(html: string, text: string): string {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i);
  const metaSummary = match?.[1]?.replace(/\s+/g, ' ').trim();
  if (metaSummary && metaSummary.length > 0) {
    return metaSummary;
  }
  return text.slice(0, 240);
}

function extractHeadings(html: string): string[] {
  const matches = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)];
  return matches
    .map((m) => stripHtml(m[1] ?? ''))
    .map((h) => h.trim())
    .filter((h) => h.length > 0)
    .slice(0, 20);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function getWorkspaceRoot(): string {
  const root = process.env.WORKSPACE_ROOT;
  if (root && root.trim().length > 0) {
    return path.resolve(root);
  }
  return process.cwd();
}

function resolveOutputDir(outputDirArg: string | undefined): string {
  const workspaceRoot = getWorkspaceRoot();
  const desired = outputDirArg ?? DEFAULT_OUTPUT_DIR;
  const absolute = path.isAbsolute(desired) ? desired : path.resolve(workspaceRoot, desired);
  const normalized = path.resolve(absolute);

  // Guardrail: keep writes under workspace for safety.
  if (!normalized.startsWith(path.resolve(workspaceRoot))) {
    throw new Error('outputDir must be inside workspace root');
  }
  return normalized;
}

function artifactFileName(customName: string | undefined): string {
  if (customName) {
    return sanitizeFileName(customName.endsWith('.json') ? customName : `${customName}.json`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `scrape-${stamp}.json`;
}

async function handleScrape(args: ToolArgs) {
  const urls = asStringArray(args.urls);
  if (urls.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No URLs provided. Pass urls as a non-empty string array.'
        }
      ]
    };
  }

  const outputDir = resolveOutputDir(asOptionalString(args.outputDir));
  const outputFileName = artifactFileName(asOptionalString(args.outputFileName));
  const maxCharsPerPage = asPositiveNumber(args.maxCharsPerPage, DEFAULT_MAX_CHARS);
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

  await fs.mkdir(outputDir, { recursive: true });
  const outPath = path.join(outputDir, outputFileName);
  await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');

  return {
    content: [
      {
        type: 'text',
        text: [
          'Web scrape completed.',
          `Saved: ${outPath}`,
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
        name: 'web_scrape_to_json',
        description: 'Fetch URLs and persist structured scrape artifacts as JSON in a selected workspace directory.',
        inputSchema: {
          type: 'object',
          properties: {
            urls: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of HTTP/HTTPS URLs to scrape.'
            },
            outputDir: {
              type: 'string',
              description: 'Directory to write the scrape artifact. Relative paths are resolved from workspace root.'
            },
            outputFileName: {
              type: 'string',
              description: 'Optional output JSON file name.'
            },
            maxCharsPerPage: {
              type: 'number',
              description: `Max normalized characters to keep per page. Default ${DEFAULT_MAX_CHARS}.`
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

  if (name === 'web_scrape_to_json') {
    return handleScrape(args);
  }

  return {
    content: [
      {
        type: 'text',
        text: `Unknown tool: ${name}`
      }
    ],
    isError: true
  };
});

const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error(`${SERVER_NAME} failed to start:`, error);
  process.exit(1);
});
