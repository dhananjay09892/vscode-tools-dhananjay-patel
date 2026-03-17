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
    name: 'mcp-smoke-test',
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

  assert(toolNames.includes('repo_architecture'), 'repo_architecture not registered');
  assert(toolNames.includes('analyze_dependencies'), 'analyze_dependencies not registered');
  assert(toolNames.includes('create_module'), 'create_module not registered');
  assert(toolNames.includes('delete_module'), 'delete_module not registered');

  const repoArchitecture = await client.callTool({
    name: 'repo_architecture',
    arguments: {
      srcDir: 'tools'
    }
  });

  const repoText = repoArchitecture?.content?.[0]?.text ?? '';
  assert(repoText.includes('Source dir: tools'), 'repo_architecture output does not include expected source dir');

  const analyzeDependencies = await client.callTool({
    name: 'analyze_dependencies',
    arguments: {
      srcDir: 'tools'
    }
  });

  const depText = analyzeDependencies?.content?.[0]?.text ?? '';
  assert(depText.includes('Nodes:'), 'analyze_dependencies output missing node summary');

  const smokeSrcDir = 'tools/code-architecture-toolkit/tmp-modules';
  const smokeName = 'test-module-smoke';

  const createModuleDryRun = await client.callTool({
    name: 'create_module',
    arguments: {
      name: smokeName,
      srcDir: smokeSrcDir,
      apply: false
    }
  });

  const moduleText = createModuleDryRun?.content?.[0]?.text ?? '';
  assert(moduleText.includes('Dry run complete'), 'create_module dry run did not return expected output');

  const createModuleApply = await client.callTool({
    name: 'create_module',
    arguments: {
      name: smokeName,
      srcDir: smokeSrcDir,
      apply: true
    }
  });

  const createApplyText = createModuleApply?.content?.[0]?.text ?? '';
  assert(createApplyText.includes('Module created:'), 'create_module apply did not create module');

  const deleteModuleDryRun = await client.callTool({
    name: 'delete_module',
    arguments: {
      name: smokeName,
      srcDir: smokeSrcDir,
      apply: false
    }
  });

  const deleteDryText = deleteModuleDryRun?.content?.[0]?.text ?? '';
  assert(deleteDryText.includes('Dry run complete'), 'delete_module dry run did not return expected output');

  const deleteModuleApply = await client.callTool({
    name: 'delete_module',
    arguments: {
      name: smokeName,
      srcDir: smokeSrcDir,
      apply: true
    }
  });

  const deleteApplyText = deleteModuleApply?.content?.[0]?.text ?? '';
  assert(deleteApplyText.includes('Module deleted:'), 'delete_module apply did not delete module');

  const pythonSmokeName = 'test-python-module-smoke';
  const createPythonDryRun = await client.callTool({
    name: 'create_module',
    arguments: {
      name: pythonSmokeName,
      srcDir: smokeSrcDir,
      language: 'python',
      framework: 'fastapi',
      apply: false
    }
  });

  const pythonDryText = createPythonDryRun?.content?.[0]?.text ?? '';
  assert(pythonDryText.includes('language=python'), 'create_module python dry run did not use python preset');

  const createPythonApply = await client.callTool({
    name: 'create_module',
    arguments: {
      name: pythonSmokeName,
      srcDir: smokeSrcDir,
      language: 'python',
      framework: 'fastapi',
      apply: true
    }
  });

  const pythonApplyText = createPythonApply?.content?.[0]?.text ?? '';
  assert(pythonApplyText.includes('Module created:'), 'create_module python apply did not create module');

  const deletePythonApply = await client.callTool({
    name: 'delete_module',
    arguments: {
      name: pythonSmokeName,
      srcDir: smokeSrcDir,
      apply: true
    }
  });

  const deletePythonText = deletePythonApply?.content?.[0]?.text ?? '';
  assert(deletePythonText.includes('Module deleted:'), 'delete_module apply did not delete python module');

  await transport.close();
  console.log('MCP smoke test passed: initialize, tools/list, and TypeScript/Python module flows succeeded.');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`MCP smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

