// src/memoryd/service.js
// The daemon-owned memory service (5.1).
//
// One database at ~/.<brand>/memory/, keyed by (identity, scope) per D5, with a
// single recall API that the reflex, missions and the router all call. Before
// this, "memory" meant whichever `.agent/` directory the process happened to be
// standing in, which is why telling it a preference in a chat window and then
// starting a mission in a different repo produced an assistant with amnesia.
//
// This is a NEW table rather than a `scope` column bolted onto the Palace's
// `memories` table. The Palace is a chronological episodic index with its own
// bucket/decay invariants and a lot of tests resting on them; widening its
// primary key would put every one of those at risk to gain a column. 5.2 will
// import Palace content in here under `project:<path>` — an import is a
// reversible operation, a schema change to a live store is not.
//
// Ranking is lexical + recency + importance, deliberately. Embeddings need an
// endpoint that may be down (S3), and a recall path that stops working when the
// model server does is worse than one that is merely less clever.

import { DatabaseSync } from 'node:sqlite'; // built-in since Node 22.5
import fs from 'node:fs';
import path from 'node:path';

import { dir as kernelDir } from '../kernel/paths.js';
import { GLOBAL, isValidScope, scopesFor, isScopeAllowed } from './scopes.js';

/** What kind of thing a memory is. Drives default importance and decay. */
export const MEMORY_KINDS = Object.freeze([
  'preference',   // standing user preference — the reason global scope exists
  'fact',         // something true about the world or the project
  'decision',     // a choice made, and ideally why
  'event',        // something that happened
  'skill',        // a procedure that worked
]);

/** Kinds that should not decay: a stated preference does not become less true. */
const DURABLE_KINDS = Object.freeze(['preference', 'decision']);

const DEFAULT_IMPORTANCE = Object.freeze({
  preference: 0.9, decision: 0.8, skill: 0.7, fact: 0.5, event: 0.3,
});

export class MemoryService {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dbPath]   default ~/.<brand>/memory/memory.db
   * @param {function} [opts.now]
   * @param {function} [opts.onAudit] called for cross-scope reads
   */
  constructor({ dbPath = null, now = Date.now, onAudit = null } = {}) {
    this._dbPath = dbPath;
    this._now = now;
    this._onAudit = onAudit;
    this._db = null;
  }

  get dbPath() {
    return this._dbPath || path.join(kernelDir('memory'), 'memory.db');
  }

  /** Open (and create) the database. Idempotent. */
  open() {
    if (this._db) return this;
    const p = this.dbPath;
    if (p !== ':memory:') fs.mkdirSync(path.dirname(p), { recursive: true });

    this._db = new DatabaseSync(p);
    this._db.exec('PRAGMA journal_mode = WAL');
    this._db.exec('PRAGMA busy_timeout = 5000');
    this._db.exec('PRAGMA synchronous = NORMAL');
    this._initSchema();
    return this;
  }

  _initSchema() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          REAL    NOT NULL,
        identity    TEXT    NOT NULL DEFAULT 'default',
        scope       TEXT    NOT NULL DEFAULT 'global',
        kind        TEXT    NOT NULL DEFAULT 'fact',
        subject     TEXT    NOT NULL DEFAULT '',
        body        TEXT    NOT NULL,
        source      TEXT    NOT NULL DEFAULT '',
        importance  REAL    NOT NULL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_access REAL,
        superseded_by INTEGER,
        UNIQUE(identity, scope, kind, subject, body)
      );

      -- Every recall filters on (identity, scope) first; without this index
      -- that is a full scan of everything the system has ever learned.
      CREATE INDEX IF NOT EXISTS idx_identity_scope ON facts(identity, scope);
      CREATE INDEX IF NOT EXISTS idx_scope_ts       ON facts(scope, ts);
      CREATE INDEX IF NOT EXISTS idx_subject        ON facts(subject);
    `);
  }

  close() {
    if (!this._db) return;
    try { this._db.close(); } catch { /* already closed */ }
    this._db = null;
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  /**
   * Record something.
   *
   * Re-remembering the same fact in the same scope is an UPDATE, not a second
   * row: a preference restated three times is one preference held firmly, and
   * duplicate rows would let repetition quietly outrank importance at recall.
   *
   * @returns {object} the stored record
   */
  remember({ body, subject = '', kind = 'fact', scope = GLOBAL, identity = 'default', source = '', importance = null }) {
    this.open();
    if (!body || typeof body !== 'string') throw new Error('a memory needs a body');
    if (!MEMORY_KINDS.includes(kind)) {
      throw new Error(`unknown memory kind "${kind}" (expected: ${MEMORY_KINDS.join(', ')})`);
    }
    if (!isValidScope(scope)) throw new Error(`invalid scope "${scope}"`);

    const ts = this._now();
    const weight = importance ?? DEFAULT_IMPORTANCE[kind] ?? 0.5;

    const existing = this._db.prepare(
      `SELECT id, importance FROM facts
        WHERE identity = ? AND scope = ? AND kind = ? AND subject = ? AND body = ?`
    ).get(identity, scope, kind, subject, body);

    if (existing) {
      // Restating something makes it slightly more important, capped at 1.
      const bumped = Math.min(1, existing.importance + 0.05);
      this._db.prepare('UPDATE facts SET ts = ?, importance = ? WHERE id = ?')
        .run(ts, bumped, existing.id);
      return this.get(existing.id);
    }

    const info = this._db.prepare(
      `INSERT INTO facts (ts, identity, scope, kind, subject, body, source, importance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(ts, identity, scope, kind, subject, body, source, weight);

    return this.get(Number(info.lastInsertRowid));
  }

  /**
   * Replace a fact with a newer one, keeping the old row.
   *
   * History matters here: "we decided Postgres" superseding "we decided MySQL"
   * is a different thing from the second decision never having had a first.
   */
  supersede(oldId, next) {
    this.open();
    const replacement = this.remember(next);
    this._db.prepare('UPDATE facts SET superseded_by = ? WHERE id = ?').run(replacement.id, oldId);
    return replacement;
  }

  get(id) {
    this.open();
    return this._db.prepare('SELECT * FROM facts WHERE id = ?').get(id) ?? null;
  }

  forget(id) {
    this.open();
    const info = this._db.prepare('DELETE FROM facts WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /** Drop everything in a scope — e.g. when a project directory is deleted. */
  forgetScope(scope, identity = 'default') {
    this.open();
    return this._db.prepare('DELETE FROM facts WHERE identity = ? AND scope = ?')
      .run(identity, scope).changes;
  }

  // ── Recall ────────────────────────────────────────────────────────────────

  /**
   * The single recall API. Reflex, missions and router all come through here.
   *
   * @param {object} opts
   * @param {string} [opts.query]     free text; empty returns the most salient
   * @param {string} [opts.layer]     'reflex' | 'mission' | 'router' | 'system'
   * @param {string[]} [opts.scopes]  explicit scopes; overrides `layer`
   * @param {string} [opts.sessionId]
   * @param {string} [opts.workspace]
   * @param {number} [opts.limit]
   * @param {boolean} [opts.crossScope] allow scopes outside the layer's policy
   * @returns {object[]} ranked memories
   */
  recall({
    query = '', layer = 'mission', scopes = null, sessionId = null, workspace = null,
    identity = 'default', limit = 10, crossScope = false, kinds = null,
  } = {}) {
    this.open();

    const allowed = scopesFor(layer, { sessionId, workspace });
    let effective = scopes && scopes.length ? scopes : allowed;

    if (scopes && scopes.length && !crossScope) {
      // Silently returning fewer results would look like "it forgot"; refusing
      // makes the policy visible at the call site where it can be fixed.
      const denied = scopes.filter(s => !isScopeAllowed(layer, s, { sessionId, workspace }));
      if (denied.length) {
        throw new Error(
          `layer "${layer}" may not read ${denied.join(', ')} — ` +
          `pass crossScope: true to override, which is audited.`
        );
      }
    }
    if (crossScope && scopes) {
      this._audit({ layer, scopes, query, identity });
      effective = scopes;
    }

    if (!effective.length) return [];

    const placeholders = effective.map(() => '?').join(',');
    const params = [identity, ...effective];
    let sql = `SELECT * FROM facts
                WHERE identity = ? AND scope IN (${placeholders})
                  AND superseded_by IS NULL`;
    if (kinds && kinds.length) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    // Bounded read: rank in JS over a recent window rather than pulling the
    // whole table. 500 is far more than any recall will surface and keeps the
    // query O(index scan) as memory grows.
    sql += ' ORDER BY ts DESC LIMIT 500';

    const rows = this._db.prepare(sql).all(...params);
    const ranked = rows
      .map(row => ({ ...row, score: this._score(row, query) }))
      .filter(row => !query || row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    this._touch(ranked.map(r => r.id));
    return ranked;
  }

  /**
   * Relevance = lexical overlap × importance × recency.
   *
   * With no query this collapses to importance × recency, which is the right
   * answer for "what should I know before starting?".
   */
  _score(row, query) {
    const importance = row.importance ?? 0.5;

    // Durable kinds do not fade. A stated preference is not less true in March
    // because it was stated in January.
    const ageDays = Math.max(0, (this._now() - row.ts) / 86_400_000);
    const recency = DURABLE_KINDS.includes(row.kind)
      ? 1
      : 1 / (1 + ageDays / 30);

    if (!query) return importance * recency;

    const terms = String(query).toLowerCase().split(/\W+/).filter(t => t.length > 2);
    if (!terms.length) return importance * recency;

    const haystack = `${row.subject} ${row.body}`.toLowerCase();
    let hits = 0;
    for (const term of terms) if (haystack.includes(term)) hits++;
    if (hits === 0) return 0;

    const overlap = hits / terms.length;
    return overlap * importance * recency;
  }

  /**
   * Set a memory's importance directly. Used by consolidation (5.4), which owns
   * decay; ordinary writers should go through remember() so the upsert rules
   * apply.
   */
  _setImportance(id, importance) {
    this.open();
    const clamped = Math.max(0, Math.min(1, Number(importance) || 0));
    this._db.prepare('UPDATE facts SET importance = ? WHERE id = ?').run(clamped, id);
    return clamped;
  }

  /** Record that a memory was used — input to consolidation (5.4). */
  _touch(ids) {
    if (!ids.length) return;
    const ts = this._now();
    const stmt = this._db.prepare('UPDATE facts SET access_count = access_count + 1, last_access = ? WHERE id = ?');
    for (const id of ids) {
      try { stmt.run(ts, id); } catch { /* a concurrent forget is not an error */ }
    }
  }

  _audit(entry) {
    if (typeof this._onAudit !== 'function') return;
    try { this._onAudit({ ...entry, ts: this._now() }); } catch { /* auditing must not break recall */ }
  }

  /**
   * Render recalled memories as the context block the reflex and missions inject.
   * Kept here so every layer formats memory identically.
   */
  recallText(opts) {
    const rows = this.recall(opts);
    if (!rows.length) return '';
    return rows.map(r => `- ${r.subject ? `${r.subject}: ` : ''}${r.body}`).join('\n');
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  /** Everything in a scope, newest first. */
  list({ scope = null, identity = 'default', limit = 100 } = {}) {
    this.open();
    if (scope) {
      return this._db.prepare(
        'SELECT * FROM facts WHERE identity = ? AND scope = ? ORDER BY ts DESC LIMIT ?'
      ).all(identity, scope, limit);
    }
    return this._db.prepare(
      'SELECT * FROM facts WHERE identity = ? ORDER BY ts DESC LIMIT ?'
    ).all(identity, limit);
  }

  stats() {
    this.open();
    const total = this._db.prepare('SELECT COUNT(*) AS n FROM facts').get().n;
    const byScope = this._db.prepare(
      'SELECT scope, COUNT(*) AS n FROM facts GROUP BY scope ORDER BY n DESC'
    ).all();
    const byKind = this._db.prepare(
      'SELECT kind, COUNT(*) AS n FROM facts GROUP BY kind ORDER BY n DESC'
    ).all();
    return { total, byScope, byKind, dbPath: this.dbPath };
  }
}

let _service = null;

export function getMemoryService(opts) {
  if (!_service) _service = new MemoryService(opts);
  return _service;
}

export function resetMemoryService() {
  if (_service) { try { _service.close(); } catch { /* already closed */ } }
  _service = null;
}
