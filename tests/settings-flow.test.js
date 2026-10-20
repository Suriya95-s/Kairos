// tests/settings-flow.test.js — S-3/S-4: the guided CONNECTION section is
// mode-aware, applying a pick updates state + remembers it, the openrouter key
// syncs to the Council, and `fetchModels` parses an OpenAI-compatible /models.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `/key` stores a credential, which since P5 means the vault — and the vault
// lives under KAIROS_HOME. Without this the suite writes an encrypted store
// into the developer's real ~/.kairos. Set before importing app.js, and left
// set: the settings write is fire-and-forget, so restoring it later would let a
// late flush escape into the real home anyway.
process.env.KAIROS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-flow-home-'));
import { state, setState } from '../apps/tui/src/state.js';
import { getSettingsItems, PROVIDER_PRESETS } from '../apps/tui/src/views/settings.js';
import { fetchModels } from '../apps/tui/src/views/picker.js';
import { executeCmd } from '../apps/tui/src/app.js';

beforeEach(() => setState({
  modelSource: 'api', provider: 'openai', serverUrl: '', apiKey: '', model: '', openrouterKey: '',
  keyHistory: [], recentEndpoints: [], recentModels: {}, fetchedModels: {},
  pickerOpen: false, pickerFilter: '', pickerIdx: 0,
}));

describe('getSettingsItems — mode-aware CONNECTION rows', () => {
  test('API mode exposes Provider / API Key / Model picks', () => {
    setState({ modelSource: 'api' });
    const conn = getSettingsItems().filter(i => i.section === 'CONNECTION').map(i => i.key);
    assert.ok(conn.includes('provider'));
    assert.ok(conn.includes('apiKey'));
    assert.ok(conn.includes('model'));
    assert.ok(!conn.includes('serverUrl'), 'no raw endpoint row in API mode');
  });
  test('Local mode swaps Provider for an Endpoint pick', () => {
    setState({ modelSource: 'local' });
    const conn = getSettingsItems().filter(i => i.section === 'CONNECTION').map(i => i.key);
    assert.ok(conn.includes('serverUrl'));
    assert.ok(conn.includes('model'));
    assert.ok(!conn.includes('provider'), 'no provider row in Local mode');
  });
  test('Source is a cycle, picks are kind:pick', () => {
    const items = getSettingsItems();
    assert.equal(items.find(i => i.key === 'modelSource').kind, 'cycle');
    assert.equal(items.find(i => i.key === 'provider').kind, 'pick');
  });
});

describe('applyPicker via commands — state + history + openrouter sync', () => {
  test('/model <id> sets the model and remembers it under the scope', async () => {
    setState({ modelSource: 'api', provider: 'openai' });
    await executeCmd('/model gpt-4o-mini');
    assert.equal(state.model, 'gpt-4o-mini');
    assert.deepEqual(state.recentModels.openai, ['gpt-4o-mini']);
  });
  test('/key <k> stores a masked key in history for the current provider', async () => {
    setState({ provider: 'openai' });
    await executeCmd('/key sk-test-123456');
    assert.equal(state.apiKey, 'sk-test-123456');
    const entry = state.keyHistory.find(k => k.key === 'sk-test-123456');
    assert.ok(entry && entry.provider === 'openai');
    assert.equal(entry.last4, '…3456');
  });
  test('selecting an openrouter key also powers the Council (openrouterKey synced)', async () => {
    setState({ provider: 'openrouter' });
    await executeCmd('/key sk-or-abcd9999');
    assert.equal(state.apiKey, 'sk-or-abcd9999');
    assert.equal(state.openrouterKey, 'sk-or-abcd9999');
  });
});

describe('PROVIDER_PRESETS — endpoint prefill', () => {
  test('each cloud provider maps to its base URL', () => {
    assert.match(PROVIDER_PRESETS.openai, /api\.openai\.com/);
    assert.match(PROVIDER_PRESETS.anthropic, /api\.anthropic\.com/);
    assert.match(PROVIDER_PRESETS.openrouter, /openrouter\.ai/);
  });
});

describe('fetchModels — OpenAI-compatible /models parse (stubbed)', () => {
  const realFetch = globalThis.fetch;
  test('returns data[].id from a JSON {data:[...]} body', async () => {
    globalThis.fetch = async (url) => {
      assert.equal(url, 'http://localhost:8000/v1/models');
      return { ok: true, json: async () => ({ data: [{ id: 'qwen-a' }, { id: 'qwen-b' }] }) };
    };
    try {
      const ids = await fetchModels('http://localhost:8000/v1/', 'k');
      assert.deepEqual(ids, ['qwen-a', 'qwen-b']);
    } finally { globalThis.fetch = realFetch; }
  });
  test('throws on a non-ok response', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    try {
      await assert.rejects(() => fetchModels('http://x/v1', ''), /503/);
    } finally { globalThis.fetch = realFetch; }
  });
});
