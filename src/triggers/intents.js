// src/triggers/intents.js
// Standing intents (6.3): "tell me whenever X".
//
// Everything proactive in the system points back to one of these. A timer, a
// watcher, a follow-up — each exists because the user once expressed a standing
// wish, and each notification it produces has to be traceable to that wish.
// Without that link, proactivity is just a program that talks at you.
//
// The load-bearing field is `notifyBudget`. An agent that can initiate contact
// needs a hard ceiling on how often, set when the intent is created and
// enforced by the ledger rather than by the good manners of whatever is doing
// the notifying. "Tell me if the build breaks" must not become forty messages
// because the build is broken forty times in an hour — and the fortieth
// message is the one that makes someone turn the whole system off.
//
// Budgets are refusals, not suggestions: `claimNotification()` returns false
// and the caller has no way to send anyway.

import { randomUUID } from 'node:crypto';

import {
  SCHEMA_VERSION,
  file as kernelFile,
  readRegistry,
  writeRegistry,
  migrateRegistry,
} from '../kernel/paths.js';

/** How an intent is satisfied. */
export const INTENT_KINDS = Object.freeze([
  'schedule',    // at a time, or on a repeating schedule (6.1)
  'watch',       // when an observed thing changes (6.2)
  'followup',    // unfinished work to resurface (6.4)
]);

export const INTENT_STATES = Object.freeze(['active', 'paused', 'fired', 'expired', 'cancelled']);

/** Default ceiling: enough to be useful, low enough that a loop is survivable. */
export const DEFAULT_BUDGET = Object.freeze({ max: 5, windowMs: 3_600_000 });

const MIGRATIONS = { 1: (data) => ({ intents: data.intents || {}, ...data }) };

export class IntentLedger {
  /**
   * @param {object} [opts]
   * @param {string} [opts.filePath]
   * @param {object} [opts.bus]
   * @param {function} [opts.now]
   * @param {boolean} [opts.persist]
   */
  constructor({ filePath = null, bus = null, now = Date.now, newId = null, persist = true } = {}) {
    this._filePath = filePath;
    this._bus = bus;
    this._now = now;
    this._newId = newId || (() => `i-${randomUUID().slice(0, 8)}`);
    this._persist = persist;
    this._intents = new Map();
    this._loaded = false;
  }

  get filePath() {
    return this._filePath || kernelFile('intents.json');
  }

  load() {
    if (this._loaded) return this;
    this._loaded = true;
    if (!this._persist) return this;
    const raw = readRegistry(this.filePath, null);
    if (raw) {
      const { data } = migrateRegistry(raw, MIGRATIONS, SCHEMA_VERSION);
      for (const [id, rec] of Object.entries(data.intents || {})) this._intents.set(id, { ...rec, id });
    }
    return this;
  }

  save() {
    if (!this._persist) return this;
    const intents = {};
    for (const [id, rec] of this._intents) intents[id] = rec;
    writeRegistry(this.filePath, { schemaVersion: SCHEMA_VERSION, intents });
    return this;
  }

  _snapshot(rec) { return JSON.parse(JSON.stringify(rec)); }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Register a standing intent.
   *
   * @param {object} spec
   * @param {string} spec.kind        schedule | watch | followup
   * @param {string} spec.description what the user asked for, in their words
   * @param {object} [spec.condition] kind-specific payload
   * @param {string} [spec.sessionId] who to tell
   * @param {string} [spec.workspace]
   * @param {number} [spec.expiresAt] absolute ms; null = until cancelled
   * @param {object} [spec.budget]    {max, windowMs}
   * @param {string} [spec.urgency]   now | soon | whenever
   */
  create({
    kind, description, condition = {}, sessionId = null, workspace = null,
    expiresAt = null, budget = null, urgency = 'soon', missionId = null,
  } = {}) {
    this.load();
    if (!INTENT_KINDS.includes(kind)) {
      throw new Error(`unknown intent kind "${kind}" (expected: ${INTENT_KINDS.join(', ')})`);
    }
    if (!description) throw new Error('an intent needs a description — it is what the user gets told about');

    const ts = this._now();
    const id = this._newId();
    const rec = {
      id, kind, description, condition, sessionId, workspace, missionId,
      urgency,
      state: 'active',
      createdAt: ts,
      updatedAt: ts,
      expiresAt,
      // A budget the caller cannot opt out of. `max: 0` is the way to say
      // "never notify"; there is no way to say "unlimited".
      budget: { ...DEFAULT_BUDGET, ...(budget || {}) },
      notifications: [],     // timestamps within the current window
      notifyCount: 0,        // lifetime, for reporting
      lastFiredAt: null,
      suppressedCount: 0,
    };
    this._intents.set(id, rec);
    this.save();
    this._emit(rec, 'created');
    return this._snapshot(rec);
  }

  get(id) {
    this.load();
    const rec = this._intents.get(id);
    return rec ? this._snapshot(rec) : null;
  }

  /** Active intents of a kind, oldest first (so ties fire in creation order). */
  list({ kind = null, state = 'active', sessionId = null } = {}) {
    this.load();
    let all = [...this._intents.values()].map(r => this._snapshot(r));
    if (kind) all = all.filter(r => r.kind === kind);
    if (state) all = all.filter(r => r.state === state);
    if (sessionId) all = all.filter(r => r.sessionId === sessionId);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }

  update(id, patch = {}) {
    this.load();
    const rec = this._intents.get(id);
    if (!rec) throw new Error(`unknown intent "${id}"`);
    if (patch.state && !INTENT_STATES.includes(patch.state)) {
      throw new Error(`invalid intent state "${patch.state}"`);
    }
    const { id: _i, createdAt: _c, ...safe } = patch;
    const next = { ...rec, ...safe, updatedAt: this._now() };
    this._intents.set(id, next);
    this.save();
    this._emit(next, 'updated');
    return this._snapshot(next);
  }

  cancel(id) { return this.update(id, { state: 'cancelled' }); }
  pause(id)  { return this.update(id, { state: 'paused' }); }
  resume(id) { return this.update(id, { state: 'active' }); }

  /** Remove terminal intents older than a cutoff. */
  purge({ olderThanMs = 30 * 86_400_000 } = {}) {
    this.load();
    const cutoff = this._now() - olderThanMs;
    const removed = [];
    for (const [id, rec] of [...this._intents]) {
      if (rec.state === 'active' || rec.state === 'paused') continue;
      if (rec.updatedAt > cutoff) continue;
      this._intents.delete(id);
      removed.push(id);
    }
    if (removed.length) this.save();
    return removed;
  }

  // ── Firing and budgets ────────────────────────────────────────────────────

  /**
   * Has this intent run out of road? Checks expiry, not budget.
   * Expiring is a state change; being over budget is temporary.
   */
  isExpired(rec, now = null) {
    const ts = now ?? this._now();
    return !!(rec.expiresAt && ts >= rec.expiresAt);
  }

  /** Expire everything past its date. Returns the ids expired. */
  sweepExpired() {
    this.load();
    const expired = [];
    for (const rec of this._intents.values()) {
      if (rec.state !== 'active') continue;
      if (!this.isExpired(rec)) continue;
      this.update(rec.id, { state: 'expired' });
      expired.push(rec.id);
    }
    return expired;
  }

  /** Notifications still available in the current window. */
  remainingBudget(id) {
    this.load();
    const rec = this._intents.get(id);
    if (!rec) return 0;
    const cutoff = this._now() - rec.budget.windowMs;
    const live = rec.notifications.filter(t => t > cutoff);
    return Math.max(0, rec.budget.max - live.length);
  }

  /**
   * Claim one notification slot.
   *
   * The single choke point for every proactive message in the system. Returns
   * false when the budget is spent, and the caller has no other route — this is
   * a refusal, not advice.
   *
   * @returns {{ok: boolean, remaining: number, reason?: string}}
   */
  claimNotification(id) {
    this.load();
    const rec = this._intents.get(id);
    if (!rec) return { ok: false, remaining: 0, reason: 'unknown intent' };
    if (rec.state !== 'active') return { ok: false, remaining: 0, reason: `intent is ${rec.state}` };
    if (this.isExpired(rec)) {
      this.update(id, { state: 'expired' });
      return { ok: false, remaining: 0, reason: 'intent has expired' };
    }

    const now = this._now();
    const cutoff = now - rec.budget.windowMs;
    // Prune as we go: an intent alive for months must not accumulate an
    // unbounded array of timestamps in a file that is rewritten on every save.
    const live = rec.notifications.filter(t => t > cutoff);

    if (live.length >= rec.budget.max) {
      rec.notifications = live;
      rec.suppressedCount++;
      this.save();
      this._emit(rec, 'suppressed');
      return {
        ok: false,
        remaining: 0,
        reason: `notification budget reached (${rec.budget.max} per ${Math.round(rec.budget.windowMs / 60_000)}m)`,
      };
    }

    live.push(now);
    rec.notifications = live;
    rec.notifyCount++;
    rec.lastFiredAt = now;
    rec.updatedAt = now;
    this.save();
    this._emit(rec, 'fired');
    return { ok: true, remaining: rec.budget.max - live.length };
  }

  /** Mark a one-shot intent as done. */
  markFired(id) { return this.update(id, { state: 'fired', lastFiredAt: this._now() }); }

  _emit(rec, action) {
    if (!this._bus) return;
    try {
      this._bus.publish({
        source: 'system',
        kind: 'trigger',
        sessionId: rec.sessionId || null,
        urgency: action === 'fired' ? (rec.urgency || 'soon') : 'whenever',
        payload: {
          action,
          intentId: rec.id,
          kind: rec.kind,
          description: rec.description,
          state: rec.state,
          notifyCount: rec.notifyCount,
          suppressedCount: rec.suppressedCount,
        },
      });
    } catch {
      // The ledger is the source of truth; a bus failure must not roll back a
      // committed budget claim, or the budget stops being a ceiling.
    }
  }
}

let _ledger = null;
export function getIntentLedger(opts) {
  if (!_ledger) _ledger = new IntentLedger(opts);
  return _ledger;
}
export function resetIntentLedger() { _ledger = null; }
