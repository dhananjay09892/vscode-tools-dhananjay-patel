import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const toolRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(toolRoot, '..', '..');

const registryPath = path.join(repoRoot, 'scripts', 'tool-registry.json');
const snapshotPath = path.join(toolRoot, 'tool-registry.snapshot.json');
const metadataPath = path.join(toolRoot, 'tool-metadata.json');

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

function diff(a, b) {
  const bSet = new Set(b);
  return a.filter((item) => !bSet.has(item));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const hasRegistry = await fileExists(registryPath);
  if (!hasRegistry) {
    console.log('Catalog sync validation skipped: root scripts/tool-registry.json not found.');
    process.exit(0);
  }

  const registry = await readJson(registryPath);
  const snapshot = await readJson(snapshotPath);
  const metadata = await readJson(metadataPath);

  const registryIds = Object.keys(registry.tools || {}).sort((a, b) => a.localeCompare(b));
  const snapshotIds = Object.keys(snapshot.tools || {}).sort((a, b) => a.localeCompare(b));
  const metadataIds = Object.keys(metadata || {}).sort((a, b) => a.localeCompare(b));

  const missingInSnapshot = diff(registryIds, snapshotIds);
  const missingInMetadata = diff(registryIds, metadataIds);

  if (missingInSnapshot.length > 0 || missingInMetadata.length > 0) {
    console.error('Tool reception catalog files are stale.');
    if (missingInSnapshot.length > 0) {
      console.error(`Missing in tool-registry.snapshot.json: ${missingInSnapshot.join(', ')}`);
    }
    if (missingInMetadata.length > 0) {
      console.error(`Missing in tool-metadata.json: ${missingInMetadata.join(', ')}`);
    }
    console.error('Run: npm --prefix tools/tool-reception run sync:catalog');
    process.exit(1);
  }

  console.log(`Catalog sync validation passed (${registryIds.length} tools).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
