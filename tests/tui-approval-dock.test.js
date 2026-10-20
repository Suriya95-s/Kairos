// tests/tui-approval-dock.test.js — Phase 4 (redesign §4): the docked approval
// interrupt owns the top band on EVERY view and escalates by glyph multiplicity +
// weight + text (never blink/color-only), so it survives mono + reduced-motion.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { composeFrame, renderApprovalDock } from '../apps/tui/src/app.js';
import { stripAnsi, visLen } from '../apps/tui/src/render.js';

const plain = (lines) => lines.map(stripAnsi).join('\n');

beforeEach(() => setState({
  showSplash: false, status: 'running', connected: true, connecting: false,
  steps: [{ step: 5, tool: 'think', arg: '', thought: '', result: '', error: false, startMs: 1 }],
  focusChain: [], hitlCursor: 0, denyInputActive: false, denyInput: '', toast: null,
  pendingApprovals: [{ id: 'a1', tool: 'run_command', args: { command: 'rm -rf build' },
    reason: 'destructive command', timestamp: Date.now(), timeoutMs: 600000 }],
}));

describe('docked approval interrupt — owns the top band on every view', () => {
  for (const view of ['live', 'memory', 'metrics', 'chat', 'council']) {
    test(`docks on the "${view}" view (cannot be scrolled away)`, () => {
      setState({ view });
      const frame = composeFrame(100, 24);
      const txt = plain(frame);
      assert.match(txt, /APPROVAL REQUIRED/);
      assert.match(txt, /run_command/);
      assert.match(txt, /destructive command/);
      assert.match(txt, /\[a\]pprove/);
      assert.match(txt, /\[d\]eny/);
      // double-ruled frame (the "floating above" weight)
      assert.match(txt, /╔/);
      assert.match(txt, /╚/);
      assert.equal(frame.length, 24);
    });
  }

  test('the NOW band is replaced by the dock (no double-render)', () => {
    setState({ view: 'live' });
    const txt = plain(composeFrame(100, 24));
    assert.doesNotMatch(txt, /NOW/);  // the dock takes the slot
  });
});

describe('escalation ladder (glyph + weight + text, never color-only)', () => {
  const dock = (remMs) => {
    setState({ pendingApprovals: [{ id: 'x', tool: 'bash', args: '', reason: 'r',
      timestamp: Date.now(), timeoutMs: remMs }] });
    return plain(renderApprovalDock(100));
  };
  test('calm (>15m): a single ⚠', () => {
    const t = dock(20 * 60000);
    assert.match(t, /⚠ /);
    assert.doesNotMatch(t, /⚠⚠/);
  });
  test('<15m: the warning glyph doubles (⚠⚠)', () => {
    assert.match(dock(10 * 60000), /⚠⚠/);
  });
  test('<1m: triples (⚠⚠⚠) and the timer reads <1m', () => {
    const t = dock(30000);
    assert.match(t, /⚠⚠⚠/);
    assert.match(t, /<1m/);
  });
});

describe('mono + queue + deny', () => {
  test('mono frame still carries the interrupt by glyph + label (no color needed)', () => {
    process.env.AGENT_TUI_MONO = '1';
    const txt = plain(composeFrame(100, 24));
    delete process.env.AGENT_TUI_MONO;
    assert.match(txt, /APPROVAL REQUIRED/);
    assert.match(txt, /⚠/);
    assert.match(txt, /╔/);
  });
  test('a multi-item queue shows (i/n) and the [←→] cycle hint', () => {
    setState({ pendingApprovals: [
      { id: 'a', tool: 't1', args: '', reason: 'r1', timestamp: Date.now(), timeoutMs: 600000 },
      { id: 'b', tool: 't2', args: '', reason: 'r2', timestamp: Date.now(), timeoutMs: 600000 },
    ], hitlCursor: 0 });
    const txt = plain(renderApprovalDock(100));
    assert.match(txt, /\(1\/2\)/);
    assert.match(txt, /\[←→\]/);
  });
  test('deny input renders inline in the dock when active', () => {
    setState({ denyInputActive: true, denyInput: 'too risky' });
    const txt = plain(renderApprovalDock(100));
    assert.match(txt, /deny reason:/);
    assert.match(txt, /too risky/);
  });
  test('every dock row is exactly the requested width', () => {
    for (const line of renderApprovalDock(100)) assert.equal(visLen(line), 100);
  });
});
