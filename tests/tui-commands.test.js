// tests/tui-commands.test.js — command-router behavior + crash-safety (robustness).
// A malformed command must never throw out of executeCmd (which is awaited inside
// the key handler — an escaping rejection would hit unhandledRejection and exit the
// TUI). Covers the previously-untested operator command surface.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { executeCmd } from '../apps/tui/src/app.js';

beforeEach(() => {
  setState({
    view: 'live', prevView: 'live', overlay: null, status: 'running', step: 5, costUsd: 0.25,
    steps: [{ step: 5, tool: 'think' }], stepsScroll: 2, pinnedIdx: 1, outputScroll: 3,
    chatMessages: [{ role: 'user', text: 'hi' }], chatScroll: 1,
    cmdHistory: [], toast: null, settingsOpen: false,
    pendingApprovals: [], hitlCursor: 0, pendingClarifications: [],
  });
});
afterEach(() => {
  if (state._toastTimer) { clearTimeout(state._toastTimer); setState({ _toastTimer: null }); }
});

describe('state-mutating commands', () => {
  test('/clear wipes the step history', async () => {
    await executeCmd('/clear');
    assert.deepEqual(state.steps, []);
    assert.equal(state.pinnedIdx, null);
    assert.equal(state.toast.colour, 'green');
  });

  test('/clearchat wipes chat history', async () => {
    await executeCmd('/clearchat');
    assert.deepEqual(state.chatMessages, []);
    assert.equal(state.chatScroll, 0);
  });

  test('/metrics and /chat switch views', async () => {
    await executeCmd('/metrics');
    assert.equal(state.view, 'metrics');
    await executeCmd('/chat');
    assert.equal(state.view, 'chat');
  });

  test('/help opens the help overlay', async () => {
    await executeCmd('/help');
    assert.equal(state.overlay, 'help');
  });

  test('/settings opens settings', async () => {
    await executeCmd('/settings');
    assert.equal(state.settingsOpen, true);
  });

  test('an unknown command shows a red error toast (no throw)', async () => {
    await executeCmd('/bogus');
    assert.equal(state.toast.colour, 'red');
    assert.match(state.toast.message, /Unknown command/);
  });

  test('/run with no arg shows a usage hint', async () => {
    await executeCmd('/run');
    assert.match(state.toast.message, /Usage/);
  });

  test('/clarify with only an id shows a usage hint', async () => {
    await executeCmd('/clarify abc');
    assert.match(state.toast.message, /Usage/);
  });
});

describe('/status is defensively hardened', () => {
  test('does not throw even when status/costUsd are malformed', async () => {
    setState({ status: null, costUsd: undefined, step: undefined });
    await assert.doesNotReject(() => executeCmd('/status'));
    assert.ok(state.toast.message.includes('UNKNOWN'));
  });
});

describe('crash-safety — executeCmd never rejects', () => {
  const inputs = [
    '', '   ', '/', '//', '/clear', '/CLEAR', '/Live', '/help', '/status',
    '/bogus', '/memory', '/metrics', '/chat', '/clearchat', '/settings',
    'not a command at all', '/clarify', '/run', '/deny', '/approve',
  ];
  for (const input of inputs) {
    test(`"${input}" resolves without throwing`, async () => {
      // Keep these to non-network, non-spawn branches; the point is the parser +
      // the try/catch wrapper hold for arbitrary operator input.
      if (/^\/(reconnect|quit|pause|resume|run|export)\b/.test(input)) return;
      await assert.doesNotReject(() => executeCmd(input));
    });
  }
});
