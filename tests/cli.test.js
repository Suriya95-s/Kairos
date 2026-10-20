// tests/cli.test.js — CLI argument parsing & subcommand routing (no LLM needed).
// Exercises the early-exit paths (help + usage errors) via subprocess so we
// cover arg handling without starting an agent run.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'src', 'cli.js');

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: opts.cwd || repoRoot,
    encoding: 'utf-8',
    timeout: 20000,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

describe('cli help', () => {
  test('--help exits 0 and prints usage', () => {
    const r = runCli(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout + r.stderr, /agent/i);
  });

  test('no args prints help and exits 0', () => {
    const r = runCli([]);
    assert.equal(r.status, 0);
  });
});

describe('cli subcommand usage errors (exit 1, no side effects)', () => {
  // Each of these hits the missing-argument guard BEFORE any workspace write.
  for (const [args, needle] of [
    [['approve'], /agent approve/i],
    [['deny'], /agent deny/i],
    [['steer'], /agent steer/i],
    [['clarify'], /agent clarify/i],
  ]) {
    test(`\`agent ${args.join(' ')}\` with no value → exit 1`, () => {
      const r = runCli(args);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
      assert.match(r.stderr + r.stdout, needle);
    });
  }
});

describe('cli does not crash on trailing value-flags', () => {
  test('approve with an id and a trailing -w flag is handled (no TypeError)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
    // `approve <id>` writes a response under the workspace; point it at a temp dir.
    const r = runCli(['approve', 'some-id', '-w', tmp]);
    // It should not crash with a stack trace; exit 0 (writes a response) is fine.
    assert.ok(!/TypeError|is not a function|Cannot read/.test(r.stderr || ''),
      `unexpected crash in stderr: ${r.stderr}`);
    assert.equal(r.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
