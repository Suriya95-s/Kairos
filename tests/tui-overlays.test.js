// tests/tui-overlays.test.js — Phase 7 (redesign §7): fuzzy command palette +
// the active onboarding wizard (Enter on the splash opens the next setup picker).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { fuzzyScore, buildSuggestions, nextSetupStep, handleKey } from '../apps/tui/src/app.js';

describe('fuzzyScore', () => {
  test('subsequence matches with a gap-distance score', () => {
    assert.equal(fuzzyScore('abc', 'abc'), 0);
    assert.ok(fuzzyScore('ac', 'abc') > 0);   // a..c has a gap
  });
  test('non-subsequence → -1', () => {
    assert.equal(fuzzyScore('xyz', 'abc'), -1);
    assert.equal(fuzzyScore('cba', 'abc'), -1);  // order matters
  });
});

describe('buildSuggestions (fuzzy command palette)', () => {
  test('non-slash input → no suggestions', () => {
    assert.deepEqual(buildSuggestions('hello'), []);
  });
  test('prefix match ranks first', () => {
    const s = buildSuggestions('/mem');
    assert.equal(s[0].cmd, '/memory');
  });
  test('fuzzy subsequence finds a command without a prefix match', () => {
    const cmds = buildSuggestions('/exprt').map((e) => e.cmd);  // e-x-p-r-t ⊂ export
    assert.ok(cmds.includes('/export'), `expected /export in ${cmds}`);
  });
  test('/layout and /theme are discoverable in the palette', () => {
    assert.ok(buildSuggestions('/lay').some((e) => e.cmd === '/layout'));
    assert.ok(buildSuggestions('/the').some((e) => e.cmd === '/theme'));
  });
});

describe('nextSetupStep (onboarding order)', () => {
  test('API: key first, then model, then done', () => {
    setState({ modelSource: 'api', apiKey: '', model: '', serverUrl: '' });
    assert.equal(nextSetupStep(), 'apiKey');
    setState({ apiKey: 'sk-x' });
    assert.equal(nextSetupStep(), 'model');
    setState({ model: 'gpt-4o' });
    assert.equal(nextSetupStep(), null);
  });
  test('Local: endpoint first, then model', () => {
    setState({ modelSource: 'local', apiKey: '', model: '', serverUrl: '' });
    assert.equal(nextSetupStep(), 'endpoint');
    setState({ serverUrl: 'http://localhost:11434/v1' });
    assert.equal(nextSetupStep(), 'model');
  });
});

describe('active splash wizard', () => {
  beforeEach(() => setState({
    showSplash: true, modelSource: 'api', apiKey: '', model: '', serverUrl: '',
    pickerOpen: false, pickerKind: '', toast: null, _toastTimer: null,
    launcherTasks: [], connected: true,
  }));

  test('Enter on the splash opens the next incomplete setup picker', async () => {
    await handleKey({ key: 'ENTER', char: '' });
    assert.equal(state.showSplash, false);
    assert.equal(state.pickerOpen, true);
    assert.equal(state.pickerKind, 'apiKey');
    if (state._toastTimer) { clearTimeout(state._toastTimer); setState({ _toastTimer: null }); }
    setState({ pickerOpen: false });
  });

  test('Enter when fully set up just dismisses the splash (no picker)', async () => {
    setState({ apiKey: 'sk-x', model: 'gpt-4o' });
    await handleKey({ key: 'ENTER', char: '' });
    assert.equal(state.showSplash, false);
    assert.equal(state.pickerOpen, false);
  });
});
