// tests/tui-onboarding.test.js — Workstream D: the splash shows a setup checklist
// reflecting model/key readiness and the keys that fix each gap.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { buildSetupChecklist } from '../apps/tui/src/app.js';
import { stripAnsi } from '../apps/tui/src/render.js';

describe('buildSetupChecklist', () => {
  beforeEach(() => setState({ modelSource: 'api', apiKey: '', serverUrl: '', model: '' }));

  test('shows ✗ for an unset model and key, with the fix keys', () => {
    setState({ model: '', apiKey: '' });
    const text = buildSetupChecklist().map(stripAnsi).join('\n');
    assert.match(text, /Model/);
    assert.match(text, /✗/);
    assert.match(text, /\[M\]/);
    assert.match(text, /\[,\]/);
  });
  test('shows ✓ for a set model', () => {
    setState({ model: 'gpt-4o', apiKey: 'sk-x' });
    const text = buildSetupChecklist().map(stripAnsi).join('\n');
    assert.match(text, /✓/);
    assert.match(text, /gpt-4o/);
  });
  test('Local mode checks the endpoint instead of the API key', () => {
    setState({ modelSource: 'local', serverUrl: 'http://localhost:11434/v1', model: 'llama3' });
    const text = buildSetupChecklist().map(stripAnsi).join('\n');
    assert.match(text, /Endpoint|endpoint/);
    assert.match(text, /localhost:11434/);
  });
});
