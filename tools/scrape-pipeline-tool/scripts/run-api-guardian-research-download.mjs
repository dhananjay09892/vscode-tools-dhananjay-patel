import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const toolRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(__dirname, '..', '..', '..');

const urls = [
  // Breaking-change definitions and diff tooling
  'https://github.com/Tufin/oasdiff',
  'https://github.com/OpenAPITools/openapi-diff',
  'https://semver.org/',

  // Error handling standards
  'https://www.rfc-editor.org/rfc/rfc7807',
  'https://www.rfc-editor.org/rfc/rfc9457',

  // Security requirements
  'https://owasp.org/API-Security/editions/2023/en/0x11-t10/',
  'https://datatracker.ietf.org/doc/html/rfc7519',
  'https://datatracker.ietf.org/doc/html/rfc6749',

  // Operational reliability patterns
  'https://www.rfc-editor.org/rfc/rfc9110',
  'https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header',

  // Governance and lint rules
  'https://github.com/stoplightio/spectral',
  'https://meta.stoplight.io/docs/spectral/01baf06bdd05a-overview',
  'https://meta.stoplight.io/docs/spectral/4dec24461f3af-open-api-rules',

  // Framework-specific mapping
  'https://expressjs.com/en/guide/routing.html',
  'https://docs.nestjs.com/controllers',
  'https://fastapi.tiangolo.com/tutorial/path-params/',
  'https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller.html',

  // Documentation UX patterns
  'https://sarifweb.azurewebsites.net/',
  'https://junit.org/junit5/docs/current/user-guide/',

  // Real-world rule packs
  'https://opensource.zalando.com/restful-api-guidelines/',
  'https://github.com/microsoft/api-guidelines',
  'https://google.aip.dev/',
  'https://stripe.com/docs/api',

  // OpenAPI and JSON Schema references for cross-linking
  'https://spec.openapis.org/oas/v3.1.0',
  'https://json-schema.org/draft/2020-12/json-schema-validation'
];

async function run() {
  const client = new Client({
    name: 'api-guardian-research-downloader',
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
      urls,
      jsonOutputDir: '.research/api-guardian',
      markdownOutputDir: '.research/api-guardian-md',
      jsonFileName: 'api-guardian-sources.json',
      indexFileName: 'api-guardian-index.md',
      maxCharsPerPage: 60000,
      maxBodyChars: 22000,
      timeoutMs: 25000
    }
  });

  console.log(result?.content?.[0]?.text ?? 'No output');
  await transport.close();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
