// tests/brain-neuromodulator.test.js
// B1 — the neuromodulator.
//
// The load-bearing test in this file is "the safety line": a maximal-arousal,
// zero-confidence, full-load state must leave every gate in IMMUTABLE_KEYS
// exactly where it found it. Everything else here is dial arithmetic; that one
// is the reason the module is allowed to exist.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  readState, modulate, pickTier, gatesIntact, describeState,
  DIALS, MODULABLE_KEYS, IMMUTABLE_KEYS, NEUTRAL_STATE,
  VOICE_AROUSAL_WINDOW_MS, MIN_LATENCY_BUDGET_MS,
} from '../src/brain/neuromodulator.js';

const inRange = (n, label) => {
  assert.ok(Number.isFinite(n), `${label} must be a number, got ${n}`);
  assert.ok(n >= 0 && n <= 1, `${label} must be within 0..1, got ${n}`);
};

// ── readState ────────────────────────────────────────────────────────────────

describe('readState — shape and bounds', () => {
  test('always returns all three dials inside 0..1', () => {
    const state = readState();
    for (const dial of DIALS) inRange(state[dial], dial);
  });

  test('absurd inputs are clamped, not propagated', () => {
    const state = readState({
      runningMissions: 9999, maxConcurrentMissions: 1, spendRatio: 42,
    });
    for (const dial of DIALS) inRange(state[dial], dial);
    assert.equal(state.load, 1);
  });

  test('non-numeric spend does not produce NaN', () => {
    const state = readState({ spendRatio: Number.NaN, runningMissions: 0 });
    assert.equal(state.load, 0);
  });
});

describe('readState — arousal', () => {
  test('presence orders arousal: active > idle > busy > away', () => {
    const a = readState({ userState: 'active' }).arousal;
    const i = readState({ userState: 'idle' }).arousal;
    const b = readState({ userState: 'busy' }).arousal;
    const w = readState({ userState: 'away' }).arousal;
    assert.ok(a > i, `active (${a}) must exceed idle (${i})`);
    assert.ok(i > b, `idle (${i}) must exceed busy (${b})`);
    assert.ok(b > w, `busy (${b}) must exceed away (${w})`);
  });

  test('an unknown user state falls back to idle rather than 0', () => {
    assert.equal(readState({ userState: 'kaleidoscope' }).arousal, readState({ userState: 'idle' }).arousal);
  });

  test('a fresh verified wake word raises arousal above an attached socket', () => {
    const now = 1_000_000;
    const socketOnly = readState({ userState: 'active', now });
    const justSpoke = readState({ userState: 'active', lastVerifiedVoiceAt: now - 1_000, now });
    assert.ok(justSpoke.arousal > socketOnly.arousal,
      `speaking (${justSpoke.arousal}) must beat merely being attached (${socketOnly.arousal})`);
  });

  test('voice arousal decays over the window and expires past it', () => {
    const now = 1_000_000;
    const fresh = readState({ userState: 'away', lastVerifiedVoiceAt: now - 1_000, now }).arousal;
    const half = readState({ userState: 'away', lastVerifiedVoiceAt: now - VOICE_AROUSAL_WINDOW_MS / 2, now }).arousal;
    const expired = readState({ userState: 'away', lastVerifiedVoiceAt: now - VOICE_AROUSAL_WINDOW_MS - 1, now }).arousal;
    assert.ok(fresh > half, `fresh (${fresh}) must exceed half-decayed (${half})`);
    assert.ok(half > expired, `half-decayed (${half}) must exceed expired (${expired})`);
    assert.equal(expired, readState({ userState: 'away', now }).arousal, 'expired voice leaves no trace');
  });

  test('a voice timestamp in the future is ignored, not treated as maximally fresh', () => {
    const now = 1_000_000;
    const future = readState({ userState: 'away', lastVerifiedVoiceAt: now + 60_000, now }).arousal;
    assert.equal(future, readState({ userState: 'away', now }).arousal);
  });

  test('voice needs a clock — a timestamp without `now` changes nothing', () => {
    assert.equal(
      readState({ userState: 'away', lastVerifiedVoiceAt: 1_000 }).arousal,
      readState({ userState: 'away' }).arousal,
    );
  });

  test('signals raise the floor, they never compound past 1', () => {
    const now = 1_000_000;
    const state = readState({
      userState: 'active', lastVerifiedVoiceAt: now, urgentPending: true, now,
    });
    inRange(state.arousal, 'arousal');
  });

  test('an urgent pending item raises arousal even with nobody present', () => {
    const quiet = readState({ userState: 'away' }).arousal;
    const urgent = readState({ userState: 'away', urgentPending: true }).arousal;
    assert.ok(urgent > quiet);
  });
});

describe('readState — load', () => {
  test('load tracks mission occupancy', () => {
    assert.equal(readState({ runningMissions: 0, maxConcurrentMissions: 2 }).load, 0);
    assert.equal(readState({ runningMissions: 1, maxConcurrentMissions: 2 }).load, 0.5);
    assert.equal(readState({ runningMissions: 2, maxConcurrentMissions: 2 }).load, 1);
  });

  test('budget spend raises load independently of missions', () => {
    assert.equal(readState({ runningMissions: 0, spendRatio: 0.8 }).load, 0.8);
  });

  test('load takes the max of its pressures, not the sum', () => {
    const state = readState({ runningMissions: 1, maxConcurrentMissions: 2, spendRatio: 0.4 });
    assert.equal(state.load, 0.5, 'max(0.5, 0.4), not 0.9');
  });

  test('a degraded endpoint counts as load — retries cost time', () => {
    assert.ok(readState({ health: 'degraded_llm' }).load >= 0.6);
    assert.ok(readState({ health: 'degraded_memory' }).load >= 0.6);
  });

  test('a budget hold is total load', () => {
    assert.equal(readState({ health: 'budget_hold' }).load, 1);
  });

  test('maxConcurrent of 0 with work running is full load, not a divide-by-zero', () => {
    const state = readState({ runningMissions: 1, maxConcurrentMissions: 0 });
    assert.equal(state.load, 1);
  });
});

describe('readState — confidence', () => {
  test('no history is exactly 0.5 — no opinion, not unearned optimism', () => {
    assert.equal(readState({ recentOutcomes: [] }).confidence, 0.5);
  });

  test('successes raise it and failures lower it', () => {
    const good = readState({ recentOutcomes: [true, true, true, true, true, true] }).confidence;
    const bad = readState({ recentOutcomes: [false, false, false, false, false, false] }).confidence;
    assert.ok(good > 0.5, `six wins should exceed 0.5, got ${good}`);
    assert.ok(bad < 0.5, `six losses should fall below 0.5, got ${bad}`);
    assert.ok(good > bad);
  });

  test('smoothing keeps one failure from becoming a verdict', () => {
    const one = readState({ recentOutcomes: [false] }).confidence;
    assert.ok(one > 0.2, `a single failure should not crater confidence, got ${one}`);
    assert.ok(one < 0.5);
  });

  test('smoothing bounds confidence away from certainty', () => {
    const perfect = readState({ recentOutcomes: Array(50).fill(true) }).confidence;
    assert.ok(perfect < 1, 'confidence must never reach certainty');
  });

  test('object outcomes are accepted in both spellings', () => {
    const ok = readState({ recentOutcomes: [{ ok: true }, { ok: true }] }).confidence;
    const success = readState({ recentOutcomes: [{ success: true }, { success: true }] }).confidence;
    assert.equal(ok, success);
    assert.ok(ok > 0.5);
  });

  test('a non-array history does not throw', () => {
    assert.equal(readState({ recentOutcomes: null }).confidence, 0.5);
    assert.equal(readState({ recentOutcomes: 'nonsense' }).confidence, 0.5);
  });
});

// ── The safety line ──────────────────────────────────────────────────────────

describe('THE SAFETY LINE: modulation changes how much, never whether', () => {
  // Every gate, set to its most permissive-to-tamper-with value, so that any
  // relaxation would be visible as a change.
  const GATED = Object.freeze({
    confinePaths: true,
    hitlEnabled: true,
    hitlRequired: true,
    requireApproval: true,
    requireSmokeTest: true,
    reflexTools: Object.freeze(['read_file', 'list_dir']),
    toolAllowlist: Object.freeze(['read_file']),
    maxTier: 'T1',
    trustTier: 'T1',
  });

  test('IMMUTABLE_KEYS and MODULABLE_KEYS do not overlap', () => {
    const overlap = MODULABLE_KEYS.filter(k => IMMUTABLE_KEYS.includes(k));
    assert.deepEqual(overlap, [], `a key cannot be both modulable and immutable: ${overlap}`);
  });

  test('every gate survives every extreme of the dial space', () => {
    const extremes = [];
    for (const arousal of [0, 0.5, 1]) {
      for (const load of [0, 0.5, 1]) {
        for (const confidence of [0, 0.5, 1]) extremes.push({ arousal, load, confidence });
      }
    }
    for (const state of extremes) {
      const out = modulate({ ...GATED }, state);
      for (const key of IMMUTABLE_KEYS) {
        assert.deepEqual(
          out[key], GATED[key],
          `${key} changed at arousal=${state.arousal} load=${state.load} confidence=${state.confidence}`,
        );
      }
      assert.ok(gatesIntact(GATED, out));
    }
  });

  test('maximal arousal does not open a single gate', () => {
    const out = modulate({ ...GATED, latencyBudgetMs: 8000 }, { arousal: 1, load: 1, confidence: 0 });
    for (const key of IMMUTABLE_KEYS) assert.deepEqual(out[key], GATED[key], `${key} was modified`);
    // ...while something modulable demonstrably DID change, so the test is not
    // passing merely because modulate did nothing at all.
    assert.notEqual(out.latencyBudgetMs, 8000, 'the test is vacuous if nothing changed');
  });

  test('collection-valued gates pass through by reference, never rebuilt', () => {
    const base = { ...GATED };
    const out = modulate(base, { arousal: 1, load: 1, confidence: 0 });
    assert.equal(out.reflexTools, base.reflexTools, 'the allowlist must be the same object');
    assert.equal(out.toolAllowlist, base.toolAllowlist);
  });

  test('the guard is loud, not silent — a violation throws rather than being quietly repaired', () => {
    // Proving the enforcement itself works, without editing the module: a base
    // object whose gate is a NaN can never compare equal to itself, which is
    // exactly the shape of "the output differs from the input" that the guard
    // exists to catch.
    assert.throws(
      () => modulate({ confinePaths: Number.NaN, latencyBudgetMs: 8000 }, NEUTRAL_STATE),
      /safety gate/,
      'a gate that does not survive the round trip must throw, not pass silently',
    );
  });

  test('gatesIntact detects a tampered gate', () => {
    assert.equal(gatesIntact(GATED, { ...GATED, confinePaths: false }), false);
    assert.equal(gatesIntact(GATED, { ...GATED }), true);
  });
});

// ── modulate ─────────────────────────────────────────────────────────────────

describe('modulate — purity and absence', () => {
  test('the input object is never mutated', () => {
    const base = { latencyBudgetMs: 8000, temperature: 0.2, modelTier: 'default' };
    const snapshot = { ...base };
    modulate(base, { arousal: 1, load: 1, confidence: 0 });
    assert.deepEqual(base, snapshot);
  });

  test('a null state returns the input unchanged — consumers degrade cleanly', () => {
    const base = { latencyBudgetMs: 8000 };
    assert.equal(modulate(base, null), base);
    assert.equal(modulate(base, undefined), base);
    assert.equal(modulate(base, 'not a state'), base);
  });

  test('keys the caller did not supply are not invented', () => {
    const out = modulate({ latencyBudgetMs: 8000 }, NEUTRAL_STATE);
    assert.ok(!('temperature' in out));
    assert.ok(!('modelTier' in out));
    assert.ok(!('consolidationAllowed' in out));
  });

  test('unrecognized keys pass through untouched', () => {
    const out = modulate({ latencyBudgetMs: 8000, somethingElse: 'kept' }, NEUTRAL_STATE);
    assert.equal(out.somethingElse, 'kept');
  });
});

describe('modulate — deadlines', () => {
  test('a waiting user gets a tighter deadline than an empty room', () => {
    const base = { latencyBudgetMs: 8000 };
    const present = modulate(base, { arousal: 0.9, load: 0, confidence: 0.5 }).latencyBudgetMs;
    const empty = modulate(base, { arousal: 0.05, load: 0, confidence: 0.5 }).latencyBudgetMs;
    assert.ok(present < empty, `present (${present}ms) must be tighter than empty room (${empty}ms)`);
    assert.ok(empty > 8000, 'with nobody waiting, the extra seconds are free');
  });

  test('the deadline never falls below the floor', () => {
    const out = modulate({ latencyBudgetMs: 100 }, { arousal: 1, load: 0, confidence: 0.5 });
    assert.equal(out.latencyBudgetMs, MIN_LATENCY_BUDGET_MS);
  });

  test('a non-numeric budget is left alone rather than turned into NaN', () => {
    assert.equal(modulate({ latencyBudgetMs: null }, NEUTRAL_STATE).latencyBudgetMs, null);
    assert.ok(Number.isNaN(modulate({ latencyBudgetMs: Number.NaN }, NEUTRAL_STATE).latencyBudgetMs),
      'NaN in, NaN out — not a silent 0');
  });
});

describe('modulate — temperature', () => {
  test('low confidence lowers temperature; high confidence restores it', () => {
    const base = { temperature: 0.2 };
    const shaky = modulate(base, { arousal: 0.5, load: 0, confidence: 0 }).temperature;
    const solid = modulate(base, { arousal: 0.5, load: 0, confidence: 1 }).temperature;
    assert.ok(shaky < solid, `shaky (${shaky}) must be cooler than solid (${solid})`);
    assert.ok(shaky > 0, 'never zero — determinism is not the goal, caution is');
    assert.ok(solid <= 0.2, 'modulation may lower temperature, never raise it above base');
  });

  test('temperature 0 stays 0', () => {
    assert.equal(modulate({ temperature: 0 }, { arousal: 1, load: 1, confidence: 0 }).temperature, 0);
  });
});

describe('pickTier / modelTier', () => {
  test('contention forces the cheap tier', () => {
    assert.equal(pickTier({ load: 0.9, confidence: 0.9 }), 'cheap');
    assert.equal(modulate({ modelTier: 'default' }, { arousal: 0.5, load: 0.9, confidence: 0.9 }).modelTier, 'cheap');
  });

  test('struggling with room to think buys the strong tier', () => {
    assert.equal(pickTier({ load: 0.1, confidence: 0.2 }), 'strong');
  });

  test('contention outranks struggling — a queued strong call helps nobody', () => {
    assert.equal(pickTier({ load: 0.9, confidence: 0.2 }), 'cheap');
  });

  test('the ordinary case keeps the caller\'s own choice', () => {
    assert.equal(pickTier({ load: 0.3, confidence: 0.7 }, 'default'), 'default');
    assert.equal(pickTier({ load: 0.3, confidence: 0.7 }, 'strong'), 'strong');
  });
});

describe('modulate — consolidation timing', () => {
  test('housekeeping runs only at rest', () => {
    const base = { consolidationAllowed: true };
    assert.equal(modulate(base, { arousal: 0.05, load: 0.1, confidence: 0.5 }).consolidationAllowed, true);
    assert.equal(modulate(base, { arousal: 0.9, load: 0.1, confidence: 0.5 }).consolidationAllowed, false,
      'not while someone is talking to us');
    assert.equal(modulate(base, { arousal: 0.05, load: 0.9, confidence: 0.5 }).consolidationAllowed, false,
      'not while the machine is busy');
  });

  test('it can turn housekeeping ON as well as off — the state decides, not the caller', () => {
    assert.equal(modulate({ consolidationAllowed: false }, { arousal: 0, load: 0, confidence: 0.5 }).consolidationAllowed, true);
  });
});

describe('describeState', () => {
  test('renders percentages and survives a missing state', () => {
    assert.match(describeState({ arousal: 0.7, load: 0.5, confidence: 0.25 }), /arousal 70%.*load 50%.*confidence 25%/);
    assert.equal(describeState(null), 'brain: —');
  });
});
