# Episodic Store — Schema, Query Contract, and Decay Semantics

Node.js port of `CEI_Model/emile_paper/experiments/cei_index.py`.
Backend: Node's built-in `node:sqlite` (experimental, stable in Node ≥22.5).

---

## Schema

### `memories` table

```sql
CREATE TABLE memories (
  entry_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp    REAL    NOT NULL,          -- Unix timestamp (seconds, float)
  domain       TEXT    NOT NULL DEFAULT '',
  bucket       INTEGER NOT NULL,          -- hash bucket: parseInt(sha256(verbatim)[:16], 16) % r
  content_hash TEXT    NOT NULL,          -- sha256(verbatim).slice(0, 16) — first 16 hex chars
  summary      TEXT    NOT NULL DEFAULT '',   -- Tier 1: short LLM-readable summary
  note         TEXT    NOT NULL DEFAULT '',   -- Tier 2: medium-detail annotation
  verbatim     TEXT    NOT NULL,              -- Tier 3: full raw text
  who          TEXT    NOT NULL DEFAULT 'kairos',  -- N2: agent name or "user"
  archived     INTEGER NOT NULL DEFAULT 0    -- soft-delete flag (1 = archived by decay)
);

CREATE INDEX idx_timestamp   ON memories(timestamp);
CREATE INDEX idx_domain_time ON memories(domain, timestamp);
CREATE INDEX idx_content_hash ON memories(content_hash);
```

### `links` table

```sql
CREATE TABLE links (
  link_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id     INTEGER NOT NULL REFERENCES memories(entry_id),
  dst_id     INTEGER NOT NULL REFERENCES memories(entry_id),
  weight     REAL    NOT NULL DEFAULT 1.0,
  created_at REAL    NOT NULL   -- Unix timestamp when the link was created
);

CREATE INDEX idx_link_src ON links(src_id);
CREATE INDEX idx_link_dst ON links(dst_id);
```

---

## API

### `contentHash(verbatim: string): string`
Returns the first 16 hex characters of SHA-256(verbatim). Identical output to Python's `hashlib.sha256(text.encode()).hexdigest()[:16]`.

### `bucketIndex(verbatim: string, bucketCount: number): number`
Returns `parseInt(contentHash(verbatim), 16) % bucketCount` using BigInt arithmetic to avoid precision loss.

### `new EpisodicStore(dbPath?, bucketCount?)`
Opens (or creates) the SQLite database at `dbPath` (default `:memory:`). Enables WAL mode and `busy_timeout = 5000ms` for concurrent safety.

### `store.insert(event): number`
Insert a memory event. Returns `entry_id`.

```js
store.insert({
  verbatim:  string,   // required — full text
  domain:    string,   // optional (default '')
  timestamp: number,   // optional (default Date.now()/1000)
  summary:   string,   // optional Tier 1
  note:      string,   // optional Tier 2
  who:       string,   // optional (default 'kairos')
})
```

Complexity: O(log n) — B-tree index maintenance.

### `store.addLink(srcId, dstId, weight?)`
Create a directional link between two memory entries. Default weight = 1.0.

### `store.queryTemporal(tStart, tEnd, domain?, topK?): object[]`
Temporal range query. Returns entries with `tStart ≤ timestamp ≤ tEnd`, ordered by timestamp DESC. Complexity: O(log n + p·c).

### `store.queryBefore(cutoff, domain?, topK?): object[]`
Returns entries with `timestamp < cutoff`, ordered by timestamp DESC. The key query that flat vector search cannot replicate.

### `store.queryAfter(cutoff, domain?, topK?): object[]`
Returns entries with `timestamp > cutoff`, ordered by timestamp ASC.

### `store.queryMostRecent(contentHash): object|null`
Conflict resolution query: returns the most recent entry matching `content_hash`. Used for knowledge versioning (fact supersession).

### `store.queryRecent(topK?, domain?): object[]`
Convenience: most recent N entries across all time.

### `store.consolidate(alpha?, deltaT?, theta?): { decayed, pruned }`
Decay step per Proposition 1 of the CEI paper.

- `alpha` — decay rate (default 0.01, validated by ablation study)
- `deltaT` — elapsed time units since last consolidation (default 1.0 = one compaction cycle)
- `theta` — minimum link weight before archiving (default 0.001)

Applies `weight ← weight × e^(−α·Δt)` to all links, then:
1. Prunes links where `weight < theta`
2. Archives memories with no remaining links that are older than 30 days

Call during compaction (`src/compaction.js`) per N4 decision.

Returns `{ decayed: <surviving link count>, pruned: <links deleted> }`.

### `store.exportSnapshot(): object`
Returns a JSON-serialisable snapshot for inclusion in the compaction anchor:
```js
{
  count:        number,   // total non-archived events
  domains:      object,   // { domain: count } top-10
  recentEvents: object[], // last 5 events (trimmed to 120 chars)
  dbPath:       string,
}
```

### `store.count(): number`
Count of non-archived memories.

### `store.close()`
Close the database connection.

### `getEpisodicStore(dbPath): EpisodicStore`
Singleton factory — returns the same instance per `dbPath` within a process.

### `closeEpisodicStore(dbPath)`
Close and evict from the singleton cache.

---

## Decay Semantics

Decay is based on Proposition 1 from the CEI paper:

> Link count is bounded by `μ · ⌈ln(λ₀/θ) / (α·Δt)⌉`

With `α=0.01` (one compaction cycle = Δt=1.0), a link starting at weight 1.0 takes `ln(1.0/0.001)/0.01 ≈ 691` compaction cycles to fall below the prune threshold. Links reinforced by repeated access stay alive indefinitely.

---

## Storage Location

The episodic DB lives at `.agent/palace/episodic.db` by default (set by `state.js`). The WAL journal (`.agent/palace/episodic.db-wal`) is part of the same atomic unit — never copy the `.db` without the `-wal` and `-shm` files.

---

## Python Parity

Both implementations share identical:
- SQL schema (column names, types, index names)
- `content_hash` algorithm (SHA-256, first 16 hex chars)
- Bucket assignment formula (`parseInt(hash, 16) % r`)
- Decay formula (`w * e^(-alpha * deltaT)`)

Parity is verified by `tests/episodic-store.test.js` against fixed test vectors.

---

## Migration Notes

On first Kairos v3.0 boot, `src/palace/migrate.js` reads `.agent/lmma/banks/*.md` and inserts each bank entry as an episodic event with `who='kairos'` and `domain` derived from the bank name. The LMMA bank files are then moved to `.agent/lmma/banks.archived/` (kept for one release cycle). Pass `--no-migrate` to skip.
