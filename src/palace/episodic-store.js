// src/palace/episodic-store.js
// Chronological Episodic Index (CEI) — Node.js port of CEI_Model/emile_paper/experiments/cei_index.py
//
// Uses node:sqlite (built-in since Node 22.5) as the B-tree backend.
// Schema is 1:1 with the Python version: memories + links tables, same column names.
//
// Complexity guarantees (from Theorem 1 in emile_paper/proofs/theorems.tex):
//   Insert:  O(log n)  — B-tree index maintenance
//   Lookup:  O(log n + k)  — k = entries in bucket
//   Range:   O(log n + p·c)  — p = matching leaves
//
// Decay: Proposition 1 — link count bounded by μ·⌈ln(λ₀/θ)/(α·Δt)⌉
// Implemented as consolidate(alpha, deltaT, theta) — call during compaction.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite'; // built-in since Node 22.5
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BUCKET_COUNT = 16;
const DEFAULT_ALPHA = 0.01;    // decay rate (from CEI ablation study)
const DEFAULT_THETA = 0.001;   // minimum link weight before archiving
// Hard cap on active (non-archived) episodic memories. Beyond this, the oldest,
// least-connected rows are archived during consolidation so the store stays bounded.
const DEFAULT_MAX_ACTIVE = parseInt(process.env.AGENT_PALACE_MAX_ACTIVE || '5000', 10);

/**
 * Compute the content hash for a verbatim string.
 * Same semantics as Python: SHA-256, first 16 hex chars (64-bit).
 * @param {string} verbatim
 * @returns {string}
 */
export function contentHash(verbatim) {
  return createHash('sha256').update(String(verbatim)).digest('hex').slice(0, 16);
}

/**
 * Assign a hash bucket: parseInt(contentHash, 16) % bucketCount
 * @param {string} verbatim
 * @param {number} bucketCount
 * @returns {number}
 */
export function bucketIndex(verbatim, bucketCount) {
  return Number(BigInt('0x' + contentHash(verbatim)) % BigInt(bucketCount));
}

// ── EpisodicStore ──────────────────────────────────────────────────────────────

export class EpisodicStore {
  /**
   * @param {string} dbPath — file path or ':memory:'
   * @param {number} bucketCount — hash bucket count (must match across sessions)
   */
  constructor(dbPath = ':memory:', bucketCount = DEFAULT_BUCKET_COUNT) {
    this.r      = bucketCount;
    this.dbPath = dbPath;

    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this._db = new DatabaseSync(dbPath);
    this._db.exec('PRAGMA journal_mode = WAL');
    this._db.exec('PRAGMA busy_timeout = 5000');
    this._db.exec('PRAGMA synchronous = NORMAL');
    this._initSchema();
    this._prepareStatements();
  }

  _initSchema() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        entry_id     INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp    REAL    NOT NULL,
        domain       TEXT    NOT NULL DEFAULT '',
        bucket       INTEGER NOT NULL,
        content_hash TEXT    NOT NULL,
        summary      TEXT    NOT NULL DEFAULT '',
        note         TEXT    NOT NULL DEFAULT '',
        verbatim     TEXT    NOT NULL,
        who          TEXT    NOT NULL DEFAULT 'kairos',
        archived     INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp
        ON memories(timestamp);

      CREATE INDEX IF NOT EXISTS idx_domain_time
        ON memories(domain, timestamp);

      CREATE INDEX IF NOT EXISTS idx_content_hash
        ON memories(content_hash);

      CREATE TABLE IF NOT EXISTS links (
        link_id    INTEGER PRIMARY KEY AUTOINCREMENT,
        src_id     INTEGER NOT NULL REFERENCES memories(entry_id),
        dst_id     INTEGER NOT NULL REFERENCES memories(entry_id),
        weight     REAL    NOT NULL DEFAULT 1.0,
        created_at REAL    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_link_src ON links(src_id);
      CREATE INDEX IF NOT EXISTS idx_link_dst ON links(dst_id);
    `);
  }

  _prepareStatements() {
    this._stmtInsert = this._db.prepare(`
      INSERT INTO memories
        (timestamp, domain, bucket, content_hash, summary, note, verbatim, who)
      VALUES
        (:timestamp, :domain, :bucket, :content_hash, :summary, :note, :verbatim, :who)
    `);

    this._stmtQueryRange = this._db.prepare(`
      SELECT entry_id, timestamp, domain, summary, note, verbatim, who
      FROM   memories
      WHERE  timestamp BETWEEN :t_start AND :t_end
        AND  archived = 0
      ORDER  BY timestamp DESC
      LIMIT  :top_k
    `);

    this._stmtQueryRangeDomain = this._db.prepare(`
      SELECT entry_id, timestamp, domain, summary, note, verbatim, who
      FROM   memories
      WHERE  timestamp BETWEEN :t_start AND :t_end
        AND  domain = :domain
        AND  archived = 0
      ORDER  BY timestamp DESC
      LIMIT  :top_k
    `);

    this._stmtQueryBefore = this._db.prepare(`
      SELECT entry_id, timestamp, domain, summary, note, verbatim, who
      FROM   memories
      WHERE  timestamp < :cutoff
        AND  archived = 0
      ORDER  BY timestamp DESC
      LIMIT  :top_k
    `);

    this._stmtQueryBeforeDomain = this._db.prepare(`
      SELECT entry_id, timestamp, domain, summary, note, verbatim, who
      FROM   memories
      WHERE  timestamp < :cutoff
        AND  domain = :domain
        AND  archived = 0
      ORDER  BY timestamp DESC
      LIMIT  :top_k
    `);

    this._stmtQueryAfter = this._db.prepare(`
      SELECT entry_id, timestamp, domain, summary, note, verbatim, who
      FROM   memories
      WHERE  timestamp > :cutoff
        AND  archived = 0
      ORDER  BY timestamp ASC
      LIMIT  :top_k
    `);

    this._stmtQueryAfterDomain = this._db.prepare(`
      SELECT entry_id, timestamp, domain, summary, note, verbatim, who
      FROM   memories
      WHERE  timestamp > :cutoff
        AND  domain = :domain
        AND  archived = 0
      ORDER  BY timestamp ASC
      LIMIT  :top_k
    `);

    this._stmtMostRecent = this._db.prepare(`
      SELECT entry_id, timestamp, domain, summary, note, verbatim, who
      FROM   memories
      WHERE  content_hash = :content_hash
        AND  archived = 0
      ORDER  BY timestamp DESC
      LIMIT  1
    `);

    this._stmtCount = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM memories WHERE archived = 0'
    );


    this._stmtInsertLink = this._db.prepare(`
      INSERT INTO links (src_id, dst_id, weight, created_at)
      VALUES (:src_id, :dst_id, :weight, :created_at)
    `);

    this._stmtDecayLinks = this._db.prepare(`
      UPDATE links SET weight = weight * :factor
    `);

    this._stmtPruneLinks = this._db.prepare(`
      DELETE FROM links WHERE weight < :theta
    `);

    this._stmtGetLinks = this._db.prepare(`
      SELECT link_id, src_id, dst_id, weight FROM links
    `);
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Insert a memory event. O(log n).
   * @param {{ verbatim: string, domain?: string, timestamp?: number, summary?: string, note?: string, who?: string }} event
   * @returns {number} entry_id
   */
  insert(event) {
    const verbatim     = String(event.verbatim ?? '');
    const domain       = String(event.domain   ?? '');
    const timestamp    = event.timestamp ?? (Date.now() / 1000);
    const summary      = String(event.summary  ?? '');
    const note         = String(event.note     ?? '');
    const who          = String(event.who      ?? 'kairos');
    const hash         = contentHash(verbatim);
    const bucket       = bucketIndex(verbatim, this.r);

    const result = this._stmtInsert.run({
      timestamp, domain, bucket,
      content_hash: hash,
      summary, note, verbatim, who,
    });
    return Number(result.lastInsertRowid);
  }

  /**
   * Add a directional link between two memory entries.
   * Used by tests and consolidation tooling to build the links graph.
   * @param {number} srcId
   * @param {number} dstId
   * @param {number} weight
   */
  addLink(srcId, dstId, weight = 1.0) {
    this._stmtInsertLink.run({
      src_id: srcId, dst_id: dstId,
      weight, created_at: Date.now() / 1000,
    });
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  /**
   * Temporal range query. O(log n + p·c).
   * @param {number} tStart  Unix timestamp
   * @param {number} tEnd    Unix timestamp
   * @param {string|null} domain  optional filter
   * @param {number} topK
   * @returns {object[]}
   */
  queryTemporal(tStart, tEnd, domain = null, topK = 5) {
    if (domain) {
      return this._stmtQueryRangeDomain.all({ t_start: tStart, t_end: tEnd, domain, top_k: topK });
    }
    return this._stmtQueryRange.all({ t_start: tStart, t_end: tEnd, top_k: topK });
  }

  /**
   * What was learned BEFORE t_cutoff? (The key query flat vector search cannot do.)
   * @param {number} cutoff  Unix timestamp
   * @param {string|null} domain
   * @param {number} topK
   * @returns {object[]}
   */
  queryBefore(cutoff, domain = null, topK = 5) {
    if (domain) {
      return this._stmtQueryBeforeDomain.all({ cutoff, domain, top_k: topK });
    }
    return this._stmtQueryBefore.all({ cutoff, top_k: topK });
  }

  /**
   * What was learned AFTER t_cutoff?
   * @param {number} cutoff  Unix timestamp
   * @param {string|null} domain
   * @param {number} topK
   * @returns {object[]}
   */
  queryAfter(cutoff, domain = null, topK = 5) {
    if (domain) {
      return this._stmtQueryAfterDomain.all({ cutoff, domain, top_k: topK });
    }
    return this._stmtQueryAfter.all({ cutoff, top_k: topK });
  }

  /**
   * Conflict query: find the most recent version of a fact by content hash.
   * @param {string} hash  16-char hex content hash
   * @returns {object|null}
   */
  queryMostRecent(hash) {
    return this._stmtMostRecent.get({ content_hash: hash }) ?? null;
  }

  /**
   * Convenience: get N most recent entries across all domains.
   * @param {number} topK
   * @param {string|null} domain
   * @returns {object[]}
   */
  queryRecent(topK = 10, domain = null) {
    return this.queryBefore(Date.now() / 1000 + 1, domain, topK);
  }

  // ── Maintenance ────────────────────────────────────────────────────────────

  /**
   * Decay step per Proposition 1: w ← w · e^(-α·Δt), prune w < θ.
   * Call during compaction (N4: every compaction, α=0.01).
   *
   * @param {number} alpha  decay rate (default 0.01)
   * @param {number} deltaT elapsed time in arbitrary units (default 1.0 = one compaction cycle)
   * @param {number} theta  minimum link weight (default 0.001)
   * @returns {{ decayed: number, pruned: number }} counts
   */
  consolidate(alpha = DEFAULT_ALPHA, deltaT = 1.0, theta = DEFAULT_THETA) {
    const factor = Math.exp(-alpha * deltaT);

    // Apply decay to all links, then prune those that fell below theta
    this._stmtDecayLinks.run({ factor });

    // Prune links that fell below threshold
    const pruneResult = this._stmtPruneLinks.run({ theta });
    const pruned = Number(pruneResult.changes);

    // Archive memories with no remaining links and age > 30 compaction cycles
    // (conservative — only prune truly orphaned old memories)
    const cutoff = (Date.now() / 1000) - (30 * 86400); // 30 days ago
    this._db.exec(`
      UPDATE memories SET archived = 1
      WHERE archived = 0
        AND timestamp < ${cutoff}
        AND entry_id NOT IN (SELECT src_id FROM links UNION SELECT dst_id FROM links)
    `);

    // Enforce a hard size cap: if active memories exceed the limit, archive the
    // oldest, least-connected rows down to the cap. Keeps the DB bounded on
    // very long or repeated runs without losing well-connected recent memories.
    const capped = this.enforceSizeCap();

    const totalLinks = this._stmtGetLinks.all().length;
    return { decayed: totalLinks, pruned, archivedByCap: capped };
  }

  /**
   * Archive the oldest, least-connected active memories when the active count
   * exceeds maxActive. Returns the number archived.
   * @param {number} maxActive
   */
  enforceSizeCap(maxActive = DEFAULT_MAX_ACTIVE) {
    if (!Number.isFinite(maxActive) || maxActive <= 0) return 0;
    const active = this.count();
    if (active <= maxActive) return 0;
    const overflow = active - maxActive;
    // Rank active memories by link-degree (asc) then age (asc) and archive the
    // weakest `overflow` of them. Well-connected memories are retained.
    const res = this._db.prepare(`
      UPDATE memories SET archived = 1
      WHERE entry_id IN (
        SELECT m.entry_id FROM memories m
        LEFT JOIN (
          SELECT src_id AS id FROM links UNION ALL SELECT dst_id AS id FROM links
        ) l ON l.id = m.entry_id
        WHERE m.archived = 0
        GROUP BY m.entry_id
        ORDER BY COUNT(l.id) ASC, m.timestamp ASC
        LIMIT :overflow
      )
    `).run({ overflow });
    return Number(res.changes);
  }

  /**
   * Export a snapshot suitable for inclusion in the compaction anchor.
   * @returns {{ count: number, domains: object, recentEvents: object[], dbPath: string }}
   */
  exportSnapshot() {
    const count = this.count();
    const recent = this.queryRecent(5);

    // Domain distribution
    const domainRows = this._db.prepare(
      "SELECT domain, COUNT(*) AS cnt FROM memories WHERE archived=0 GROUP BY domain ORDER BY cnt DESC LIMIT 10"
    ).all();
    const domains = Object.fromEntries(domainRows.map(r => [r.domain || '(none)', r.cnt]));

    return {
      count,
      domains,
      recentEvents: recent.map(e => ({
        entry_id:  e.entry_id,
        timestamp: e.timestamp,
        domain:    e.domain,
        who:       e.who,
        summary:   (e.summary || e.verbatim || '').slice(0, 120),
      })),
      dbPath: this.dbPath,
    };
  }

  count() {
    return Number(this._stmtCount.get().cnt);
  }

  close() {
    try { this._db.close(); } catch { /* already closed */ }
  }
}

// ── Singleton per db-path ─────────────────────────────────────────────────────

const _instances = new Map();

/**
 * Get (or create) the EpisodicStore for a workspace.
 * Always returns the same instance for the same dbPath within a process.
 * @param {string} dbPath
 * @returns {EpisodicStore}
 */
export function getEpisodicStore(dbPath) {
  if (!_instances.has(dbPath)) {
    _instances.set(dbPath, new EpisodicStore(dbPath));
  }
  return _instances.get(dbPath);
}

/** Close and remove a store from the singleton cache. */
export function closeEpisodicStore(dbPath) {
  const store = _instances.get(dbPath);
  if (store) {
    store.close();
    _instances.delete(dbPath);
  }
}
