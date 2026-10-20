// src/selfimprove/metrics.js
// The agent watches itself (9.2 / 9.4).
//
// The Phase 9 acceptance criterion is unusually blunt about what counts:
//
//   month-over-month: guard-fire rate down, reflex accuracy up, cost per
//   mission down — measured by 9.2, **not vibes**.
//
// So this module does two things and refuses a third. It **collects** the
// numbers from the records the system already keeps, and it **compares** two
// periods to say whether they moved the right way. What it does not do is
// judge: there is no "health score", no letter grade, nothing that compresses
// four independent trends into one number that can look fine while one of them
// rots.
//
// A trend also needs a floor before it means anything. Three missions in a week
// is not a sample, and "cost per mission down 40%" across two weeks of two
// missions each is noise being reported as progress. Every comparison carries
// its sample size, and thin samples say so instead of pretending.

import { measureRouter } from './router-training.js';

/** The metrics the AC names, plus the ones needed to interpret them. */
export const TRACKED = Object.freeze([
  'missions', 'missionSuccessRate', 'costPerMission', 'guardFireRate',
  'routerAccuracy', 'llmFallbackRate', 'memoryFacts', 'irreversibleActions',
]);

/** Which direction is good. Reported alongside, never assumed by the caller. */
export const DIRECTION = Object.freeze({
  missions: 'neutral',
  missionSuccessRate: 'up',
  costPerMission: 'down',
  guardFireRate: 'down',
  routerAccuracy: 'up',
  llmFallbackRate: 'down',
  memoryFacts: 'neutral',
  irreversibleActions: 'neutral',
});

/** Below this many missions, a period is reported but not compared. */
export const MIN_SAMPLE = 5;

/**
 * Collect one period's numbers from the records the system already keeps.
 *
 * Everything is read from existing sources — the mission registry, the audit
 * ledger, the router log, the memory store. Nothing new is instrumented,
 * because a metric with its own collection path is a metric that drifts from
 * the thing it claims to measure.
 *
 * @param {object} sources  {missions, ledger, memory, routerDir}
 * @param {object} window   {from, to}
 */
export function collect({ missions = null, ledger = null, memory = null, routerDir = null } = {}, { from = 0, to = Date.now() } = {}) {
  const period = { from, to };

  // ── Missions ──────────────────────────────────────────────────
  const all = (missions?.list?.() || []).filter(m => m.endedAt && m.endedAt >= from && m.endedAt < to);
  const done = all.filter(m => m.state === 'done');
  const costs = all.map(m => Number(m.result?.costUsd) || 0);
  const totalCost = costs.reduce((a, b) => a + b, 0);

  // Guard fires: the anti-stall arsenal firing is the system failing to make
  // progress on its own. A rising rate means it is getting stuck more often,
  // whatever the success rate says.
  const guardFires = all.reduce((n, m) => n + countGuardFires(m), 0);
  const totalSteps = all.reduce((n, m) => n + (m.lastStep || 0), 0);

  // ── Actuation ─────────────────────────────────────────────────
  const actions = (ledger?.read?.({ since: from }) || []).filter(e => e.ts < to && e.tool !== '__undo__');

  // ── Router ────────────────────────────────────────────────────
  let router = { accuracy: null, judged: 0, llmFallbackRate: 0 };
  if (routerDir !== undefined) {
    try {
      const r = measureRouter({ dir: routerDir, since: from });
      router = { accuracy: r.accuracy, judged: r.judged, llmFallbackRate: r.llmFallbackRate };
    } catch { /* no router log yet */ }
  }

  return {
    period,
    missions: all.length,
    missionSuccessRate: all.length ? round(done.length / all.length) : null,
    costUsd: round(totalCost, 4),
    costPerMission: all.length ? round(totalCost / all.length, 4) : null,
    guardFires,
    guardFireRate: totalSteps ? round(guardFires / totalSteps, 4) : null,
    totalSteps,
    routerAccuracy: router.accuracy,
    routerJudged: router.judged,
    llmFallbackRate: router.llmFallbackRate,
    memoryFacts: memory?.stats?.().total ?? null,
    actions: actions.length,
    irreversibleActions: actions.filter(a => a.irreversible && a.outcome === 'ok').length,
    refusedActions: actions.filter(a => a.outcome === 'refused').length,
    exitReasons: tally(all.map(m => m.exitReason || m.state)),
  };
}

/**
 * Compare two collected periods.
 *
 * Returns a verdict per metric — `better`, `worse`, `flat`, or
 * `insufficient-data`. The last one is load-bearing: it is the honest answer
 * far more often than people expect, and reporting a direction from four data
 * points is how a self-improvement loop convinces itself it is working.
 */
export function compare(previous, current, { minSample = MIN_SAMPLE } = {}) {
  const thin = (current?.missions ?? 0) < minSample || (previous?.missions ?? 0) < minSample;
  const out = {};

  for (const key of TRACKED) {
    const a = previous?.[key];
    const b = current?.[key];
    const direction = DIRECTION[key];

    if (a == null || b == null) { out[key] = { verdict: 'insufficient-data', reason: 'not measured in both periods' }; continue; }
    if (thin && direction !== 'neutral') {
      out[key] = {
        verdict: 'insufficient-data', previous: a, current: b,
        reason: `fewer than ${minSample} missions in a period — a direction here would be noise`,
      };
      continue;
    }

    const delta = round(b - a, 4);
    // A 1% wobble is not a trend. Requiring a visible move keeps the report
    // from declaring victory every week by rounding.
    const magnitude = Math.abs(a) > 0 ? Math.abs(delta / a) : (delta === 0 ? 0 : 1);
    if (direction === 'neutral' || magnitude < 0.05) {
      out[key] = { verdict: 'flat', previous: a, current: b, delta };
      continue;
    }
    const improved = direction === 'up' ? delta > 0 : delta < 0;
    out[key] = { verdict: improved ? 'better' : 'worse', previous: a, current: b, delta };
  }

  return {
    verdicts: out,
    sampleWarning: thin ? `sample too small to compare (${previous?.missions ?? 0} → ${current?.missions ?? 0} missions)` : null,
    // The AC's three, called out so a regression in one cannot hide behind
    // improvement in the others.
    headline: {
      guardFireRate: out.guardFireRate?.verdict ?? 'insufficient-data',
      routerAccuracy: out.routerAccuracy?.verdict ?? 'insufficient-data',
      costPerMission: out.costPerMission?.verdict ?? 'insufficient-data',
    },
  };
}

/**
 * Anything that got worse, for the P6 watcher to alarm on.
 * Returns [] when nothing regressed — including when there is not enough data,
 * because "we do not know" is not a regression.
 */
export function regressions(comparison) {
  return Object.entries(comparison.verdicts)
    .filter(([, v]) => v.verdict === 'worse')
    .map(([metric, v]) => ({
      metric,
      previous: v.previous,
      current: v.current,
      delta: v.delta,
      direction: DIRECTION[metric],
    }));
}

/**
 * The weekly digest (9.4), as prose rather than a dashboard.
 *
 * A digest nobody reads is worse than no digest, so this leads with what
 * changed and what needs a decision, and puts the raw counts last.
 */
export function renderDigest(current, comparison = null, { periodName = 'this week' } = {}) {
  const lines = [];
  lines.push(`Kairos, ${periodName}:`);
  lines.push('');

  if (!current.missions) {
    lines.push('No missions ran. Nothing to report.');
    return lines.join('\n');
  }

  const pct = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
  lines.push(`${current.missions} mission${current.missions === 1 ? '' : 's'}, ` +
    `${pct(current.missionSuccessRate)} completed, $${(current.costUsd ?? 0).toFixed(2)} total.`);

  if (current.irreversibleActions) {
    // Surfaced prominently and always: an irreversible action is the thing a
    // person most wants to know happened, and burying it under counts is how
    // a digest becomes something to skim.
    lines.push(`${current.irreversibleActions} irreversible action${current.irreversibleActions === 1 ? '' : 's'} were taken.`);
  }
  if (current.refusedActions) {
    lines.push(`${current.refusedActions} action${current.refusedActions === 1 ? ' was' : 's were'} refused at the gate.`);
  }

  if (comparison) {
    const worse = regressions(comparison);
    lines.push('');
    if (comparison.sampleWarning) {
      lines.push(`Trends: ${comparison.sampleWarning}.`);
    } else if (worse.length) {
      lines.push('Getting worse:');
      for (const r of worse) lines.push(`- ${humanMetric(r.metric)}: ${fmt(r.previous)} → ${fmt(r.current)}`);
    } else {
      const better = Object.entries(comparison.verdicts).filter(([, v]) => v.verdict === 'better');
      lines.push(better.length
        ? `Improving: ${better.map(([m]) => humanMetric(m)).join(', ')}.`
        : 'Steady — nothing moved much either way.');
    }
  }

  const stalls = Object.entries(current.exitReasons || {})
    .filter(([r]) => r !== 'completed')
    .sort((a, b) => b[1] - a[1]);
  if (stalls.length) {
    lines.push('');
    lines.push(`Unfinished: ${stalls.map(([r, n]) => `${n} ${r}`).join(', ')}.`);
  }

  return lines.join('\n');
}

// ── helpers ─────────────────────────────────────────────────────────────────

function countGuardFires(mission) {
  // Guards are recorded by the loop in its result. Absent on older records,
  // which is why this is defensive rather than assuming a shape.
  const g = mission?.result?.guardFires ?? mission?.result?.recoveryEvents;
  if (typeof g === 'number') return g;
  if (Array.isArray(g)) return g.length;
  return 0;
}

function tally(values) {
  const out = {};
  for (const v of values) { if (v) out[v] = (out[v] || 0) + 1; }
  return out;
}

function round(n, dp = 3) {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
}

function humanMetric(key) {
  return {
    guardFireRate: 'guard fires per step',
    routerAccuracy: 'router accuracy',
    costPerMission: 'cost per mission',
    missionSuccessRate: 'mission success rate',
    llmFallbackRate: 'router falling back to the model',
    irreversibleActions: 'irreversible actions',
    memoryFacts: 'memory size',
    missions: 'missions run',
  }[key] || key;
}

function fmt(v) {
  if (v == null) return 'n/a';
  if (v < 1 && v > 0) return v.toFixed(3);
  return String(v);
}
