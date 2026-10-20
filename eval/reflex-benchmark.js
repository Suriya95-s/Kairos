#!/usr/bin/env node
// eval/reflex-benchmark.js
// The P4 acceptance criterion, measured: "p50 reflex latency < 2s".
//
// Two halves, deliberately separated, because one of them needs a model and the
// other does not:
//
//   OFFLINE  router classification — accuracy against the fixture set, and the
//            latency of the deterministic pass. Runs anywhere, always.
//   ONLINE   the reflex end to end, against whatever model is configured.
//            Skipped honestly when no endpoint answers.
//
// The separation matters because the offline half is a regression gate that can
// run in CI, and the online half cannot. Merging them would mean either CI
// needs a GPU or the gate gets deleted.
//
// Design notes worth stating, since a benchmark that lies is worse than none:
//
//   * **p50, not mean.** The AC says p50, and a mean is dragged around by one
//     slow outlier — which is exactly what a retry looks like.
//   * **Warm-up runs are excluded.** The first call pays module loading, a TCP
//     handshake and often a model load; including it makes the figure a
//     measurement of startup.
//   * **The kernel's own cost is reported separately** from the model's, so a
//     regression can be attributed rather than guessed at.
//   * **Exit code 1 when the AC is violated**, so this can gate a release. It
//     exits 0 when the online half is skipped: "not measured" is not "failed".
//
// Usage:
//   node eval/reflex-benchmark.js                  both halves
//   node eval/reflex-benchmark.js --offline-only   no model needed
//   node eval/reflex-benchmark.js --runs 40 --budget-ms 2000
//   node eval/reflex-benchmark.js --json

import { getFlag, getIntFlag } from './args.js';

const args = process.argv.slice(2);
const RUNS       = getIntFlag(args, '--runs', 20, { min: 1 });
const WARMUP     = getIntFlag(args, '--warmup', 2, { min: 0 });
const BUDGET_MS  = getIntFlag(args, '--budget-ms', 2000, { min: 1 });
const OFFLINE    = args.includes('--offline-only');
const AS_JSON    = args.includes('--json');
const PROBE_MS   = getIntFlag(args, '--probe-ms', 4000, { min: 100 });

/** Utterances that should reach the reflex — questions and chat, not jobs. */
const REFLEX_PROMPTS = [
  'what is a monad?',
  'why does JavaScript have both null and undefined?',
  'what is the difference between fork and spawn?',
  'should I use a queue here or just retry?',
  'explain what a write-ahead log is for',
  'thanks, that worked',
  'is Postgres a good fit for time series data?',
  'what does ECONNREFUSED usually mean?',
];

// ── reporting ───────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (!sorted.length) return null;
  // Nearest-rank on a 0-indexed array. For p50 of an even count this takes the
  // upper of the two middles, which is the conservative direction for a latency
  // budget.
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function stats(samples) {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: round(s[0]),
    p50: round(percentile(s, 50)),
    p95: round(percentile(s, 95)),
    p99: round(percentile(s, 99)),
    max: round(s[s.length - 1]),
    mean: round(sum / s.length),
  };
}

const round = (n) => Math.round(Number(n) * 100) / 100;
const out = (s) => { if (!AS_JSON) process.stdout.write(s + '\n'); };

function line(label, st, unit = 'ms') {
  if (!st) { out(`  ${label.padEnd(26)} no samples`); return; }
  out(`  ${label.padEnd(26)} p50 ${String(st.p50).padStart(8)}${unit}` +
      `   p95 ${String(st.p95).padStart(8)}${unit}` +
      `   max ${String(st.max).padStart(8)}${unit}   (n=${st.n})`);
}

// ── offline: the router ─────────────────────────────────────────────────────

async function benchmarkRouter() {
  const { classify } = await import('../src/router/classify.js');
  const { dispatch } = await import('../src/router/dispatch.js');
  const { ROUTER_CASES, CONTEXTUAL_CASES } = await import('../tests/fixtures/router-cases.js');

  // Accuracy against the fixed set. This is the number the P4 AC names (≥90%),
  // and it is measurable without any model at all.
  const failures = [];
  for (const c of ROUTER_CASES) {
    const got = classify(c.text);
    if (got.intent !== c.intent) failures.push({ text: c.text, want: c.intent, got: got.intent });
  }
  for (const c of CONTEXTUAL_CASES) {
    const got = classify(c.text, c.context);
    if (got.intent !== c.intent) failures.push({ text: c.text, want: c.intent, got: got.intent, context: c.context });
  }
  const total = ROUTER_CASES.length + CONTEXTUAL_CASES.length;
  const accuracy = (total - failures.length) / total;

  // Classification latency.
  const classifyMs = [];
  for (let i = 0; i < WARMUP * 10; i++) classify(REFLEX_PROMPTS[i % REFLEX_PROMPTS.length]);
  for (let i = 0; i < RUNS * 10; i++) {
    const t = process.hrtime.bigint();
    classify(REFLEX_PROMPTS[i % REFLEX_PROMPTS.length]);
    classifyMs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }

  // Full dispatch with the model stubbed out — this is the kernel's own cost,
  // the part a model can never explain away.
  const stub = async () => ({ text: 'stub', latencyMs: 0 });
  const dispatchMs = [];
  const deps = {
    sessionId: 'bench',
    workspace: process.cwd(),
    runReflex: stub,
    startMission: async () => ({ id: 'm-bench' }),
    controlMission: async () => {},
    steerMission: async () => {},
  };
  for (let i = 0; i < WARMUP; i++) await dispatch(REFLEX_PROMPTS[0], deps);
  for (let i = 0; i < RUNS; i++) {
    const t = process.hrtime.bigint();
    await dispatch(REFLEX_PROMPTS[i % REFLEX_PROMPTS.length], deps);
    dispatchMs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }

  return {
    accuracy: round(accuracy * 100) / 100,
    cases: total,
    failures,
    classify: stats(classifyMs),
    dispatchOverhead: stats(dispatchMs),
  };
}

// ── online: the reflex ──────────────────────────────────────────────────────

/** Is a model actually reachable? Cheap, bounded, and honest about the answer. */
async function probeModel() {
  const { default: config } = await import('../src/config.js');
  const base = String(config.baseURL || '').replace(/\/+$/, '');
  if (!base) return { ok: false, reason: 'no baseURL configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_MS);
  try {
    const res = await fetch(`${base}/models`, {
      signal: controller.signal,
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    });
    // 401 means the endpoint is up and the credential is wrong — a different
    // problem from "nothing is listening", and worth saying so.
    if (res.status === 401) return { ok: false, reason: `${base} rejected the credential (401)` };
    if (res.status >= 500) return { ok: false, reason: `${base} returned ${res.status}` };
    return { ok: true, base, model: config.cheapModel || config.model };
  } catch (err) {
    return { ok: false, reason: `${base} unreachable (${err?.name === 'AbortError' ? `no answer in ${PROBE_MS}ms` : err.message})` };
  } finally {
    clearTimeout(timer);
  }
}

async function benchmarkReflex() {
  const { reflex } = await import('../src/reflex/engine.js');
  const samples = [];
  const firstToken = [];
  const outcomes = { answered: 0, escalated: 0, degraded: 0, truncated: 0 };

  const run = async (prompt) => {
    let firstAt = null;
    const t0 = process.hrtime.bigint();
    const r = await reflex(prompt, {
      workspace: process.cwd(),
      // A generous budget: the point is to MEASURE latency, not to enforce it.
      // Leaving the 8s default would truncate slow answers and quietly turn a
      // latency measurement into a truncation-rate measurement.
      latencyBudgetMs: Math.max(BUDGET_MS * 10, 30_000),
      onToken: () => { if (firstAt == null) firstAt = process.hrtime.bigint(); },
    });
    const total = Number(process.hrtime.bigint() - t0) / 1e6;
    return { total, ttft: firstAt ? Number(firstAt - t0) / 1e6 : null, r };
  };

  for (let i = 0; i < WARMUP; i++) {
    try { await run(REFLEX_PROMPTS[i % REFLEX_PROMPTS.length]); } catch { /* warm-up failures are not data */ }
  }

  for (let i = 0; i < RUNS; i++) {
    const prompt = REFLEX_PROMPTS[i % REFLEX_PROMPTS.length];
    try {
      const { total, ttft, r } = await run(prompt);
      samples.push(total);
      if (ttft != null) firstToken.push(ttft);
      if (r.escalation?.proposed) outcomes.escalated++;
      else if (r.degraded) outcomes.degraded++;
      else outcomes.answered++;
      if (r.truncated) outcomes.truncated++;
    } catch (err) {
      // A thrown reflex is a failure of the thing being measured, so it counts
      // as a degraded outcome rather than being dropped from the sample.
      outcomes.degraded++;
      if (!AS_JSON) out(`  ! ${prompt.slice(0, 40)} — ${err.message}`);
    }
  }

  return { total: stats(samples), firstToken: stats(firstToken), outcomes };
}

// ── main ────────────────────────────────────────────────────────────────────

const report = { at: new Date().toISOString(), runs: RUNS, budgetMs: BUDGET_MS };
let violations = [];

out('');
out('Reflex benchmark');
out('════════════════');
out('');

// ── offline
out('Router (no model required)');
const router = await benchmarkRouter();
report.router = router;

out(`  fixture accuracy           ${(router.accuracy * 100).toFixed(1)}%  (${router.cases} cases, ${router.failures.length} wrong)`);
for (const f of router.failures.slice(0, 8)) {
  out(`    want=${f.want.padEnd(9)} got=${f.got.padEnd(9)} ${f.text.slice(0, 52)}`);
}
line('classify()', router.classify);
line('dispatch overhead', router.dispatchOverhead);

// The P4 AC's accuracy floor.
if (router.accuracy < 0.90) {
  violations.push(`router accuracy ${(router.accuracy * 100).toFixed(1)}% is below the 90% bar`);
}
// The kernel must not be a meaningful part of the latency budget. 5% is a
// generous ceiling — it has been measuring ~0.1%.
const overheadShare = router.dispatchOverhead ? router.dispatchOverhead.p50 / BUDGET_MS : 0;
if (overheadShare > 0.05) {
  violations.push(`dispatch overhead p50 ${router.dispatchOverhead.p50}ms is >5% of the ${BUDGET_MS}ms budget`);
}

out('');

// ── online
if (OFFLINE) {
  out('Reflex end-to-end            skipped (--offline-only)');
  report.reflex = { skipped: 'offline-only' };
} else {
  const probe = await probeModel();
  if (!probe.ok) {
    // Not a failure. An unmeasured criterion is an unmeasured criterion, and
    // reporting it as a pass would be the more damaging lie.
    out('Reflex end-to-end            SKIPPED — no model reachable');
    out(`  ${probe.reason}`);
    out('');
    out('  The p50 < 2s criterion is therefore NOT verified by this run.');
    out('  Start a local model and re-run to measure it.');
    report.reflex = { skipped: probe.reason };
  } else {
    out(`Reflex end-to-end (${probe.model} @ ${probe.base})`);
    const reflexStats = await benchmarkReflex();
    report.reflex = reflexStats;

    line('total', reflexStats.total);
    if (reflexStats.firstToken) line('time to first token', reflexStats.firstToken);
    out(`  outcomes                   ${reflexStats.outcomes.answered} answered, ` +
        `${reflexStats.outcomes.escalated} escalated, ${reflexStats.outcomes.degraded} degraded`);

    if (reflexStats.total) {
      const modelShare = reflexStats.total.p50 - (router.dispatchOverhead?.p50 ?? 0);
      out(`  attribution                kernel ${router.dispatchOverhead?.p50 ?? 0}ms + model ~${round(modelShare)}ms`);

      if (reflexStats.total.p50 > BUDGET_MS) {
        violations.push(`reflex p50 ${reflexStats.total.p50}ms exceeds the ${BUDGET_MS}ms budget`);
      }
    }
  }
}

out('');
out('────────────────');
if (violations.length) {
  out('FAILED');
  for (const v of violations) out(`  ✗ ${v}`);
} else if (report.reflex?.skipped) {
  out('PASSED (partial) — the offline criteria hold; the latency criterion was not measured');
} else {
  out('PASSED — every measured criterion holds');
}
out('');

report.violations = violations;
report.verdict = violations.length ? 'failed' : (report.reflex?.skipped ? 'partial' : 'passed');
if (AS_JSON) process.stdout.write(JSON.stringify(report, null, 2) + '\n');

// Exit non-zero only on a real violation. A skipped measurement must not fail a
// build — that is how a gate gets removed for being noisy.
process.exit(violations.length ? 1 : 0);
