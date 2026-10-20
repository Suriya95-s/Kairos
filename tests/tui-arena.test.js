// tests/tui-arena.test.js — AI Arena (renamed from Council): add a model to the
// lineup via the searchable picker ([a]), and remove one ([d]). Plus the rename.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { handleKey, composeFrame } from '../apps/tui/src/app.js';
import { buildPickerItems } from '../apps/tui/src/views/picker.js';
import { stripAnsi } from '../apps/tui/src/render.js';

const plain = (lines) => lines.map(stripAnsi).join('\n');

beforeEach(() => setState({
  showSplash: false, view: 'council', connected: true, connecting: false, status: 'running',
  pendingApprovals: [], overlay: null, settingsOpen: false, pickerOpen: false, pickerKind: '',
  pickerFilter: '', pickerIdx: 0, toast: null, _toastTimer: null,
  councilCfgOpen: false, councilCfgIdx: 0,
  councilModels: [
    { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B', on: true },
    { id: 'deepseek/deepseek-chat:free', label: 'DeepSeek Chat', on: false },
  ],
  councilChairman: 'meta-llama/llama-3.3-70b-instruct:free',
  recentModels: {}, fetchedModels: {},
}));

describe('rename → AI Arena', () => {
  test('the view title and tab read AI ARENA / AI Arena, not Council', () => {
    const frame = composeFrame(100, 20);
    const txt = plain(frame);
    assert.match(txt, /AI ARENA/);
    assert.doesNotMatch(txt, /LLM COUNCIL/);
    assert.match(plain([frame.at(-1)]), /AI Arena/);
  });
});

describe('buildPickerItems("arenaAdd")', () => {
  test('OpenRouter-scoped, excludes models already in the lineup, allows custom + refresh', () => {
    const p = buildPickerItems('arenaAdd');
    assert.equal(p.title, 'ADD ARENA MODEL');
    assert.equal(p.allowCustom, true);
    assert.equal(p.refreshable, true);
    const vals = p.items.map((i) => i.value);
    assert.ok(!vals.includes('meta-llama/llama-3.3-70b-instruct:free'), 'already-in-lineup excluded');
  });
});

describe('add a model via the lineup editor', () => {
  test('[a] opens the Arena-add picker and closes the editor', async () => {
    setState({ councilCfgOpen: true, councilCfgIdx: 0 });
    await handleKey({ key: null, char: 'a' });
    assert.equal(state.pickerOpen, true);
    assert.equal(state.pickerKind, 'arenaAdd');
    assert.equal(state.councilCfgOpen, false);
    setState({ pickerOpen: false });
  });

  test('typing a custom id + Enter appends it to the lineup (on)', async () => {
    setState({ pickerOpen: true, pickerKind: 'arenaAdd', pickerFilter: '', pickerIdx: 0 });
    for (const ch of 'x-ai/grok-beta') await handleKey({ key: null, char: ch });
    await handleKey({ key: 'ENTER', char: '' });
    const added = state.councilModels.find((m) => m.id === 'x-ai/grok-beta');
    assert.ok(added, 'model appended to lineup');
    assert.equal(added.on, true);
    if (state._toastTimer) { clearTimeout(state._toastTimer); setState({ _toastTimer: null }); }
  });

  test('adding a duplicate does not double it', async () => {
    setState({ pickerOpen: true, pickerKind: 'arenaAdd', pickerFilter: 'deepseek/deepseek-chat:free', pickerIdx: 0 });
    await handleKey({ key: 'ENTER', char: '' });
    const count = state.councilModels.filter((m) => m.id === 'deepseek/deepseek-chat:free').length;
    assert.equal(count, 1);
    if (state._toastTimer) { clearTimeout(state._toastTimer); setState({ _toastTimer: null }); }
  });
});

describe('remove a model from the lineup', () => {
  test('[d] removes the selected model (keeping at least one)', async () => {
    setState({ councilCfgOpen: true, councilCfgIdx: 1 }); // DeepSeek
    await handleKey({ key: null, char: 'd' });
    assert.ok(!state.councilModels.some((m) => m.id === 'deepseek/deepseek-chat:free'));
    assert.equal(state.councilModels.length, 1);
    if (state._toastTimer) { clearTimeout(state._toastTimer); setState({ _toastTimer: null }); }
    setState({ councilCfgOpen: false });
  });

  test('refuses to remove the last remaining model', async () => {
    setState({ councilModels: [{ id: 'only/one', label: 'Only', on: true }], councilChairman: 'only/one',
      councilCfgOpen: true, councilCfgIdx: 0 });
    await handleKey({ key: null, char: 'd' });
    assert.equal(state.councilModels.length, 1);
    if (state._toastTimer) { clearTimeout(state._toastTimer); setState({ _toastTimer: null }); }
    setState({ councilCfgOpen: false });
  });
});
