const test = require('node:test');
const assert = require('node:assert/strict');

const { buildQuickActionItems, toUserFriendlyError } = require('../../out/commandUtils.js');

test('buildQuickActionItems includes key commands', () => {
  const items = buildQuickActionItems();
  const commands = items.map((item) => item.command);

  assert.ok(commands.includes('devpilot.openChat'));
  assert.ok(commands.includes('devpilot.configureLlm'));
  assert.ok(commands.includes('devpilot.searchSubagent'));
  assert.ok(commands.includes('devpilot.analyzeCurrentFile'));
  assert.ok(commands.includes('devpilot.explainSelection'));
  assert.ok(commands.includes('devpilot.generateTests'));
  assert.ok(commands.includes('devpilot.refactorSuggestion'));
});

test('toUserFriendlyError maps timeout message', () => {
  const text = toUserFriendlyError('Request timed out after 8000ms');
  assert.match(text, /Request timed out/i);
});

test('toUserFriendlyError maps auth message', () => {
  const text = toUserFriendlyError('HTTP 401');
  assert.match(text, /Authentication failed/i);
});

test('toUserFriendlyError maps fallback message', () => {
  const text = toUserFriendlyError('something odd happened');
  assert.match(text, /Unexpected error/i);
});

test('toUserFriendlyError maps 404 for provider context', () => {
  const text = toUserFriendlyError('HTTP 404', { providerId: 'openai' });
  assert.match(text, /Provider endpoint not found/i);
});
