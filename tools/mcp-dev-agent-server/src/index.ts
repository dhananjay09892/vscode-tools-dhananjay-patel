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
type ModuleLanguage = 'typescript' | 'python';
type ModuleFramework = 'standard' | 'fastapi';

interface ModuleFile {
  path: string;
  content: string;
}

interface ModulePlan {
  language: ModuleLanguage;
  framework: ModuleFramework;
  srcDir: string;
  moduleRoot: string;
  files: ModuleFile[];
  routerRegistration?: {
    filePath: string;
    importLine: string;
    includeLine: string;
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
        description: 'Create a module skeleton using TypeScript or FastAPI Python presets.',
        inputSchema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              description: 'Module name, for example user-auth.'
            },
            language: {
              type: 'string',
              enum: ['typescript', 'python'],
              description: 'Module language preset. Default: typescript.'
            },
            framework: {
              type: 'string',
              enum: ['standard', 'fastapi'],
              description: 'Framework preset. Default: standard for typescript, fastapi for python.'
            },
            srcDir: {
              type: 'string',
              description: 'Relative source directory. Default: src/modules (typescript), src/app/modules (python).'
            },
            registerRouter: {
              type: 'boolean',
              description: 'When true (python+fastapi), append router registration lines. Default: false.'
            },
            routerFile: {
              type: 'string',
              description: 'Relative router file path for registration. Default: src/app/routes.py.'
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

  const language = normalizeModuleLanguage(asString(args.language));
  if (!language) {
    return textResult('Invalid language. Allowed values: typescript, python.');
  }

  const framework = normalizeModuleFramework(asString(args.framework), language);
  if (!framework) {
    return textResult('Invalid framework for selected language. Use standard (typescript) or fastapi (python).');
  }

  const srcDir = asString(args.srcDir) || defaultModuleSrcDir(language);
  const registerRouter = Boolean(args.registerRouter);
  const routerFile = asString(args.routerFile);
  const apply = Boolean(args.apply);

  const plan = buildModulePlan({
    moduleName,
    language,
    framework,
    srcDir,
    registerRouter,
    routerFile
  });

  if (!apply) {
    const lines = [
      'Dry run complete. Set apply=true to write files.',
      `Preset: language=${plan.language}, framework=${plan.framework}`,
      ...plan.files.map((f) => `- ${path.relative(workspaceRoot, f.path)}`)
    ];

    if (plan.routerRegistration) {
      lines.push(`- [router update] ${path.relative(workspaceRoot, plan.routerRegistration.filePath)}`);
    }

    return textResult(
      lines.join('\n')
    );
  }

  await fs.mkdir(plan.moduleRoot, { recursive: true });
  for (const file of plan.files) {
    await fs.writeFile(file.path, file.content, 'utf-8');
  }

  if (plan.routerRegistration) {
    await applyRouterRegistration(plan.routerRegistration);
  }

  const createdLines = [
    `Module created: ${moduleName}`,
    `Preset: language=${plan.language}, framework=${plan.framework}`,
    ...plan.files.map((f) => `- ${path.relative(workspaceRoot, f.path)}`)
  ];

  if (plan.routerRegistration) {
    createdLines.push(`- [router updated] ${path.relative(workspaceRoot, plan.routerRegistration.filePath)}`);
  }

  return textResult(createdLines.join('\n'));
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

function buildModulePlan(input: {
  moduleName: string;
  language: ModuleLanguage;
  framework: ModuleFramework;
  srcDir: string;
  registerRouter: boolean;
  routerFile?: string;
}): ModulePlan {
  const moduleRoot = safeJoinWorkspace(path.join(input.srcDir, input.moduleName));

  if (input.language === 'typescript') {
    return {
      language: 'typescript',
      framework: 'standard',
      srcDir: input.srcDir,
      moduleRoot,
      files: [
        {
          path: path.join(moduleRoot, `${input.moduleName}.controller.ts`),
          content: renderController(input.moduleName)
        },
        {
          path: path.join(moduleRoot, `${input.moduleName}.service.ts`),
          content: renderService(input.moduleName)
        },
        {
          path: path.join(moduleRoot, `${input.moduleName}.repository.ts`),
          content: renderRepository(input.moduleName)
        },
        {
          path: path.join(moduleRoot, 'index.ts'),
          content: renderIndex(input.moduleName)
        }
      ]
    };
  }

  const baseName = toPythonSafeName(input.moduleName);
  const className = toPascalCase(input.moduleName);
  const files: ModuleFile[] = [
    {
      path: path.join(moduleRoot, '__init__.py'),
      content: renderPythonInit()
    },
    {
      path: path.join(moduleRoot, 'routes.py'),
      content: renderFastApiRoutes(baseName, className)
    },
    {
      path: path.join(moduleRoot, 'service.py'),
      content: renderFastApiService(baseName, className)
    },
    {
      path: path.join(moduleRoot, 'schema.py'),
      content: renderFastApiSchema(className)
    },
    {
      path: path.join(moduleRoot, `test_${baseName}.py`),
      content: renderFastApiTest(baseName)
    }
  ];

  const plan: ModulePlan = {
    language: 'python',
    framework: 'fastapi',
    srcDir: input.srcDir,
    moduleRoot,
    files
  };

  if (input.registerRouter) {
    const routerRelativePath = input.routerFile || defaultRouterFile(input.srcDir);
    const routerAbsPath = safeJoinWorkspace(routerRelativePath);
    const moduleImport = toPythonImportPath(path.join(input.srcDir, input.moduleName, 'routes.py'));
    const moduleVar = `${baseName.replace(/-/g, '_')}_router`;

    plan.routerRegistration = {
      filePath: routerAbsPath,
      importLine: `from ${moduleImport} import router as ${moduleVar}`,
      includeLine: `app.include_router(${moduleVar})`
    };
  }

  return plan;
}

function renderPythonInit(): string {
  return ['from .routes import router', ''].join('\n');
}

function renderFastApiRoutes(baseName: string, className: string): string {
  return [
    'from fastapi import APIRouter, Depends',
    `from .schema import ${className}HealthResponse`,
    `from .service import ${className}Service, get_${baseName}_service`,
    '',
    `router = APIRouter(prefix='/${baseName}', tags=['${baseName}'])`,
    '',
    `@router.get('/health', response_model=${className}HealthResponse)`,
    `def get_${baseName}_health(`,
    `    service: ${className}Service = Depends(get_${baseName}_service),`,
    `) -> ${className}HealthResponse:`,
    '    return service.get_health()',
    ''
  ].join('\n');
}

function renderFastApiService(baseName: string, className: string): string {
  return [
    `from .schema import ${className}HealthResponse`,
    '',
    `class ${className}Service:`,
    `    def get_health(self) -> ${className}HealthResponse:`,
    `        return ${className}HealthResponse(ok=True)`,
    '',
    `def get_${baseName}_service() -> ${className}Service:`,
    `    return ${className}Service()`,
    ''
  ].join('\n');
}

function renderFastApiSchema(className: string): string {
  return [
    'from pydantic import BaseModel',
    '',
    `class ${className}HealthResponse(BaseModel):`,
    '    ok: bool',
    ''
  ].join('\n');
}

function renderFastApiTest(baseName: string): string {
  return [
    'from .service import get_' + `${baseName}_service`,
    '',
    `def test_${baseName}_health() -> None:`,
    `    response = get_${baseName}_service().get_health()`,
    '    assert response.ok is True',
    ''
  ].join('\n');
}

async function applyRouterRegistration(registration: { filePath: string; importLine: string; includeLine: string }): Promise<void> {
  const exists = await pathExists(registration.filePath);
  if (!exists) {
    throw new Error(`Router file not found for registration: ${path.relative(workspaceRoot, registration.filePath)}`);
  }

  const source = await fs.readFile(registration.filePath, 'utf-8');
  const hasImport = source.includes(registration.importLine);
  const hasInclude = source.includes(registration.includeLine);

  if (hasImport && hasInclude) {
    return;
  }

  const nextParts: string[] = [source.trimEnd(), '', '# Module registration', registration.importLine, registration.includeLine, ''];
  await fs.writeFile(registration.filePath, nextParts.join('\n'), 'utf-8');
}

function normalizeModuleLanguage(value: string | undefined): ModuleLanguage | undefined {
  if (!value) {
    return 'typescript';
  }

  if (value === 'typescript' || value === 'python') {
    return value;
  }

  return undefined;
}

function normalizeModuleFramework(value: string | undefined, language: ModuleLanguage): ModuleFramework | undefined {
  if (language === 'typescript') {
    if (!value || value === 'standard') {
      return 'standard';
    }
    return undefined;
  }

  if (!value || value === 'fastapi') {
    return 'fastapi';
  }

  return undefined;
}

function defaultModuleSrcDir(language: ModuleLanguage): string {
  return language === 'python' ? 'src/app/modules' : 'src/modules';
}

function defaultRouterFile(srcDir: string): string {
  const normalized = srcDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized.endsWith('/modules')) {
    return `${normalized.slice(0, -'/modules'.length)}/routes.py`;
  }

  return `${normalized}/routes.py`;
}

function toPythonImportPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^[/]+/, '')
    .replace(/\.py$/, '')
    .replace(/\//g, '.');
}

function toPythonSafeName(input: string): string {
  return input.replace(/-/g, '_');
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
