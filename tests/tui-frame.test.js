// tests/tui-frame.test.js — Wave E-1: golden-frame harness over composeFrame().
// Feeds a known state into the pure frame composer and asserts structural
// invariants + determinism. These guard the E-2 app.js split against regressions.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { composeFrame } from '../apps/tui/src/app.js';
import { visLen } from '../apps/tui/src/render.js';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const plain = (lines) => lines.map(stripAnsi).join('\n');
// Strip ANSI + digits → removes live timers/counters so two renders compare equal.
const skeleton = (lines) => lines.map(l => stripAnsi(l).replace(/\d+/g, '#'));

// Reset to a clean, known baseline before each test.
beforeEach(() => {
  setState({
    showSplash: false, view: 'live', overlay: null,
    episodeId: 'ep-test', task: 'fix the parser bug', status: 'running',
    step: 3, stage: 'execution', model: 'claude', costUsd: 0.42,
    steps: [], stepLatenciesMs: [], pendingApprovals: [],
    stepsScroll: 0, outputScroll: 0, pinnedIdx: null,
    modelPickerOpen: false, settingsOpen: false, modelConfigOpen: false,
    chatToolApproval: null, toast: null,
    errors: 0, hallucinations: 0, compactions: 0,
  });
});

describe('composeFrame — dimensions', () => {
  test('returns exactly H lines', () => {
    const frame = composeFrame(80, 24);
    assert.equal(frame.length, 24);
  });

  test('header band fits when there is room (120 cols)', () => {
    // Tight 80-col / per-view width discipline is E-4 (narrow-terminal) work;
    // here we assert the header composes within a generous width.
    const header = composeFrame(120, 24)[0];
    assert.ok(visLen(header) <= 120, `header wider than 120: "${stripAnsi(header)}"`);
  });

  test('adapts to a different size', () => {
    assert.equal(composeFrame(100, 30).length, 30);
    assert.equal(composeFrame(60, 12).length, 12);
  });
});

describe('composeFrame — content (live session)', () => {
  test('header carries the step, stage, and cost instruments', () => {
    const header = stripAnsi(composeFrame(80, 24)[0]);
    assert.match(header, /step 3/);          // redesign §5: lowercase mid-dot meta
    assert.match(header, /execution/);
    assert.match(header, /\$0\.42/);
  });

  test('the task is visible somewhere in the live frame', () => {
    // The task renders in the narrow INFO panel and word-wraps, so assert a
    // distinctive token rather than the full contiguous phrase.
    const txt = plain(composeFrame(80, 24));
    assert.match(txt, /parser/);
  });

  test('a rendered step row shows its tool name', () => {
    setState({
      steps: [{ step: 3, tool: 'run_command', arg: 'node --test', thought: 're-run', result: 'ok', error: false, startMs: 1 }],
    });
    const txt = plain(composeFrame(80, 24));
    assert.match(txt, /run_command/);
  });
});

describe('composeFrame — splash', () => {
  test('splash frame includes the KAIROS banner', () => {
    setState({ showSplash: true, status: 'connecting' });
    const txt = plain(composeFrame(80, 24));
    assert.match(txt, /KAIROS/);
  });
});

describe('composeFrame — other views compose without throwing', () => {
  for (const view of ['live', 'memory', 'metrics', 'chat']) {
    test(`view "${view}" yields a full-height frame`, () => {
      setState({ view });
      const frame = composeFrame(80, 24);
      assert.equal(frame.length, 24);
    });
  }
});

describe('composeFrame — determinism (regression guard for the split)', () => {
  test('frame skeleton is stable across two renders of frozen state', () => {
    setState({
      steps: [{ step: 3, tool: 'edit_file', arg: 'src/x.js', thought: 'patch', result: 'written', error: false, startMs: 1 }],
    });
    const a = skeleton(composeFrame(80, 24));
    const b = skeleton(composeFrame(80, 24));
    assert.deepEqual(a, b);
  });
});
