import { promises as fs } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const toolRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const goldenPath = path.join(toolRoot, 'testdata', 'golden', 'objectives.json');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function loadGoldenCases() {
  const raw = await fs.readFile(goldenPath, 'utf-8');
  const parsed = JSON.parse(raw);
  const cases = Array.isArray(parsed?.cases) ? parsed.cases : [];
  if (cases.length === 0) {
    throw new Error(`No golden cases found: ${goldenPath}`);
  }
  return cases;
}

function extractRecommendationJson(text) {
  const marker = 'Recommendation JSON:';
  const index = text.indexOf(marker);
  if (index < 0) {
    return undefined;
  }

  const payload = text.slice(index + marker.length).trim();
  if (!payload) {
    return undefined;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

async function run() {
  const goldenCases = await loadGoldenCases();

  const client = new Client({
    name: 'tool-reception-golden-test',
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

  for (const testCase of goldenCases) {
    const response = await client.callTool({
      name: 'tool_reception',
      arguments: {
        userInput: `/tool-reception ${testCase.objective}`,
        topK: 3
      }
    });

    const text = response?.content?.[0]?.text ?? '';

    if (testCase.expectNoStrongRecommendation) {
      assert(
        text.includes('No strong recommendation yet'),
        `[${testCase.name}] expected no-strong-recommendation fallback`
      );
      continue;
    }

    const recommendationJson = extractRecommendationJson(text);
    const topToolId = recommendationJson?.recommendations?.[0]?.toolId;
    assert(
      typeof topToolId === 'string' && topToolId.length > 0,
      `[${testCase.name}] recommendation JSON missing top tool id`
    );
    assert(
      topToolId === testCase.expectedTopToolId,
      `[${testCase.name}] expected top tool ${testCase.expectedTopToolId}, received ${topToolId}`
    );
  }

  await transport.close();
  console.log(`Tool Reception golden tests passed (${goldenCases.length} cases).`);
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Tool Reception golden tests failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
