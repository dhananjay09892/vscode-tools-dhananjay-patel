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
    name: 'tool-reception-smoke-test',
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
  assert(toolNames.includes('tool_reception'), 'tool_reception not registered');

  const catalog = await client.callTool({
    name: 'tool_reception',
    arguments: {}
  });

  const catalogText = catalog?.content?.[0]?.text ?? '';
  assert(catalogText.includes('Tool Reception: available tool catalog'), 'catalog output missing expected header');
  assert(!catalogText.includes('codebase-integration-tool'), 'catalog should not include placeholder tools');

  const skippedNoTrigger = await client.callTool({
    name: 'tool_reception',
    arguments: {
      objective: 'validate architecture layers before merge'
    }
  });

  const skippedText = skippedNoTrigger?.content?.[0]?.text ?? '';
  assert(skippedText.includes('skipped (objective provided without slash trigger)'), 'non-trigger objective should be skipped');

  const recommendation = await client.callTool({
    name: 'tool_reception',
    arguments: {
      userInput: '/tool-reception validate architecture layers before merge',
      topK: 2
    }
  });

  const recommendationText = recommendation?.content?.[0]?.text ?? '';
  assert(recommendationText.includes('Recommendations (top'), 'recommendation output missing expected section');
  assert(recommendationText.includes('architecture-validator'), 'expected architecture-validator recommendation missing');

  const lowConfidence = await client.callTool({
    name: 'tool_reception',
    arguments: {
      userInput: '/tool-reception help'
    }
  });

  const lowConfidenceText = lowConfidence?.content?.[0]?.text ?? '';
  assert(lowConfidenceText.includes('No strong recommendation yet'), 'low confidence fallback should be returned for vague objectives');

  await transport.close();
  console.log('Tool Reception smoke test passed.');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Tool Reception smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
