// tests/tui-cockpit.test.js — Wave E-4: narrow-terminal degradation + reconnect honesty.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { composeFrame } from '../apps/tui/src/app.js';
import { stripAnsi, visLen } from '../apps/tui/src/render.js';

const plain = (lines) => lines.map(stripAnsi).join('\n');

beforeEach(() => {
  setState({
    showSplash: false, view: 'live', overlay: null,
    episodeId: 'ep-1', task: 'fix the parser bug', status: 'running',
    step: 7, stage: 'execution', model: 'claude', costUsd: 0.3,
    steps: [{ step: 7, tool: 'run_command', arg: 'node --test', thought: 're-running the suite', result: '', error: false, startMs: 1 }],
    stepLatenciesMs: [], pendingApprovals: [], connected: true, connecting: false, reconnectAttempts: 0,
    modelPickerOpen: false, settingsOpen: false, modelConfigOpen: false, chatToolApproval: null, toast: null,
  });
});

describe('narrow-terminal degradation (no hard-fail under 60 cols)', () => {
  test('40-col frame still renders H lines (no "too narrow" bail)', () => {
    const frame = composeFrame(40, 20);
    assert.equal(frame.length, 20);
    assert.doesNotMatch(plain(frame), /too narrow/i);
  });

  test('narrow frame keeps situational awareness: status, step, current tool', () => {
    const txt = plain(composeFrame(40, 20));
    assert.match(txt, /KAIROS/);
    assert.match(txt, /step 7/);
    assert.match(txt, /run_command/);  // the NOW band
  });

  test('narrow frame surfaces a pending approval + intervention keys', () => {
    setState({ pendingApprovals: [{ id: 'a1', tool: 'run_command', reason: 'destructive', timestamp: Date.now() }] });
    const txt = plain(composeFrame(44, 20));
    assert.match(txt, /APPROVAL/);
    assert.match(txt, /\[a\]pprove/);
    assert.match(txt, /\[d\]eny/);
  });

  test('every narrow line stays within the width', () => {
    const frame = composeFrame(40, 20);
    for (const line of frame) assert.ok(visLen(line) <= 40, `line wider than 40: "${stripAnsi(line)}"`);
  });

  test('works down to a phone-width 32 columns', () => {
    const frame = composeFrame(32, 16);
    assert.equal(frame.length, 16);
    for (const line of frame) assert.ok(visLen(line) <= 32);
  });
});

describe('NOW band (the current step is sacred — visible across all views)', () => {
  beforeEach(() => setState({
    status: 'running',
    steps: [{ step: 9, tool: 'run_command', arg: 'pytest', thought: 'running the failing test', result: '', error: false, startMs: 1 }],
  }));

  for (const view of ['live', 'memory', 'metrics', 'chat']) {
    test(`NOW band shows the current tool in the "${view}" view`, () => {
      setState({ view });
      const txt = plain(composeFrame(100, 24));
      assert.match(txt, /NOW/);
      assert.match(txt, /run_command/);
      assert.match(txt, /running the failing test/); // the thought sub-line
    });
  }

  test('NOW band is absent on the splash and when idle', () => {
    setState({ showSplash: true });
    assert.doesNotMatch(plain(composeFrame(100, 24)), /▶ NOW/);
    setState({ showSplash: false, status: 'completed' });
    assert.doesNotMatch(plain(composeFrame(100, 24)), /▶ NOW/);
  });

  test('frame still totals H lines with the NOW band present', () => {
    setState({ view: 'live' });
    assert.equal(composeFrame(100, 24).length, 24);
  });
});

describe('focus-chain strip (§7.2 — drift becomes visible)', () => {
  beforeEach(() => setState({
    status: 'running', showSplash: false, view: 'live',
    steps: [{ step: 3, tool: 'edit_file', arg: '', thought: '', result: '', error: false, startMs: 1 }],
    focusChain: [
      { text: 'scout the repo', state: 'done' },
      { text: 'fix extractJsonObjects', state: 'current' },
      { text: 'add regression test', state: 'pending' },
    ],
  }));

  test('renders the plan items with the current one present', () => {
    const txt = plain(composeFrame(100, 24));
    assert.match(txt, /plan/);
    assert.match(txt, /scout the repo/);
    assert.match(txt, /fix extractJsonObjects/);
    assert.match(txt, /add regression test/);
  });

  test('distinct glyphs encode item state (done ✓ / current ▸ / pending ·)', () => {
    const txt = plain(composeFrame(100, 24));
    assert.match(txt, /✓ scout the repo/);
    assert.match(txt, /▸ /);
    assert.match(txt, /· add regression test/);
  });

  test('strip stays reserved with a placeholder when there is no plan, frame still totals H', () => {
    setState({ focusChain: [] });
    const txt = plain(composeFrame(100, 24));
    assert.match(txt, /plan/);
    assert.match(txt, /no active plan/);   // reserved rhythm: the slot persists (redesign §7)
    assert.equal(composeFrame(100, 24).length, 24);
  });
});

describe('inline HITL — approval band renders in Live (F-1)', () => {
  beforeEach(() => setState({
    showSplash: false, view: 'live', status: 'running',
    steps: [{ step: 5, tool: 'think', arg: '', thought: '', result: '', error: false, startMs: 1 }],
    pendingApprovals: [{ id: 'a1', tool: 'run_command', args: { command: 'rm -rf build' }, reason: 'destructive command', timestamp: Date.now(), timeoutMs: 600000 }],
    hitlCursor: 0, denyInputActive: false,
  }));

  test('the Live frame shows the approval with tool, reason, and a/d actions', () => {
    const txt = plain(composeFrame(100, 24));
    assert.match(txt, /APPROVAL REQUIRED/);
    assert.match(txt, /run_command/);
    assert.match(txt, /destructive command/);
    assert.match(txt, /\[a\]/);
    assert.match(txt, /\[d\]/);
  });

  test('frame still totals H with the band present', () => {
    assert.equal(composeFrame(100, 24).length, 24);
  });

  test('deny input renders inline in the band when active', () => {
    setState({ denyInputActive: true, denyInput: 'too risky' });
    const txt = plain(composeFrame(100, 24));
    assert.match(txt, /deny reason:/);
    assert.match(txt, /too risky/);
  });

  test('no band when there are no pending approvals', () => {
    setState({ pendingApprovals: [] });
    assert.doesNotMatch(plain(composeFrame(100, 24)), /APPROVAL REQUIRED/);
  });
});

describe('reconnect honesty in the header', () => {
  test('a dropped session that is retrying shows RECONNECTING, not stale live state', () => {
    setState({ connected: false, connecting: true, reconnectAttempts: 2, episodeId: 'ep-1' });
    const header = stripAnsi(composeFrame(100, 24)[0]);
    assert.match(header, /RECONNECTING/);
    assert.match(header, /try 2/);
    assert.doesNotMatch(header, /RUNNING/); // never present the old live status as current
  });

  test('an initial connection (no prior session) shows CONNECTING', () => {
    setState({ connected: false, connecting: true, reconnectAttempts: 0, episodeId: '' });
    const header = stripAnsi(composeFrame(100, 24)[0]);
    assert.match(header, /CONNECTING/);
    assert.doesNotMatch(header, /RECONNECTING/);
  });

  test('a healthy running session shows RUNNING', () => {
    setState({ connected: true, connecting: false });
    const header = stripAnsi(composeFrame(100, 24)[0]);
    assert.match(header, /RUNNING/);
  });
});

describe('reserved NOW/FOCUS rhythm (redesign §7 — no layout jump)', () => {
  test('idle shows calm placeholders instead of collapsing the slots', () => {
    setState({ status: 'completed', steps: [], focusChain: [], showSplash: false, view: 'live' });
    const txt = plain(composeFrame(100, 24));
    assert.match(txt, /idle · waiting for next step/);
    assert.match(txt, /no active plan/);
  });

  test('frame height is constant whether running or idle (slots are reserved)', () => {
    setState({ status: 'running', steps: [{ step: 1, tool: 'edit', arg: 'a', thought: 't', result: '', error: false, startMs: 1 }],
      focusChain: [{ text: 'do a thing', state: 'current' }], showSplash: false, view: 'live' });
    const running = composeFrame(100, 24).length;
    setState({ status: 'completed', steps: [], focusChain: [] });
    const idle = composeFrame(100, 24).length;
    assert.equal(running, 24);
    assert.equal(idle, 24);
  });
});
