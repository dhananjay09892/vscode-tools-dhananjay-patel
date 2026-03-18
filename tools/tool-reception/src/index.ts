import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from '@modelcontextprotocol/sdk/types.js';

const SERVER_NAME = 'tool-reception';
const SERVER_VERSION = '0.0.1';
const INSTALL_CONFIRM_TOKEN = 'CONFIRM_INSTALL';
const DEFAULT_INSTALLER_REPO_URL = 'https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git';
const DEFAULT_INSTALLER_VERSION = '20260317';

type ToolArgs = Record<string, unknown>;

type ToolCategory = 'mcp-server' | 'vscode-extension' | 'tooling';

interface ToolCatalogEntry {
  toolId: string;
  displayName: string;
  category: ToolCategory;
  summary: string;
  useCases: string[];
  keywords: string[];
  onboarding: string;
  documentation?: string;
}

interface ToolRegistryShape {
  defaultToolId?: string;
  tools?: Record<string, { kind?: string }>;
}

type ToolMetadata = Omit<ToolCatalogEntry, 'toolId' | 'displayName' | 'category' | 'onboarding'>;

type ToolMetadataMap = Record<string, ToolMetadata>;

const DEFAULT_TOOL_METADATA: ToolMetadataMap = {
  'code-architecture-toolkit': {
    summary: 'MCP server for dependency analysis, architecture views, and scaffolding.',
    useCases: ['analyze imports', 'find cycles', 'scaffold module', 'repo architecture overview'],
    keywords: ['dependency', 'cycle', 'module', 'architecture', 'fastapi', 'mcp'],
    documentation: 'tools/code-architecture-toolkit/README.md'
  },
  'architecture-validator': {
    summary: 'VS Code extension that validates architecture boundaries and layer policies.',
    useCases: ['layer policy checks', 'pre-merge architecture validation', 'import boundary rules'],
    keywords: ['layer', 'validator', 'import policy', 'architecture rule'],
    documentation: 'tools/architecture-validator/README.md'
  },
  'tool-reception': {
    summary: 'Tool discovery entry point that recommends the best internal tool for a task.',
    useCases: ['discover available tools', 'route objective to best tool', 'tool onboarding guidance'],
    keywords: ['discover', 'recommend', 'tooling', 'onboarding', 'catalog'],
    documentation: 'tools/tool-reception/README.md'
  },
  'playwright-tool': {
    summary: 'Playwright skill advisor for E2E, CI, flakiness reduction, and migration guidance.',
    useCases: ['stabilize flaky tests', 'recommend Playwright guides', 'CI pipeline setup', 'Cypress to Playwright migration'],
    keywords: ['playwright', 'e2e', 'flaky', 'trace', 'ci', 'test automation', 'cypress migration'],
    documentation: 'tools/playwright-tool/README.md'
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const toolRoot = path.resolve(__dirname, '..');

const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd());
const MIN_RECOMMENDATION_SCORE = 4;
let toolCatalogCache: ToolCatalogEntry[] | undefined;
let toolMetadataCache: ToolMetadataMap | undefined;

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
        name: 'tool_reception',
        description:
          'Slash-triggered tool discovery. Use only when user input starts with /tool-reception; otherwise keep normal LLM response.',
        inputSchema: {
          type: 'object',
          properties: {
            userInput: {
              type: 'string',
              description:
                'Raw user text. Expected format: /tool-reception <objective>. Tool will no-op if slash trigger is absent.'
            },
            objective: {
              type: 'string',
              description:
                'Objective text. Optional when userInput includes /tool-reception <objective>.'
            },
            topK: {
              type: 'number',
              description: 'Max recommended tools to return. Default: 3.'
            },
            force: {
              type: 'boolean',
              description:
                'When true, bypass slash-trigger check and run directly. Useful for tests or internal automation.'
            },
            autoInstall: {
              type: 'boolean',
              description:
                'When true, include an installation handoff plan for the top recommendation. No installation runs automatically.'
            },
            confirmInstall: {
              type: 'string',
              description:
                `Explicit safety confirmation token required with autoInstall=true. Expected value: ${INSTALL_CONFIRM_TOKEN}`
            },
            installerRepoUrl: {
              type: 'string',
              description:
                'Optional override for installer repo URL used in generated handoff command.'
            },
            installerVersion: {
              type: 'string',
              description:
                'Optional cache-bust version token for public-install.ps1 URL. Default matches project README snippet.'
            }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  try {
    const { name, arguments: args = {} } = request.params;

    if (name === 'tool_reception') {
      return await handleToolReception(args as ToolArgs);
    }

    return textResult(`Unknown tool: ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [
        {
          type: 'text',
          text: `Tool execution failed: ${message}`
        }
      ],
      isError: true
    };
  }
});

async function handleToolReception(args: ToolArgs) {
  const toolCatalog = await getToolCatalog();
  const userInput = (asString(args.userInput) || '').trim();
  const objectiveArg = (asString(args.objective) || '').trim();
  const force = asBoolean(args.force) ?? false;
  const objectiveFromInput = parseTriggeredObjective(userInput);

  if (!force && userInput && !objectiveFromInput) {
    return textResult(
      [
        'Tool Reception: skipped (no explicit slash trigger).',
        'Expected format: /tool-reception <objective>',
        'This keeps regular Copilot/LLM replies uninterrupted when users do not request this tool.'
      ].join('\n')
    );
  }

  if (!force && !userInput && objectiveArg) {
    return textResult(
      [
        'Tool Reception: skipped (objective provided without slash trigger).',
        'Use userInput with format: /tool-reception <objective>',
        'For automation and tests, pass force=true to bypass trigger checks.'
      ].join('\n')
    );
  }

  const objective = (objectiveFromInput || (force ? objectiveArg : '')).trim();
  const topK = Math.max(1, Math.min(10, asNumber(args.topK) ?? 3));
  const autoInstall = asBoolean(args.autoInstall) ?? false;
  const confirmInstall = (asString(args.confirmInstall) || '').trim();
  const installerRepoUrl = (asString(args.installerRepoUrl) || DEFAULT_INSTALLER_REPO_URL).trim();
  const installerVersion = (asString(args.installerVersion) || DEFAULT_INSTALLER_VERSION).trim();

  if (!objective) {
    const lines = [
      `Workspace: ${workspaceRoot}`,
      'Tool Reception: available tool catalog',
      ...toolCatalog.map(
        (entry) =>
          `- ${entry.toolId} [${entry.category}] :: ${entry.summary} | use cases: ${entry.useCases.join(', ')} | docs: ${entry.documentation || 'n/a'}`
      ),
      'Set objective to get recommendations. Example: userInput="/tool-reception validate architecture layers before PR"'
    ];

    lines.push('Catalog JSON:');
    lines.push(JSON.stringify({ tools: toolCatalog }, null, 2));
    return textResult(lines.join('\n'));
  }

  const ranked = rankToolsForObjective(objective, toolCatalog).slice(0, topK);

  if (ranked.length === 0 || ranked[0].score < MIN_RECOMMENDATION_SCORE) {
    const lines = [
      `Workspace: ${workspaceRoot}`,
      `Tool Reception objective: ${objective}`,
      'No strong recommendation yet from the current objective.',
      'Try a more specific objective. Example prompts:',
      '- /tool-reception validate architecture layers before PR',
      '- /tool-reception find dependency cycles and coupling hotspots',
      '- /tool-reception stabilize flaky Playwright tests in CI'
    ];
    return textResult(lines.join('\n'));
  }

  const lines = [
    `Workspace: ${workspaceRoot}`,
    `Tool Reception objective: ${objective}`,
    `Recommendations (top ${ranked.length}, confidence=${confidenceLabel(ranked[0].score)}):`
  ];

  for (const [idx, rec] of ranked.entries()) {
    lines.push(
      `${idx + 1}. ${rec.tool.toolId} (score=${rec.score}) -> ${rec.tool.summary}`
    );
    lines.push(`   Use cases: ${rec.tool.useCases.join(', ')}`);
    lines.push(`   Why: matched keywords: ${rec.matches.join(', ') || 'context similarity'}`);
    lines.push(`   Documentation: ${rec.tool.documentation || 'n/a'}`);
    lines.push(`   One-line selector: ${rec.tool.onboarding}`);
  }

  let installPlan: {
    status: 'disabled' | 'needs-confirmation' | 'ready';
    toolId?: string;
    command?: string;
    confirmationToken?: string;
  } = { status: 'disabled' };

  if (autoInstall) {
    const topRecommendation = ranked[0]?.tool;
    if (topRecommendation) {
      const command = buildPublicInstallCommand(topRecommendation.toolId, installerRepoUrl, installerVersion);

      if (confirmInstall !== INSTALL_CONFIRM_TOKEN) {
        installPlan = {
          status: 'needs-confirmation',
          toolId: topRecommendation.toolId,
          command,
          confirmationToken: INSTALL_CONFIRM_TOKEN
        };
        lines.push('Install handoff: confirmation required before providing runnable install flow.');
        lines.push(`Set confirmInstall to "${INSTALL_CONFIRM_TOKEN}" with autoInstall=true to enable the handoff command.`);
      } else {
        installPlan = {
          status: 'ready',
          toolId: topRecommendation.toolId,
          command,
          confirmationToken: INSTALL_CONFIRM_TOKEN
        };
        lines.push('Install handoff: ready. Run this PowerShell command in the target repository folder:');
        lines.push(command);
      }
    }
  }

  lines.push('Recommendation JSON:');
  lines.push(
    JSON.stringify(
      {
        objective,
        installPlan,
        recommendations: ranked.map((rec) => ({
          toolId: rec.tool.toolId,
          score: rec.score,
          summary: rec.tool.summary,
          useCases: rec.tool.useCases,
          matchedKeywords: rec.matches,
          documentation: rec.tool.documentation,
          onboarding: rec.tool.onboarding
        }))
      },
      null,
      2
    )
  );

  return textResult(lines.join('\n'));
}

function rankToolsForObjective(
  objective: string,
  toolCatalog: ToolCatalogEntry[]
): Array<{ tool: ToolCatalogEntry; score: number; matches: string[] }> {
  const normalized = normalizeText(objective);
  const normalizedTokens = new Set(tokenize(normalized));

  const scopedTerms = new Set<string>(normalizedTokens);
  for (const token of normalizedTokens) {
    for (const related of expandToken(token)) {
      scopedTerms.add(related);
    }
  }

  const scored = toolCatalog.map((tool) => {
    let score = 0;
    const matches: string[] = [];

    for (const keyword of tool.keywords) {
      const keywordNormalized = normalizeText(keyword);
      if (normalized.includes(keywordNormalized)) {
        score += 3;
        matches.push(keyword);
        continue;
      }

      const keywordTokens = tokenize(keywordNormalized);
      if (keywordTokens.some((token) => scopedTerms.has(token))) {
        score += 2;
        matches.push(keyword);
      }
    }

    for (const useCase of tool.useCases) {
      const significant = tokenize(useCase).filter((part) => part.length >= 4);
      const hit = significant.some((token) => scopedTerms.has(token));
      if (hit) {
        score += 2;
        matches.push(useCase);
      }
    }

    if (normalized.includes(tool.category)) {
      score += 1;
    }

    return { tool, score, matches: unique(matches) };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.toolId.localeCompare(b.tool.toolId));
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseTriggeredObjective(userInput: string): string | undefined {
  if (!userInput) {
    return undefined;
  }

  const match = userInput.match(/^\s*\/tool-reception(?:\s+(.+))?\s*$/i);
  if (!match) {
    return undefined;
  }

  return (match[1] || '').trim();
}

function textResult(text: string) {
  return {
    content: [
      {
        type: 'text',
        text
      }
    ]
  };
}

async function getToolCatalog(): Promise<ToolCatalogEntry[]> {
  if (toolCatalogCache) {
    return toolCatalogCache;
  }

  const metadata = await getToolMetadata();
  const registry =
    (await readRegistry(path.join(workspaceRoot, 'scripts', 'tool-registry.json'))) ||
    (await readRegistry(path.join(toolRoot, 'tool-registry.snapshot.json')));

  const catalog = buildCatalogFromRegistry(registry, metadata);
  toolCatalogCache = catalog.length > 0 ? catalog : fallbackCatalog(metadata);
  return toolCatalogCache;
}

async function getToolMetadata(): Promise<ToolMetadataMap> {
  if (toolMetadataCache) {
    return toolMetadataCache;
  }

  const metadata = await readToolMetadata(path.join(toolRoot, 'tool-metadata.json'));
  toolMetadataCache = metadata ?? DEFAULT_TOOL_METADATA;
  return toolMetadataCache;
}

async function readRegistry(filePath: string): Promise<ToolRegistryShape | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as ToolRegistryShape;
  } catch {
    return undefined;
  }
}

function buildCatalogFromRegistry(registry: ToolRegistryShape | undefined, metadataMap: ToolMetadataMap): ToolCatalogEntry[] {
  if (!registry?.tools) {
    return [];
  }

  const entries: ToolCatalogEntry[] = [];

  for (const [toolId, spec] of Object.entries(registry.tools)) {
    const metadata = metadataMap[toolId] || defaultMetadataFor(toolId, spec?.kind);
    entries.push({
      toolId,
      displayName: toDisplayName(toolId),
      category: normalizeCategory(spec?.kind),
      summary: metadata.summary,
      useCases: metadata.useCases,
      keywords: metadata.keywords,
      documentation: metadata.documentation,
      onboarding: `$env:TOOLKIT_TOOL_ID="${toolId}"`
    });
  }

  return entries.sort((a, b) => a.toolId.localeCompare(b.toolId));
}

function fallbackCatalog(metadataMap: ToolMetadataMap): ToolCatalogEntry[] {
  return Object.keys(metadataMap)
    .sort((a, b) => a.localeCompare(b))
    .map((toolId) => {
      const metadata = metadataMap[toolId];
      return {
        toolId,
        displayName: toDisplayName(toolId),
        category: toolId === 'architecture-validator' ? 'vscode-extension' : 'mcp-server',
        summary: metadata.summary,
        useCases: metadata.useCases,
        keywords: metadata.keywords,
        documentation: metadata.documentation,
        onboarding: `$env:TOOLKIT_TOOL_ID="${toolId}"`
      };
    });
}

async function readToolMetadata(filePath: string): Promise<ToolMetadataMap | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const metadata: ToolMetadataMap = {};

    for (const [toolId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') {
        continue;
      }

      const candidate = value as Record<string, unknown>;
      const summary = typeof candidate.summary === 'string' ? candidate.summary.trim() : '';
      const useCases = asStringArray(candidate.useCases);
      const keywords = asStringArray(candidate.keywords);
      const documentation =
        typeof candidate.documentation === 'string'
          ? candidate.documentation.trim().replace(/\\/g, '/')
          : '';

      if (!summary || useCases.length === 0 || keywords.length === 0) {
        continue;
      }

      metadata[toolId] = { summary, useCases, keywords, documentation };
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  } catch {
    return undefined;
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeCategory(kind: string | undefined): ToolCategory {
  if (kind === 'mcp-server' || kind === 'vscode-extension') {
    return kind;
  }
  return 'tooling';
}

function defaultMetadataFor(toolId: string, kind: string | undefined): ToolMetadata {
  const category = normalizeCategory(kind);
  return {
    summary: `${toDisplayName(toolId)} (${category}) available in the internal tools registry.`,
    useCases: ['tool onboarding', 'workspace integration', 'developer productivity'],
    keywords: [toolId, category, 'tool', 'internal'],
    documentation: ''
  };
}

function toDisplayName(toolId: string): string {
  return toolId
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[_/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function expandToken(token: string): string[] {
  const synonyms: Record<string, string[]> = {
    architecture: ['layer', 'boundary', 'module', 'design'],
    dependency: ['import', 'cycle', 'coupling', 'graph'],
    testing: ['test', 'playwright', 'e2e', 'flaky', 'ci'],
    onboarding: ['install', 'setup', 'configure', 'mcp']
  };

  const expanded = new Set<string>([token]);
  for (const [key, values] of Object.entries(synonyms)) {
    if (token === key || values.includes(token)) {
      for (const value of values) {
        expanded.add(value);
      }
    }
  }

  return Array.from(expanded);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function confidenceLabel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 10) {
    return 'high';
  }
  if (score >= MIN_RECOMMENDATION_SCORE) {
    return 'medium';
  }
  return 'low';
}

function buildPublicInstallCommand(toolId: string, repoUrl: string, versionToken: string): string {
  return `$env:TOOLKIT_REPO_URL="${repoUrl}"; $env:TOOLKIT_TOOL_ID="${toolId}"; $u="https://raw.githubusercontent.com/dhananjay09892/vscode-tools-dhananjay-patel/main/scripts/public-install.ps1?v=${versionToken}"; $s=Join-Path $env:TEMP "public-install.ps1"; iwr $u -UseBasicParsing -OutFile $s; & $s`;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] running on stdio, workspace=${workspaceRoot}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[${SERVER_NAME}] fatal: ${message}`);
  process.exit(1);
});
