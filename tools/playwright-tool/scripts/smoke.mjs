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
    name: 'playwright-tool-smoke-test',
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
  assert(toolNames.includes('playwright_skill_advisor'), 'playwright_skill_advisor not registered');

  const catalog = await client.callTool({
    name: 'playwright_skill_advisor',
    arguments: {}
  });

  const catalogText = catalog?.content?.[0]?.text ?? '';
  assert(catalogText.includes('Playwright catalog by category'), 'catalog output missing expected section');

  const recommendation = await client.callTool({
    name: 'playwright_skill_advisor',
    arguments: {
      userInput: '/playwright-tool stabilize flaky tests in ci with retries and traces',
      topK: 4
    }
  });

  const recommendationText = recommendation?.content?.[0]?.text ?? '';
  assert(recommendationText.includes('Recommendations (top'), 'recommendation output missing expected section');

  await transport.close();
  console.log('Playwright Tool smoke test passed.');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Playwright Tool smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
