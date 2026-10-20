// tests/tui-compose.test.js — Phase 2: generic composition helpers (seg, bandLR,
// boxTopN/boxBotN/boxRowN) shared by every layout preset. Width-exact + mono-safe.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { seg, bandLR, boxTopN, boxBotN, boxRowN, stripAnsi, visLen, C } from '../apps/tui/src/render.js';

describe('seg', () => {
  test('plain text when no color/bold', () => {
    assert.equal(seg('hi'), 'hi');
  });
  test('wraps in color + reset', () => {
    const s = seg('hi', C.iris);
    assert.equal(stripAnsi(s), 'hi');
    assert.ok(s.includes(C.iris));
    assert.ok(s.endsWith(C.reset));
  });
  test('bold prepends the bold code', () => {
    const s = seg('hi', C.iris, true);
    assert.ok(s.startsWith(C.bold));
  });
});

describe('bandLR', () => {
  test('justifies left and right to the exact width', () => {
    const line = bandLR('left', 'right', 20);
    assert.equal(visLen(line), 20);
    assert.ok(stripAnsi(line).startsWith('left'));
    assert.ok(stripAnsi(line).endsWith('right'));
  });
  test('clips the left side when they would collide', () => {
    const line = bandLR('a very long left side indeed', 'RIGHT', 12);
    assert.equal(visLen(line), 12);
    assert.ok(stripAnsi(line).endsWith('RIGHT'));
  });
  test('measures visible length, ignoring color codes', () => {
    const line = bandLR(seg('left', C.iris), seg('right', C.aqua), 20);
    assert.equal(visLen(line), 20);
  });
});

describe('boxTopN / boxBotN', () => {
  test('single-weight top has the right corners and junctions', () => {
    const top = stripAnsi(boxTopN([3, 4], 'single'));
    assert.equal(top, '┌───┬────┐');
  });
  test('double-weight bottom uses heavy glyphs', () => {
    const bot = stripAnsi(boxBotN([2, 2], 'double'));
    assert.equal(bot, '╚══╩══╝');
  });
  test('single column has no junction', () => {
    assert.equal(stripAnsi(boxTopN([5], 'single')), '┌─────┐');
  });
});

describe('boxRowN', () => {
  test('pads each cell to its width and frames with bars', () => {
    const row = boxRowN(['a', 'bb'], [3, 4], 'single');
    const plain = stripAnsi(row);
    assert.equal(plain, '│a  │bb  │');
  });
  test('clips a cell that overflows its width', () => {
    const row = boxRowN(['abcdef'], [4], 'single');
    assert.equal(stripAnsi(row), '│abc…│');
  });
  test('double weight uses ║ bars', () => {
    assert.equal(stripAnsi(boxRowN(['x'], [3], 'double')), '║x  ║');
  });
});
