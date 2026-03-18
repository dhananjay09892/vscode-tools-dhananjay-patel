import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_INDEX_RELATIVE_PATH, parseDocsIndex, validateDocsPaths } from './docs-index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const toolRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(toolRoot, '..', '..');

const registryPath = path.join(repoRoot, 'scripts', 'tool-registry.json');
const snapshotPath = path.join(toolRoot, 'tool-registry.snapshot.json');
const metadataPath = path.join(toolRoot, 'tool-metadata.json');

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function defaultMetadataFor(toolId, kind) {
  return {
    summary: `${toolId} (${kind || 'tooling'}) available in the internal tools registry.`,
    useCases: ['tool onboarding', 'workspace integration', 'developer productivity'],
    keywords: [toolId, kind || 'tooling', 'tool', 'internal'],
    documentation: ''
  };
}

async function main() {
  const registry = await readJson(registryPath, undefined);
  if (!registry?.tools || typeof registry.tools !== 'object') {
    throw new Error(`Registry not found or invalid at ${registryPath}`);
  }

  const docsIndex = await parseDocsIndex(repoRoot);
  await validateDocsPaths(repoRoot, docsIndex.entries);

  const sortedToolIds = Object.keys(registry.tools).sort((a, b) => a.localeCompare(b));
  const missingDocs = sortedToolIds.filter((toolId) => !docsIndex.entries.has(toolId));
  if (missingDocs.length > 0) {
    throw new Error(
      `Missing documentation entries in ${DOC_INDEX_RELATIVE_PATH} for tools: ${missingDocs.join(', ')}`
    );
  }

  const snapshot = {
    defaultToolId: registry.defaultToolId,
    tools: {}
  };

  const metadata = {};

  for (const toolId of sortedToolIds) {
    const kind = registry.tools[toolId]?.kind || 'tooling';
    snapshot.tools[toolId] = { kind };

    const entry = docsIndex.entries.get(toolId);
    metadata[toolId] =
      entry
        ? {
            summary: entry.summary,
            useCases: entry.useCases,
            keywords: entry.keywords,
            documentation: entry.docPath
          }
        : defaultMetadataFor(toolId, kind);
  }

  await fs.writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');

  console.log(`Synced snapshot: ${snapshotPath}`);
  console.log(`Synced metadata: ${metadataPath}`);
  console.log(`Docs index source: ${docsIndex.docsIndexPath}`);
  console.log(`Tools synced: ${sortedToolIds.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
