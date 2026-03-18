import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DOC_INDEX_RELATIVE_PATH = 'docs/tool-docs-index.md';

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeToolMeta(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return undefined;
  }

  const item = candidate;
  const toolId = typeof item.toolId === 'string' ? item.toolId.trim() : '';
  const docPath = typeof item.docPath === 'string' ? item.docPath.trim().replace(/\\/g, '/') : '';
  const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
  const useCases = normalizeStringArray(item.useCases);
  const keywords = normalizeStringArray(item.keywords);

  if (!toolId || !docPath || !summary || useCases.length === 0 || keywords.length === 0) {
    return undefined;
  }

  return {
    toolId,
    docPath,
    summary,
    useCases,
    keywords
  };
}

export async function parseDocsIndex(repoRoot) {
  const docsIndexPath = path.join(repoRoot, DOC_INDEX_RELATIVE_PATH);
  const raw = await fs.readFile(docsIndexPath, 'utf-8');
  const blockRegex = /```tool-meta\s*([\s\S]*?)```/g;

  const parsed = new Map();
  let match;

  while ((match = blockRegex.exec(raw)) !== null) {
    const jsonText = match[1]?.trim() || '';
    if (!jsonText) {
      continue;
    }

    let candidate;
    try {
      candidate = JSON.parse(jsonText);
    } catch (error) {
      throw new Error(`Invalid JSON in docs index tool-meta block: ${error instanceof Error ? error.message : String(error)}`);
    }

    const normalized = normalizeToolMeta(candidate);
    if (!normalized) {
      throw new Error('Invalid tool-meta block: required fields are toolId, docPath, summary, useCases, keywords.');
    }

    if (parsed.has(normalized.toolId)) {
      throw new Error(`Duplicate tool-meta entry for toolId: ${normalized.toolId}`);
    }

    parsed.set(normalized.toolId, normalized);
  }

  if (parsed.size === 0) {
    throw new Error(`No tool-meta entries found in ${DOC_INDEX_RELATIVE_PATH}`);
  }

  return {
    docsIndexPath,
    entries: parsed
  };
}

export async function validateDocsPaths(repoRoot, entries) {
  for (const [toolId, meta] of entries.entries()) {
    const absoluteDocPath = path.join(repoRoot, meta.docPath);
    try {
      await fs.access(absoluteDocPath);
    } catch {
      throw new Error(`docPath not found for tool '${toolId}': ${meta.docPath}`);
    }
  }
}
