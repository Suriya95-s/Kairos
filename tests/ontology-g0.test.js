// tests/ontology-g0.test.js
// G0 — foundations hardening: the projection/fold cache, the journal write
// lock, incremental link discovery, and release pinning. All hermetic —
// KAIROS_HOME points at a temp dir per test.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendDocument, loadProjection, setPublicationState, withJournalLock,
  createRelease, loadRelease, listReleases, domainDir,
} from '../src/ontology/store.js';
import { discoverLinks } from '../src/ontology/induce.js';
import { ingestFile } from '../src/ontology/engine.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;
const savedLockTimeout = process.env.KAIROS_LOCK_TIMEOUT_MS;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-g0-'));
  process.env.KAIROS_HOME = tmpHome;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  if (savedLockTimeout === undefined) delete process.env.KAIROS_LOCK_TIMEOUT_MS;
  else process.env.KAIROS_LOCK_TIMEOUT_MS = savedLockTimeout;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* Windows locks */ }
});

const DOC = (over = {}) => ({
  name: 'Customer', state: 'candidate', proposedBy: 'kairos-induction',
  evidence: [{ snapshot: 'snapshot:abc', locator: 'header' }], ...over,
});

function journalPath(domain) {
  return path.join(domainDir(domain), 'documents.jsonl');
}

// ── The fold cache ───────────────────────────────────────────────────────────

describe('G0 projection cache', () => {
  test('warm reads serve exactly what cold reads served', () => {
    appendDocument('sales', { kind: 'object_type', id: 'type:Customer', payload: DOC() });
    appendDocument('sales', { kind: 'instance', id: 'inst:Customer:1', payload: { type: 'Customer', key: '1' } });
    const cold = loadProjection('sales');
    const warm = loadProjection('sales');
    assert.deepEqual(warm.counts, cold.counts);
    assert.deepEqual(warm.object_type.get('type:Customer').name, 'Customer');
  });

  test('an append from ANOTHER process invalidates the cache (stamp check)', () => {
    appendDocument('sales', { kind: 'object_type', id: 'type:Customer', payload: DOC() });
    loadProjection('sales'); // warm the cache
    // Simulate a foreign writer: raw bytes straight onto the journal, no store API.
    const foreign = { kind: 'object_type', id: 'type:Region', version: 1, payload: DOC({ name: 'Region' }), at: Date.now() };
    fs.appendFileSync(journalPath('sales'), JSON.stringify(foreign) + '\n');
    const proj = loadProjection('sales');
    assert.equal(proj.counts.object_type, 2, 'the cache must notice the file changed under it');
    assert.equal(proj.object_type.get('type:Region').name, 'Region');
  });

  test('returned projections are fresh copies — mutating one cannot poison the cache', () => {
    appendDocument('sales', { kind: 'object_type', id: 'type:Customer', payload: DOC() });
    const first = loadProjection('sales');
    first.object_type.get('type:Customer').name = 'MUTATED';
    first.object_type.delete('type:Customer');
    const second = loadProjection('sales');
    assert.equal(second.object_type.get('type:Customer').name, 'Customer');
  });

  test('in-place cache update after append folds to the latest version', () => {
    appendDocument('sales', { kind: 'object_type', id: 'type:Customer', payload: DOC() });
    loadProjection('sales'); // warm
    appendDocument('sales', { kind: 'object_type', id: 'type:Customer', payload: DOC({ name: 'Client' }) });
    const proj = loadProjection('sales');
    assert.equal(proj.object_type.get('type:Customer').name, 'Client');
    assert.equal(proj.object_type.get('type:Customer')._version, 2);
  });

  test('repointing KAIROS_HOME never leaks a cached fold across homes', () => {
    appendDocument('sales', { kind: 'object_type', id: 'type:Customer', payload: DOC() });
    loadProjection('sales'); // warm under home A
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-g0b-'));
    try {
      process.env.KAIROS_HOME = otherHome;
      const proj = loadProjection('sales');
      assert.equal(proj.counts.object_type, 0, 'same domain name, different home, must be empty');
    } finally {
      process.env.KAIROS_HOME = tmpHome;
      try { fs.rmSync(otherHome, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});

// ── The journal write lock ───────────────────────────────────────────────────

describe('G0 journal write lock', () => {
  test('a live foreign lock blocks the writer until timeout, then throws', () => {
    process.env.KAIROS_LOCK_TIMEOUT_MS = '120';
    fs.mkdirSync(domainDir('sales'), { recursive: true });
    fs.writeFileSync(journalPath('sales') + '.lock', JSON.stringify({ pid: 99999, at: Date.now() }));
    assert.throws(
      () => appendDocument('sales', { kind: 'object_type', id: 'type:X', payload: DOC() }),
      /locked by another writer/,
      'a second writer must wait, not interleave — and must not hang forever',
    );
  });

  test('a stale lock (dead writer) is stolen, not obeyed', () => {
    fs.mkdirSync(domainDir('sales'), { recursive: true });
    const lock = journalPath('sales') + '.lock';
    fs.writeFileSync(lock, JSON.stringify({ pid: 99999, at: Date.now() - 60_000 }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const res = appendDocument('sales', { kind: 'object_type', id: 'type:X', payload: DOC({ name: 'X' }) });
    assert.equal(res.appended, true, 'a lock from a dead process must not brick the domain');
  });

  test('the lock is re-entrant in-process and released afterwards', () => {
    const out = withJournalLock('sales', () => {
      appendDocument('sales', { kind: 'object_type', id: 'type:A', payload: DOC({ name: 'A' }) });
      return withJournalLock('sales', () =>
        appendDocument('sales', { kind: 'object_type', id: 'type:B', payload: DOC({ name: 'B' }) }));
    });
    assert.equal(out.appended, true);
    assert.equal(fs.existsSync(journalPath('sales') + '.lock'), false, 'released on exit');
    // And a later writer is not blocked:
    const later = appendDocument('sales', { kind: 'object_type', id: 'type:C', payload: DOC({ name: 'C' }) });
    assert.equal(later.appended, true);
  });
});

// ── Incremental link discovery ───────────────────────────────────────────────

function chainProjection() {
  // Order.customerId → Customer.regionId → Region: two discoverable FK pairs.
  const types = [
    { name: 'Order', keyProperty: 'id', properties: [{ name: 'id' }, { name: 'customerId' }], evidence: [{ snapshot: 's', locator: 'h' }] },
    { name: 'Customer', keyProperty: 'id', properties: [{ name: 'id' }, { name: 'regionId' }], evidence: [{ snapshot: 's', locator: 'h' }] },
    { name: 'Region', keyProperty: 'id', properties: [{ name: 'id' }], evidence: [{ snapshot: 's', locator: 'h' }] },
  ];
  const instances = [
    { type: 'Order', key: 'o1', properties: { id: 'o1', customerId: 'c1' }, evidence: [{ snapshot: 's', locator: 'r' }] },
    { type: 'Order', key: 'o2', properties: { id: 'o2', customerId: 'c2' }, evidence: [{ snapshot: 's', locator: 'r' }] },
    { type: 'Customer', key: 'c1', properties: { id: 'c1', regionId: 'r1' }, evidence: [{ snapshot: 's', locator: 'r' }] },
    { type: 'Customer', key: 'c2', properties: { id: 'c2', regionId: 'r2' }, evidence: [{ snapshot: 's', locator: 'r' }] },
    { type: 'Region', key: 'r1', properties: { id: 'r1' }, evidence: [{ snapshot: 's', locator: 'r' }] },
    { type: 'Region', key: 'r2', properties: { id: 'r2' }, evidence: [{ snapshot: 's', locator: 'r' }] },
  ];
  return {
    object_type: new Map(types.map((t) => [`type:${t.name}`, t])),
    instance: new Map(instances.map((i) => [`inst:${i.type}:${i.key}`, i])),
  };
}

describe('G0 incremental link discovery', () => {
  test('a full scan still finds every pair', () => {
    const ids = discoverLinks(chainProjection()).map((r) => r.id);
    assert.ok(ids.includes('rel:refers:Order.customerId->Customer'));
    assert.ok(ids.includes('rel:refers:Customer.regionId->Region'));
  });

  test('touchedTypes scans only pairs the ingest touched', () => {
    const ids = discoverLinks(chainProjection(), { touchedTypes: ['Region'] }).map((r) => r.id);
    assert.ok(ids.includes('rel:refers:Customer.regionId->Region'), 'the touched side must still be scanned');
    assert.ok(!ids.includes('rel:refers:Order.customerId->Customer'), 'an untouched pair must not be re-scanned');
  });

  test('end to end: files dropped in either order still cross-link', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-g0-data-'));
    try {
      fs.writeFileSync(path.join(dataDir, 'orders.csv'), 'id,customerId\no1,c1\no2,c2\n');
      fs.writeFileSync(path.join(dataDir, 'customers.csv'), 'id,name\nc1,Aiko\nc2,Ren\n');
      // orders first: Customer does not exist yet, so no link possible…
      assert.equal(ingestFile('shop', path.join(dataDir, 'orders.csv')).ok, true);
      // …customers second: the incremental scan touches Customer, and the
      // Order.customerId → Customer pair includes a touched side.
      assert.equal(ingestFile('shop', path.join(dataDir, 'customers.csv')).ok, true);
      const proj = loadProjection('shop');
      // Header "customerId" is a single word to propName, so it lowercases whole.
      assert.ok(proj.relationship.has('rel:refers:Order.customerid->Customer'),
        'incremental mode must never lose the cross-file link the full scan found');
    } finally {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});

// ── Release pinning ──────────────────────────────────────────────────────────

function approveOne(domain, id, name) {
  appendDocument(domain, { kind: 'object_type', id, payload: DOC({ name }) });
  setPublicationState(domain, 'object_type', id, 'approved', 'the-owner');
}

describe('G0 release pinning', () => {
  test('nothing approved → nothing to release', () => {
    appendDocument('sales', { kind: 'object_type', id: 'type:Customer', payload: DOC() });
    assert.throws(() => createRelease('sales'), /no approved documents/,
      'a release of candidates would pin claims no human signed');
  });

  test('a release is content-addressed and idempotent', () => {
    approveOne('sales', 'type:Customer', 'Customer');
    const first = createRelease('sales', { createdBy: 'the-owner' });
    assert.match(first.id, /^release:[0-9a-f]{16}$/);
    assert.equal(first.existed, false);
    assert.equal(first.counts.object_type, 1);
    assert.ok(fs.existsSync(first.file));
    const again = createRelease('sales', { createdBy: 'the-owner' });
    assert.equal(again.id, first.id, 'same approved set → same release, forever');
    assert.equal(again.existed, true);
  });

  test('approving more changes the release id — versions are immutable, not updated', () => {
    approveOne('sales', 'type:Customer', 'Customer');
    const v1 = createRelease('sales');
    approveOne('sales', 'type:Region', 'Region');
    const v2 = createRelease('sales');
    assert.notEqual(v2.id, v1.id);
    const ids = listReleases('sales').map((r) => r.id);
    assert.ok(ids.includes(v1.id) && ids.includes(v2.id), 'both versions remain citable');
  });

  test('candidates and retired docs never enter a release', () => {
    approveOne('sales', 'type:Customer', 'Customer');
    appendDocument('sales', { kind: 'object_type', id: 'type:Draft', payload: DOC({ name: 'Draft' }) });
    const rel = createRelease('sales');
    const rec = loadRelease('sales', rel.id);
    assert.ok(rec.docs.object_type['type:Customer']);
    assert.equal(rec.docs.object_type['type:Draft'], undefined, 'unapproved claims stay out');
  });

  test('a tampered release is refused, not served', () => {
    approveOne('sales', 'type:Customer', 'Customer');
    const rel = createRelease('sales');
    const rec = JSON.parse(fs.readFileSync(rel.file, 'utf-8'));
    rec.docs.object_type['type:Customer'].name = 'Attacker';
    fs.writeFileSync(rel.file, JSON.stringify(rec, null, 2));
    assert.throws(() => loadRelease('sales', rel.id), /tampered/,
      'a release whose bytes no longer hash to its id has been edited');
  });

  test('loading an unknown release says so', () => {
    assert.throws(() => loadRelease('sales', 'release:0000000000000000'), /no such release/);
  });
});
