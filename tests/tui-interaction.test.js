// tests/tui-interaction.test.js — guard rail for the app.js split.
// Drives the real key dispatcher (handleKey) and command router (executeCmd)
// and asserts the resulting STATE transitions. These pin key→state behavior so
// the monolith split can be verified to preserve it. Only side-effect-free paths
// are exercised (no network/spawn/process.exit keys: P, R, Q, Enter-spawn).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { handleKey, executeCmd } from '../apps/tui/src/app.js';
import { KEYS } from '../apps/tui/src/keys.js';

// A clean, connected, no-overlay baseline before each test.
beforeEach(() => {
  setState({
    showSplash: false, connected: true, connecting: false,
    view: 'live', prevView: 'live', overlay: null, status: 'running',
    settingsOpen: false, chatToolApproval: null,
    pickerOpen: false, pickerKind: '', pickerFilter: '', pickerIdx: 0, pickerFetching: false,
    modelSource: 'api', provider: 'openai', serverUrl: '',
    recentModels: {}, fetchedModels: {}, keyHistory: [], recentEndpoints: [],
    steps: [{ step: 1, tool: 'think', arg: '', thought: '', result: '', error: false, startMs: 1 }],
    stepsScroll: 0, outputScroll: 0, pinnedIdx: null,
    pendingApprovals: [], hitlCursor: 0, denyInputActive: false,
    memMode: 'temporal', memScroll: 0, memFocus: 'events', memSearchActive: false,
    chatScroll: 0, cmdInputActive: false, cmdInput: '', cmdHistory: [], cmdSuggestions: [], cmdSugIdx: -1, cmdHistoryIdx: -1,
    steerInput: '', infoScroll: 0, modelList: [{ id: 'm1', label: 'M1' }, { id: 'm2', label: 'M2' }],
    toast: null,
  });
});

describe('view switching (number keys + F-keys)', () => {
  // HITL merged into Live; Council added: 1 Live · 2 Memory · 3 Metrics · 4 Chat · 5 Council.
  for (const [char, view] of [['1', 'live'], ['2', 'memory'], ['3', 'metrics'], ['4', 'chat'], ['5', 'council']]) {
    test(`"${char}" switches to ${view}`, async () => {
      await handleKey({ char });
      assert.equal(state.view, view);
    });
  }
  test('switching records prevView', async () => {
    setState({ view: 'live' });
    await handleKey({ char: '2' });
    assert.equal(state.view, 'memory');
    assert.equal(state.prevView, 'live');
  });
  test('F3 is an alias for "3" (metrics)', async () => {
    await handleKey({ key: KEYS.F3 });
    assert.equal(state.view, 'metrics');
  });
});

describe('overlays open/close', () => {
  test('"?" opens help; any non-q key closes it', async () => {
    await handleKey({ char: '?' });
    assert.equal(state.overlay, 'help');
    await handleKey({ char: 'x' });
    assert.equal(state.overlay, null);
  });
  test('"S" opens steer; typing builds the buffer; ESC cancels', async () => {
    await handleKey({ char: 'S' });
    assert.equal(state.overlay, 'steer');
    await handleKey({ char: 'h' });
    await handleKey({ char: 'i' });
    assert.equal(state.steerInput, 'hi');
    await handleKey({ key: KEYS.BACKSPACE });
    assert.equal(state.steerInput, 'h');
    await handleKey({ key: KEYS.ESC });
    assert.equal(state.overlay, null);
    assert.equal(state.steerInput, '');
  });
  test('"," opens settings', async () => {
    await handleKey({ char: ',' });
    assert.equal(state.settingsOpen, true);
  });
  test('info overlay scrolls and closes', async () => {
    setState({ overlay: 'info', infoLines: ['a', 'b', 'c'], infoScroll: 0 });
    await handleKey({ key: KEYS.DOWN });
    assert.equal(state.infoScroll, 1);
    await handleKey({ key: KEYS.UP });
    assert.equal(state.infoScroll, 0);
    await handleKey({ key: KEYS.ESC });
    assert.equal(state.overlay, null);
  });
});

describe('model picker (searchable dropdown)', () => {
  test('"M" opens the model picker; type filters; UP/DOWN move; ESC closes', async () => {
    // API + openai → curated PROVIDER_MODELS gives a non-empty list to navigate.
    setState({ modelSource: 'api', provider: 'openai' });
    await handleKey({ char: 'M' });
    assert.equal(state.pickerOpen, true);
    assert.equal(state.pickerKind, 'model');
    await handleKey({ key: KEYS.DOWN });
    assert.equal(state.pickerIdx, 1);
    await handleKey({ key: KEYS.UP });
    assert.equal(state.pickerIdx, 0);
    // Typing builds the filter and resets the cursor.
    await handleKey({ char: 'm' });
    await handleKey({ char: 'i' });
    assert.equal(state.pickerFilter, 'mi');
    assert.equal(state.pickerIdx, 0);
    await handleKey({ key: KEYS.BACKSPACE });
    assert.equal(state.pickerFilter, 'm');
    await handleKey({ key: KEYS.ESC });
    assert.equal(state.pickerOpen, false);
    assert.equal(state.pickerFilter, '');
  });

  test('ENTER on a custom-typed model id applies it and remembers it', async () => {
    setState({ modelSource: 'local', serverUrl: 'http://localhost:8000/v1', recentModels: {} });
    await handleKey({ char: 'M' });
    for (const c of 'my-local-model') await handleKey({ char: c });
    await handleKey({ key: KEYS.ENTER });
    assert.equal(state.model, 'my-local-model');
    assert.equal(state.pickerOpen, false);
    assert.deepEqual(state.recentModels['http://localhost:8000/v1'], ['my-local-model']);
  });
});

describe('live view scrolling', () => {
  test('UP/DOWN move the step scroll; ESC unpins', async () => {
    setState({ view: 'live', steps: [{ step: 3 }, { step: 2 }, { step: 1 }], stepsScroll: 0 });
    await handleKey({ key: KEYS.DOWN });
    assert.equal(state.stepsScroll, 1);
    await handleKey({ key: KEYS.UP });
    assert.equal(state.stepsScroll, 0);
    setState({ pinnedIdx: 1 });
    await handleKey({ key: KEYS.ESC });
    assert.equal(state.pinnedIdx, null);
  });
});

describe('memory view mode toggles', () => {
  test('t/r/f switch modes', async () => {
    setState({ view: 'memory' });
    await handleKey({ char: 'r' });
    assert.equal(state.memMode, 'rooms');
    await handleKey({ char: 'f' });
    assert.equal(state.memMode, 'search');
    assert.equal(state.memSearchActive, true);
    setState({ memSearchActive: false });
    await handleKey({ char: 't' });
    assert.equal(state.memMode, 'temporal');
  });
  test('TAB cycles the focus panel', async () => {
    setState({ view: 'memory', memFocus: 'events', memSearchActive: false });
    await handleKey({ key: KEYS.TAB });
    assert.equal(state.memFocus, 'skills');
    await handleKey({ key: KEYS.TAB });
    assert.equal(state.memFocus, 'reflections');
    await handleKey({ key: KEYS.TAB });
    assert.equal(state.memFocus, 'events');
  });
});

describe('inline approvals in Live (HITL merged in)', () => {
  test('in Live, ←→ cycle the pending requests; "d" opens the deny input', async () => {
    setState({ view: 'live', pendingApprovals: [{ id: 'a' }, { id: 'b' }], hitlCursor: 0, denyInputActive: false });
    await handleKey({ key: KEYS.RIGHT });
    assert.equal(state.hitlCursor, 1);
    await handleKey({ key: KEYS.RIGHT }); // clamped
    assert.equal(state.hitlCursor, 1);
    await handleKey({ key: KEYS.LEFT });
    assert.equal(state.hitlCursor, 0);
    await handleKey({ char: 'd' });
    assert.equal(state.denyInputActive, true);
    assert.equal(state.view, 'live'); // stays in Live, not a separate panel
  });
});

describe('splash dismissal', () => {
  test('a printable key dismisses the splash and starts command input', async () => {
    setState({ showSplash: true, connected: true });
    await handleKey({ char: 'h' });
    assert.equal(state.showSplash, false);
    assert.equal(state.cmdInputActive, true);
    assert.equal(state.cmdInput, 'h');
  });
});

describe('global intervention keys (Wave E-4b — reachable from any view)', () => {
  test('"d" opens the deny input in place when an approval is pending', async () => {
    setState({ view: 'memory', pendingApprovals: [{ id: 'a1', tool: 'run_command' }] });
    await handleKey({ char: 'd' });
    assert.equal(state.denyInputActive, true);
    assert.equal(state.view, 'live'); // surfaces in Live (where the band renders)
  });

  test('"a" from the MEMORY view approves the pending request (clears it from state)', async () => {
    setState({ view: 'memory', pendingApprovals: [{ id: 'a1', tool: 'run_command' }], hitlCursor: 0 });
    await handleKey({ char: 'a' });
    assert.equal(state.pendingApprovals.length, 0); // sendApprove removes it regardless of network
  });

  test('with NO pending approval, "a" falls through to command input (not intercepted)', async () => {
    setState({ view: 'live', pendingApprovals: [], cmdInputActive: false });
    await handleKey({ char: 'a' });
    assert.equal(state.cmdInputActive, true);
    assert.equal(state.cmdInput, 'a');
  });

  test('SPACE does not start command input (it is the global pause key)', async () => {
    setState({ view: 'live', pendingApprovals: [], cmdInputActive: false, status: 'running' });
    await handleKey({ char: ' ' });
    assert.equal(state.cmdInputActive, false); // space is intercepted, not typed
  });
});

describe('executeCmd — parser + history (no side-effecting branch)', () => {
  test('empty input clears the command line', async () => {
    setState({ cmdInputActive: true, cmdInput: '/' });
    await executeCmd('');
    assert.equal(state.cmdInputActive, false);
    assert.equal(state.cmdInput, '');
  });
  test('/council switches to the council view', async () => {
    setState({ view: 'live' });
    await executeCmd('/council');
    assert.equal(state.view, 'council');
  });

  test('a command is pushed onto history (most-recent first, deduped)', async () => {
    setState({ cmdHistory: ['old'] });
    await executeCmd('/unknowncmd xyz');
    assert.equal(state.cmdHistory[0], '/unknowncmd xyz');
    assert.ok(state.cmdHistory.includes('old'));
    assert.equal(state.cmdInputActive, false); // input line cleared after dispatch
  });
});
