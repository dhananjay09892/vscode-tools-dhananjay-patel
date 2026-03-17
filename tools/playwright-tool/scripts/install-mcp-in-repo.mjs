import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultServerDist = path.resolve(__dirname, '..', 'dist', 'index.js');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) {
      continue;
    }

    const key = current.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    args[key] = value;
  }
  return args;
}

function toForwardSlash(inputPath) {
  return inputPath.replace(/\\/g, '/');
}

function printUsage() {
  console.log('Usage:');
  console.log('  node scripts/install-mcp-in-repo.mjs --target <repo-path> [--name <server-name>] [--server-dist <dist-path>]');
  console.log('');
  console.log('Example:');
  console.log('  npm run install:repo -- --target "C:/Users/dev/project-a"');
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function ensureFileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.target;
  const serverName = args.name || 'playwright-tool';
  const serverDist = path.resolve(args['server-dist'] || defaultServerDist);

  if (!target) {
    printUsage();
    throw new Error('Missing required argument: --target');
  }

  const targetRepo = path.resolve(target);
  const targetExists = await ensureFileExists(targetRepo);
  if (!targetExists) {
    throw new Error(`Target repo path not found: ${targetRepo}`);
  }

  const serverExists = await ensureFileExists(serverDist);
  if (!serverExists) {
    throw new Error(`Server dist file not found: ${serverDist}. Run "npm run build" in tools/playwright-tool first.`);
  }

  const vscodeDir = path.join(targetRepo, '.vscode');
  const mcpPath = path.join(vscodeDir, 'mcp.json');
  await fs.mkdir(vscodeDir, { recursive: true });

  const existing = (await readJsonIfExists(mcpPath)) || {};
  const servers = existing.servers && typeof existing.servers === 'object' ? existing.servers : {};

  servers[serverName] = {
    type: 'stdio',
    command: 'node',
    args: [toForwardSlash(serverDist)],
    env: {
      WORKSPACE_ROOT: '${workspaceFolder}'
    }
  };

  const output = {
    ...existing,
    servers
  };

  await fs.writeFile(mcpPath, `${JSON.stringify(output, null, 2)}\n`, 'utf-8');

  console.log(`MCP config updated: ${mcpPath}`);
  console.log(`Server name: ${serverName}`);
  console.log(`Server dist: ${toForwardSlash(serverDist)}`);
  console.log('Next steps: reload VS Code window and refresh MCP servers in Copilot Chat.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
