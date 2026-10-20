// tests/eval-args.test.js — eval harness flag parsing (regression coverage).
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { getFlag, getIntFlag, positional } from '../eval/args.js';

describe('eval/args getFlag', () => {
  test('returns the value after the flag', () => {
    assert.equal(getFlag(['--workspace-dir', '/tmp/x'], '--workspace-dir', 'def'), '/tmp/x');
  });

  test('returns default when the flag is absent (the indexOf -1 bug)', () => {
    // Previously args[indexOf(-1)+1] === args[0] turned the positional file into
    // the flag value. The default must be returned instead.
    assert.equal(getFlag(['tasks.json'], '--workspace-dir', 'def'), 'def');
  });

  test('returns default when the flag is the last token (no value)', () => {
    assert.equal(getFlag(['tasks.json', '--workspace-dir'], '--workspace-dir', 'def'), 'def');
  });
});

describe('eval/args getIntFlag', () => {
  test('parses a valid integer', () => {
    assert.equal(getIntFlag(['--max', '5'], '--max', 0), 5);
  });

  test('falls back to default on non-numeric value (no NaN propagation)', () => {
    const v = getIntFlag(['--timeout-ms', 'abc'], '--timeout-ms', 300000, { min: 1 });
    assert.equal(v, 300000);
    assert.ok(Number.isFinite(v));
  });

  test('falls back to default when the flag is missing', () => {
    assert.equal(getIntFlag(['tasks.json'], '--timeout-ms', 300000, { min: 1 }), 300000);
  });

  test('enforces the minimum (0 timeout would fire instantly)', () => {
    assert.equal(getIntFlag(['--timeout-ms', '0'], '--timeout-ms', 300000, { min: 1 }), 300000);
  });
});

describe('eval/args positional', () => {
  test('returns the first non-flag argument', () => {
    assert.equal(positional(['--max', '5', 'instances.jsonl']), 'instances.jsonl');
  });
  test('returns null when only flags are present', () => {
    assert.equal(positional(['--max', '5']), null);
  });
});
