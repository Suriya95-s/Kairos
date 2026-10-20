// tests/tui-theme.test.js — Kairos Aurora accent themes via a single indirection.
// Mono always wins (blanks color). Unknown names fall back to aurora. Assertions
// are color-depth-robust (truecolor `38;2;` or 256 `38;5;`), not byte-exact.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { accent, setActiveTheme, boxTop, monoMode } from '../apps/tui/src/render.js';

afterEach(() => { setActiveTheme('aurora'); delete process.env.AGENT_TUI_MONO; });

describe('theme accent', () => {
  test('aurora (default) accent is a non-empty fg SGR', () => {
    if (monoMode()) return;  // forced-mono runs blank all color — covered below
    setActiveTheme('aurora');
    assert.match(accent(), /\x1b\[38;[25];/);  // truecolor or 256
  });
  test('the four accents are all distinct', () => {
    if (monoMode()) return;
    const seen = new Set();
    for (const name of ['aurora', 'ocean', 'ember', 'lime']) { setActiveTheme(name); seen.add(accent()); }
    assert.equal(seen.size, 4);
  });
  test('unknown theme name falls back to aurora', () => {
    if (monoMode()) return;
    setActiveTheme('aurora');
    const auroraSgr = accent();
    setActiveTheme('bogus');
    assert.equal(accent(), auroraSgr);
  });
  test('mono mode blanks the accent regardless of theme', () => {
    setActiveTheme('ocean');
    process.env.AGENT_TUI_MONO = '1';
    assert.equal(accent(), '');
  });
  test('boxTop borders use the active accent', () => {
    if (monoMode()) return;
    setActiveTheme('ember');
    const top = boxTop(20);
    assert.ok(top.includes(accent()), 'box border should carry the active accent');
  });
});

import { state, setState } from '../apps/tui/src/state.js';
import { getSettingsItems } from '../apps/tui/src/views/settings.js';

describe('theme settings integration', () => {
  test('getSettingsItems includes a Theme cycle row', () => {
    setState({ theme: 'ocean' });
    const item = getSettingsItems().find((i) => i.key === 'theme');
    assert.ok(item, 'expected a theme settings item');
    assert.equal(item.kind, 'cycle');
    assert.equal(item.value, 'ocean');
    setState({ theme: 'aurora' });
  });
});

import { composeFrame } from '../apps/tui/src/app.js';
import { stripAnsi } from '../apps/tui/src/render.js';

describe('density tunable (Phase 8)', () => {
  test('getSettingsItems includes a Density cycle row', () => {
    setState({ density: 'compact' });
    const item = getSettingsItems().find((i) => i.key === 'density');
    assert.ok(item);
    assert.equal(item.kind, 'cycle');
    assert.equal(item.value, 'compact');
    setState({ density: 'comfortable' });
  });

  test('compact density drops the step arg sub-line in the Live grid', () => {
    const base = {
      showSplash: false, view: 'live', layoutPreset: 'split', status: 'completed',
      connected: true, connecting: false, pendingApprovals: [], focusChain: [],
      overlay: null, settingsOpen: false, pickerOpen: false, toast: null,
      steps: [{ step: 9, tool: 'read', arg: 'ZZARGZZ', result: 'done', error: false, latencyMs: 100 }],
      stepsScroll: 0, outputScroll: 0, pinnedIdx: null, stepLatenciesMs: [], costHistory: [], palaceEvents: [], skills: [],
    };
    setState({ ...base, density: 'comfortable' });
    assert.match(composeFrame(120, 24).map(stripAnsi).join('\n'), /ZZARGZZ/);
    setState({ ...base, density: 'compact' });
    assert.doesNotMatch(composeFrame(120, 24).map(stripAnsi).join('\n'), /ZZARGZZ/);
    setState({ density: 'comfortable' });
  });
});
