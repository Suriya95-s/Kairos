// tests/tui-render.test.js — Wave E-2: row-diff rendering primitives.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { diffRows, writeFrame, resetFrameBuffer } from '../apps/tui/src/render.js';

describe('diffRows — pure row comparison', () => {
  test('null previous → all rows changed', () => {
    assert.deepEqual(diffRows(null, ['a', 'b', 'c']), [0, 1, 2]);
  });
  test('different length → all rows changed', () => {
    assert.deepEqual(diffRows(['a'], ['a', 'b']), [0, 1]);
  });
  test('identical frames → no rows changed', () => {
    assert.deepEqual(diffRows(['a', 'b'], ['a', 'b']), []);
  });
  test('only the changed rows are reported', () => {
    assert.deepEqual(diffRows(['a', 'b', 'c'], ['a', 'X', 'c']), [1]);
    assert.deepEqual(diffRows(['a', 'b', 'c'], ['A', 'b', 'C']), [0, 2]);
  });
});

describe('writeFrame — diffed output to a captured stream', () => {
  let written;
  let origWrite;
  beforeEach(() => {
    resetFrameBuffer();
    written = [];
    origWrite = process.stdout.write;
    process.stdout.write = (s) => { written.push(s); return true; };
  });
  afterEach(() => {
    process.stdout.write = origWrite;
    resetFrameBuffer();
  });

  test('first frame is a full paint from home', () => {
    writeFrame(['row one', 'row two'], 20);
    const out = written.join('');
    assert.ok(out.startsWith('\x1b[H') || out.startsWith('\x1b['), 'starts at home');
    assert.match(out, /row one/);
    assert.match(out, /row two/);
  });

  test('full paint emits NO newline (a trailing \\n scrolls a full-height frame, duplicating the bottom line)', () => {
    // Regression: with the reserved NOW/FOCUS rhythm the frame fills the screen
    // exactly, so a "\r\n" after the last row scrolled the terminal up by one.
    writeFrame(['row one', 'row two', 'row three'], 20);
    const out = written.join('');
    assert.doesNotMatch(out, /\r?\n/, 'full paint must cursor-address rows, not newline-separate them');
    assert.match(out, /\x1b\[1;1H/, 'rows are absolutely positioned');
    assert.match(out, /\x1b\[3;1H/);
  });

  test('second frame rewrites only the changed row (cursor-addressed)', () => {
    writeFrame(['alpha', 'beta', 'gamma'], 20);
    written.length = 0;
    writeFrame(['alpha', 'BETA!', 'gamma'], 20); // only row 2 changed
    const out = written.join('');
    assert.match(out, /BETA!/);
    assert.doesNotMatch(out, /alpha/, 'unchanged rows are not rewritten');
    assert.doesNotMatch(out, /gamma/);
    assert.match(out, /\x1b\[2;1H/, 'cursor-addresses row 2');
  });

  test('an unchanged frame writes nothing but the cursor hide is skipped', () => {
    writeFrame(['x', 'y'], 20);
    written.length = 0;
    writeFrame(['x', 'y'], 20);
    assert.equal(written.join(''), '', 'no output when nothing changed');
  });

  test('a width change forces a clear + full repaint', () => {
    writeFrame(['x', 'y'], 20);
    written.length = 0;
    writeFrame(['x', 'y'], 40); // same content, wider
    const out = written.join('');
    assert.match(out, /\x1b\[2J/, 'clears the screen on resize');
  });

  test('resetFrameBuffer forces the next frame to full-paint', () => {
    writeFrame(['x', 'y'], 20);
    resetFrameBuffer();
    written.length = 0;
    writeFrame(['x', 'y'], 20);
    const out = written.join('');
    assert.match(out, /x/);
    assert.match(out, /y/);
  });
});
