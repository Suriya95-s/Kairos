// src/brain/neuromodulator.js
// B1 — the internal state: how things are going, in three numbers.
//
// Neuromodulators do not carry content. They set the *gain* of everything at
// once: under high arousal the brain is faster, narrower, more reflexive; at
// rest it is slower, broader, more exploratory. One global state, many local
// effects — and crucially, the effects are all quantitative.
//
// Kairos already knows everything needed for this and does nothing global with
// it. `inferUserState()` knows whether anyone is there; the daemon knows its own
// health, its mission count and its spend; the mission ledger knows how recent
// work went. Each is read ad hoc at one call site, which is why the reflex's
// 8-second budget is 8 seconds whether the user is mid-sentence or asleep.
//
//   readState(observations) → { arousal, load, confidence }   all 0..1
//   modulate(settings, state) → a NEW settings object
//
// ── The safety line ─────────────────────────────────────────────────────────
//
// Modulation may change HOW MUCH, never WHETHER. Budgets, deadlines, model
// tier, temperature: modulable. Trust tiers, HITL, path confinement, the reflex
// tool allowlist, the smoke-test gate: never, under any state, for any reason.
//
// This is enforced structurally rather than by convention — `modulate()`
// restores every key in IMMUTABLE_KEYS from its input before returning, so a
// future edit to the dial logic cannot relax a gate even by accident. A global
// that can open a safety gate is not a neuromodulator, it is a privilege
// escalation path with a biological name.

/** The dials. All normalized 0..1. */
export const DIALS = Object.freeze(['arousal', 'load', 'confidence']);

/** Settings `modulate()` is permitted to change. */
export const MODULABLE_KEYS = Object.freeze([
  'latencyBudgetMs',
  'temperature',
  'modelTier',
  'consolidationAllowed',
]);

/**
 * Settings `modulate()` must never change, whatever the dials say.
 * Restored from the input on the way out — see the note above.
 */
export const IMMUTABLE_KEYS = Object.freeze([
  'confinePaths',        // workspace path confinement
  'hitlEnabled',         // human-in-the-loop gating
  'hitlRequired',
  'requireApproval',     // trust-tier approval prompts
  'requireSmokeTest',    // the build-profile verification gate
  'reflexTools',         // the reflex tool allowlist (T0/T1 only)
  'toolAllowlist',       // per-profile tool allowlists
  'maxTier',             // the highest trust tier that may execute
  'trustTier',
]);

/** Baseline arousal by what the user appears to be doing. */
const AROUSAL_BY_USER_STATE = Object.freeze({
  active: 0.7,   // interacting right now
  idle: 0.35,    // at the machine, not talking to us
  busy: 0.3,     // present, explicitly do-not-disturb
  away: 0.05,    // nobody there
});

/**
 * How long a verified wake word keeps arousal elevated.
 *
 * It decays rather than latching: having spoken once three minutes ago is not
 * evidence of being at the desk now. Three minutes is roughly the span over
 * which a follow-up utterance is still part of the same exchange.
 */
export const VOICE_AROUSAL_WINDOW_MS = 180_000;

/** Floor on any modulated deadline. A budget scaled to nothing is a broken feature. */
export const MIN_LATENCY_BUDGET_MS = 2_000;

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Compute the current internal state from what the kernel can observe.
 *
 * Pure: every input is an argument, including the clock. Nothing here reads
 * config, the daemon, or the filesystem.
 *
 * @param {object} obs
 * @param {'active'|'idle'|'away'|'busy'} [obs.userState]
 * @param {string}  [obs.health]                 daemon health state
 * @param {number}  [obs.runningMissions]
 * @param {number}  [obs.maxConcurrentMissions]
 * @param {number}  [obs.spendRatio]             0..1 of the daily budget
 * @param {Array}   [obs.recentOutcomes]         booleans, or {ok}/{success} objects
 * @param {number}  [obs.lastVerifiedVoiceAt]    ms timestamp of the last VERIFIED wake word
 * @param {boolean} [obs.urgentPending]          an urgent notification is waiting
 * @param {number}  [obs.now]
 * @returns {{arousal:number, load:number, confidence:number}}
 */
export function readState({
  userState = 'idle',
  health = 'healthy',
  runningMissions = 0,
  maxConcurrentMissions = 2,
  spendRatio = 0,
  recentOutcomes = [],
  lastVerifiedVoiceAt = null,
  urgentPending = false,
  now = null,
} = {}) {
  // ── arousal — how much *now* matters ──────────────────────────────
  let arousal = AROUSAL_BY_USER_STATE[userState] ?? AROUSAL_BY_USER_STATE.idle;

  // A verified wake word is the strongest presence signal the system can
  // produce — stronger than a socket being attached, because it means a person
  // spoke and the voiceprint matched. Unverified speech is deliberately not a
  // signal: in a noisy shared room that would be anyone.
  if (lastVerifiedVoiceAt != null && now != null) {
    const age = now - lastVerifiedVoiceAt;
    if (age >= 0 && age < VOICE_AROUSAL_WINDOW_MS) {
      const freshness = 1 - age / VOICE_AROUSAL_WINDOW_MS;
      // max(), never sum: signals raise the floor, they do not compound.
      arousal = Math.max(arousal, 0.5 + 0.5 * freshness);
    }
  }
  if (urgentPending) arousal = Math.max(arousal, 0.85);

  // ── load — how contended the system is ────────────────────────────
  const missionLoad = maxConcurrentMissions > 0
    ? runningMissions / maxConcurrentMissions
    : (runningMissions > 0 ? 1 : 0);
  let load = Math.max(clamp01(missionLoad), clamp01(spendRatio));
  if (health === 'degraded_llm' || health === 'degraded_memory') load = Math.max(load, 0.6);
  if (health === 'budget_hold') load = 1;

  // ── confidence — how recent work has gone ─────────────────────────
  // Laplace-smoothed, so an empty history is exactly 0.5 (no opinion) rather
  // than 1.0 (unearned optimism), and one early failure is not a verdict.
  const outcomes = (Array.isArray(recentOutcomes) ? recentOutcomes : [])
    .map(o => (typeof o === 'boolean' ? o : !!(o && (o.ok ?? o.success))));
  const wins = outcomes.filter(Boolean).length;
  const confidence = (wins + 1) / (outcomes.length + 2);

  return {
    arousal: round2(clamp01(arousal)),
    load: round2(clamp01(load)),
    confidence: round2(confidence),
  };
}

/**
 * Choose a model tier for the current state.
 * Exported because `selectModelForStage` needs the same rule.
 */
export function pickTier({ load = 0, confidence = 0.5 } = {}, fallback = 'default') {
  // Contention and budget pressure come first: when the system is busy, the
  // cheap model finishing beats the strong model queueing.
  if (load >= 0.75) return 'cheap';
  // Struggling, with room to think: spend more per call rather than repeating
  // a cheap failure. This is the case worth paying for.
  if (confidence <= 0.4 && load <= 0.4) return 'strong';
  return fallback;
}

/**
 * Apply the dials to a settings object.
 *
 * Returns a NEW object; the input is never mutated. Passing a null state
 * returns the input unchanged, so every consumer degrades cleanly to its
 * unmodulated behaviour when the brain is absent.
 *
 * @param {object} base
 * @param {object|null} state  from readState()
 * @param {object} [opts]
 * @returns {object}
 */
export function modulate(base = {}, state = null, opts = {}) {
  if (!state || typeof state !== 'object') return base;

  const arousal = clamp01(state.arousal);
  const confidence = clamp01(state.confidence);
  const load = clamp01(state.load);
  const out = { ...base };

  // ── deadlines: tighter when someone is waiting ────────────────────
  // At full arousal 0.6×, at rest 1.6×. Somebody mid-sentence is better served
  // by a fast partial answer than a slow complete one; with nobody there, the
  // opposite is true and the extra seconds are free.
  if (typeof base.latencyBudgetMs === 'number' && Number.isFinite(base.latencyBudgetMs)) {
    const floor = opts.minLatencyBudgetMs ?? MIN_LATENCY_BUDGET_MS;
    out.latencyBudgetMs = Math.max(floor, Math.round(base.latencyBudgetMs * (1.6 - arousal)));
  }

  // ── temperature: conservative when recent work has gone badly ─────
  if (typeof base.temperature === 'number' && Number.isFinite(base.temperature)) {
    out.temperature = round3(base.temperature * (0.6 + 0.4 * confidence));
  }

  // ── model tier ────────────────────────────────────────────────────
  if ('modelTier' in base) {
    out.modelTier = pickTier({ load, confidence }, base.modelTier);
  }

  // ── housekeeping only happens at rest ─────────────────────────────
  // Competing with live work for the database and the CPU to tidy up is the
  // wrong trade, and consolidation is never urgent.
  if ('consolidationAllowed' in base) {
    out.consolidationAllowed = arousal <= 0.3 && load <= 0.3;
  }

  // ── the safety line, enforced structurally ────────────────────────
  // No branch above touches a gate. This checks anyway, because the whole
  // point of a safety line is that it does not depend on the code above it
  // staying correct through future edits.
  //
  // It repairs AND throws, in that order. Repairing means a caller that
  // swallows the error still cannot receive a relaxed gate. Throwing means the
  // bug is loud rather than silently corrected — a violation here is not a
  // runtime condition to recover from, it is a defect, and the 27-point dial
  // sweep in the test suite reaches it long before production does.
  const violations = [];
  for (const key of IMMUTABLE_KEYS) {
    if (!(key in base)) continue;
    if (out[key] !== base[key]) {
      out[key] = base[key];
      violations.push(key);
    }
  }
  if (violations.length) {
    throw new Error(
      `neuromodulator tried to change a safety gate (${violations.join(', ')}) — ` +
      'modulation may change how much, never whether',
    );
  }

  return out;
}

/**
 * True when no key in IMMUTABLE_KEYS differs between two settings objects.
 * Used by the invariance test, and available as a runtime assertion.
 */
export function gatesIntact(base = {}, out = {}) {
  for (const key of IMMUTABLE_KEYS) {
    if (!(key in base) && !(key in out)) continue;
    const a = base[key];
    const b = out[key];
    if (a === b) continue;
    // Reference equality is the contract for the collection-valued gates —
    // modulate must pass them through, never rebuild them.
    return false;
  }
  return true;
}

/** A neutral state: no opinion in any direction. Useful as a default. */
export const NEUTRAL_STATE = Object.freeze({ arousal: 0.35, load: 0, confidence: 0.5 });

/** One-line human summary, for the TUI header and `kairos status`. */
export function describeState(state) {
  if (!state) return 'brain: —';
  const pct = (n) => `${Math.round(clamp01(n) * 100)}%`;
  return `arousal ${pct(state.arousal)} · load ${pct(state.load)} · confidence ${pct(state.confidence)}`;
}
