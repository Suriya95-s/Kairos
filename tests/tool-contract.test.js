// tests/tool-contract.test.js — Wave B structured tool contract.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWorkspace } from '../src/state.js';
import { ok, fail, isToolResult, renderForModel } from '../src/tools/utils/toolResult.js';
import { executeRegistryTool } from '../src/routing/toolRegistry.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  setWorkspace(dir);
});

describe('toolResult factories', () => {
  test('ok() builds a success result', () => {
    const r = ok('hello');
    assert.equal(r.ok, true);
    assert.equal(r.data, 'hello');
    assert.equal(r.stderr, '');
    assert.equal(r.exitCode, 0);
    assert.equal(r.dryRun, false);
  });

  test('fail() builds a failure result with exitCode 1 by default', () => {
    const r = fail('boom');
    assert.equal(r.ok, false);
    assert.equal(r.stderr, 'boom');
    assert.equal(r.exitCode, 1);
  });

  test('extra fields override defaults', () => {
    assert.equal(ok('x', { dryRun: true }).dryRun, true);
    assert.equal(fail('x', { exitCode: 137 }).exitCode, 137);
  });

  test('isToolResult discriminates structured vs legacy', () => {
    assert.equal(isToolResult(ok('x')), true);
    assert.equal(isToolResult(fail('x')), true);
    assert.equal(isToolResult('a bare string'), false);
    assert.equal(isToolResult(null), false);
    assert.equal(isToolResult(undefined), false);
    assert.equal(isToolResult({ data: 'no ok field' }), false);
  });
});

describe('renderForModel parity', () => {
  test('success renders data verbatim', () => {
    assert.equal(renderForModel(ok('exact text')), 'exact text');
  });
  test('empty success renders a placeholder', () => {
    assert.equal(renderForModel(ok('')), '(no output)');
  });
  test('failure renders stderr verbatim', () => {
    assert.equal(renderForModel(fail('EDIT_ERROR_STRING_NOT_FOUND: ...')), 'EDIT_ERROR_STRING_NOT_FOUND: ...');
  });
  test('a legacy bare string passes through unchanged', () => {
    assert.equal(renderForModel('legacy string'), 'legacy string');
  });
});

describe('registry dual-shape normalization', () => {
  test('structured ok → error:false and exposes .structured', () => {
    // write_file is migrated in Batch 1; assert the structured field is present.
    const r = executeRegistryTool('write_file', { path: 'a.txt', content: 'hi' });
    assert.equal(r.error, false);
    assert.ok(isToolResult(r.structured), 'structured result attached');
    assert.equal(r.structured.ok, true);
    assert.match(r.result, /File written/);
  });

  test('structured fail → error:true derived from ok (not sniffing)', () => {
    const r = executeRegistryTool('edit_file', { path: 'missing.txt', oldString: 'a', newString: 'b' });
    assert.equal(r.error, true);
    assert.equal(r.structured.ok, false);
  });

  test('run_command carries a real exitCode on the structured result', () => {
    const r = executeRegistryTool('run_command', { command: 'node -e "process.exit(3)"' });
    assert.equal(r.error, true);
    assert.equal(r.structured.exitCode, 3);
  });
});

describe('dryRun previews without side effects', () => {
  test('write_file dryRun does not create the file', () => {
    const r = executeRegistryTool('write_file', { path: 'preview.txt', content: 'hello', dryRun: true });
    assert.equal(r.error, false);
    assert.equal(r.structured.dryRun, true);
    assert.match(r.result, /\[dry-run\]/);
    assert.equal(fs.existsSync(path.join(dir, 'preview.txt')), false);
  });

  test('edit_file dryRun leaves the file unchanged and shows a diff', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x = 1\n');
    const r = executeRegistryTool('edit_file', { path: 'a.txt', oldString: 'x = 1', newString: 'x = 2', dryRun: true });
    assert.equal(r.error, false);
    assert.equal(r.structured.dryRun, true);
    assert.match(r.result, /- x = 1/);
    assert.match(r.result, /\+ x = 2/);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8'), 'x = 1\n');
  });

  test('delete_path dryRun does not delete', () => {
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'data');
    const r = executeRegistryTool('delete_path', { path: 'keep.txt', dryRun: true });
    assert.equal(r.error, false);
    assert.equal(fs.existsSync(path.join(dir, 'keep.txt')), true);
  });

  test('run_command dryRun does not execute', () => {
    const r = executeRegistryTool('run_command', { command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'1\')"', dryRun: true });
    assert.equal(r.error, false);
    assert.match(r.result, /\[dry-run\] would run/);
    assert.equal(fs.existsSync(path.join(dir, 'ran.txt')), false);
  });
});

describe('tool polish (Wave B)', () => {
  test('search_files skips node_modules', () => {
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'const NEEDLE = 1;');
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'const NEEDLE = 2;');
    const r = executeRegistryTool('search_files', { pattern: 'NEEDLE', filePattern: '**/*.js' });
    assert.equal(r.error, false);
    assert.doesNotMatch(r.result, /node_modules/);
    assert.match(r.result, /src\/app\.js/);
  });

  test('run_command timeout is flagged with exitCode 124 (spawnSync path)', () => {
    const r = executeRegistryTool('run_command', { command: 'node -e "setInterval(()=>{},1000)"', timeout: 500 });
    assert.equal(r.error, true);
    assert.equal(r.structured.exitCode, 124);
    assert.match(r.result, /timed out/);
  });
});
