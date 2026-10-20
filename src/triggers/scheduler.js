// src/triggers/scheduler.js
// Timers (6.1): "remind me to check the deploy on Friday".
//
// The scheduler owns no state of its own. A scheduled thing is a standing
// intent with a `schedule` condition, which means it persists across restarts
// for free and is cancellable, inspectable and budgeted through exactly the
// same surface as everything else proactive.
//
// Two shapes:
//   one-shot   { at: <ms> }              fires once, then the intent is `fired`
//   repeating  { cron: 'm h dom mon dow' } fires forever until cancelled
//
// A deliberately small cron subset: numbers, `*`, lists (`1,15`), ranges
// (`9-17`) and steps (`*/15`). No `@reboot`, no seconds field, no month names.
// This is for "every weekday at 9" — anything more elaborate is a mission.
//
// **Missed fires are delivered, not skipped.** A laptop that was asleep at 9am
// must still say the thing at 10, because "remind me at 9" means "make sure I
// know", not "make a sound at exactly 09:00:00". The catch-up is collapsed to
// one delivery, so a week of downtime produces one reminder rather than 168.

const FIELD_RANGES = Object.freeze([
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
]);

/**
 * Parse one cron field into the set of values it matches.
 * @returns {Set<number>}
 */
function parseField(spec, { min, max, name }) {
  const values = new Set();
  for (const part of String(spec).split(',')) {
    const token = part.trim();
    if (!token) throw new Error(`empty ${name} field`);

    const [range, stepRaw] = token.split('/');
    const step = stepRaw === undefined ? 1 : parseInt(stepRaw, 10);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step "${stepRaw}" in ${name}`);

    let lo, hi;
    if (range === '*') {
      lo = min; hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(n => parseInt(n, 10));
      lo = a; hi = b;
    } else {
      lo = hi = parseInt(range, 10);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`invalid ${name} value "${range}"`);
    if (lo < min || hi > max || lo > hi) throw new Error(`${name} "${range}" is outside ${min}-${max}`);

    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/**
 * Parse a 5-field cron expression.
 * Throws on anything malformed — a typo'd schedule that silently never fires
 * is the worst outcome here, because nothing is obviously broken.
 */
export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron needs 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  }
  return FIELD_RANGES.map((range, i) => parseField(parts[i], range));
}

/** Does `date` match the parsed cron? */
export function cronMatches(fields, date) {
  const [minute, hour, dom, month, dow] = fields;
  return minute.has(date.getMinutes())
    && hour.has(date.getHours())
    && month.has(date.getMonth() + 1)
    // Standard cron: when BOTH day fields are restricted, either matching is
    // enough. Requiring both would make "the 1st, and Mondays" mean "Mondays
    // that fall on the 1st", which is not what anyone means by it.
    && (isWildcard(dom, 1, 31) || isWildcard(dow, 0, 6)
      ? dom.has(date.getDate()) && dow.has(date.getDay())
      : dom.has(date.getDate()) || dow.has(date.getDay()));
}

function isWildcard(set, min, max) { return set.size === (max - min + 1); }

/**
 * Next firing time at or after `from`, or null when the expression can never
 * match (e.g. 31 February).
 */
export function nextCronTime(expr, from) {
  const fields = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  // Four years of minutes is enough to cover every leap-year case; bounded so
  // an impossible expression returns null instead of spinning.
  const limit = 4 * 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (cronMatches(fields, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

export class TriggerScheduler {
  /**
   * @param {object} opts
   * @param {object} opts.ledger      IntentLedger
   * @param {function} opts.onFire    async (intent, {scheduledFor, missed}) => void
   * @param {number} [opts.intervalMs]
   * @param {function} [opts.now]
   */
  constructor({ ledger, onFire = null, intervalMs = 30_000, now = Date.now } = {}) {
    if (!ledger) throw new Error('TriggerScheduler needs an intent ledger');
    this.ledger = ledger;
    this._onFire = onFire;
    this._intervalMs = intervalMs;
    this._now = now;
    this._timer = null;
    this.firedCount = 0;
  }

  /**
   * Schedule a one-shot reminder.
   * @param {object} spec
   * @param {number} spec.at  absolute ms
   */
  scheduleAt({ at, description, sessionId = null, workspace = null, urgency = 'soon', budget = null }) {
    if (!Number.isFinite(at)) throw new Error('scheduleAt needs an absolute timestamp');
    return this.ledger.create({
      kind: 'schedule',
      description,
      sessionId, workspace, urgency, budget,
      condition: { at, nextAt: at },
      // A one-shot has no reason to outlive its own delivery by much; the
      // window keeps a stuck item from lingering in the ledger forever.
      expiresAt: at + 30 * 86_400_000,
    });
  }

  /** Schedule a repeating reminder. Validates the expression up front. */
  scheduleCron({ cron, description, sessionId = null, workspace = null, urgency = 'soon', budget = null, expiresAt = null }) {
    const nextAt = nextCronTime(cron, this._now());
    if (nextAt == null) throw new Error(`cron "${cron}" will never match`);
    return this.ledger.create({
      kind: 'schedule',
      description,
      sessionId, workspace, urgency, budget, expiresAt,
      condition: { cron, nextAt },
    });
  }

  /**
   * Fire everything that is due.
   *
   * Exposed so the daemon and tests drive it directly — a scheduler that can
   * only be observed by waiting is a scheduler nobody tests.
   *
   * @returns {Promise<object[]>} what fired
   */
  async tick() {
    this.ledger.sweepExpired();
    const due = [];
    const now = this._now();

    for (const intent of this.ledger.list({ kind: 'schedule' })) {
      const nextAt = intent.condition?.nextAt;
      if (!Number.isFinite(nextAt) || nextAt > now) continue;

      // The budget is the choke point for every proactive message. Claiming
      // BEFORE delivering means a suppressed fire still advances the schedule
      // — otherwise a budget-blocked cron would re-fire every tick forever.
      const claim = this.ledger.claimNotification(intent.id);
      this._advance(intent, now);

      if (!claim.ok) continue;

      const missedBy = now - nextAt;
      due.push({ intent, scheduledFor: nextAt, missedBy });
      this.firedCount++;

      if (this._onFire) {
        try {
          await this._onFire(intent, { scheduledFor: nextAt, missedBy, late: missedBy > 90_000 });
        } catch {
          // A failing delivery must not stop the other due triggers, and must
          // not leave the schedule un-advanced (it already was, above).
        }
      }
    }
    return due;
  }

  /**
   * Move an intent to its next occurrence — or retire it if it was one-shot.
   *
   * For a cron that was missed while the machine slept, this skips straight to
   * the next future occurrence rather than replaying every slot in between.
   */
  _advance(intent, now) {
    const cron = intent.condition?.cron;
    if (!cron) {
      this.ledger.markFired(intent.id);
      return;
    }
    const nextAt = nextCronTime(cron, now);
    if (nextAt == null) {
      this.ledger.update(intent.id, { state: 'expired' });
      return;
    }
    this.ledger.update(intent.id, { condition: { ...intent.condition, nextAt } });
  }

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => { this.tick().catch(() => {}); }, this._intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    return this;
  }

  status() {
    return {
      running: !!this._timer,
      firedCount: this.firedCount,
      pending: this.ledger.list({ kind: 'schedule' }).length,
    };
  }
}

// ── Natural-language shorthand ──────────────────────────────────────────────

const WEEKDAYS = Object.freeze({
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5,
  saturday: 6, sat: 6,
});

/**
 * Turn a phrase like "friday", "in 20 minutes" or "every weekday at 9" into a
 * schedule spec.
 *
 * A small deterministic parser, not an LLM call: this runs inside the reflex's
 * latency budget, and "remind me in 5 minutes" should not depend on a model
 * being reachable. Returns null when nothing is recognised — the caller then
 * asks, rather than guessing at a time and being silently wrong.
 *
 * @returns {{at: number}|{cron: string}|null}
 */
export function parseWhen(text, now = Date.now()) {
  const s = String(text || '').toLowerCase();

  // Relative: "in 20 minutes", "in 2 hours"
  const rel = /\bin\s+(\d+)\s*(second|sec|minute|min|hour|hr|day)s?\b/.exec(s);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2];
    const ms = unit.startsWith('sec') ? 1000
      : unit.startsWith('min') ? 60_000
      : unit.startsWith('h') ? 3_600_000
      : 86_400_000;
    return { at: now + n * ms };
  }

  const timeMatch = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(s);
  const hour = timeMatch ? normalizeHour(parseInt(timeMatch[1], 10), timeMatch[3]) : 9;
  const minute = timeMatch && timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;

  // Repeating
  if (/\bevery\s+weekday\b/.test(s) || /\bevery\s+working\s+day\b/.test(s)) {
    return { cron: `${minute} ${hour} * * 1-5` };
  }
  if (/\bevery\s+day\b/.test(s) || /\bdaily\b/.test(s)) {
    return { cron: `${minute} ${hour} * * *` };
  }
  const everyDow = /\bevery\s+([a-z]+day|mon|tue|tues|wed|thu|thurs|fri|sat|sun)\b/.exec(s);
  if (everyDow && WEEKDAYS[everyDow[1]] !== undefined) {
    return { cron: `${minute} ${hour} * * ${WEEKDAYS[everyDow[1]]}` };
  }
  if (/\bevery\s+hour\b/.test(s) || /\bhourly\b/.test(s)) return { cron: '0 * * * *' };

  // A named weekday: the NEXT one, not this week's if it has passed.
  const dow = /\b(?:on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thurs|fri|sat)\b/.exec(s);
  if (dow) return { at: nextWeekday(WEEKDAYS[dow[1]], hour, minute, now) };

  if (/\btomorrow\b/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(hour, minute, 0, 0);
    return { at: d.getTime() };
  }
  if (/\btonight\b/.test(s)) {
    const d = new Date(now);
    d.setHours(timeMatch ? hour : 20, minute, 0, 0);
    return { at: d.getTime() > now ? d.getTime() : d.getTime() + 86_400_000 };
  }
  // A bare time with no day: today if it is still ahead, else tomorrow.
  if (timeMatch) {
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    return { at: d.getTime() > now ? d.getTime() : d.getTime() + 86_400_000 };
  }
  return null;
}

function normalizeHour(h, meridiem) {
  if (!meridiem) return h;
  if (meridiem === 'pm') return h === 12 ? 12 : h + 12;
  return h === 12 ? 0 : h;
}

function nextWeekday(target, hour, minute, now) {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  let delta = (target - d.getDay() + 7) % 7;
  // "Friday" said on a Friday afternoon means next Friday, not four hours ago.
  if (delta === 0 && d.getTime() <= now) delta = 7;
  d.setDate(d.getDate() + delta);
  return d.getTime();
}
