// src/trust/approvals.js
// Standing approvals (7.2): "always allow calendar-create".
//
// Confirming every single calendar event is how a trust gate gets disabled
// wholesale — people do not tolerate friction that never decreases, and the
// version of this system that asks forty times a day is the version whose owner
// sets `hitlEnabled=0` and loses every other protection with it. So the gate has
// to be able to learn.
//
// What it must never learn is anything irreversible. A standing approval is a
// statement about a *class* of future actions, made before any of them exist;
// that is a reasonable thing to say about "create a calendar event" and an
// unreasonable thing to say about "delete the production database". T3 is
// therefore excluded at grant time, at match time, and in the CLI — three
// checks for one rule, because a single missed path is the entire guarantee.
//
// Scoping is deliberately narrow by default:
//   tool         required — never a blanket "allow everything"
//   workspace    optional; absent means any
//   argMatch     optional literal/prefix constraints on specific arguments
//   expiresAt    optional; a grant made in a hurry should not last forever
//   maxUses      optional; "just this once, but don't ask again for the retry"

import { randomUUID } from 'node:crypto';

import {
  SCHEMA_VERSION,
  file as kernelFile,
  readRegistry,
  writeRegistry,
  migrateRegistry,
} from '../kernel/paths.js';
import { classify, canGrantStanding, tierRank } from './tiers.js';

const MIGRATIONS = { 1: (data) => ({ approvals: data.approvals || {}, ...data }) };

export class StandingApprovals {
  constructor({ filePath = null, now = Date.now, newId = null, persist = true, onAudit = null } = {}) {
    this._filePath = filePath;
    this._now = now;
    this._newId = newId || (() => `sa-${randomUUID().slice(0, 8)}`);
    this._persist = persist;
    this._onAudit = onAudit;
    this._approvals = new Map();
    this._loaded = false;
  }

  get filePath() { return this._filePath || kernelFile('standing-approvals.json'); }

  load() {
    if (this._loaded) return this;
    this._loaded = true;
    if (!this._persist) return this;
    const raw = readRegistry(this.filePath, null);
    if (raw) {
      const { data } = migrateRegistry(raw, MIGRATIONS, SCHEMA_VERSION);
      for (const [id, rec] of Object.entries(data.approvals || {})) this._approvals.set(id, { ...rec, id });
    }
    return this;
  }

  save() {
    if (!this._persist) return this;
    const approvals = {};
    for (const [id, rec] of this._approvals) approvals[id] = rec;
    writeRegistry(this.filePath, { schemaVersion: SCHEMA_VERSION, approvals });
    return this;
  }

  _snapshot(rec) { return JSON.parse(JSON.stringify(rec)); }

  /**
   * Grant a standing approval.
   *
   * @param {object} spec
   * @param {string} spec.tool
   * @param {string} [spec.workspace]  restrict to one project
   * @param {object} [spec.argMatch]   {argName: 'literal' | {prefix: '...'}}
   * @param {number} [spec.expiresAt]
   * @param {number} [spec.maxUses]
   * @param {string} [spec.grantedBy]  who said yes — this is an audit record
   * @throws when the tool's tier forbids standing approval
   */
  grant({ tool, workspace = null, argMatch = null, expiresAt = null, maxUses = null, grantedBy = 'user', reason = '', tier = null } = {}) {
    this.load();
    if (!tool) throw new Error('a standing approval must name a tool — there is no blanket allow');

    // Classify with NO arguments: a standing approval covers future calls whose
    // arguments are not yet known, so it must be judged at the tool's ceiling.
    // Granting on `run_command` while looking at `ls` would authorise `rm -rf`.
    const resolved = tier || worstCaseTier(tool);
    if (!canGrantStanding(resolved)) {
      throw new Error(
        `"${tool}" is ${resolved} (irreversible) — standing approval is not available for it. ` +
        `Actions that cannot be taken back are confirmed every time, by design.`
      );
    }

    const ts = this._now();
    const id = this._newId();
    const rec = {
      id, tool, workspace, argMatch, expiresAt, maxUses,
      tier: resolved,
      grantedBy, reason,
      createdAt: ts,
      uses: 0,
      lastUsedAt: null,
      revokedAt: null,
    };
    this._approvals.set(id, rec);
    this.save();
    this._audit({ action: 'granted', id, tool, tier: resolved, workspace, grantedBy });
    return this._snapshot(rec);
  }

  /**
   * Find a live standing approval covering this call.
   *
   * Returns null rather than throwing when nothing matches — "no standing
   * approval" is the normal case, not an error.
   */
  find(tool, args = {}, { workspace = null } = {}) {
    this.load();
    const now = this._now();

    for (const rec of this._approvals.values()) {
      if (rec.revokedAt) continue;
      if (rec.tool !== tool) continue;
      if (rec.expiresAt && now >= rec.expiresAt) continue;
      if (rec.maxUses != null && rec.uses >= rec.maxUses) continue;
      if (rec.workspace && rec.workspace !== workspace) continue;
      if (!argsMatch(rec.argMatch, args)) continue;

      // Re-check the tier against the ACTUAL arguments. A standing approval on
      // `run_command` is legitimate for `npm test`; the same grant must not
      // cover `rm -rf /` just because the tool name matches. This is the check
      // that makes argument-sensitive tiers meaningful.
      const actual = classify(tool, args).tier;
      if (!canGrantStanding(actual)) continue;
      if (tierRank(actual) > tierRank(rec.tier)) continue;

      return this._snapshot(rec);
    }
    return null;
  }

  /** Record a use. Separate from find() so a dry-run check costs nothing. */
  recordUse(id) {
    this.load();
    const rec = this._approvals.get(id);
    if (!rec) return null;
    rec.uses++;
    rec.lastUsedAt = this._now();
    this.save();
    return this._snapshot(rec);
  }

  revoke(id) {
    this.load();
    const rec = this._approvals.get(id);
    if (!rec || rec.revokedAt) return false;
    rec.revokedAt = this._now();
    this.save();
    this._audit({ action: 'revoked', id, tool: rec.tool });
    return true;
  }

  /** Revoke everything. The panic button, and it must be one call. */
  revokeAll() {
    this.load();
    let n = 0;
    for (const rec of this._approvals.values()) {
      if (rec.revokedAt) continue;
      rec.revokedAt = this._now();
      n++;
    }
    if (n) { this.save(); this._audit({ action: 'revoked_all', count: n }); }
    return n;
  }

  /** Live approvals, for `trust` to display. */
  list({ includeRevoked = false } = {}) {
    this.load();
    const now = this._now();
    return [...this._approvals.values()]
      .filter(r => includeRevoked || (!r.revokedAt && !(r.expiresAt && now >= r.expiresAt)))
      .map(r => this._snapshot(r))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  _audit(entry) {
    if (typeof this._onAudit !== 'function') return;
    try { this._onAudit({ ...entry, ts: this._now(), kind: 'standing_approval' }); } catch { /* never break a grant */ }
  }
}

/**
 * The tier a tool could reach with the worst arguments it might be given.
 *
 * For argument-sensitive tools this is what a standing approval is judged
 * against, because the grant is made before the arguments exist.
 */
export function worstCaseTier(tool) {
  const plain = classify(tool, {}).tier;
  if (tool !== 'run_command') return plain;
  // The shell can reach T3. A standing approval on it is therefore only
  // available with argMatch constraints, which are re-checked per call.
  return 'T2';
}

/**
 * Do a call's arguments satisfy a constraint set?
 *
 * An absent constraint set matches everything, which is why `grant()` requires
 * a tool name and why the CLI encourages constraints — an unconstrained
 * standing approval on a T2 tool is a broad thing to hand out.
 */
export function argsMatch(argMatch, args) {
  if (!argMatch) return true;
  for (const [key, expected] of Object.entries(argMatch)) {
    const actual = args?.[key];
    if (expected && typeof expected === 'object') {
      if (typeof expected.prefix === 'string') {
        if (typeof actual !== 'string' || !actual.startsWith(expected.prefix)) return false;
        continue;
      }
      if (Array.isArray(expected.oneOf)) {
        if (!expected.oneOf.includes(actual)) return false;
        continue;
      }
      // An unrecognised constraint shape must not silently match everything.
      return false;
    }
    if (actual !== expected) return false;
  }
  return true;
}

let _approvals = null;
export function getStandingApprovals(opts) {
  if (!_approvals) _approvals = new StandingApprovals(opts);
  return _approvals;
}
export function resetStandingApprovals() { _approvals = null; }
