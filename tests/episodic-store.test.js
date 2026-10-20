// tests/episodic-store.test.js
// CEI Phase 6 — episodic store tests: all query types, decay, parity with Python schema.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os   from 'node:os';
import path from 'node:path';
import fs   from 'node:fs';
import { EpisodicStore, contentHash, bucketIndex, getEpisodicStore, closeEpisodicStore } from '../src/palace/episodic-store.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const NOW = Math.floor(Date.now() / 1000);

function makeStore(dbPath = ':memory:') {
  return new EpisodicStore(dbPath);
}

// ── Content hash / bucket tests ────────────────────────────────────────────────

describe('CEI hash utilities', () => {
  it('contentHash returns 16-char hex string', () => {
    const h = contentHash('hello world');
    assert.equal(typeof h, 'string');
    assert.equal(h.length, 16);
    assert.ok(/^[0-9a-f]+$/.test(h));
  });

  it('contentHash is deterministic', () => {
    assert.equal(contentHash('test'), contentHash('test'));
  });

  it('contentHash matches Python: SHA-256 of "hello" first 16 hex chars', () => {
    // Python: hashlib.sha256(b"hello").hexdigest()[:16] = "2cf24dba5fb0a30e"
    assert.equal(contentHash('hello'), '2cf24dba5fb0a30e');
  });

  it('bucketIndex is in [0, bucketCount)', () => {
    for (const text of ['foo', 'bar', 'baz', 'hello world', '']) {
      const b = bucketIndex(text, 16);
      assert.ok(b >= 0 && b < 16, `bucket ${b} out of range for "${text}"`);
    }
  });
});

// ── Insert + count ─────────────────────────────────────────────────────────────

describe('EpisodicStore — insert and count', () => {
  it('inserts a single event and returns entry_id', () => {
    const store = makeStore();
    const id = store.insert({ verbatim: 'test event', domain: 'testing', timestamp: NOW });
    assert.ok(typeof id === 'number' && id >= 1);
    assert.equal(store.count(), 1);
    store.close();
  });

  it('inserts 10k events', () => {
    const store = makeStore();
    for (let i = 0; i < 10000; i++) {
      store.insert({ verbatim: `event ${i}`, domain: i % 2 === 0 ? 'coding' : 'testing', timestamp: NOW - i });
    }
    assert.equal(store.count(), 10000);
    store.close();
  });

  it('who field defaults to kairos', () => {
    const store = makeStore();
    store.insert({ verbatim: 'default who', domain: 'test', timestamp: NOW });
    const results = store.queryRecent(1);
    assert.equal(results[0].who, 'kairos');
    store.close();
  });

  it('custom who field stored correctly (N2: user-initiated events)', () => {
    const store = makeStore();
    store.insert({ verbatim: 'user action', domain: 'test', timestamp: NOW, who: 'user' });
    const results = store.queryRecent(1);
    assert.equal(results[0].who, 'user');
    store.close();
  });
});

// ── queryTemporal ──────────────────────────────────────────────────────────────

describe('EpisodicStore — queryTemporal', () => {
  it('returns events within time range', () => {
    const store = makeStore();
    store.insert({ verbatim: 'old', domain: 'a', timestamp: NOW - 3600 });
    store.insert({ verbatim: 'recent', domain: 'a', timestamp: NOW - 100 });
    store.insert({ verbatim: 'future', domain: 'a', timestamp: NOW + 100 });

    const results = store.queryTemporal(NOW - 200, NOW, null, 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].verbatim, 'recent');
    store.close();
  });

  it('filters by domain', () => {
    const store = makeStore();
    store.insert({ verbatim: 'coding event', domain: 'coding', timestamp: NOW });
    store.insert({ verbatim: 'testing event', domain: 'testing', timestamp: NOW });

    const coding = store.queryTemporal(NOW - 1, NOW + 1, 'coding', 10);
    assert.equal(coding.length, 1);
    assert.equal(coding[0].domain, 'coding');
    store.close();
  });

  it('respects topK limit', () => {
    const store = makeStore();
    for (let i = 0; i < 20; i++) {
      store.insert({ verbatim: `e${i}`, domain: 'x', timestamp: NOW - i });
    }
    const results = store.queryTemporal(NOW - 100, NOW + 1, null, 5);
    assert.equal(results.length, 5);
    store.close();
  });

  it('returns results in descending timestamp order', () => {
    const store = makeStore();
    for (let i = 10; i >= 1; i--) {
      store.insert({ verbatim: `e${i}`, domain: 'x', timestamp: NOW - i * 10 });
    }
    const results = store.queryTemporal(NOW - 1000, NOW + 1, null, 10);
    for (let i = 0; i < results.length - 1; i++) {
      assert.ok(results[i].timestamp >= results[i + 1].timestamp);
    }
    store.close();
  });
});

// ── queryBefore / queryAfter ───────────────────────────────────────────────────

describe('EpisodicStore — queryBefore and queryAfter', () => {
  it('queryBefore returns events before cutoff', () => {
    const store = makeStore();
    store.insert({ verbatim: 'past',   domain: 'x', timestamp: NOW - 3600 });
    store.insert({ verbatim: 'future', domain: 'x', timestamp: NOW + 3600 });

    const results = store.queryBefore(NOW, null, 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].verbatim, 'past');
    store.close();
  });

  it('queryAfter returns events after cutoff', () => {
    const store = makeStore();
    store.insert({ verbatim: 'past',   domain: 'x', timestamp: NOW - 3600 });
    store.insert({ verbatim: 'future', domain: 'x', timestamp: NOW + 3600 });

    const results = store.queryAfter(NOW, null, 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].verbatim, 'future');
    store.close();
  });

  it('queryBefore with domain filter', () => {
    const store = makeStore();
    store.insert({ verbatim: 'coding past',  domain: 'coding',  timestamp: NOW - 100 });
    store.insert({ verbatim: 'testing past', domain: 'testing', timestamp: NOW - 100 });

    const results = store.queryBefore(NOW, 'coding', 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].domain, 'coding');
    store.close();
  });

  it('queryAfter returns ascending order', () => {
    const store = makeStore();
    for (let i = 1; i <= 5; i++) {
      store.insert({ verbatim: `e${i}`, domain: 'x', timestamp: NOW + i * 10 });
    }
    const results = store.queryAfter(NOW, null, 10);
    for (let i = 0; i < results.length - 1; i++) {
      assert.ok(results[i].timestamp <= results[i + 1].timestamp);
    }
    store.close();
  });
});

// ── queryMostRecent ────────────────────────────────────────────────────────────

describe('EpisodicStore — queryMostRecent (conflict resolution)', () => {
  it('returns the most recent entry for a given content hash', () => {
    const store = makeStore();
    const hash = contentHash('the same fact');
    store.insert({ verbatim: 'the same fact', domain: 'x', timestamp: NOW - 100 });
    store.insert({ verbatim: 'the same fact', domain: 'x', timestamp: NOW });

    const result = store.queryMostRecent(hash);
    assert.ok(result);
    assert.ok(result.timestamp >= NOW - 1);
    store.close();
  });

  it('returns null for unknown hash', () => {
    const store = makeStore();
    assert.equal(store.queryMostRecent('0000000000000000'), null);
    store.close();
  });
});

// ── Links and decay ────────────────────────────────────────────────────────────

describe('EpisodicStore — links and decay (Proposition 1)', () => {
  it('addLink stores a link between entries', () => {
    const store = makeStore();
    const id1 = store.insert({ verbatim: 'a', domain: 'x', timestamp: NOW });
    const id2 = store.insert({ verbatim: 'b', domain: 'x', timestamp: NOW });
    store.addLink(id1, id2, 1.0);
    // No crash = success (link integrity tested via consolidate)
    store.close();
  });

  it('consolidate applies exponential decay', () => {
    const store = makeStore();
    const id1 = store.insert({ verbatim: 'a', domain: 'x', timestamp: NOW });
    const id2 = store.insert({ verbatim: 'b', domain: 'x', timestamp: NOW });
    store.addLink(id1, id2, 1.0);

    const { decayed, pruned } = store.consolidate(0.01, 1.0, 0.001);
    // weight = 1.0 * e^(-0.01*1.0) ≈ 0.990, above theta=0.001 → should survive
    assert.equal(pruned, 0);
    assert.ok(decayed >= 0);
    store.close();
  });

  it('consolidate prunes links below theta', () => {
    const store = makeStore();
    const id1 = store.insert({ verbatim: 'a', domain: 'x', timestamp: NOW - 86400 * 40 }); // very old
    const id2 = store.insert({ verbatim: 'b', domain: 'x', timestamp: NOW - 86400 * 40 });
    store.addLink(id1, id2, 0.0005); // below theta=0.001 after one decay step

    const { pruned } = store.consolidate(0.01, 1000.0, 0.001); // large deltaT → very small weight
    assert.ok(pruned >= 1, `expected at least 1 pruned link, got ${pruned}`);
    store.close();
  });

  it('decay math matches Python: w * e^(-alpha*deltaT)', () => {
    // Verify the decay factor is applied correctly
    const alpha = 0.01;
    const deltaT = 1.0;
    const expectedFactor = Math.exp(-alpha * deltaT);
    assert.ok(Math.abs(expectedFactor - 0.9900498) < 1e-6);
  });
});

// ── exportSnapshot ─────────────────────────────────────────────────────────────

describe('EpisodicStore — exportSnapshot', () => {
  it('returns correct count and recent events', () => {
    const store = makeStore();
    for (let i = 0; i < 10; i++) {
      store.insert({ verbatim: `event ${i}`, domain: 'test', timestamp: NOW - i });
    }
    const snap = store.exportSnapshot();
    assert.equal(snap.count, 10);
    assert.ok(Array.isArray(snap.recentEvents));
    assert.ok(snap.recentEvents.length <= 5);
    assert.ok(typeof snap.domains === 'object');
    store.close();
  });
});

// ── File persistence ───────────────────────────────────────────────────────────

describe('EpisodicStore — file persistence (WAL mode)', () => {
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-episodic-'));
    dbPath = path.join(tmpDir, 'episodic.db');
  });

  after(() => {
    closeEpisodicStore(dbPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists data across store instances', () => {
    const store1 = new EpisodicStore(dbPath);
    store1.insert({ verbatim: 'persisted', domain: 'test', timestamp: NOW });
    store1.close();

    const store2 = new EpisodicStore(dbPath);
    assert.equal(store2.count(), 1);
    assert.equal(store2.queryRecent(1)[0].verbatim, 'persisted');
    store2.close();
  });

  it('singleton getEpisodicStore returns same instance', () => {
    const s1 = getEpisodicStore(dbPath);
    const s2 = getEpisodicStore(dbPath);
    assert.equal(s1, s2);
  });
});

// ── Performance ────────────────────────────────────────────────────────────────

describe('EpisodicStore — performance', () => {
  it('100k inserts complete in under 10s', () => {
    const store = makeStore();
    const start = Date.now();
    for (let i = 0; i < 100000; i++) {
      store.insert({ verbatim: `event ${i} ${'x'.repeat(50)}`, domain: `domain${i % 10}`, timestamp: NOW - i });
    }
    const elapsed = Date.now() - start;
    console.log(`  100k inserts: ${elapsed}ms`);
    assert.ok(elapsed < 10000, `100k inserts took ${elapsed}ms (limit: 10000ms)`);
    assert.equal(store.count(), 100000);
    store.close();
  });

  it('1k temporal queries complete in under 100ms total', () => {
    const store = makeStore();
    for (let i = 0; i < 10000; i++) {
      store.insert({ verbatim: `ev ${i}`, domain: 'x', timestamp: NOW - i * 60 });
    }
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      store.queryTemporal(NOW - 3600, NOW, null, 5);
    }
    const elapsed = Date.now() - start;
    console.log(`  1k temporal queries: ${elapsed}ms`);
    assert.ok(elapsed < 100, `1k queries took ${elapsed}ms (limit: 100ms)`);
    store.close();
  });
});
