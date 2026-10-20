// tests/settings-picker.test.js — S-1/S-2: the searchable picker item builder + filter.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { buildPickerItems, filteredItems, modelScope, API_PROVIDERS } from '../apps/tui/src/views/picker.js';

beforeEach(() => setState({
  modelSource: 'api', provider: 'openai', serverUrl: '', apiKey: '',
  keyHistory: [], recentEndpoints: [], recentModels: {}, fetchedModels: {},
  pickerFilter: '', pickerIdx: 0,
}));

describe('buildPickerItems — provider', () => {
  test('lists the API providers with endpoint presets, no custom', () => {
    const { items, allowCustom } = buildPickerItems('provider');
    assert.deepEqual(items.map(i => i.value), API_PROVIDERS);
    assert.equal(allowCustom, false);
    assert.match(items.find(i => i.value === 'openai').sub, /api\.openai\.com/);
  });
});

describe('buildPickerItems — apiKey (remembered, masked)', () => {
  test('shows only this provider\'s keys, masked to last4, plus custom entry on filter', () => {
    setState({ provider: 'openai', keyHistory: [
      { provider: 'openai', key: 'sk-aaaa1111', last4: '…1111' },
      { provider: 'anthropic', key: 'sk-bbbb2222', last4: '…2222' },
    ]});
    const { items, allowCustom } = buildPickerItems('apiKey');
    assert.equal(items.length, 1);             // only openai key
    assert.equal(items[0].value, 'sk-aaaa1111');
    assert.equal(items[0].label, '…1111');     // masked
    assert.equal(allowCustom, true);
  });
});

describe('buildPickerItems — endpoint (recent + presets)', () => {
  test('merges recent endpoints and local presets, dedup, custom allowed', () => {
    setState({ recentEndpoints: ['http://localhost:8000/v1'] });
    const { items, allowCustom } = buildPickerItems('endpoint');
    const vals = items.map(i => i.value);
    assert.ok(vals.includes('http://localhost:8000/v1'));     // recent (also a vLLM preset → deduped)
    assert.ok(vals.includes('http://localhost:11434/v1'));    // ollama preset
    assert.equal(vals.filter(v => v === 'http://localhost:8000/v1').length, 1, 'deduped');
    assert.equal(allowCustom, true);
  });
});

describe('buildPickerItems — model (curated ∪ recent ∪ fetched)', () => {
  test('API scope = provider; merges curated, recent, fetched with tags', () => {
    setState({ modelSource: 'api', provider: 'openai',
      recentModels: { openai: ['my-recent-model'] },
      fetchedModels: { openai: ['fetched-x'] } });
    assert.equal(modelScope(), 'openai');
    const { items, refreshable } = buildPickerItems('model');
    const byVal = Object.fromEntries(items.map(i => [i.value, i.tag]));
    assert.equal(byVal['my-recent-model'], 'recent');
    assert.equal(byVal['fetched-x'], 'live');
    assert.ok('gpt-4o' in byVal);            // curated
    assert.equal(refreshable, true);
  });
  test('Local scope = endpoint; no curated, recent honored', () => {
    setState({ modelSource: 'local', serverUrl: 'http://localhost:8000/v1', recentModels: { 'http://localhost:8000/v1': ['qwen-local'] } });
    assert.equal(modelScope(), 'http://localhost:8000/v1');
    const ids = buildPickerItems('model').items.map(i => i.value);
    assert.deepEqual(ids, ['qwen-local']);   // only recent (no curated for local)
  });
});

describe('filteredItems — type-to-filter + custom entry', () => {
  test('filters by substring across label/value/sub', () => {
    setState({ pickerFilter: 'mini' });
    const ids = filteredItems('model').map(i => i.value);
    assert.ok(ids.includes('gpt-4o-mini'));
    assert.ok(!ids.includes('gpt-4o') || ids.indexOf('gpt-4o-mini') >= 0);
  });
  test('a non-matching filter yields a "use <typed>" custom item first', () => {
    setState({ pickerFilter: 'totally-custom-model' });
    const items = filteredItems('model');
    assert.equal(items[0].custom, true);
    assert.equal(items[0].value, 'totally-custom-model');
    assert.match(items[0].label, /use "totally-custom-model"/);
  });
  test('an exact match does NOT add a duplicate custom item', () => {
    setState({ pickerFilter: 'gpt-4o-mini' });
    const items = filteredItems('model');
    assert.ok(!items.some(i => i.custom), 'no synthetic custom when an exact value matches');
  });
  test('provider picker has no custom entry even with a filter', () => {
    setState({ pickerFilter: 'zzz' });
    assert.ok(!filteredItems('provider').some(i => i.custom));
  });
});
