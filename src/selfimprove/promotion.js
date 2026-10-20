// src/selfimprove/promotion.js
// Skill promotion (9.3): earning trust by working.
//
// The two halves of this already existed and had never been connected. The
// skill grader scores a skill on how often it succeeds; the tier registry
// decides how much confirmation a capability needs. Wiring them means a skill
// that has demonstrably worked twenty times stops asking permission every time
// — which is the only version of "getting better on its own" that a user
// actually feels.
//
// The wiring is deliberately one-directional and bounded:
//
//   * Promotion only ever **lowers friction**, never capability. A skill cannot
//     promote its way into being allowed to do something new; it can only stop
//     being asked about something it was already permitted to do.
//   * **T3 is not promotable.** Same rule as standing approvals, and for the
//     same reason: a track record of twenty successful deletions is not
//     evidence that the twenty-first is wanted.
//   * A single failure **demotes immediately**. Trust is asymmetric — it should
//     be slow to earn and fast to lose, because the cost of the two mistakes is
//     not symmetric either.

import { classify, canGrantStanding, tierRank, atLeast } from '../trust/tiers.js';

/** How much evidence is enough. */
export const PROMOTION = Object.freeze({
  /** Successful uses before a skill is considered proven. */
  minUses: 20,
  /** Minimum success rate over those uses. */
  minSuccessRate: 0.95,
  /** How long a proven skill stays proven without further use. */
  staleAfterMs: 90 * 86_400_000,
  /** Ceiling: promotion can never produce a standing grant above this. */
  maxTier: 'T2',
});

/**
 * Should this skill be promoted to a standing approval?
 *
 * Returns a decision object rather than a boolean, because "no, and here is
 * how far off it is" is the useful answer for a report.
 */
export function evaluate(skill, { now = Date.now(), policy = {} } = {}) {
  const p = { ...PROMOTION, ...policy };
  const uses = skill?.uses ?? 0;
  const failures = skill?.failures ?? 0;
  const successes = Math.max(0, uses - failures);
  const successRate = uses ? successes / uses : 0;
  const tier = skill?.tier || classify(skill?.tool || skill?.name || '', {}).tier;

  const reasons = [];

  // Tier first: no amount of evidence changes an irreversible action.
  if (!canGrantStanding(tier)) {
    return {
      promote: false, demote: false, tier,
      reason: `${tier} actions are confirmed every time — a track record does not change that`,
      blocked: true,
    };
  }
  if (atLeast(tier, p.maxTier) && tierRank(tier) > tierRank(p.maxTier)) {
    return { promote: false, demote: false, tier, reason: `above the promotion ceiling (${p.maxTier})`, blocked: true };
  }

  // A single recent failure is disqualifying. This is the asymmetry: twenty
  // successes and one failure is not "95% reliable", it is "it broke once and
  // we do not know why yet".
  if (skill?.lastFailureAt && (now - skill.lastFailureAt) < 7 * 86_400_000) {
    return { promote: false, demote: true, tier, reason: 'failed within the last week' };
  }

  if (uses < p.minUses) reasons.push(`${uses}/${p.minUses} uses`);
  if (successRate < p.minSuccessRate) reasons.push(`${Math.round(successRate * 100)}% success (need ${Math.round(p.minSuccessRate * 100)}%)`);

  const stale = skill?.lastUsedAt && (now - skill.lastUsedAt) > p.staleAfterMs;
  if (stale) reasons.push('unused for too long to still count as proven');

  if (reasons.length) {
    return { promote: false, demote: stale, tier, reason: reasons.join('; '), successRate, uses };
  }

  return {
    promote: true, demote: false, tier, successRate, uses,
    reason: `${successes} successes in ${uses} uses`,
  };
}

/**
 * Apply promotion decisions to the standing-approval store.
 *
 * The grant is always **scoped to the skill's own tool and workspace**. An
 * unscoped promotion would mean "this skill worked, so allow this tool
 * anywhere", which is a much larger claim than the evidence supports.
 *
 * @param {object[]} skills
 * @param {object} approvals  StandingApprovals
 * @returns {{promoted: object[], demoted: object[], skipped: object[]}}
 */
export function applyPromotions(skills, approvals, { now = Date.now(), policy = {}, dryRun = false } = {}) {
  const promoted = [];
  const demoted = [];
  const skipped = [];

  const live = approvals.list();
  const bySkill = new Map(live.filter(a => a.reason?.startsWith('promoted:')).map(a => [a.reason.slice(9), a]));

  for (const skill of skills || []) {
    const name = skill?.name || skill?.tool;
    if (!name) continue;
    const decision = evaluate(skill, { now, policy });
    const existing = bySkill.get(name);

    if (decision.demote && existing) {
      if (!dryRun) approvals.revoke(existing.id);
      demoted.push({ skill: name, reason: decision.reason });
      continue;
    }
    if (!decision.promote) { skipped.push({ skill: name, reason: decision.reason }); continue; }
    if (existing) { skipped.push({ skill: name, reason: 'already promoted' }); continue; }

    if (!dryRun) {
      try {
        approvals.grant({
          tool: skill.tool || name,
          workspace: skill.workspace || null,
          argMatch: skill.argMatch || null,
          // Time-boxed. A promotion is a statement about a track record, and a
          // track record goes stale — re-earning it costs nothing if the skill
          // is still being used.
          expiresAt: now + PROMOTION.staleAfterMs,
          grantedBy: 'promotion',
          reason: `promoted:${name}`,
          tier: decision.tier,
        });
      } catch (err) {
        skipped.push({ skill: name, reason: err.message });
        continue;
      }
    }
    promoted.push({ skill: name, tier: decision.tier, evidence: decision.reason });
  }

  return { promoted, demoted, skipped };
}

/** A line a person can read in the weekly digest. */
export function renderPromotions({ promoted, demoted }) {
  const lines = [];
  if (promoted.length) {
    lines.push(`Stopped asking about: ${promoted.map(p => p.skill).join(', ')} — each has a clean track record.`);
  }
  if (demoted.length) {
    lines.push(`Asking again about: ${demoted.map(d => `${d.skill} (${d.reason})`).join(', ')}.`);
  }
  return lines.join('\n');
}
