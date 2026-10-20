// tests/tui-layout.test.js — Phase 6 (redesign §6): Live layout presets
// (Split / Focus / Wide) cycled with [L], the ambient vitals ribbon, and a
// stable frame height across presets. Width-exact + mono-safe.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { composeFrame, handleKey } from '../apps/tui/src/app.js';
import { stripAnsi, visLen } from '../apps/tui/src/render.js';

const plain = (lines) => lines.map(stripAnsi).join('\n');

beforeEach(() => setState({
  showSplash: false, view: 'live', status: 'running', connected: true, connecting: false,
  layoutPreset: 'split', pendingApprovals: [], focusChain: [], overlay: null,
  settingsOpen: false, pickerOpen: false, cmdInputActive: false, toast: null,
  model: 'gpt-4o', stage: 'build', costUsd: 0.042, palaceEvents: [],
  stepLatenciesMs: [300, 800, 1200], costHistory: [0.01, 0.02, 0.042],
  steps: [
    { step: 12, tool: 'edit', arg: 'app.js', thought: '', result: 'ok\n+ added\n- removed', error: false, latencyMs: 1200, startMs: 1 },
    { step: 11, tool: 'read', arg: 'x', result: 'r', error: false, latencyMs: 300 },
  ],
  stepsScroll: 0, outputScroll: 0, pinnedIdx: null,
}));

describe('layout presets', () => {
  for (const [preset, H] of [['split', 24], ['focus', 24], ['wide', 24]]) {
    test(`${preset} renders exactly H lines, width-exact`, () => {
      setState({ layoutPreset: preset });
      const frame = composeFrame(100, H);
      assert.equal(frame.length, H);
      for (const line of frame) assert.ok(visLen(line) <= 100, `line too wide in ${preset}`);
    });
  }

  test('Focus and Wide show the ambient vitals ribbon (model · stage · trends)', () => {
    setState({ layoutPreset: 'focus' });
    const f = plain(composeFrame(100, 24));
    assert.match(f, /◷/);
    assert.match(f, /gpt-4o/);
    assert.match(f, /◧ Focus/);
    setState({ layoutPreset: 'wide' });
    assert.match(plain(composeFrame(100, 24)), /◧ Wide/);
  });

  test('Split (the classic 3-col) has no vitals ribbon', () => {
    setState({ layoutPreset: 'split' });
    assert.doesNotMatch(plain(composeFrame(100, 24)), /◷/);
    assert.match(plain(composeFrame(100, 24)), /STEPS/);
    assert.match(plain(composeFrame(100, 24)), /INFO/);
  });
});

describe('[L] cycles the preset', () => {
  test('split → focus → wide → split', async () => {
    setState({ layoutPreset: 'split' });
    await handleKey({ key: null, char: 'L' });
    assert.equal(state.layoutPreset, 'focus');
    await handleKey({ key: null, char: 'L' });
    assert.equal(state.layoutPreset, 'wide');
    await handleKey({ key: null, char: 'L' });
    assert.equal(state.layoutPreset, 'split');
  });

  test('[L] only acts on the Live view', async () => {
    setState({ view: 'memory', layoutPreset: 'split' });
    await handleKey({ key: null, char: 'L' });
    assert.equal(state.layoutPreset, 'split');  // unchanged off-Live
  });
});

describe('mono — presets stay legible with zero color', () => {
  test('Focus ribbon + frame carry no SGR but keep the glyphs/labels', () => {
    process.env.AGENT_TUI_MONO = '1';
    setState({ layoutPreset: 'focus' });
    const frame = composeFrame(100, 24);
    delete process.env.AGENT_TUI_MONO;
    const raw = frame.join('\n');
    assert.ok(!/\x1b\[/.test(raw), 'no escapes in mono');
    const txt = plain(frame);
    assert.match(txt, /◷/);
    assert.match(txt, /OUTPUT/);
  });
});
