import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from '@modelcontextprotocol/sdk/types.js';
import { analyzeDependencies } from './dependency/analyzer.js';

const SERVER_NAME = 'internal-dev-agent';
const SERVER_VERSION = '0.0.1';

const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd());

type ToolArgs = Record<string, unknown>;

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
        name: 'repo_architecture',
        description: 'Summarize top-level source modules and file counts.',
        inputSchema: {
          type: 'object',
          properties: {
            srcDir: {
              type: 'string',
              description: 'Relative source directory. Default: src'
            }
          }
        }
      },
      {
        name: 'analyze_dependencies',
        description: 'Analyze import graph and detect circular dependencies.',
        inputSchema: {
          type: 'object',
          properties: {
            srcDir: {
              type: 'string',
              description: 'Relative source directory. Default: src'
            }
          }
        }
      },
      {
        name: 'create_module',
        description: 'Create a module skeleton using Controller -> Service -> Repository.',
        inputSchema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              description: 'Module name, for example user-auth.'
            },
            srcDir: {
              type: 'string',
              description: 'Relative source directory. Default: src/modules'
            },
            apply: {
              type: 'boolean',
              description: 'When true, writes files to disk. Default: false.'
            }
          }
        }
      },
      {
        name: 'delete_module',
        description: 'Delete a generated module folder safely within workspace root.',
        inputSchema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              description: 'Module name, for example user-auth.'
            },
            srcDir: {
              type: 'string',
              description: 'Relative source directory. Default: src/modules'
            },
            apply: {
              type: 'boolean',
              description: 'When true, deletes the folder. Default: false.'
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

    if (name === 'repo_architecture') {
      return await handleRepoArchitecture(args as ToolArgs);
    }

    if (name === 'analyze_dependencies') {
      return await handleAnalyzeDependencies(args as ToolArgs);
    }

    if (name === 'create_module') {
      return await handleCreateModule(args as ToolArgs);
    }

    if (name === 'delete_module') {
      return await handleDeleteModule(args as ToolArgs);
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

async function handleRepoArchitecture(args: ToolArgs) {
  const srcDir = asString(args.srcDir) || 'src';
  const srcPath = safeJoinWorkspace(srcDir);
  const entries = await readDirIfExists(srcPath);

  const folders = entries.filter((e) => e.type === 'dir').map((e) => e.name);
  const files = await listSourceFiles(srcPath);

  return textResult(
    [
      `Workspace: ${workspaceRoot}`,
      `Source dir: ${srcDir}`,
      `Top-level folders (${folders.length}): ${folders.join(', ') || '(none)'}`,
      `Source files (${files.length})`
    ].join('\n')
  );
}

async function handleAnalyzeDependencies(args: ToolArgs) {
  const srcDir = asString(args.srcDir) || 'src';
  const srcPath = safeJoinWorkspace(srcDir);
  const analyzed = await analyzeDependencies(workspaceRoot, srcPath);

  const summary = [
    `Workspace: ${workspaceRoot}`,
    `Source dir: ${srcDir}`,
    `Nodes: ${analyzed.nodes}`,
    `Edges: ${analyzed.edges}`,
    `Cycles: ${analyzed.cycles.length}`,
    `Internal edges: ${analyzed.internalEdges}`,
    `External imports: ${analyzed.externalImports.length}`,
    `Unresolved imports: ${analyzed.unresolvedImports.length}`,
    `Total imports seen: ${analyzed.totalImportsSeen}`,
    `Confidence: ${analyzed.confidenceLabel} (${analyzed.confidenceScore})`
  ];

  if (analyzed.languageBreakdown.length > 0) {
    summary.push('Language breakdown:');
    for (const item of analyzed.languageBreakdown) {
      summary.push(`- ${item.language}: nodes=${item.nodes}, edges=${item.edges}`);
    }
  }

  if (analyzed.frameworkHints.length > 0) {
    summary.push(`Framework hints: ${analyzed.frameworkHints.join(', ')}`);
  }

  if (analyzed.topCoupledFiles.length > 0) {
    summary.push('Top coupled files (outbound):');
    for (const item of analyzed.topCoupledFiles) {
      summary.push(`- ${item.file}: ${item.count}`);
    }
  }

  if (analyzed.topImportedFiles.length > 0) {
    summary.push('Top imported files (inbound):');
    for (const item of analyzed.topImportedFiles) {
      summary.push(`- ${item.file}: ${item.count}`);
    }
  }

  if (analyzed.unresolvedImports.length > 0) {
    summary.push('Unresolved import samples:');
    for (const item of analyzed.unresolvedImports.slice(0, 10)) {
      summary.push(`- ${item}`);
    }
  }

  const cycleLines = analyzed.cycles.slice(0, 10).map((cycle, idx) => `${idx + 1}. ${cycle.join(' -> ')}`);
  if (cycleLines.length > 0) {
    summary.push('Cycle samples:');
    summary.push(...cycleLines);
  }

  summary.push('Summary JSON:');
  summary.push(
    JSON.stringify(
      {
        nodes: analyzed.nodes,
        edges: analyzed.edges,
        cycles: analyzed.cycles.length,
        internalEdges: analyzed.internalEdges,
        externalImports: analyzed.externalImports,
        unresolvedImports: analyzed.unresolvedImports,
        totalImportsSeen: analyzed.totalImportsSeen,
        confidence: {
          label: analyzed.confidenceLabel,
          score: analyzed.confidenceScore
        },
        topCoupledFiles: analyzed.topCoupledFiles,
        topImportedFiles: analyzed.topImportedFiles,
        frameworkHints: analyzed.frameworkHints,
        languageBreakdown: analyzed.languageBreakdown
      },
      null,
      2
    )
  );

  return textResult(summary.join('\n'));
}

async function handleCreateModule(args: ToolArgs) {
  const rawName = asString(args.name);
  if (!rawName) {
    return textResult('Missing required argument: name');
  }

  const moduleName = toKebabCase(rawName);
  if (!/^[a-z0-9-]+$/.test(moduleName)) {
    return textResult('Module name must contain only lowercase letters, numbers, and dashes.');
  }

  const srcDir = asString(args.srcDir) || 'src/modules';
  const apply = Boolean(args.apply);

  const moduleRoot = safeJoinWorkspace(path.join(srcDir, moduleName));
  const controllerFile = path.join(moduleRoot, `${moduleName}.controller.ts`);
  const serviceFile = path.join(moduleRoot, `${moduleName}.service.ts`);
  const repositoryFile = path.join(moduleRoot, `${moduleName}.repository.ts`);
  const indexFile = path.join(moduleRoot, 'index.ts');

  const files = [
    {
      path: controllerFile,
      content: renderController(moduleName)
    },
    {
      path: serviceFile,
      content: renderService(moduleName)
    },
    {
      path: repositoryFile,
      content: renderRepository(moduleName)
    },
    {
      path: indexFile,
      content: renderIndex(moduleName)
    }
  ];

  if (!apply) {
    return textResult(
      [
        'Dry run complete. Set apply=true to write files.',
        ...files.map((f) => `- ${path.relative(workspaceRoot, f.path)}`)
      ].join('\n')
    );
  }

  await fs.mkdir(moduleRoot, { recursive: true });
  for (const file of files) {
    await fs.writeFile(file.path, file.content, 'utf-8');
  }

  return textResult(
    [
      `Module created: ${moduleName}`,
      ...files.map((f) => `- ${path.relative(workspaceRoot, f.path)}`)
    ].join('\n')
  );
}

async function handleDeleteModule(args: ToolArgs) {
  const rawName = asString(args.name);
  if (!rawName) {
    return textResult('Missing required argument: name');
  }

  const moduleName = toKebabCase(rawName);
  if (!/^[a-z0-9-]+$/.test(moduleName)) {
    return textResult('Module name must contain only lowercase letters, numbers, and dashes.');
  }

  const srcDir = asString(args.srcDir) || 'src/modules';
  const apply = Boolean(args.apply);
  const moduleRoot = safeJoinWorkspace(path.join(srcDir, moduleName));
  const relativeModuleRoot = path.relative(workspaceRoot, moduleRoot);

  const exists = await pathExists(moduleRoot);
  if (!exists) {
    return textResult(`Module not found: ${relativeModuleRoot}`);
  }

  if (!apply) {
    return textResult(
      [
        'Dry run complete. Set apply=true to delete module folder.',
        `- ${relativeModuleRoot}`
      ].join('\n')
    );
  }

  await fs.rm(moduleRoot, { recursive: true, force: false });
  return textResult(`Module deleted: ${relativeModuleRoot}`);
}

function renderController(moduleName: string): string {
  const name = toPascalCase(moduleName);
  return [
    `import { ${name}Service } from './${moduleName}.service.js';`,
    '',
    `export class ${name}Controller {`,
    '  constructor(private readonly service = new ' + `${name}Service()` + ') {}',
    '',
    '  async getHealth(): Promise<{ ok: boolean }> {',
    '    return this.service.getHealth();',
    '  }',
    '}',
    ''
  ].join('\n');
}

function renderService(moduleName: string): string {
  const name = toPascalCase(moduleName);
  return [
    `import { ${name}Repository } from './${moduleName}.repository.js';`,
    '',
    `export class ${name}Service {`,
    '  constructor(private readonly repository = new ' + `${name}Repository()` + ') {}',
    '',
    '  async getHealth(): Promise<{ ok: boolean }> {',
    '    return this.repository.getHealth();',
    '  }',
    '}',
    ''
  ].join('\n');
}

function renderRepository(moduleName: string): string {
  const name = toPascalCase(moduleName);
  return [
    `export class ${name}Repository {`,
    '  async getHealth(): Promise<{ ok: boolean }> {',
    '    return { ok: true };',
    '  }',
    '}',
    ''
  ].join('\n');
}

function renderIndex(moduleName: string): string {
  return [
    `export * from './${moduleName}.controller.js';`,
    `export * from './${moduleName}.service.js';`,
    `export * from './${moduleName}.repository.js';`,
    ''
  ].join('\n');
}

function fileExistsSyncStyle(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, out);
  return out.filter((f) => /\.(ts|tsx|js|jsx|py)$/.test(f));
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readDirIfExists(dir);

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out' || entry.name.startsWith('.')) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.type === 'dir') {
      await walk(fullPath, out);
    } else {
      out.push(fullPath);
    }
  }
}

async function readDirIfExists(dir: string): Promise<Array<{ name: string; type: 'file' | 'dir' }>> {
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    return dirents.map((d) => ({
      name: d.name,
      type: d.isDirectory() ? 'dir' : 'file'
    }));
  } catch {
    return [];
  }
}

function safeJoinWorkspace(relativePath: string): string {
  const cleanRelative = relativePath.replace(/^[/\\]+/, '');
  const full = path.resolve(workspaceRoot, cleanRelative);

  const normalizedRoot = workspaceRoot.toLowerCase();
  const normalizedFull = full.toLowerCase();

  if (!normalizedFull.startsWith(normalizedRoot)) {
    throw new Error('Path escapes workspace root.');
  }

  return full;
}

function toKebabCase(input: string): string {
  return input
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .toLowerCase();
}

function toPascalCase(input: string): string {
  return input
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
