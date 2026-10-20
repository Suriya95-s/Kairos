// tests/tui-accessibility.test.js — Wave E-3: mono / symbols / reduced-motion.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { composeFrame } from '../apps/tui/src/app.js';
import { C, g, r, paint, monoMode, reducedMotion } from '../apps/tui/src/render.js';

// fg/bg/bold/dim color codes — incl. 256-index and 24-bit truecolor (Aurora grade)
const COLOR_SGR = /\x1b\[(3[0-9]|9[0-9]|1|2|38;5;\d+|48;5;\d+|38;2;\d+;\d+;\d+|48;2;\d+;\d+;\d+)m/;

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

describe('monoMode / C proxy', () => {
  test('color helpers emit ANSI when color is on', () => {
    withEnv({ NO_COLOR: null, AGENT_TUI_MONO: null }, () => {
      assert.match(g('hi'), COLOR_SGR);
      assert.notEqual(C.green, '');
    });
  });

  test('NO_COLOR blanks every SGR code', () => {
    withEnv({ NO_COLOR: '1', AGENT_TUI_MONO: null }, () => {
      assert.equal(monoMode(), true);
      assert.equal(C.green, '');
      assert.equal(C.bold, '');
      assert.equal(C.reset, '');
      assert.equal(g('hi'), 'hi');       // no wrapping codes
      assert.equal(paint(C.red, 'x'), 'x');
    });
  });

  test('AGENT_TUI_MONO=1 also blanks color', () => {
    withEnv({ NO_COLOR: null, AGENT_TUI_MONO: '1' }, () => {
      assert.equal(monoMode(), true);
      assert.equal(r('boom'), 'boom');
    });
  });

  test('NO_COLOR set to empty string still counts (convention)', () => {
    withEnv({ NO_COLOR: '', AGENT_TUI_MONO: null }, () => {
      assert.equal(monoMode(), true);
    });
  });
});

describe('a composed frame is ANSI-free in mono mode', () => {
  beforeEach(() => setState({
    showSplash: false, view: 'live', overlay: null,
    task: 'demo', status: 'running', step: 2, stage: 'execution', model: 'claude',
    costUsd: 0.5, steps: [{ step: 2, tool: 'edit_file', arg: 'a.js', thought: 't', result: 'ok', error: false, startMs: 1 }],
    stepLatenciesMs: [], pendingApprovals: [], modelPickerOpen: false, settingsOpen: false,
    modelConfigOpen: false, chatToolApproval: null, toast: null,
  }));

  test('mono frame contains no color escape sequences', () => {
    withEnv({ AGENT_TUI_MONO: '1' }, () => {
      const frame = composeFrame(80, 24).join('\n');
      assert.doesNotMatch(frame, COLOR_SGR, 'no SGR color codes should remain in mono');
    });
  });

  test('the same state in color mode DOES contain color codes (control)', () => {
    withEnv({ NO_COLOR: null, AGENT_TUI_MONO: null }, () => {
      const frame = composeFrame(80, 24).join('\n');
      assert.match(frame, COLOR_SGR);
    });
  });
});

describe('status glyphs are distinct (color-blind / mono legibility)', () => {
  test('each status renders a unique leading glyph in the header', () => {
    const glyphs = {};
    for (const status of ['running', 'paused', 'completed', 'error', 'disconnected']) {
      withEnv({ AGENT_TUI_MONO: '1' }, () => {
        setState({ status, showSplash: false, view: 'live' });
        const header = composeFrame(80, 24)[0];
        const m = header.match(/[▶‖✓✗·]/);
        assert.ok(m, `status ${status} should carry a glyph; header="${header.trim()}"`);
        glyphs[status] = m[0];
      });
    }
    const unique = new Set(Object.values(glyphs));
    assert.equal(unique.size, Object.keys(glyphs).length, `glyphs must be distinct: ${JSON.stringify(glyphs)}`);
  });
});

describe('reduced motion', () => {
  test('reducedMotion reflects AGENT_TUI_NO_SPIN', () => {
    withEnv({ AGENT_TUI_NO_SPIN: '1' }, () => assert.equal(reducedMotion(), true));
    withEnv({ AGENT_TUI_NO_SPIN: null }, () => assert.equal(reducedMotion(), false));
  });

  test('connecting status shows a static marker (no animation frame) under reduced motion', () => {
    withEnv({ AGENT_TUI_NO_SPIN: '1', AGENT_TUI_MONO: '1' }, () => {
      setState({ status: 'connecting', showSplash: false, view: 'live', _spinFrame: 3 });
      const header = composeFrame(80, 24)[0];
      // Static marker, not the rotating |/-\ frame that _spinFrame=3 would select.
      assert.match(header, /▷ CONNECTING/);
      assert.doesNotMatch(header, /\\ CONNECTING/);
    });
  });
});
