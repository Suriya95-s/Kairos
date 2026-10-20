// tests/tui-steer-attach.test.js — F-3: attachments fold into the steer injection.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { executeCmd } from '../apps/tui/src/app.js';
import { api } from '../apps/tui/src/client/api.js';

let captured;
let origSteer;
beforeEach(() => {
  captured = null;
  origSteer = api.steer;
  api.steer = async (_port, message) => { captured = message; return { ok: true }; }; // stub (no network)
  setState({ view: 'live', overlay: null, steerInput: '', attachments: [], cmdHistory: [], toast: null });
});
afterEach(() => {
  api.steer = origSteer;
  if (state._toastTimer) { clearTimeout(state._toastTimer); setState({ _toastTimer: null }); }
});

describe('steer with attachments', () => {
  test('free text + attachments → message carries the [ATTACHED FILE] payload', async () => {
    setState({ attachments: [{ path: '/x/a.js', name: 'a.js', bytes: 12, content: 'console.log(1)', truncated: false }] });
    await executeCmd('please review this');
    assert.match(captured, /please review this/);
    assert.match(captured, /\[ATTACHED FILE: \/x\/a\.js \(12 bytes\)\]/);
    assert.match(captured, /console\.log\(1\)/);
    assert.deepEqual(state.attachments, [], 'attachments cleared after send');
  });

  test('truncated attachment is flagged in the payload header', async () => {
    setState({ attachments: [{ path: '/x/big.txt', name: 'big.txt', bytes: 100000, content: 'x'.repeat(10), truncated: true }] });
    await executeCmd('here');
    assert.match(captured, /\(100000 bytes, truncated\)/);
  });

  test('attachments-only (empty Enter) still sends with a placeholder', async () => {
    setState({ attachments: [{ path: '/x/c.md', name: 'c.md', bytes: 5, content: 'hello', truncated: false }] });
    await executeCmd('');  // empty line + attachments
    assert.ok(captured, 'a steer was sent');
    assert.match(captured, /see attached files/);
    assert.match(captured, /\[ATTACHED FILE: \/x\/c\.md/);
    assert.deepEqual(state.attachments, []);
  });

  test('total attachment payload is capped (context-budget guard)', async () => {
    const huge = 'y'.repeat(200 * 1024);
    setState({ attachments: [{ path: '/x/h.txt', name: 'h.txt', bytes: huge.length, content: huge, truncated: true }] });
    await executeCmd('go');
    assert.ok(captured.length <= 200 * 1024, `payload capped, got ${captured.length}`);
  });
});
