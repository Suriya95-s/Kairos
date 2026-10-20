// tests/reflex-benchmark.test.js
// The benchmark that measures the P4 acceptance criterion needs its own tests,
// for a specific reason: a benchmark that reports a pass when it should report a
// failure is worse than having no benchmark, because it actively creates
// confidence. So what is tested here is mostly the *gate*, not the numbers.
//
// The one thing deliberately not asserted is a latency figure. Test machines
// vary, CI is slower than a laptop, and a test that fails because a shared
// runner was busy teaches people to ignore it.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BENCH = fileURLToPath(new URL('../eval/reflex-benchmark.js', import.meta.url));
const REPO = fileURLToPath(new URL('../', import.meta.url));

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-bench-'));
  process.env.KAIROS_HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

/** Run the benchmark as a real process and capture its verdict + exit code. */
function runBench(extraArgs = [], { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BENCH, ...extraArgs], {
      cwd: REPO,
      env: { ...process.env, KAIROS_HOME: tmpHome, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    // 'close', not 'exit': exit fires before the stdio streams have flushed,
    // so assertions on stdout were racing the output and seeing it truncated.
    let exitCode = null;
    child.on('exit', (c) => { exitCode = c; });
    child.on('close', () => resolve({ code: exitCode, stdout, stderr }));
  });
}

function parseJson(stdout) {
  const i = stdout.indexOf('{');
  assert.ok(i >= 0, 'expected JSON in the output');
  return JSON.parse(stdout.slice(i));
}

describe('the benchmark runs without a model', () => {
  test('the offline half measures accuracy and overhead', async () => {
    // This is the part that can gate CI. It must not need an endpoint.
    const { code, stdout } = await runBench(['--offline-only', '--runs', '3', '--json']);
    const r = parseJson(stdout);

    assert.equal(code, 0);
    assert.equal(r.router.cases >= 100, true, 'the fixture set is the exam');
    assert.equal(r.router.accuracy, 1);
    assert.ok(r.router.classify.p50 >= 0);
    assert.ok(r.router.dispatchOverhead.p50 >= 0);
  });

  test('percentiles are reported, not just a mean', async () => {
    // The AC names p50, and a mean is dragged around by one slow outlier —
    // which is exactly what a retry looks like.
    const { stdout } = await runBench(['--offline-only', '--runs', '3', '--json']);
    const r = parseJson(stdout);
    for (const k of ['p50', 'p95', 'p99', 'min', 'max', 'mean', 'n']) {
      assert.ok(k in r.router.dispatchOverhead, `missing ${k}`);
    }
  });

  test('ordering holds: min ≤ p50 ≤ p95 ≤ max', async () => {
    const { stdout } = await runBench(['--offline-only', '--runs', '5', '--json']);
    const s = parseJson(stdout).router.dispatchOverhead;
    assert.ok(s.min <= s.p50 && s.p50 <= s.p95 && s.p95 <= s.max,
      `percentiles out of order: ${JSON.stringify(s)}`);
  });
});

describe('an unmeasured criterion is reported as unmeasured', () => {
  test('no reachable model → SKIPPED, verdict partial, exit 0', async () => {
    // The important judgement in the whole file. "Not measured" is not
    // "failed" — a build that breaks because no GPU is attached gets the gate
    // deleted. But it is also not "passed", and saying so would be the more
    // damaging lie.
    const { code, stdout } = await runBench(['--runs', '2', '--json'], {
      // Somewhere nothing is listening.
      env: { AGENT_BASE_URL: 'http://127.0.0.1:1/v1' },
    });
    const r = parseJson(stdout);

    assert.equal(code, 0, 'a skipped measurement must not fail a build');
    assert.equal(r.verdict, 'partial');
    assert.ok(r.reflex.skipped, 'and it must say it was skipped');
  });

  test('the skip reason names what was unreachable', async () => {
    const { stdout } = await runBench(['--runs', '2', '--probe-ms', '300'], {
      env: { AGENT_BASE_URL: 'http://127.0.0.1:1/v1' },
    });
    assert.match(stdout, /127\.0\.0\.1:1/);
  });

  test('--offline-only skips without even probing', async () => {
    const { stdout } = await runBench(['--offline-only', '--runs', '2', '--json']);
    assert.equal(parseJson(stdout).reflex.skipped, 'offline-only');
  });
});

describe('the gate fires when a criterion is violated', () => {
  test('overhead above 5% of the budget fails, with a specific message', async () => {
    // Verified by shrinking the budget rather than by slowing the code: the
    // ratio is what the check is about.
    const { code, stdout } = await runBench(['--offline-only', '--runs', '5', '--budget-ms', '10']);
    assert.equal(code, 1, 'a real violation must fail the build');
    assert.match(stdout, /FAILED/);
    assert.match(stdout, /dispatch overhead p50 .*is >5% of the 10ms budget/);
  });

  test('a passing run says PASSED and exits 0', async () => {
    const { code, stdout } = await runBench(['--offline-only', '--runs', '3']);
    assert.equal(code, 0);
    assert.match(stdout, /PASSED/);
  });

  test('violations are listed in the JSON, not only in the prose', async () => {
    // So this can be consumed by the P6 watcher as well as read by a person.
    const { stdout } = await runBench(['--offline-only', '--runs', '5', '--budget-ms', '10', '--json']);
    const r = parseJson(stdout);
    assert.equal(r.verdict, 'failed');
    assert.equal(r.violations.length >= 1, true);
  });
});

describe('the accuracy floor is the AC, not a vibe', () => {
  test('a broken classifier fails the 90% floor', async () => {
    // Copy the repo's classifier aside, break it, run, restore. A source-level
    // break is the only honest way to prove the floor is load-bearing.
    const target = path.join(REPO, 'src', 'router', 'classify.js');
    const backup = fs.readFileSync(target, 'utf-8');
    const marker = '  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);';
    assert.ok(backup.includes(marker), 'the break target must still exist in the source');

    try {
      // Two entries, not one. A single-element array makes `ranked[1][1]`
      // throw, and the benchmark would exit 1 from a CRASH rather than from the
      // gate — which looks identical from the outside and proves nothing.
      fs.writeFileSync(target, backup.replace(marker,
        "  const ranked = [['clarify', 9], ['reflex', 0]];"));
      const { code, stdout } = await runBench(['--offline-only', '--runs', '2']);
      assert.match(stdout, /below the 90% bar/, 'the gate must be what fails, not a crash');
      assert.match(stdout, /FAILED/);
      assert.equal(code, 1, 'a classifier that answers "clarify" to everything must fail');
    } finally {
      fs.writeFileSync(target, backup);
    }
  });

  test('and the repo currently passes it', async () => {
    const { stdout } = await runBench(['--offline-only', '--runs', '2', '--json']);
    assert.ok(parseJson(stdout).router.accuracy >= 0.9);
  });
});

describe('flag handling', () => {
  test('--runs and --budget-ms are honoured', async () => {
    const { stdout } = await runBench(['--offline-only', '--runs', '7', '--budget-ms', '3000', '--json']);
    const r = parseJson(stdout);
    assert.equal(r.runs, 7);
    assert.equal(r.budgetMs, 3000);
    assert.equal(r.router.dispatchOverhead.n, 7);
  });

  test('warm-up runs are excluded from the sample', async () => {
    // Including the first call would make the figure a measurement of module
    // loading and TCP setup rather than of the reflex.
    const { stdout } = await runBench(['--offline-only', '--runs', '4', '--warmup', '3', '--json']);
    assert.equal(parseJson(stdout).router.dispatchOverhead.n, 4);
  });

  test('a nonsense flag value falls back to the default rather than NaN', async () => {
    const { code, stdout } = await runBench(['--offline-only', '--runs', 'abc', '--json']);
    assert.equal(code, 0);
    assert.equal(parseJson(stdout).runs, 20, 'the documented default');
  });
});
