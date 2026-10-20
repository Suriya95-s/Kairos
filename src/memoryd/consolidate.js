// src/memoryd/consolidate.js
// Sleep (5.4): the maintenance that keeps memory from becoming a landfill.
//
// The machinery for this mostly existed already — `offlineConsolidation.js`,
// the Palace's decay, the skill consolidator — and all of it ran only when
// someone remembered to invoke it manually, which is to say never. A daemon
// changes that: there is now a process that is awake at 4am with nothing to do.
//
// Three things happen here, in order:
//
//   1. **Decay** — importance of non-durable memories falls with disuse.
//      Preferences and decisions are exempt: a preference does not become less
//      true because nobody asked about it this month.
//   2. **Merge** — near-duplicates collapse into the strongest survivor. Ten
//      recordings of "the tests are slow" should be one fact held firmly, not
//      ten weak ones that crowd out everything else in a recall.
//   3. **Prune** — what has decayed below the floor is dropped, and each scope
//      is capped so one runaway project cannot starve recall everywhere else.
//
// Consolidation only runs when the system is idle. Competing with a live
// mission for the database — and for the CPU — to tidy up is exactly the wrong
// trade, and the work is never urgent.

const DEFAULTS = Object.freeze({
  /** Fraction of importance retained per idle period, for non-durable kinds. */
  decayFactor: 0.92,
  /** Below this, a memory is no longer worth carrying. */
  pruneFloor: 0.08,
  /** Maximum live memories per scope. */
  scopeCap: 2000,
  /**
   * Jaccard similarity above which two memories are the same thing.
   *
   * 0.8 = four of five tokens shared. Tuned against the case that matters in
   * both directions: "the integration test suite is very slow" vs "...is slow"
   * scores 0.83 and SHOULD merge, while "the tests are slow" vs "the tests are
   * fast" scores 0.6 and must not — merging opposites would have the system
   * confidently remember the negation of what it was told.
   */
  mergeThreshold: 0.8,
  /** Kinds that never decay. */
  durableKinds: Object.freeze(['preference', 'decision']),
});

/**
 * Run one consolidation pass.
 *
 * @param {object} service MemoryService
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] compute the plan, change nothing
 * @returns {{decayed: number, merged: number, pruned: number, scanned: number, dryRun: boolean}}
 */
export function consolidate(service, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const dryRun = !!opts.dryRun;
  service.open();

  const rows = service.list({ limit: 100_000 });
  let decayed = 0, merged = 0, pruned = 0;

  // ── 1. Decay ──────────────────────────────────────────────────────
  const survivors = [];
  for (const row of rows) {
    if (cfg.durableKinds.includes(row.kind)) { survivors.push(row); continue; }

    // Something recalled recently has proven its worth; decay only what has
    // gone unused. Without this, an actively-used memory would still fade and
    // the system would forget precisely what it keeps needing.
    const usedRecently = row.last_access && (service._now() - row.last_access) < 7 * 86_400_000;
    if (usedRecently) { survivors.push(row); continue; }

    const next = row.importance * cfg.decayFactor;
    decayed++;
    if (next < cfg.pruneFloor) {
      if (!dryRun) service.forget(row.id);
      pruned++;
      continue;
    }
    if (!dryRun) service._setImportance(row.id, next);
    survivors.push({ ...row, importance: next });
  }

  // ── 2. Merge near-duplicates within a scope ───────────────────────
  const byScope = new Map();
  for (const row of survivors) {
    if (!byScope.has(row.scope)) byScope.set(row.scope, []);
    byScope.get(row.scope).push(row);
  }

  for (const [, group] of byScope) {
    // Strongest first, so the survivor of any merge is the best-evidenced one.
    group.sort((a, b) => b.importance - a.importance || b.ts - a.ts);
    const kept = [];
    for (const row of group) {
      const twin = kept.find(k => k.kind === row.kind && similarity(k.body, row.body) >= cfg.mergeThreshold);
      if (!twin) { kept.push(row); continue; }
      // The duplicate is evidence FOR the survivor, not noise to discard
      // silently: repetition means the thing kept being true.
      const bumped = Math.min(1, twin.importance + 0.03);
      if (!dryRun) {
        service._setImportance(twin.id, bumped);
        service.forget(row.id);
      }
      twin.importance = bumped;
      merged++;
    }

    // ── 3. Cap the scope ────────────────────────────────────────────
    if (kept.length > cfg.scopeCap) {
      const excess = kept
        .sort((a, b) => a.importance - b.importance || a.ts - b.ts)
        .slice(0, kept.length - cfg.scopeCap);
      for (const row of excess) {
        if (cfg.durableKinds.includes(row.kind)) continue; // never capped away
        if (!dryRun) service.forget(row.id);
        pruned++;
      }
    }
  }

  return { decayed, merged, pruned, scanned: rows.length, dryRun };
}

/**
 * Token-overlap similarity (Jaccard), 0..1.
 *
 * Lexical on purpose. Embeddings would be better at "the suite is slow" vs
 * "tests take forever", but they need an endpoint that may be down — and a
 * consolidation pass that silently stops working when the model server is
 * unreachable would let memory grow unbounded with nobody watching.
 */
export function similarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

function tokenize(text) {
  return new Set(
    String(text || '').toLowerCase().split(/\W+/).filter(t => t.length > 2)
  );
}

// ── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Runs consolidation when the system is idle.
 *
 * "Idle" is asked of the host rather than inferred, because only the daemon
 * knows whether a mission is mid-write. A timer that fired regardless would
 * contend with live work for the same database.
 */
export class ConsolidationScheduler {
  /**
   * @param {object} opts
   * @param {object} opts.service        MemoryService
   * @param {function} opts.isIdle       () => boolean
   * @param {number} [opts.intervalMs]   how often to consider running
   * @param {number} [opts.minIdleMs]    how long idle before it is worth doing
   * @param {function} [opts.onRun]      called with each pass's result
   * @param {function} [opts.extra]      additional work (palace decay, skills)
   * @param {function} [opts.now]
   */
  constructor({
    service,
    isIdle = () => true,
    intervalMs = 30 * 60_000,
    minIdleMs = 5 * 60_000,
    onRun = null,
    extra = null,
    now = Date.now,
  } = {}) {
    if (!service) throw new Error('ConsolidationScheduler needs a memory service');
    this.service = service;
    this._isIdle = isIdle;
    this._intervalMs = intervalMs;
    this._minIdleMs = minIdleMs;
    this._onRun = onRun;
    this._extra = extra;
    this._now = now;
    this._timer = null;
    this._idleSince = null;
    this.lastRun = null;
    this.runCount = 0;
  }

  /**
   * One scheduler tick. Exposed so the daemon and tests drive it directly
   * rather than waiting on wall-clock timers.
   * @returns {Promise<object|null>} the pass result, or null when skipped
   */
  async tick() {
    const idle = !!this._isIdle();
    if (!idle) {
      this._idleSince = null;
      return null;
    }
    if (this._idleSince == null) {
      this._idleSince = this._now();
      return null;
    }
    // Wait out a settling period. A gap between two missions is not the same
    // as an idle machine, and consolidating in that gap delays the next job.
    if (this._now() - this._idleSince < this._minIdleMs) return null;

    return this.runNow();
  }

  /** Consolidate immediately, idle or not. */
  async runNow() {
    let result;
    try {
      result = consolidate(this.service);
    } catch (err) {
      // Maintenance must never be able to take down a daemon that was
      // otherwise healthy.
      result = { error: err.message, decayed: 0, merged: 0, pruned: 0, scanned: 0 };
    }

    if (typeof this._extra === 'function') {
      try {
        result.extra = await this._extra();
      } catch (err) {
        result.extra = { error: err.message };
      }
    }

    this.lastRun = this._now();
    this.runCount++;
    // Reset so the next pass waits out another full idle period rather than
    // running again on the very next tick.
    this._idleSince = this._now();

    if (typeof this._onRun === 'function') {
      try { this._onRun(result); } catch { /* reporting must not break the pass */ }
    }
    return result;
  }

  /** Start the background timer. Unref'd — it must never hold the process open. */
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
      runCount: this.runCount,
      lastRun: this.lastRun,
      idleSince: this._idleSince,
      intervalMs: this._intervalMs,
      minIdleMs: this._minIdleMs,
    };
  }
}

export { DEFAULTS as CONSOLIDATION_DEFAULTS };
