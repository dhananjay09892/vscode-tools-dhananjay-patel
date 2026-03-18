import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { DOC_INDEX_RELATIVE_PATH, parseDocsIndex, validateDocsPaths } from './docs-index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const toolRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(toolRoot, '..', '..');
const registryPath = path.join(repoRoot, 'scripts', 'tool-registry.json');

async function main() {
  const rawRegistry = await fs.readFile(registryPath, 'utf-8');
  const registry = JSON.parse(rawRegistry);

  if (!registry?.tools || typeof registry.tools !== 'object') {
    throw new Error(`Registry not found or invalid at ${registryPath}`);
  }

  const docsIndex = await parseDocsIndex(repoRoot);
  await validateDocsPaths(repoRoot, docsIndex.entries);

  const registryToolIds = Object.keys(registry.tools).sort((a, b) => a.localeCompare(b));
  const missingInDocs = registryToolIds.filter((toolId) => !docsIndex.entries.has(toolId));
  const extraInDocs = Array.from(docsIndex.entries.keys()).filter((toolId) => !registry.tools[toolId]);

  if (missingInDocs.length > 0) {
    throw new Error(`Missing docs entries in ${DOC_INDEX_RELATIVE_PATH}: ${missingInDocs.join(', ')}`);
  }

  if (extraInDocs.length > 0) {
    throw new Error(`Docs index has unknown tools not in scripts/tool-registry.json: ${extraInDocs.join(', ')}`);
  }

  console.log(`Docs index validation passed (${registryToolIds.length} tools).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
