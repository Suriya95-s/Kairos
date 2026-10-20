// tests/tui-footer.test.js — Workstream B: the command-bar hints line is
// view-aware (shows keys for the active view) and always advertises [?] Help.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { renderCommandBar } from '../apps/tui/src/components/commandBar.js';
import { stripAnsi } from '../apps/tui/src/render.js';

function hints() {
  // last line of the command bar is the hints line
  const bar = renderCommandBar(120).map(stripAnsi);
  return bar[bar.length - 1];
}

describe('view-aware hints line', () => {
  beforeEach(() => {
    setState({ cmdInputActive: false, overlay: null, attachments: [],
      pendingApprovals: [], settingsOpen: false });
  });
  test('live view advertises pin + model keys', () => {
    setState({ view: 'live' });
    const h = hints();
    assert.match(h, /Enter/);
    assert.match(h, /pin/i);
    assert.match(h, /\[\?\] Help/);
  });
  test('memory view advertises temporal/rooms/search', () => {
    setState({ view: 'memory' });
    const h = hints();
    assert.match(h, /Temporal|temporal/);
    assert.match(h, /Search|search/);
    assert.match(h, /\[\?\] Help/);
  });
  test('metrics view advertises export', () => {
    setState({ view: 'metrics' });
    assert.match(hints(), /Export|export/);
    assert.match(hints(), /\[\?\] Help/);
  });
  test('hints line is exactly one row, width-padded', () => {
    setState({ view: 'live' });
    const bar = renderCommandBar(120);
    const last = bar[bar.length - 1];
    assert.equal(stripAnsi(last).length, 120);
  });
  test('mono mode → no SGR codes in the hints line', () => {
    process.env.AGENT_TUI_MONO = '1';
    setState({ view: 'live' });
    const raw = renderCommandBar(120);
    delete process.env.AGENT_TUI_MONO;
    const last = raw[raw.length - 1];
    assert.ok(!/\x1b\[/.test(last), 'expected no ANSI escapes under mono');
  });
});
