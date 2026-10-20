// src/lmma/importanceScorer.js
// Importance scoring with a learned-utility feedback loop.
//
// Heuristics give a base score; a running EMA of step-outcome success per
// bank/ontology-tag (the "utility" signal) then nudges that score up or down.
// Over a run, memory areas that have historically led to SUCCESSFUL steps are
// scored as more important, and areas that correlate with failures decay — so
// importance becomes learned from outcomes rather than purely hand-tuned.

const UTILITY_NEUTRAL = 0.5;
const UTILITY_ALPHA = 0.2;       // EMA learning rate
const LEARNED_WEIGHT = 0.2;      // max ±0.1 swing from learned utility

export function scoreImportance({ actionTool = '', toolError = false, stage = '', retrievalHits = [], learnedUtility = null }) {
  // Base is low enough that a routine non-mutating success (e.g. think/read with
  // no special stage) lands below 0.4, so the aggregate-only writeback throttle
  // in memoryWriteback.js is actually reachable and banks stop growing one full
  // entry per step. Errors get the largest bump (errors are always important),
  // which also fixes the prior inversion where errors scored BELOW successes.
  let score = 0.25;
  if (toolError) score += 0.25;          // errors are always important
  else score += 0.1;                     // routine success
  if (['verification', 'finalization'].includes(stage)) score += 0.1;
  if (['write_file', 'edit_file', 'patch', 'run_command'].includes(actionTool)) score += 0.15;
  if (retrievalHits.length > 0) score += 0.05;
  // Learned adjustment: shift by (utility − 0.5)·weight. Neutral utility (0.5)
  // leaves the heuristic score unchanged; high historical utility raises it.
  if (typeof learnedUtility === 'number') {
    score += (learnedUtility - UTILITY_NEUTRAL) * LEARNED_WEIGHT;
  }
  return Number(Math.min(1, Math.max(0, score)).toFixed(2));
}

/**
 * Compute the learned utility for a memory given its bank and ontology tags.
 * Returns the mean of the known EMAs, or null when nothing has been learned yet
 * (so scoreImportance stays purely heuristic until evidence accumulates).
 */
export function computeLearnedUtility(utility, bank, tags = []) {
  const u = utility || {};
  const vals = [];
  if (bank && u.banks && typeof u.banks[bank] === 'number') vals.push(u.banks[bank]);
  for (const tag of tags) {
    if (u.tags && typeof u.tags[tag] === 'number') vals.push(u.tags[tag]);
  }
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

/**
 * Update the utility EMAs for a bank and its tags from one step's outcome.
 * Returns a NEW utility object (does not mutate the input).
 * @param {object} utility - prior {banks, tags}
 * @param {string} bank
 * @param {string[]} tags
 * @param {boolean} success - was the step successful (no tool error)?
 */
export function updateUtility(utility, bank, tags = [], success = true, alpha = UTILITY_ALPHA) {
  const prior = utility && typeof utility === 'object' ? utility : {};
  const banks = { ...(prior.banks || {}) };
  const tagMap = { ...(prior.tags || {}) };
  const target = success ? 1 : 0;
  const ema = (cur) => (typeof cur === 'number' ? cur : UTILITY_NEUTRAL) * (1 - alpha) + target * alpha;
  if (bank) banks[bank] = Number(ema(banks[bank]).toFixed(3));
  for (const tag of tags) tagMap[tag] = Number(ema(tagMap[tag]).toFixed(3));
  return { banks, tags: tagMap };
}
