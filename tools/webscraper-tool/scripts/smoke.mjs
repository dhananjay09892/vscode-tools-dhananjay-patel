import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const toolRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(__dirname, '..', '..', '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run() {
  const client = new Client({
    name: 'webscraper-tool-smoke-test',
    version: '0.0.1'
  });

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    cwd: toolRoot,
    env: {
      ...process.env,
      WORKSPACE_ROOT: workspaceRoot
    }
  });

  await client.connect(transport);

  const listTools = await client.listTools();
  const toolNames = (listTools?.tools ?? []).map((t) => t.name);
  assert(toolNames.includes('web_scrape_to_json'), 'web_scrape_to_json not registered');

  const result = await client.callTool({
    name: 'web_scrape_to_json',
    arguments: {
      urls: ['https://example.com'],
      outputDir: '.scraped-data'
    }
  });

  const text = result?.content?.[0]?.text ?? '';
  assert(text.includes('Web scrape completed.'), 'scrape output missing expected section');

  await transport.close();
  console.log('Webscraper Tool smoke test passed.');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Webscraper Tool smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
