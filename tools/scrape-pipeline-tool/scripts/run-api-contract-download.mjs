import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const toolRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(__dirname, '..', '..', '..');

async function run() {
  const client = new Client({
    name: 'api-contract-download-runner',
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

  const result = await client.callTool({
    name: 'scrape_and_convert_pipeline',
    arguments: {
      urls: [
        'https://spec.openapis.org/oas/v3.1.0',
        'https://json-schema.org/draft/2020-12/json-schema-core',
        'https://json-schema.org/draft/2020-12/json-schema-validation',
        'https://www.rfc-editor.org/rfc/rfc9110',
        'https://www.rfc-editor.org/rfc/rfc9457'
      ],
      jsonOutputDir: '.research/api-contract',
      markdownOutputDir: '.research/api-contract-md',
      jsonFileName: 'standards-source.json',
      indexFileName: 'api-contract-index.md',
      maxCharsPerPage: 50000,
      maxBodyChars: 20000,
      timeoutMs: 20000
    }
  });

  const output = result?.content?.[0]?.text ?? 'No output';
  console.log(output);

  await transport.close();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
