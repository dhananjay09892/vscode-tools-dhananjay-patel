import * as path from 'path';
import * as vscode from 'vscode';
import { ValidatorConfig, Violation } from './types';

const IMPORT_REGEX = /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?['\"]([^'\"]+)['\"];?/gm;

export async function runValidation(config: ValidatorConfig): Promise<Violation[]> {
  const includeGlobs = config.includeGlobs && config.includeGlobs.length > 0
    ? config.includeGlobs
    : ['**/*.{ts,tsx,js,jsx}'];

  const excludes = config.excludeGlobs && config.excludeGlobs.length > 0
    ? `{${config.excludeGlobs.join(',')}}`
    : '{**/node_modules/**,**/dist/**,**/out/**}';

  const files = await Promise.all(includeGlobs.map((g) => vscode.workspace.findFiles(g, excludes)));
  const uris = dedupeUris(files.flat());

  const violations: Violation[] = [];

  for (const fileUri of uris) {
    const sourceLayer = layerForPath(fileUri.path, config.layers);
    if (!sourceLayer) {
      continue;
    }

    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const text = Buffer.from(bytes).toString('utf-8');
    const imports = findImports(text);

    for (const imp of imports) {
      if (!imp.specifier.startsWith('.')) {
        continue;
      }

      const resolvedPath = resolveRelativeImport(fileUri.path, imp.specifier);
      const targetLayer = layerForPath(resolvedPath, config.layers);
      if (!targetLayer) {
        continue;
      }

      const allowedTargets: string[] = config.allowedImports[sourceLayer] ?? [];
      const isAllowed = allowedTargets.includes(targetLayer) || sourceLayer === targetLayer;

      if (!isAllowed) {
        violations.push({
          file: fileUri.fsPath,
          line: imp.line,
          sourceLayer,
          targetLayer,
          importText: imp.specifier,
          message: `${sourceLayer} cannot import ${targetLayer}`
        });
      }
    }
  }

  return violations;
}

function dedupeUris(input: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  const out: vscode.Uri[] = [];

  for (const uri of input) {
    if (!seen.has(uri.fsPath)) {
      out.push(uri);
      seen.add(uri.fsPath);
    }
  }

  return out;
}

function layerForPath(filePath: string, layers: Record<string, string[]>): string | undefined {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();

  for (const [layer, prefixes] of Object.entries(layers)) {
    const hit = prefixes.some((prefix) => normalized.includes(prefix.toLowerCase()));
    if (hit) {
      return layer;
    }
  }

  return undefined;
}

function resolveRelativeImport(currentFilePath: string, specifier: string): string {
  const currentDir = path.posix.dirname(currentFilePath.replace(/\\/g, '/'));
  const base = path.posix.resolve(currentDir, specifier);
  return base;
}

function findImports(text: string): Array<{ specifier: string; line: number }> {
  const matches: Array<{ specifier: string; line: number }> = [];
  let m: RegExpExecArray | null;

  while ((m = IMPORT_REGEX.exec(text)) !== null) {
    const consumed = text.slice(0, m.index);
    const line = consumed.split('\n').length;
    matches.push({
      specifier: m[1],
      line
    });
  }

  return matches;
}
