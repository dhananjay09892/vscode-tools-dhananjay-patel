import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from '@modelcontextprotocol/sdk/types.js';

const SERVER_NAME = 'tool-reception';
const SERVER_VERSION = '0.0.1';

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
}

const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    toolId: 'code-architecture-toolkit',
    displayName: 'Code Architecture Toolkit',
    category: 'mcp-server',
    summary: 'MCP server for dependency analysis, architecture views, and scaffolding.',
    useCases: ['analyze imports', 'find cycles', 'scaffold module', 'repo architecture overview'],
    keywords: ['dependency', 'cycle', 'module', 'architecture', 'fastapi', 'mcp'],
    onboarding: '$env:TOOLKIT_TOOL_ID="code-architecture-toolkit"'
  },
  {
    toolId: 'architecture-validator',
    displayName: 'Architecture Validator',
    category: 'vscode-extension',
    summary: 'Validates layer boundaries such as Controller -> Service -> Repository.',
    useCases: ['layer policy checks', 'pre-merge architecture validation', 'import boundary rules'],
    keywords: ['layer', 'validator', 'import policy', 'architecture rule'],
    onboarding: '$env:TOOLKIT_TOOL_ID="architecture-validator"'
  },
  {
    toolId: 'playwright-tool',
    displayName: 'Playwright Tool',
    category: 'mcp-server',
    summary: 'Playwright skill advisor for E2E, CI, flakiness reduction, and migration guidance.',
    useCases: ['stabilize flaky tests', 'recommend Playwright guides', 'CI pipeline setup', 'Cypress to Playwright migration'],
    keywords: ['playwright', 'e2e', 'flaky', 'trace', 'ci', 'test automation', 'cypress migration'],
    onboarding: '$env:TOOLKIT_TOOL_ID="playwright-tool"'
  },
  {
    toolId: 'codebase-integration-tool',
    displayName: 'Codebase Integration Tool',
    category: 'tooling',
    summary: 'Assists with integrating code and workflows across repositories.',
    useCases: ['cross-repo integration', 'migration support'],
    keywords: ['integration', 'migration', 'repo'],
    onboarding: 'coming soon'
  },
  {
    toolId: 'internal-api-generator',
    displayName: 'Internal API Generator',
    category: 'tooling',
    summary: 'Generates internal API skeletons and contracts.',
    useCases: ['api scaffolding', 'endpoint boilerplate'],
    keywords: ['api', 'endpoint', 'generator'],
    onboarding: 'coming soon'
  },
  {
    toolId: 'repo-intelligence-tool',
    displayName: 'Repo Intelligence Tool',
    category: 'tooling',
    summary: 'Provides repository insights and structural intelligence.',
    useCases: ['repo insights', 'structure understanding'],
    keywords: ['repo', 'insights', 'intelligence'],
    onboarding: 'coming soon'
  },
  {
    toolId: 'code-quality-enforcer',
    displayName: 'Code Quality Enforcer',
    category: 'tooling',
    summary: 'Automates code quality policy checks and guidance.',
    useCases: ['quality gates', 'policy enforcement'],
    keywords: ['quality', 'lint', 'policy'],
    onboarding: 'coming soon'
  },
  {
    toolId: 'dependency-analyzer',
    displayName: 'Dependency Analyzer',
    category: 'tooling',
    summary: 'Focuses on dependency relationships and potential coupling issues.',
    useCases: ['dependency graph', 'coupling analysis'],
    keywords: ['dependency', 'graph', 'coupling'],
    onboarding: 'coming soon'
  }
];

const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd());

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
  const userInput = (asString(args.userInput) || '').trim();
  const force = asBoolean(args.force) ?? false;
  const objectiveFromInput = parseTriggeredObjective(userInput);
  const objective = (asString(args.objective) || objectiveFromInput || '').trim();
  const topK = Math.max(1, Math.min(10, asNumber(args.topK) ?? 3));

  if (!force && userInput && !objectiveFromInput) {
    return textResult(
      [
        'Tool Reception: skipped (no explicit slash trigger).',
        'Expected format: /tool-reception <objective>',
        'This keeps regular Copilot/LLM replies uninterrupted when users do not request this tool.'
      ].join('\n')
    );
  }

  if (!objective) {
    const lines = [
      `Workspace: ${workspaceRoot}`,
      'Tool Reception: available tool catalog',
      ...TOOL_CATALOG.map(
        (entry) =>
          `- ${entry.toolId} [${entry.category}] :: ${entry.summary} | use cases: ${entry.useCases.join(', ')}`
      ),
      'Set objective to get recommendations. Example: userInput="/tool-reception validate architecture layers before PR"'
    ];

    lines.push('Catalog JSON:');
    lines.push(JSON.stringify({ tools: TOOL_CATALOG }, null, 2));
    return textResult(lines.join('\n'));
  }

  const ranked = rankToolsForObjective(objective).slice(0, topK);
  const lines = [
    `Workspace: ${workspaceRoot}`,
    `Tool Reception objective: ${objective}`,
    `Recommendations (top ${ranked.length}):`
  ];

  for (const [idx, rec] of ranked.entries()) {
    lines.push(
      `${idx + 1}. ${rec.tool.toolId} (score=${rec.score}) -> ${rec.tool.summary}`
    );
    lines.push(`   Use cases: ${rec.tool.useCases.join(', ')}`);
    lines.push(`   Why: matched keywords: ${rec.matches.join(', ') || 'context similarity'}`);
    lines.push(`   One-line selector: ${rec.tool.onboarding}`);
  }

  lines.push('Recommendation JSON:');
  lines.push(
    JSON.stringify(
      {
        objective,
        recommendations: ranked.map((rec) => ({
          toolId: rec.tool.toolId,
          score: rec.score,
          summary: rec.tool.summary,
          useCases: rec.tool.useCases,
          matchedKeywords: rec.matches,
          onboarding: rec.tool.onboarding
        }))
      },
      null,
      2
    )
  );

  return textResult(lines.join('\n'));
}

function rankToolsForObjective(objective: string): Array<{ tool: ToolCatalogEntry; score: number; matches: string[] }> {
  const normalized = objective.toLowerCase();

  const scored = TOOL_CATALOG.map((tool) => {
    let score = 0;
    const matches: string[] = [];

    for (const keyword of tool.keywords) {
      if (normalized.includes(keyword.toLowerCase())) {
        score += 3;
        matches.push(keyword);
      }
    }

    for (const useCase of tool.useCases) {
      const chunk = useCase.toLowerCase();
      const significant = chunk.split(/\s+/).filter((part) => part.length >= 4);
      const hit = significant.some((token) => normalized.includes(token));
      if (hit) {
        score += 1;
      }
    }

    if (tool.toolId === 'code-architecture-toolkit') {
      score += 1;
    }

    return { tool, score, matches };
  });

  return scored.sort((a, b) => b.score - a.score || a.tool.toolId.localeCompare(b.tool.toolId));
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
