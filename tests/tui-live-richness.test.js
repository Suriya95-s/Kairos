// tests/tui-live-richness.test.js — Workstream A: surface timing/trend data in
// the Live view. Pure helpers (fmtDuration/sparkline/wrapLine) + colorizeOutput
// diff tint + per-step duration rendering. All offline, mono-asserted.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { fmtDuration, sparkline, wrapLine, stripAnsi, monoMode, C } from '../apps/tui/src/render.js';

describe('fmtDuration', () => {
  test('sub-second renders as Nms', () => {
    assert.equal(fmtDuration(0), '0ms');
    assert.equal(fmtDuration(450), '450ms');
    assert.equal(fmtDuration(999), '999ms');
  });
  test('>= 1s renders as N.Ns', () => {
    assert.equal(fmtDuration(1000), '1.0s');
    assert.equal(fmtDuration(1234), '1.2s');
    assert.equal(fmtDuration(5400), '5.4s');
  });
  test('nullish / negative → empty string', () => {
    assert.equal(fmtDuration(null), '');
    assert.equal(fmtDuration(undefined), '');
    assert.equal(fmtDuration(-5), '');
  });
});

describe('sparkline', () => {
  test('empty input → empty string', () => {
    assert.equal(sparkline([], 8), '');
    assert.equal(sparkline(null, 8), '');
  });
  test('maps min→lowest glyph, max→highest glyph', () => {
    const s = sparkline([0, 100], 8);
    assert.equal(stripAnsi(s)[0], '▁');
    assert.equal(stripAnsi(s)[stripAnsi(s).length - 1], '█');
  });
  test('flat data (min==max) → mid-tier bar, no NaN', () => {
    const s = stripAnsi(sparkline([5, 5, 5], 8));
    assert.equal(s.length, 3);
    assert.ok(!s.includes('NaN'));
    assert.ok('▁▂▃▄▅▆▇█'.includes(s[0]));
  });
  test('keeps only the last `width` samples', () => {
    const s = stripAnsi(sparkline([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3));
    assert.equal(s.length, 3);
  });
});

describe('wrapLine', () => {
  test('short line returned as single element', () => {
    assert.deepEqual(wrapLine('hello', 10), ['hello']);
  });
  test('wraps on word boundaries', () => {
    assert.deepEqual(wrapLine('aaa bbb ccc', 7), ['aaa bbb', 'ccc']);
  });
  test('hard-breaks a token longer than width (never drops chars)', () => {
    const out = wrapLine('abcdefghij', 4);
    assert.deepEqual(out, ['abcd', 'efgh', 'ij']);
    assert.equal(out.join(''), 'abcdefghij');
  });
  test('empty string → single empty element', () => {
    assert.deepEqual(wrapLine('', 5), ['']);
  });
});

import { state, setState } from '../apps/tui/src/state.js';
import { renderLive } from '../apps/tui/src/views/live.js';
import { colorizeOutput } from '../apps/tui/src/views/live.js';

describe('live view richness', () => {
  test('a completed step shows its duration token', () => {
    setState({
      steps: [{ step: 7, tool: 'edit', arg: 'app.js', result: 'ok', error: false, latencyMs: 1234 }],
      status: 'completed', pinnedIdx: null, stepsScroll: 0, outputScroll: 0,
      pendingApprovals: [], task: 't', stage: '', model: 'm',
      stepLatenciesMs: [1234], costHistory: [0.01], palaceEvents: [], skills: [],
    });
    const text = renderLive(120, 24).map(stripAnsi).join('\n');
    assert.match(text, /1\.2s/);
  });
  test('a slow step (>=5s) is flagged with ⚠', () => {
    setState({
      steps: [{ step: 8, tool: 'bash', arg: '', result: 'done', error: false, latencyMs: 5400 }],
      status: 'completed', pinnedIdx: null, stepsScroll: 0, outputScroll: 0,
      pendingApprovals: [], task: 't', stage: '', model: 'm',
      stepLatenciesMs: [5400], costHistory: [0.02], palaceEvents: [], skills: [],
    });
    const text = renderLive(120, 24).map(stripAnsi).join('\n');
    assert.match(text, /5\.4s/);
    assert.match(text, /⚠/);
  });
  test('INFO panel shows a LATENCY section', () => {
    setState({
      steps: [{ step: 1, tool: 'read', result: 'x', error: false, latencyMs: 300 }],
      status: 'running', pinnedIdx: null, stepsScroll: 0, outputScroll: 0,
      pendingApprovals: [], task: 't', stage: '', model: 'm',
      stepLatenciesMs: [300, 800, 1200], costHistory: [0.01, 0.02], palaceEvents: [], skills: [],
    });
    const text = renderLive(120, 24).map(stripAnsi).join('\n');
    assert.match(text, /LATENCY/);
  });
  test('colorizeOutput tints + / - diff lines', () => {
    if (monoMode()) {
      // Mono blanks all color via the C proxy — assert no ANSI instead of a hue.
      assert.ok(!/\x1b\[/.test(colorizeOutput('+ added line')));
      assert.ok(!/\x1b\[/.test(colorizeOutput('- removed line')));
      return;
    }
    // Palette-robust: a '+' line carries the green/jade fg, '-' carries red/coral,
    // and the two differ. (Exact bytes vary with color depth under the Aurora grade.)
    assert.ok(colorizeOutput('+ added line').includes(C.green));
    assert.ok(colorizeOutput('- removed line').includes(C.red));
    assert.notEqual(C.green, C.red);
  });
});
