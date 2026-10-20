// tests/tui-paste.test.js — F-3: file drop (bracketed paste → attachments) + F-2 chips.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractPastePaths } from '../apps/tui/src/keys.js';
import { state, setState } from '../apps/tui/src/state.js';
import { handleKey } from '../apps/tui/src/app.js';
import { renderCommandBar } from '../apps/tui/src/components/commandBar.js';
import { stripAnsi } from '../apps/tui/src/render.js';

describe('extractPastePaths', () => {
  test('single plain path', () => {
    assert.deepEqual(extractPastePaths('/home/u/file.js'), ['/home/u/file.js']);
  });
  test('double-quoted path with spaces', () => {
    assert.deepEqual(extractPastePaths('"/home/u/my file.js"'), ['/home/u/my file.js']);
  });
  test('backslash-escaped spaces', () => {
    assert.deepEqual(extractPastePaths('/home/u/my\\ file.js'), ['/home/u/my file.js']);
  });
  test('newline-separated multi-file drop', () => {
    assert.deepEqual(extractPastePaths('/a/x.js\n/a/y.js'), ['/a/x.js', '/a/y.js']);
  });
  test('empty / whitespace → []', () => {
    assert.deepEqual(extractPastePaths('   '), []);
    assert.deepEqual(extractPastePaths(''), []);
  });
});

describe('PASTE event → file attachments', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-'));
    setState({ attachments: [], cmdInputActive: false, cmdInput: '', view: 'live',
      denyInputActive: false, memSearchActive: false, settingsEditing: null, overlay: null, toast: null });
  });
  afterEach(() => {
    if (state._toastTimer) { clearTimeout(state._toastTimer); setState({ _toastTimer: null }); }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('dropping real files attaches them (name, bytes, content)', async () => {
    const f1 = path.join(dir, 'a.txt'); fs.writeFileSync(f1, 'hello');
    const f2 = path.join(dir, 'b.md');  fs.writeFileSync(f2, '# title');
    await handleKey({ key: 'PASTE', char: `${f1}\n${f2}` });
    assert.equal(state.attachments.length, 2);
    assert.equal(state.attachments[0].name, 'a.txt');
    assert.equal(state.attachments[0].content, 'hello');
    assert.equal(state.attachments[0].bytes, 5);
  });

  test('caps at 5 files', async () => {
    const paths = [];
    for (let i = 0; i < 8; i++) { const p = path.join(dir, `f${i}.txt`); fs.writeFileSync(p, String(i)); paths.push(p); }
    await handleKey({ key: 'PASTE', char: paths.join('\n') });
    assert.equal(state.attachments.length, 5);
  });

  test('truncates content over 64 KB and flags it', async () => {
    const big = path.join(dir, 'big.txt'); fs.writeFileSync(big, 'x'.repeat(100 * 1024));
    await handleKey({ key: 'PASTE', char: big });
    assert.equal(state.attachments[0].content.length, 64 * 1024);
    assert.equal(state.attachments[0].truncated, true);
  });

  test('a non-file paste drops into the command input as text', async () => {
    await handleKey({ key: 'PASTE', char: 'just some pasted text' });
    assert.equal(state.attachments.length, 0);
    assert.equal(state.cmdInputActive, true);
    assert.match(state.cmdInput, /just some pasted text/);
  });

  test('the same drop is not attached twice', async () => {
    const f = path.join(dir, 'dup.txt'); fs.writeFileSync(f, 'x');
    await handleKey({ key: 'PASTE', char: f });
    await handleKey({ key: 'PASTE', char: f });
    assert.equal(state.attachments.length, 1);
  });

  test('pasting into an open picker lands in its filter, not the command bar', async () => {
    setState({ pickerOpen: true, pickerKind: 'apiKey', pickerFilter: '', pickerIdx: 3,
      cmdInputActive: false, cmdInput: '' });
    await handleKey({ key: 'PASTE', char: 'sk-proj-abcd1234EFGH' });
    assert.equal(state.pickerFilter, 'sk-proj-abcd1234EFGH');
    assert.equal(state.pickerIdx, 0);              // cursor reset like typing
    assert.equal(state.cmdInputActive, false);     // did NOT leak to the command bar
    assert.equal(state.attachments.length, 0);     // not treated as a file drop
    setState({ pickerOpen: false, pickerFilter: '' });
  });
});

describe('attachment chips render in the command bar (F-2)', () => {
  test('chips show file names + sizes', () => {
    setState({ attachments: [{ path: '/x/a.js', name: 'a.js', bytes: 2300 }], cmdInputActive: false,
      view: 'live', overlay: null, denyInputActive: false, memSearchActive: false });
    const bar = renderCommandBar(80).map(stripAnsi).join('\n');
    assert.match(bar, /📎 a\.js/);
    assert.match(bar, /2\.2 KB/);
    assert.match(bar, /\[Enter\] send/);
  });
});
