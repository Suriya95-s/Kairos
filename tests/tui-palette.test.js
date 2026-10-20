// tests/tui-palette.test.js — Phase 1: the Kairos Aurora color core. colorDepth
// (mono/ansi256/truecolor), fg()/bg() token resolvers, the depth-aware C Proxy,
// and the legacy-name → Aurora-role remapping that re-grades every existing view.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { colorDepth, fg, bg, C, monoMode } from '../apps/tui/src/render.js';

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(env)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

afterEach(() => { delete process.env.AGENT_TUI_MONO; delete process.env.NO_COLOR; delete process.env.COLORTERM; });

describe('colorDepth', () => {
  test('mono when NO_COLOR / AGENT_TUI_MONO set', () => {
    withEnv({ AGENT_TUI_MONO: '1', NO_COLOR: null, COLORTERM: null }, () => assert.equal(colorDepth(), 'mono'));
    withEnv({ NO_COLOR: '1', AGENT_TUI_MONO: null, COLORTERM: null }, () => assert.equal(colorDepth(), 'mono'));
  });
  test('truecolor when $COLORTERM advertises 24-bit', () => {
    withEnv({ COLORTERM: 'truecolor', NO_COLOR: null, AGENT_TUI_MONO: null }, () => assert.equal(colorDepth(), 'truecolor'));
    withEnv({ COLORTERM: '24bit', NO_COLOR: null, AGENT_TUI_MONO: null }, () => assert.equal(colorDepth(), 'truecolor'));
  });
  test('ansi256 otherwise', () => {
    withEnv({ COLORTERM: null, NO_COLOR: null, AGENT_TUI_MONO: null }, () => assert.equal(colorDepth(), 'ansi256'));
  });
});

describe('fg / bg token resolvers', () => {
  test('256 fallback emits the token index', () => {
    withEnv({ COLORTERM: null, NO_COLOR: null, AGENT_TUI_MONO: null }, () => {
      assert.equal(fg('iris'), '\x1b[38;5;105m');
      assert.equal(fg('jade'), '\x1b[38;5;78m');
      assert.equal(bg('raise'), '\x1b[48;5;235m');
    });
  });
  test('truecolor emits 24-bit rgb', () => {
    withEnv({ COLORTERM: 'truecolor', NO_COLOR: null, AGENT_TUI_MONO: null }, () => {
      assert.equal(fg('iris'), '\x1b[38;2;123;140;255m');
      assert.equal(bg('raise'), '\x1b[48;2;22;28;40m');
    });
  });
  test('mono blanks both', () => {
    withEnv({ AGENT_TUI_MONO: '1' }, () => { assert.equal(fg('iris'), ''); assert.equal(bg('raise'), ''); });
  });
  test('unknown token → empty string', () => {
    withEnv({ COLORTERM: null, NO_COLOR: null, AGENT_TUI_MONO: null }, () => assert.equal(fg('nope'), ''));
  });
});

describe('C proxy legacy → Aurora remap', () => {
  test('legacy names resolve to Aurora roles (256)', () => {
    withEnv({ COLORTERM: null, NO_COLOR: null, AGENT_TUI_MONO: null }, () => {
      assert.equal(C.green, fg('jade'));
      assert.equal(C.yellow, fg('amber'));
      assert.equal(C.red, fg('coral'));
      assert.equal(C.cyan, fg('aqua'));
      assert.equal(C.grey, fg('ink3'));
      assert.equal(C.violet, fg('iris'));
      assert.equal(C.blue, fg('sky'));
      assert.equal(C.white, fg('ink'));
    });
  });
  test('new role names work directly', () => {
    withEnv({ COLORTERM: null, NO_COLOR: null, AGENT_TUI_MONO: null }, () => {
      assert.equal(C.iris, fg('iris'));
      assert.equal(C.ink3, fg('ink3'));
      assert.equal(C.bgSel, bg('raise'));
    });
  });
  test('struct codes present in color, blank in mono', () => {
    withEnv({ COLORTERM: null, NO_COLOR: null, AGENT_TUI_MONO: null }, () => {
      assert.equal(C.bold, '\x1b[1m');
      assert.equal(C.reset, '\x1b[0m');
    });
    withEnv({ AGENT_TUI_MONO: '1' }, () => { assert.equal(C.bold, ''); assert.equal(C.reset, ''); });
  });
});
