// src/triggers/etiquette.js
// Interruption etiquette (6.5) — what separates Jarvis from a smoke alarm.
//
// Every other part of proactivity answers "is this true?". This one answers
// "should I say it, and when?", and it is the harder question. A system that
// can initiate contact and always does is worse than one that never can,
// because the first thing a person does with a device that interrupts badly is
// switch it off — and then the genuinely urgent message never arrives either.
//
// Three inputs, one decision:
//
//   urgency × user state × time of day  →  speak | queue | digest | drop
//
//   speak   deliver now, interrupt whatever is happening
//   queue   hold it; surface at the user's next interaction
//   digest  roll into a periodic summary — for things that are true but small
//   drop    do not deliver at all (over budget, or expired)
//
// The bias is deliberate: anything short of `now` waits. The cost of a delayed
// "the build broke" is minutes; the cost of a 3am interruption for it is that
// nobody trusts the system again.

/** What the system may do with a pending notification. */
export const DELIVERY = Object.freeze(['speak', 'queue', 'digest', 'drop']);

/** What the user appears to be doing. */
export const USER_STATES = Object.freeze([
  'active',    // interacting right now — a message is welcome
  'idle',      // at the machine but not talking to us
  'away',      // no client attached
  'busy',      // explicitly do-not-disturb
]);

/**
 * Arousal at or above which a `soon` item may interrupt an *idle* user.
 * 0.75 is only reachable from a verified wake word inside its decay window, or
 * from an urgent item already pending — never from presence alone.
 */
export const HIGH_AROUSAL = 0.75;

export const DEFAULT_POLICY = Object.freeze({
  /** Local hours [start, end) during which only `now` gets through. */
  quietHours: Object.freeze({ start: 22, end: 8 }),
  /** Does an urgent item pierce quiet hours? Off by default — this is someone's sleep. */
  urgentPiercesQuiet: false,
  /** Does an urgent item pierce an explicit do-not-disturb? */
  urgentPiercesBusy: true,
  /** How long a queued item waits before it is only worth digesting. */
  staleAfterMs: 4 * 3_600_000,
});

/**
 * Decide what to do with one notification.
 *
 * Pure: no clock, no I/O, no ledger. Everything comes in as an argument so the
 * policy can be reasoned about and tested exhaustively — this is the function
 * that decides whether to wake someone up.
 *
 * @param {object} input
 * @param {'now'|'soon'|'whenever'} input.urgency
 * @param {'active'|'idle'|'away'|'busy'} input.userState
 * @param {number} input.hour           local hour, 0–23
 * @param {number} [input.createdAt]    when the item was raised
 * @param {number} [input.now]
 * @param {object} [input.policy]
 * @param {number} [input.arousal]      B1 neuromodulator arousal, 0..1. Only ever
 *                                      consulted on the one genuinely borderline
 *                                      branch — see below.
 * @returns {{delivery: string, reason: string}}
 */
export function decideDelivery({
  urgency = 'soon',
  userState = 'idle',
  hour = 12,
  createdAt = null,
  now = null,
  policy = {},
  arousal = null,
} = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const quiet = inQuietHours(hour, p.quietHours);

  // ── Quiet hours ──────────────────────────────────────────────────
  if (quiet) {
    if (urgency === 'now' && p.urgentPiercesQuiet) {
      return { delivery: 'speak', reason: 'urgent, and configured to pierce quiet hours' };
    }
    // Everything else waits until morning. Note this deliberately overrides
    // `userState: active` — someone up at 3am is not thereby asking to be
    // interrupted about a flaky test.
    return { delivery: 'queue', reason: 'quiet hours' };
  }

  // ── Explicit do-not-disturb ──────────────────────────────────────
  if (userState === 'busy') {
    if (urgency === 'now' && p.urgentPiercesBusy) {
      return { delivery: 'speak', reason: 'urgent, and urgent pierces do-not-disturb' };
    }
    return { delivery: 'queue', reason: 'user is busy' };
  }

  // ── Nobody there ─────────────────────────────────────────────────
  if (userState === 'away') {
    // Speaking to an empty room is not delivery. Even urgent items queue —
    // and P8's phone channel is what will change this answer, not a louder
    // message to a terminal nobody is looking at.
    return {
      delivery: urgency === 'whenever' ? 'digest' : 'queue',
      reason: 'no client attached',
    };
  }

  // ── Present ──────────────────────────────────────────────────────
  if (urgency === 'now') return { delivery: 'speak', reason: 'urgent and the user is present' };

  if (urgency === 'soon') {
    // Mid-conversation, a `soon` item is a natural aside. Idle at the machine,
    // it can wait for them to look — interrupting a train of thought for
    // something that is merely "soon" is the behaviour being avoided.
    if (userState === 'active') {
      return { delivery: 'speak', reason: 'user is mid-conversation; this fits alongside' };
    }
    // The one branch arousal is allowed to move, and only in this direction.
    // `idle` means the kernel has not heard from a client recently — but a
    // verified wake word thirty seconds ago is better evidence of presence than
    // socket traffic is, and someone who just spoke to us is mid-exchange
    // whatever the session registry believes.
    //
    // Everything above this line is untouched: quiet hours, do-not-disturb and
    // an empty room all return before reaching here, so no arousal value can
    // reach through them. This branch would otherwise queue, so the worst case
    // is an aside to somebody who is demonstrably present.
    if (arousal != null && arousal >= HIGH_AROUSAL && userState === 'idle') {
      return { delivery: 'speak', reason: 'the user spoke to us moments ago; this fits alongside' };
    }
    return { delivery: 'queue', reason: 'not urgent enough to interrupt' };
  }

  // `whenever` never interrupts, by definition.
  const stale = createdAt != null && now != null && (now - createdAt) > p.staleAfterMs;
  return {
    delivery: 'digest',
    reason: stale ? 'low priority and already stale' : 'low priority',
  };
}

/** Is `hour` inside the quiet window? Handles windows that wrap midnight. */
export function inQuietHours(hour, { start, end } = DEFAULT_POLICY.quietHours) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  if (start === end) return false;              // an empty window means no quiet hours
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;                 // wraps midnight, e.g. 22 → 8
}

// ── The outbox ──────────────────────────────────────────────────────────────

/**
 * Holds what etiquette decided not to say yet.
 *
 * In memory on purpose. A queued notification is a statement about *this
 * moment* — "tell them when they're next around" — and replaying yesterday's
 * queue after a restart is how a system greets you with eleven stale alerts.
 * Anything that must survive a restart is a standing intent, and will fire
 * again on its own terms.
 */
export class Outbox {
  constructor({ now = Date.now, maxQueued = 50 } = {}) {
    this._now = now;
    this._maxQueued = maxQueued;
    this._queued = [];
    this._digest = [];
  }

  /**
   * Route a notification. Returns the decision so the caller can deliver
   * `speak` items itself — the outbox holds only what is deferred.
   */
  route(notification, context) {
    const decision = decideDelivery({ ...context, urgency: notification.urgency, createdAt: notification.createdAt, now: this._now() });
    const item = { ...notification, decidedAt: this._now(), reason: decision.reason };

    if (decision.delivery === 'queue') this._push(this._queued, item);
    if (decision.delivery === 'digest') this._push(this._digest, item);
    return { ...decision, item };
  }

  _push(list, item) {
    list.push(item);
    // Bounded: an unbounded queue behind a do-not-disturb becomes a wall of
    // text the moment it lifts, which is the same failure as interrupting.
    if (list.length > this._maxQueued) list.splice(0, list.length - this._maxQueued);
  }

  /** Everything waiting for the user's next interaction. Drains the queue. */
  drainQueued() {
    const out = this._queued;
    this._queued = [];
    return out;
  }

  /**
   * Roll the digest into one message. Drains it.
   * @returns {string} '' when there is nothing worth saying
   */
  drainDigest() {
    const items = this._digest;
    this._digest = [];
    if (!items.length) return '';
    if (items.length === 1) return items[0].text;

    // Grouped by intent so "the build broke" five times reads as one line with
    // a count, not five lines.
    const groups = new Map();
    for (const it of items) {
      const key = it.intentId || it.text;
      if (!groups.has(key)) groups.set(key, { text: it.text, count: 0 });
      groups.get(key).count++;
    }
    const lines = [...groups.values()].map(g => (g.count > 1 ? `${g.text} (×${g.count})` : `- ${g.text}`));
    return `While you were away:\n${lines.map(l => (l.startsWith('- ') ? l : `- ${l}`)).join('\n')}`;
  }

  get queuedCount() { return this._queued.length; }
  get digestCount() { return this._digest.length; }

  status() {
    return { queued: this._queued.length, digest: this._digest.length, maxQueued: this._maxQueued };
  }
}

/**
 * Infer what the user is doing from what the kernel can actually see.
 *
 * Deliberately conservative: the only way to reach `active` is a client that
 * has been heard from recently. Guessing that someone is present, and being
 * wrong, means interrupting an empty room — or worse, a meeting.
 */
export function inferUserState({ clientAttached = false, lastSeenAt = null, now = Date.now(), doNotDisturb = false, activeWindowMs = 120_000 } = {}) {
  if (doNotDisturb) return 'busy';
  if (!clientAttached) return 'away';
  if (lastSeenAt && (now - lastSeenAt) <= activeWindowMs) return 'active';
  return 'idle';
}
