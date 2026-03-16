import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';

export interface AnalyzerResult {
  graph: Map<string, string[]>;
  cycles: string[][];
  nodes: number;
  edges: number;
  languageBreakdown: Array<{ language: string; nodes: number; edges: number }>;
  frameworkHints: string[];
}

interface LanguageAdapter {
  language: string;
  extensions: string[];
  prepare?: (files: string[], srcPath: string) => unknown;
  resolveImports: (absFile: string, source: string, context: AdapterContext) => string[];
}

interface AdapterContext {
  srcPath: string;
  files: string[];
  preparedData?: unknown;
}

type PythonImportEntry =
  | { kind: 'import'; modules: string[] }
  | { kind: 'from'; level: number; module?: string; names: string[] };

const JS_TS_ADAPTER: LanguageAdapter = {
  language: 'javascript-typescript',
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
  resolveImports: (absFile, source) => {
    return parseJsImports(source)
      .filter((i) => i.startsWith('.'))
      .map((rel) => resolveJsImportTarget(absFile, rel))
      .filter(Boolean) as string[];
  }
};

const PYTHON_ADAPTER: LanguageAdapter = {
  language: 'python',
  extensions: ['.py'],
  prepare: (files, srcPath) => buildPythonModuleIndex(files, srcPath),
  resolveImports: (absFile, source, context) => {
    const moduleIndex = context.preparedData as Map<string, string>;
    if (!moduleIndex) {
      return [];
    }

    const currentModule = pythonModuleNameFromFile(absFile, moduleIndex);
    if (!currentModule) {
      return [];
    }

    const parsed = parsePythonImports(source);
    const resolved = new Set<string>();

    for (const entry of parsed) {
      for (const moduleName of resolvePythonModuleNames(entry, currentModule)) {
        const filePath = moduleIndex.get(moduleName);
        if (filePath) {
          resolved.add(filePath);
        }
      }
    }

    return [...resolved];
  }
};

const ADAPTERS: LanguageAdapter[] = [JS_TS_ADAPTER, PYTHON_ADAPTER];

export async function analyzeDependencies(workspaceRoot: string, srcPath: string): Promise<AnalyzerResult> {
  const files = await listSourceFiles(srcPath, ADAPTERS);
  const graph = new Map<string, string[]>();

  const contexts = new Map<LanguageAdapter, AdapterContext>();
  for (const adapter of ADAPTERS) {
    const adapterFiles = files.filter((f) => adapter.extensions.includes(path.extname(f)));
    contexts.set(adapter, {
      srcPath,
      files: adapterFiles,
      preparedData: adapter.prepare ? adapter.prepare(adapterFiles, srcPath) : undefined
    });
  }

  for (const absFile of files) {
    const adapter = adapterForFile(absFile);
    if (!adapter) {
      continue;
    }

    const fileText = await fs.readFile(absFile, 'utf-8');
    const context = contexts.get(adapter) as AdapterContext;
    const imports = adapter.resolveImports(absFile, fileText, context);
    graph.set(absFile, imports);
  }

  const cycles = findCycles(graph, workspaceRoot);
  const languageBreakdown = buildLanguageBreakdown(graph);
  const frameworkHints = await detectFrameworkHints(workspaceRoot, files);

  return {
    graph,
    cycles,
    nodes: graph.size,
    edges: countEdges(graph),
    languageBreakdown,
    frameworkHints
  };
}

function adapterForFile(filePath: string): LanguageAdapter | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return ADAPTERS.find((adapter) => adapter.extensions.includes(ext));
}

function buildLanguageBreakdown(graph: Map<string, string[]>): Array<{ language: string; nodes: number; edges: number }> {
  const perLanguage = new Map<string, { nodes: number; edges: number }>();

  for (const [node, edges] of graph.entries()) {
    const adapter = adapterForFile(node);
    if (!adapter) {
      continue;
    }

    const slot = perLanguage.get(adapter.language) ?? { nodes: 0, edges: 0 };
    slot.nodes += 1;
    slot.edges += edges.length;
    perLanguage.set(adapter.language, slot);
  }

  return [...perLanguage.entries()].map(([language, stat]) => ({
    language,
    nodes: stat.nodes,
    edges: stat.edges
  }));
}

async function detectFrameworkHints(workspaceRoot: string, files: string[]): Promise<string[]> {
  const hints = new Set<string>();

  if (fileExistsSyncStyle(path.join(workspaceRoot, 'next.config.js')) || fileExistsSyncStyle(path.join(workspaceRoot, 'next.config.ts'))) {
    hints.add('nextjs');
  }

  if (fileExistsSyncStyle(path.join(workspaceRoot, 'nest-cli.json'))) {
    hints.add('nestjs');
  }

  if (fileExistsSyncStyle(path.join(workspaceRoot, 'manage.py'))) {
    hints.add('django');
  }

  const pyFiles = files.filter((f) => f.endsWith('.py')).slice(0, 25);
  for (const pyFile of pyFiles) {
    const source = await fs.readFile(pyFile, 'utf-8');
    if (/\bfrom\s+fastapi\s+import\b|\bimport\s+fastapi\b/.test(source)) {
      hints.add('fastapi');
    }
    if (/\bfrom\s+flask\s+import\b|\bimport\s+flask\b/.test(source)) {
      hints.add('flask');
    }
  }

  return [...hints];
}

function parseJsImports(source: string): string[] {
  const out: string[] = [];
  const regex = /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?['\"]([^'\"]+)['\"]/gm;
  let m: RegExpExecArray | null;

  while ((m = regex.exec(source)) !== null) {
    out.push(m[1]);
  }

  return out;
}

function resolveJsImportTarget(fromFile: string, specifier: string): string | undefined {
  const dir = path.dirname(fromFile);
  const base = path.resolve(dir, specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx')
  ];

  for (const p of candidates) {
    if (fileExistsSyncStyle(p)) {
      return p;
    }
  }

  return undefined;
}

function buildPythonModuleIndex(pyFiles: string[], srcPath: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const absFile of pyFiles) {
    const rel = path.relative(srcPath, absFile).replace(/\\/g, '/');
    const noExt = rel.replace(/\.py$/, '');
    const parts = noExt.split('/').filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    const normalizedParts = parts[parts.length - 1] === '__init__' ? parts.slice(0, -1) : parts;
    if (normalizedParts.length === 0) {
      continue;
    }

    out.set(normalizedParts.join('.'), absFile);
  }

  return out;
}

function parsePythonImports(source: string): PythonImportEntry[] {
  const entries: PythonImportEntry[] = [];
  const lines = source.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const importMatch = /^import\s+(.+)$/.exec(line);
    if (importMatch) {
      const modules = importMatch[1]
        .split(',')
        .map((item) => item.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      if (modules.length > 0) {
        entries.push({ kind: 'import', modules });
      }
      continue;
    }

    const fromMatch = /^from\s+([\.]*)([A-Za-z_][\w\.]*)?\s+import\s+(.+)$/.exec(line);
    if (fromMatch) {
      const dots = fromMatch[1] ?? '';
      const module = fromMatch[2];
      const names = fromMatch[3]
        .split(',')
        .map((item) => item.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean)
        .filter((name) => name !== '*');

      entries.push({
        kind: 'from',
        level: dots.length,
        module,
        names
      });
    }
  }

  return entries;
}

function resolvePythonModuleNames(entry: PythonImportEntry, currentModule: string): string[] {
  if (entry.kind === 'import') {
    return entry.modules;
  }

  if (entry.level <= 0) {
    return entry.module ? [entry.module] : [];
  }

  const currentParts = currentModule.split('.');
  const currentPackageParts = currentParts.slice(0, -1);
  const popCount = Math.max(entry.level - 1, 0);
  const parentParts = currentPackageParts.slice(0, Math.max(currentPackageParts.length - popCount, 0));

  const baseParts = entry.module ? parentParts.concat(entry.module.split('.')) : parentParts;
  const base = baseParts.join('.');

  const candidates = new Set<string>();
  if (base) {
    candidates.add(base);
  }

  for (const importedName of entry.names) {
    if (!base) {
      candidates.add(importedName);
    } else {
      candidates.add(`${base}.${importedName}`);
    }
  }

  return [...candidates];
}

function pythonModuleNameFromFile(absFile: string, moduleIndex: Map<string, string>): string | undefined {
  for (const [moduleName, filePath] of moduleIndex.entries()) {
    if (filePath === absFile) {
      return moduleName;
    }
  }

  return undefined;
}

function countEdges(graph: Map<string, string[]>): number {
  let edgeCount = 0;
  for (const edges of graph.values()) {
    edgeCount += edges.length;
  }
  return edgeCount;
}

function findCycles(graph: Map<string, string[]>, workspaceRoot: string): string[][] {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const pathStack: string[] = [];
  const cycles: string[][] = [];
  const seenCycles = new Set<string>();

  const dfs = (node: string) => {
    visited.add(node);
    stack.add(node);
    pathStack.push(node);

    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) {
        continue;
      }

      if (!visited.has(next)) {
        dfs(next);
        continue;
      }

      if (stack.has(next)) {
        const startIdx = pathStack.indexOf(next);
        const cycle = pathStack.slice(startIdx).concat(next).map((p) => path.relative(workspaceRoot, p));
        const key = cycle.join('>');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push(cycle);
        }
      }
    }

    stack.delete(node);
    pathStack.pop();
  };

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

function fileExistsSyncStyle(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function listSourceFiles(root: string, adapters: LanguageAdapter[]): Promise<string[]> {
  const out: string[] = [];
  const allowed = new Set(adapters.flatMap((a) => a.extensions));
  await walk(root, out);
  return out.filter((f) => allowed.has(path.extname(f).toLowerCase()));
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
