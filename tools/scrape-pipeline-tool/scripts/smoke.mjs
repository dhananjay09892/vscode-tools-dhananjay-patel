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
    name: 'scrape-pipeline-tool-smoke-test',
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
  assert(toolNames.includes('scrape_and_convert_pipeline'), 'scrape_and_convert_pipeline not registered');

  const result = await client.callTool({
    name: 'scrape_and_convert_pipeline',
    arguments: {
      urls: ['https://example.com'],
      jsonOutputDir: '.scraped-data',
      markdownOutputDir: '.scraped-markdown'
    }
  });

  const text = result?.content?.[0]?.text ?? '';
  assert(text.includes('Pipeline completed.'), 'pipeline output missing expected section');

  await transport.close();
  console.log('Scrape Pipeline Tool smoke test passed.');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Scrape Pipeline Tool smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
