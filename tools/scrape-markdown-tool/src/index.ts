import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const SERVER_NAME = 'scrape-markdown-tool';
const SERVER_VERSION = '0.0.1';
const DEFAULT_OUTPUT_DIR = '.scraped-markdown';
const DEFAULT_INDEX_FILE = 'INDEX.md';
const DEFAULT_MAX_BODY_CHARS = 12000;

type ToolArgs = Record<string, unknown>;

interface ScrapedSource {
  url: string;
  title: string;
  summary: string;
  headings?: string[];
  text: string;
  fetchedAt?: string;
}

interface ScrapeArtifact {
  generatedAt?: string;
  sourceCount?: number;
  sources: ScrapedSource[];
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getWorkspaceRoot(): string {
  const root = process.env.WORKSPACE_ROOT;
  if (root && root.trim().length > 0) {
    return path.resolve(root);
  }
  return process.cwd();
}

function resolveInWorkspace(inputPath: string): string {
  const workspaceRoot = getWorkspaceRoot();
  const absolute = path.isAbsolute(inputPath) ? inputPath : path.resolve(workspaceRoot, inputPath);
  const normalized = path.resolve(absolute);
  if (!normalized.startsWith(path.resolve(workspaceRoot))) {
    throw new Error('Path must be inside workspace root');
  }
  return normalized;
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
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

function buildMarkdown(source: ScrapedSource, maxBodyChars: number): string {
  const safeTitle = source.title?.trim() || titleFromUrl(source.url);
  const headings = (source.headings ?? []).filter((h) => h.trim().length > 0).slice(0, 20);
  const body = (source.text ?? '').trim().slice(0, maxBodyChars);
  const fetchedAt = source.fetchedAt ?? 'unknown';
  const summary = source.summary?.trim() || 'No summary available.';

  const lines: string[] = [];
  lines.push(`# ${safeTitle}`);
  lines.push('');
  lines.push('## Source Metadata');
  lines.push('');
  lines.push(`- URL: ${source.url}`);
  lines.push(`- Fetched At: ${fetchedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(summary);
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

async function loadArtifact(filePath: string): Promise<ScrapeArtifact> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<ScrapeArtifact>;

  if (!parsed || !Array.isArray(parsed.sources)) {
    throw new Error('Invalid artifact: expected { sources: [...] }');
  }

  return {
    generatedAt: parsed.generatedAt,
    sourceCount: parsed.sourceCount,
    sources: parsed.sources
  };
}

async function handleConvert(args: ToolArgs) {
  const inputFileArg = asOptionalString(args.inputFile);
  if (!inputFileArg) {
    return {
      content: [{ type: 'text', text: 'Missing required argument: inputFile' }],
      isError: true
    };
  }

  const outputDirArg = asOptionalString(args.outputDir) ?? DEFAULT_OUTPUT_DIR;
  const indexFileName = asOptionalString(args.indexFileName) ?? DEFAULT_INDEX_FILE;
  const maxBodyChars = asPositiveNumber(args.maxBodyChars, DEFAULT_MAX_BODY_CHARS);

  const inputFile = resolveInWorkspace(inputFileArg);
  const outputDir = resolveInWorkspace(outputDirArg);

  const artifact = await loadArtifact(inputFile);
  await fs.mkdir(outputDir, { recursive: true });

  const writtenFiles: string[] = [];
  for (const source of artifact.sources) {
    const baseName = sanitizeFileName(source.title || titleFromUrl(source.url) || 'source');
    const fileName = baseName.length > 0 ? `${baseName}.md` : `source-${writtenFiles.length + 1}.md`;
    const absolute = path.join(outputDir, fileName);
    await fs.writeFile(absolute, buildMarkdown(source, maxBodyChars), 'utf-8');
    writtenFiles.push(absolute);
  }

  const indexLines: string[] = [];
  indexLines.push('# Scraped Knowledge Index');
  indexLines.push('');
  indexLines.push(`- Generated At: ${new Date().toISOString()}`);
  indexLines.push(`- Artifact Source: ${inputFile}`);
  indexLines.push(`- Documents: ${writtenFiles.length}`);
  indexLines.push('');
  indexLines.push('| Title | File | URL |');
  indexLines.push('|---|---|---|');

  for (let i = 0; i < artifact.sources.length; i += 1) {
    const src = artifact.sources[i];
    const docPath = writtenFiles[i];
    const fileName = path.basename(docPath);
    indexLines.push(`| ${markdownEscape(src.title || 'Untitled')} | [${fileName}](./${fileName}) | ${markdownEscape(src.url)} |`);
  }

  const indexPath = path.join(outputDir, sanitizeFileName(indexFileName).replace(/\.md$/, '') + '.md');
  await fs.writeFile(indexPath, `${indexLines.join('\n')}\n`, 'utf-8');

  return {
    content: [
      {
        type: 'text',
        text: [
          'Markdown conversion completed.',
          `Input artifact: ${inputFile}`,
          `Output directory: ${outputDir}`,
          `Index file: ${indexPath}`,
          `Generated files: ${writtenFiles.length}`
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
        name: 'scrape_json_to_markdown',
        description: 'Convert scrape JSON artifacts into a structured markdown knowledge folder with an index.',
        inputSchema: {
          type: 'object',
          properties: {
            inputFile: {
              type: 'string',
              description: 'Path to scrape JSON artifact.'
            },
            outputDir: {
              type: 'string',
              description: 'Directory for generated markdown files. Relative paths resolve from workspace root.'
            },
            indexFileName: {
              type: 'string',
              description: `Name of index markdown file. Default ${DEFAULT_INDEX_FILE}.`
            },
            maxBodyChars: {
              type: 'number',
              description: `Maximum body characters per markdown file. Default ${DEFAULT_MAX_BODY_CHARS}.`
            }
          },
          required: ['inputFile']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as ToolArgs;

  if (name === 'scrape_json_to_markdown') {
    return handleConvert(args);
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
