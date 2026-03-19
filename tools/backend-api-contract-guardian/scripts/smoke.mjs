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

async function writeFixtures() {
  const fixtureDir = path.join(workspaceRoot, '.tmp-backend-guardian');
  await fs.mkdir(fixtureDir, { recursive: true });

  const baseline = {
    openapi: '3.1.0',
    info: { title: 'Sample API', version: '1.0.0' },
    components: {
      schemas: {
        ProblemDetails: {
          type: 'object',
          required: ['type', 'title', 'status'],
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            instance: { type: 'string' }
          }
        },
        Status: {
          type: 'string',
          enum: ['active', 'inactive']
        }
      }
    },
    paths: {
      '/orders/{id}': {
        get: {
          operationId: 'getOrder',
          security: [{ oauth2: ['orders.read'] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'expand', in: 'query', required: false, schema: { type: 'string' } }
          ],
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      amount: { type: 'number' },
                      status: { $ref: '#/components/schemas/Status' }
                    }
                  }
                }
              }
            },
            '404': {
              description: 'not found',
              content: {
                'application/problem+json': {
                  schema: { $ref: '#/components/schemas/ProblemDetails' }
                }
              }
            },
            '500': {
              description: 'error',
              content: {
                'application/problem+json': {
                  schema: { $ref: '#/components/schemas/ProblemDetails' }
                }
              }
            }
          }
        }
      }
    }
  };

  const candidate = {
    ...baseline,
    paths: {
      '/orders/{id}': {
        get: {
          operationId: 'getOrder',
          security: [{ oauth2: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'expand', in: 'query', required: true, schema: { type: 'string' } }
          ],
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      amount: { type: 'string' },
                      status: { type: 'string', enum: ['active'] }
                    }
                  }
                }
              }
            },
            '500': {
              description: 'error',
              content: {
                'application/problem+json': {
                  schema: { $ref: '#/components/schemas/ProblemDetails' }
                }
              }
            }
          }
        }
      },
      '/payments': {
        post: {
          operationId: 'createPayment',
          security: [{ oauth2: ['payments.write'] }],
          responses: {
            '201': {
              description: 'created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { id: { type: 'string' } }
                  }
                }
              }
            },
            '400': {
              description: 'bad request',
              content: {
                'application/problem+json': {
                  schema: { $ref: '#/components/schemas/ProblemDetails' }
                }
              }
            }
          }
        }
      }
    }
  };

  const baselinePath = path.join(fixtureDir, 'baseline.json');
  const candidatePath = path.join(fixtureDir, 'candidate.json');
  await fs.writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
  await fs.writeFile(candidatePath, JSON.stringify(candidate, null, 2) + '\n', 'utf-8');

  return { baselinePath, candidatePath };
}

async function run() {
  const { baselinePath, candidatePath } = await writeFixtures();

  const client = new Client({
    name: 'backend-api-contract-guardian-smoke-test',
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
  assert(toolNames.includes('backend_api_contract_guardian'), 'backend_api_contract_guardian not registered');

  const result = await client.callTool({
    name: 'backend_api_contract_guardian',
    arguments: {
      specPath: candidatePath,
      baselineSpecPath: baselinePath,
      mode: 'strict',
      outputDir: '.research/backend-guardian-smoke'
    }
  });

  const text = result?.content?.[0]?.text ?? '';
  assert(text.includes('Backend API Contract Guardian completed.'), 'guardian output missing summary');
  assert(text.includes('"BC-002"'), 'guardian output missing expected BC finding');

  await transport.close();
  console.log('Backend API Contract Guardian smoke test passed.');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Backend API Contract Guardian smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
