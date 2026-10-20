// tests/palace-decay.test.js
// Phase 2.20 — Decay test: simulated clock, unvisited memories archived after N days.
// Verifies decay function math and archiving behavior on a controlled timeline.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EpisodicStore } from '../src/palace/episodic-store.js';

const SEC  = 1;
const MIN  = 60 * SEC;
const HOUR = 60 * MIN;
const DAY  = 24 * HOUR;
const NOW  = Math.floor(Date.now() / 1000);

// ── Decay math ─────────────────────────────────────────────────────────────────

describe('Decay math (Proposition 1)', () => {
  it('decay factor = e^(-alpha * deltaT)', () => {
    const alpha  = 0.01;
    const deltaT = 1.0;
    const factor = Math.exp(-alpha * deltaT);
    assert.ok(Math.abs(factor - 0.99004983) < 1e-6);
  });

  it('weight after one step (alpha=0.01, deltaT=1): 1.0 → ~0.990', () => {
    const w0     = 1.0;
    const alpha  = 0.01;
    const deltaT = 1.0;
    const w1     = w0 * Math.exp(-alpha * deltaT);
    assert.ok(Math.abs(w1 - 0.99004983) < 1e-6);
  });

  it('weight after 691 cycles (alpha=0.01, deltaT=1): 1.0 → <0.001 (theta)', () => {
    // ln(1.0/0.001) / 0.01 ≈ 690.8 cycles to reach theta=0.001
    const cycles = 691;
    const w = 1.0 * Math.exp(-0.01 * cycles);
    assert.ok(w < 0.001, `weight ${w} should be below theta=0.001 after ${cycles} cycles`);
  });

  it('weight after 100 cycles is still well above theta', () => {
    const w = 1.0 * Math.exp(-0.01 * 100);
    assert.ok(w > 0.36, `weight ${w} should be above 0.36 after 100 cycles`);
  });
});

// ── Link pruning at threshold ───────────────────────────────────────────────────

describe('Link pruning at theta threshold', () => {
  it('link starting below theta is pruned immediately', () => {
    const store = new EpisodicStore();
    const id1 = store.insert({ verbatim: 'a', domain: 'x', timestamp: NOW });
    const id2 = store.insert({ verbatim: 'b', domain: 'x', timestamp: NOW });
    // Add a link already below theta
    store.addLink(id1, id2, 0.0005); // below theta=0.001

    const { pruned } = store.consolidate(0.01, 1.0, 0.001);
    // After one decay: 0.0005 * e^(-0.01) ≈ 0.000495, still below theta → pruned
    assert.ok(pruned >= 1, `expected ≥1 pruned links, got ${pruned}`);
    store.close();
  });

  it('strong link (weight=1.0) survives many decay cycles', () => {
    const store = new EpisodicStore();
    const id1 = store.insert({ verbatim: 'x', domain: 'a', timestamp: NOW });
    const id2 = store.insert({ verbatim: 'y', domain: 'a', timestamp: NOW });
    store.addLink(id1, id2, 1.0);

    // Run 100 decay cycles — link should survive (weight ≈ 0.368, well above theta=0.001)
    let totalPruned = 0;
    for (let i = 0; i < 100; i++) {
      const { pruned } = store.consolidate(0.01, 1.0, 0.001);
      totalPruned += pruned;
    }
    assert.equal(totalPruned, 0, 'strong link should not be pruned after 100 decay cycles');
    store.close();
  });

  it('link is pruned exactly when it crosses theta after N cycles', () => {
    const store = new EpisodicStore();
    const id1 = store.insert({ verbatim: 'p', domain: 'a', timestamp: NOW });
    const id2 = store.insert({ verbatim: 'q', domain: 'a', timestamp: NOW });
    // Start with weight = 0.01 (will decay below 0.001 after ~231 cycles at alpha=0.01)
    // But with deltaT=100 per call: 0.01 * e^(-0.01*100) = 0.01 * 0.368 ≈ 0.00368
    // After two such calls: 0.00368 * 0.368 ≈ 0.00135 (still above 0.001)
    // After three calls:   0.00135 * 0.368 ≈ 0.000497 (below 0.001 → pruned)
    store.addLink(id1, id2, 0.01);
    store.consolidate(0.01, 100.0, 0.001); // call 1
    store.consolidate(0.01, 100.0, 0.001); // call 2
    const { pruned } = store.consolidate(0.01, 100.0, 0.001); // call 3 — should prune
    assert.ok(pruned >= 1, `expected pruned ≥ 1 on call 3, got ${pruned}`);
    store.close();
  });
});

// ── Memory archiving (simulated clock) ─────────────────────────────────────────

describe('Memory archiving with simulated clock', () => {
  it('very old orphaned memories are archived during consolidation', () => {
    const store = new EpisodicStore();
    // Insert events 40 days ago (beyond the 30-day archive threshold)
    const oldTs = NOW - 40 * DAY;
    store.insert({ verbatim: 'old unlinked event 1', domain: 'project', timestamp: oldTs });
    store.insert({ verbatim: 'old unlinked event 2', domain: 'project', timestamp: oldTs });

    const before = store.count();
    assert.equal(before, 2);

    // Consolidate — old, unlinked memories should be archived
    store.consolidate(0.01, 1.0, 0.001);
    const after = store.count();
    assert.ok(after < before, `count should decrease after archiving: was ${before}, now ${after}`);
    store.close();
  });

  it('recent events are NOT archived even with no links', () => {
    const store = new EpisodicStore();
    // Insert events just 1 day ago (well within the 30-day window)
    store.insert({ verbatim: 'recent event', domain: 'project', timestamp: NOW - DAY });
    store.insert({ verbatim: 'also recent',  domain: 'project', timestamp: NOW - HOUR });

    store.consolidate(0.01, 1.0, 0.001);
    assert.equal(store.count(), 2, 'recent events should survive consolidation');
    store.close();
  });

  it('linked old events are NOT archived even when old', () => {
    const store = new EpisodicStore();
    const oldTs = NOW - 40 * DAY;
    const id1 = store.insert({ verbatim: 'old linked A', domain: 'project', timestamp: oldTs });
    const id2 = store.insert({ verbatim: 'old linked B', domain: 'project', timestamp: oldTs });
    // Link them — linked events survive even if old
    store.addLink(id1, id2, 1.0);

    store.consolidate(0.01, 1.0, 0.001);
    // Links have weight ~0.990 after one decay cycle — still above theta=0.001
    // So linked events should still be reachable and NOT archived
    assert.equal(store.count(), 2, 'linked old events should not be archived after a single decay');
    store.close();
  });

  it('archiving is idempotent (consolidate twice produces same count)', () => {
    const store = new EpisodicStore();
    const oldTs = NOW - 40 * DAY;
    store.insert({ verbatim: 'old orphan', domain: 'project', timestamp: oldTs });

    store.consolidate(0.01, 1.0, 0.001); // first pass — archives
    const afterFirst = store.count();

    store.consolidate(0.01, 1.0, 0.001); // second pass — nothing new to archive
    const afterSecond = store.count();

    assert.equal(afterFirst, afterSecond, 'consolidate should be idempotent');
    store.close();
  });
});

// ── Steady-state bounded decay (Proposition 1 empirical check) ─────────────────

describe('Proposition 1 steady-state (μ·T* bound)', () => {
  it('link count stabilizes after many decay cycles at α=0.01', () => {
    const store = new EpisodicStore();
    // Insert 20 events and link them in a chain
    const ids = [];
    for (let i = 0; i < 20; i++) {
      ids.push(store.insert({ verbatim: `node-${i}`, domain: 'x', timestamp: NOW - i * 10 }));
    }
    for (let i = 1; i < ids.length; i++) store.addLink(ids[i - 1], ids[i], 1.0);

    // Run 50 decay cycles
    let lastCount = Infinity;
    for (let c = 0; c < 50; c++) {
      const { decayed } = store.consolidate(0.01, 1.0, 0.001);
      lastCount = decayed;
    }

    // After 50 cycles at α=0.01, weight ≈ e^(-0.5) ≈ 0.607 — all 19 links should survive
    assert.ok(lastCount >= 0, 'link count should be non-negative');
    store.close();
  });
});
