// src/triggers/followups.js
// The follow-up ledger (6.4): work that stopped without finishing.
//
// The exit taxonomy this depends on has existed since long before the daemon —
// `max_steps`, `repair_stalled`, `budget_exceeded`, `interrupted` — and until
// now nothing consumed it. A mission that ran out of steps simply ended, and
// whether anyone noticed depended on whether they were watching the terminal at
// the time. That is the precise failure a resident system should fix: it was
// there when the job stopped, and it can be the one to remember.
//
// Not every ending deserves a follow-up. A mission that `completed` needs
// nothing, and a mission the user `cancelled` needs nothing either — they
// stopped it on purpose, and resurfacing it would be nagging. What earns one is
// an ending the *system* chose: it hit a ceiling, got stuck, or was interrupted
// by something other than the user's intent.

import { projectScope } from '../memoryd/scopes.js';

/**
 * Exit reasons that warrant a follow-up, and what to say about each.
 *
 * The phrasing matters more than it looks. "Ran out of steps" invites
 * "continue"; "failed" invites "give up". They describe the same event.
 */
export const FOLLOWUP_REASONS = Object.freeze({
  max_steps: {
    summary: 'ran out of steps before finishing',
    suggestion: 'resume it with a higher step budget',
    resumable: true,
    urgency: 'soon',
  },
  budget_exceeded: {
    summary: 'hit its character budget',
    suggestion: 'resume it, or narrow the task',
    resumable: true,
    urgency: 'soon',
  },
  repair_stalled: {
    summary: 'got stuck trying to repair its own work',
    suggestion: 'look at what it was fixing — this usually needs a human decision',
    resumable: true,
    // Stuck-in-a-loop is the one worth hearing about promptly: it burned budget
    // to get nowhere, and it will do it again on a naive resume.
    urgency: 'soon',
  },
  interrupted: {
    summary: 'was interrupted and checkpointed',
    suggestion: 'resume it where it left off',
    resumable: true,
    urgency: 'whenever',
  },
  error: {
    summary: 'stopped with an error',
    suggestion: 'check the mission log',
    resumable: false,
    urgency: 'soon',
  },
});

/** Endings that need nothing said. */
const NO_FOLLOWUP = Object.freeze(['completed']);

export class FollowUpLedger {
  /**
   * @param {object} opts
   * @param {object} opts.intents   IntentLedger — a follow-up IS a standing intent
   * @param {object} [opts.memory]  MemoryService, for recording the pattern
   * @param {function} [opts.now]
   */
  constructor({ intents, memory = null, now = Date.now } = {}) {
    if (!intents) throw new Error('FollowUpLedger needs an intent ledger');
    this.intents = intents;
    this._memory = memory;
    this._now = now;
  }

  /**
   * Consider a finished mission. Creates a follow-up when the ending warrants one.
   * @param {object} mission  the mission record
   * @returns {object|null} the created intent, or null
   */
  onMissionEnded(mission) {
    if (!mission) return null;
    const reason = mission.exitReason || (mission.state === 'failed' ? 'error' : null);

    // The user stopping something is a decision, not a loose end.
    if (mission.state === 'cancelled') return null;
    if (!reason || NO_FOLLOWUP.includes(reason)) return null;

    const spec = FOLLOWUP_REASONS[reason];
    if (!spec) return null;

    const intent = this.intents.create({
      kind: 'followup',
      description: `"${truncate(mission.title || mission.task, 70)}" ${spec.summary}`,
      sessionId: mission.sessionId || null,
      workspace: mission.workspace || null,
      missionId: mission.id,
      urgency: spec.urgency,
      condition: {
        exitReason: reason,
        resumable: spec.resumable,
        suggestion: spec.suggestion,
        lastStep: mission.lastStep ?? 0,
      },
      // One mention. A follow-up that repeats is nagging, and the user can
      // always ask `missions` to see everything outstanding.
      budget: { max: 1, windowMs: 86_400_000 },
      // Two weeks: after that, an unfinished job is not a follow-up, it is
      // something the user decided not to do.
      expiresAt: this._now() + 14 * 86_400_000,
    });

    this._rememberPattern(mission, reason);
    return intent;
  }

  /**
   * Record the stall in memory so it can inform later work.
   *
   * Project-scoped: "the migration mission keeps hitting max_steps" is a fact
   * about that codebase, not about the user.
   */
  _rememberPattern(mission, reason) {
    if (!this._memory || !mission.workspace) return;
    try {
      this._memory.remember({
        body: `A mission ("${truncate(mission.title, 60)}") ended as ${reason} after ${mission.lastStep ?? 0} steps`,
        subject: 'mission-outcome',
        kind: 'event',
        scope: projectScope(mission.workspace),
        source: 'followup-ledger',
      });
    } catch { /* memory is an enhancement here, never a requirement */ }
  }

  /** Outstanding follow-ups, oldest first. */
  pending({ sessionId = null } = {}) {
    return this.intents.list({ kind: 'followup', state: 'active', sessionId });
  }

  /**
   * Claim a follow-up for delivery. Returns null when its budget is spent,
   * which for a follow-up means it has already been mentioned once.
   */
  claim(intentId) {
    const claim = this.intents.claimNotification(intentId);
    if (!claim.ok) return null;
    const intent = this.intents.get(intentId);
    // One mention and it is done — it stays visible in `missions`, but it stops
    // being something the system brings up.
    this.intents.markFired(intentId);
    return intent;
  }

  /** Drop the follow-up for a mission that has since been resumed or finished. */
  resolveForMission(missionId) {
    const resolved = [];
    for (const intent of this.intents.list({ kind: 'followup', state: 'active' })) {
      if (intent.missionId !== missionId) continue;
      this.intents.update(intent.id, { state: 'fired' });
      resolved.push(intent.id);
    }
    return resolved;
  }

  /**
   * Render outstanding follow-ups as something worth reading.
   * @returns {string} '' when there is nothing outstanding
   */
  render(items = null) {
    const list = items ?? this.pending();
    if (!list.length) return '';
    if (list.length === 1) {
      const it = list[0];
      return `${it.description}. You could ${it.condition?.suggestion || 'take another look'}.`;
    }
    const lines = list.map(it => `- ${it.description}`);
    return `${list.length} unfinished things:\n${lines.join('\n')}`;
  }
}

function truncate(text, n) {
  const s = String(text || 'a mission');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
