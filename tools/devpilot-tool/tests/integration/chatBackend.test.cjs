const test = require('node:test');
const assert = require('node:assert/strict');

const { startChatBackend } = require('../../out/chatBackend.js');

test('POST /chat returns response with request metadata', async () => {
  const backend = await startChatBackend();

  try {
    const payload = {
      prompt: 'integration test prompt',
      context: {
        activeFile: 'demo.ts',
        languageId: 'typescript',
        cursor: 'line 1, col 1',
        selectionSummary: 'Selection: (none)',
        selectionRange: 'start(1:1) end(1:1)',
        activeFileContent: 'const x = 1;',
        diagnosticsSummary: '(no diagnostics)',
        gitDiffSummary: '(no git diff)'
      }
    };

    const response = await fetch(`${backend.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    assert.equal(response.status, 200);
    const data = await response.json();

    assert.equal(typeof data.requestId, 'string');
    assert.equal(typeof data.model, 'string');
    assert.match(data.answer, /Devpilot backend response/i);
    assert.match(data.answer, /integration test prompt/i);
  } finally {
    await backend.dispose();
  }
});
