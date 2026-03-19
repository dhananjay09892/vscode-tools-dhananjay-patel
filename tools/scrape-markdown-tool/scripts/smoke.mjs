import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

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
  const fixtureDir = path.resolve(workspaceRoot, '.scraped-data');
  await fs.mkdir(fixtureDir, { recursive: true });
  const fixtureFile = path.join(fixtureDir, 'smoke-scrape.json');
  await fs.writeFile(
    fixtureFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceCount: 1,
        sources: [
          {
            url: 'https://example.com',
            title: 'Example Domain',
            summary: 'Example summary',
            headings: ['Example Heading'],
            text: 'Example normalized content',
            fetchedAt: new Date().toISOString()
          }
        ]
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  const client = new Client({
    name: 'scrape-markdown-tool-smoke-test',
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
  assert(toolNames.includes('scrape_json_to_markdown'), 'scrape_json_to_markdown not registered');

  const result = await client.callTool({
    name: 'scrape_json_to_markdown',
    arguments: {
      inputFile: '.scraped-data/smoke-scrape.json',
      outputDir: '.scraped-markdown'
    }
  });

  const text = result?.content?.[0]?.text ?? '';
  assert(text.includes('Markdown conversion completed.'), 'markdown conversion output missing expected section');

  await transport.close();
  console.log('Scrape Markdown Tool smoke test passed.');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Scrape Markdown Tool smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
