// tests/ontology-graph-view.test.js
// The knowledge-graph surfaces: HTML export, TUI Ontology view, daemon
// integration (bus kind registered, drop-scan announced), CLI verb.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendDocument, loadProjection } from '../src/ontology/store.js';
import { ingestFile, dropDir } from '../src/ontology/engine.js';
import { graphData, renderGraphHtml, writeGraphHtml } from '../src/ontology/graph.js';
import { EVENT_KINDS } from '../src/kernel/bus.js';
import {
  foldOntologyEvent, ontologyEventLine, renderOntology, ONTOLOGY_EVENT_CAP,
  copyIntoInbox, INBOX_DROP_MAX_FILES,
} from '../apps/tui/src/views/ontology.js';
import { state } from '../apps/tui/src/state.js';
import { adaptDaemonEvent } from '../apps/tui/src/client/daemonEvents.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-ograph-'));
  process.env.KAIROS_HOME = tmpHome;
  state.ontology = { events: [], domains: null, dropDir: '', lastGraphPath: '', probedAt: 0 };
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* Windows locks */ }
});

function seedShop() {
  const c = path.join(tmpHome, 'customers.csv');
  const o = path.join(tmpHome, 'orders.csv');
  fs.writeFileSync(c, 'id,name\nC1,Ada\nC2,Lin\n');
  fs.writeFileSync(o, 'id,customer_id,total\nO1,C1,90\nO2,C2,50\n');
  ingestFile('shop', c);
  ingestFile('shop', o);
}

// ── Graph data + HTML ────────────────────────────────────────────────────────

describe('knowledge-graph export', () => {
  test('graphData: type nodes sized by instances, reference edges labeled by property', () => {
    seedShop();
    const data = graphData(loadProjection('shop'));
    const typeNodes = data.nodes.filter((n) => n.kind === 'type');
    assert.deepEqual(typeNodes.map((n) => n.label).sort(), ['Customer', 'Order']);
    assert.equal(typeNodes.find((n) => n.label === 'Customer').count, 2);
    const ref = data.edges.find((e) => e.kind === 'reference');
    assert.ok(ref, 'the discovered foreign key appears as a type-level edge');
    assert.equal(ref.label, 'customerId');
    const instEdges = data.edges.filter((e) => e.kind === 'instance_of');
    assert.equal(instEdges.length, 4, 'each instance hangs off its type');
  });

  test('the HTML is self-contained: no external URLs, script parses, data embedded', () => {
    seedShop();
    const html = renderGraphHtml(loadProjection('shop'));
    assert.ok(!/(?:src|href)\s*=\s*["']https?:/i.test(html), 'no CDN/external references — the file must open anywhere');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new Function(script), 'the embedded viewer must parse as JavaScript');
    const data = JSON.parse(html.match(/const DATA = (.*?);\n/)[1]);
    assert.ok(data.nodes.length >= 6 && data.edges.length >= 5);
    assert.equal(data.meta.domain, 'shop');
  });

  test('evidence refs travel into the node details — the review artifact shows lineage', () => {
    seedShop();
    const data = graphData(loadProjection('shop'));
    const inst = data.nodes.find((n) => n.kind === 'instance');
    assert.ok(inst.detail.evidence.length > 0);
    assert.match(inst.detail.evidence[0].snapshot, /^snapshot:/);
  });

  test('writeGraphHtml writes into the domain dir and returns the path', () => {
    seedShop();
    const p = writeGraphHtml('shop');
    assert.ok(fs.existsSync(p));
    assert.ok(p.includes(path.join('ontology', 'shop')));
  });

  test('a huge instance count summarizes the instance layer instead of a 10k-node hairball', () => {
    for (let i = 0; i < 401; i++) {
      appendDocument('big', {
        kind: 'instance', id: `inst:Row:${i}`,
        payload: { type: 'Row', key: String(i), properties: {}, state: 'candidate', proposedBy: 'kairos-induction', evidence: [{ snapshot: 's', locator: `row:${i}` }] },
      });
    }
    appendDocument('big', { kind: 'object_type', id: 'type:Row', payload: { name: 'Row', properties: [], state: 'candidate', proposedBy: 'kairos-induction', evidence: [{ snapshot: 's', locator: 'h' }] } });
    const data = graphData(loadProjection('big'));
    assert.equal(data.nodes.filter((n) => n.kind === 'instance').length, 0);
    assert.equal(data.meta.instancesSummarized, true);
    assert.equal(data.nodes.find((n) => n.kind === 'type').count, 401, 'the count survives the summary');
  });
});

// ── Bus + daemon integration ─────────────────────────────────────────────────

describe('bus integration', () => {
  test("'ontology' is a registered event kind — unregistered kinds are silently discarded", () => {
    assert.ok(EVENT_KINDS.includes('ontology'),
      "the daemon's _publish swallows validation throws; an unregistered kind is events silently not existing");
  });

  test('the TUI adapter passes ontology events through whole', () => {
    const adapted = adaptDaemonEvent({
      kind: 'ontology',
      payload: { action: 'ingested', domain: 'shop', file: 'x.csv', counts: { instance: 2 }, appended: 5 },
    });
    assert.equal(adapted.type, 'ontology');
    assert.equal(adapted.domain, 'shop');
    assert.equal(adapted.appended, 5);
  });
});

// ── TUI view ─────────────────────────────────────────────────────────────────

describe('TUI ontology view', () => {
  test('foldOntologyEvent: feeds newest-first, caps, and marks the domain table stale on ingest', () => {
    let o = state.ontology;
    o = foldOntologyEvent(o, { action: 'ingested', domain: 'shop', file: 'a.csv', counts: {}, appended: 3, graphPath: 'G' }, 1000);
    o = foldOntologyEvent(o, { action: 'ingest_skipped', domain: 'shop', file: 'b.png', reason: 'unsupported' }, 2000);
    assert.equal(o.events.length, 2);
    assert.equal(o.events[0].file, 'b.png', 'newest first');
    assert.equal(o.lastGraphPath, 'G');
    assert.equal(o.probedAt, 0, 'an ingest marks the cached domain table stale');
    for (let i = 0; i < ONTOLOGY_EVENT_CAP + 10; i++) o = foldOntologyEvent(o, { action: 'ingested', domain: 'd', file: `${i}.csv` });
    assert.equal(o.events.length, ONTOLOGY_EVENT_CAP);
  });

  test('event lines: ingest shows counts, skip shows reason', () => {
    const ing = ontologyEventLine({ ts: 0, action: 'ingested', domain: 'shop', file: 'a.csv', counts: { object_type: 1, instance: 2, relationship: 0 }, appended: 3 }, 80);
    assert.match(ing, /a\.csv → shop/);
    assert.match(ing, /1t\/2i\/0r/);
    const skip = ontologyEventLine({ ts: 0, action: 'ingest_skipped', file: 'b.png', reason: 'unsupported file type' }, 80);
    assert.match(skip, /unsupported file type/);
  });

  test('renderOntology fills exactly H rows and shows the empty-state hint', () => {
    state.ontology.probedAt = Date.now();
    state.ontology.domains = [];
    const lines = renderOntology(100, 24);
    assert.equal(lines.length, 24);
    const text = lines.join('\n');
    assert.match(text, /ONTOLOGY/);
    assert.match(text, /no domains yet/);
  });

  test('renderOntology lists domains with counts once probed', () => {
    state.ontology.probedAt = Date.now();
    state.ontology.dropDir = 'D:\\drop';
    state.ontology.domains = [{ name: 'shop', counts: { object_type: 2, instance: 6, relationship: 4, ingest: 2, approvedTypes: 1 } }];
    const text = renderOntology(110, 24).join('\n');
    assert.match(text, /shop/);
    assert.match(text, /2 types · 6 instances · 4 relations/);
  });
});

// ── Drop-onto-the-window (page 7) ────────────────────────────────────────────

describe('copyIntoInbox — a drop on the Ontology view feeds the inbox', () => {
  test('a dropped file and a dropped folder both land in the inbox, recursively', async () => {
    const file = path.join(tmpHome, 'loose.csv');
    fs.writeFileSync(file, 'id\nA\n');
    const folder = path.join(tmpHome, 'My Shop Data');
    fs.mkdirSync(path.join(folder, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'a.csv'), 'id\nA\n');
    fs.writeFileSync(path.join(folder, 'nested', 'b.csv'), 'id\nB\n');

    const results = await copyIntoInbox([file, folder]);
    assert.deepEqual(results.map((r) => r.ok), [true, true]);
    const { dropDir } = await import('../src/ontology/engine.js');
    assert.ok(fs.existsSync(path.join(dropDir(), 'loose.csv')));
    assert.ok(fs.existsSync(path.join(dropDir(), 'My Shop Data', 'nested', 'b.csv')),
      'the folder copies whole, so its name becomes the domain');
  });

  test('a path already inside the inbox is refused (no self-copy loops)', async () => {
    const { dropDir } = await import('../src/ontology/engine.js');
    const inside = path.join(dropDir(), 'x.csv');
    fs.mkdirSync(dropDir(), { recursive: true });
    fs.writeFileSync(inside, 'id\nA\n');
    const results = await copyIntoInbox([inside]);
    assert.equal(results[0].ok, false);
    assert.match(results[0].reason, /already in the inbox/);
  });

  test('an oversized folder is refused with a reason, not copied', async () => {
    const big = path.join(tmpHome, 'huge');
    fs.mkdirSync(big, { recursive: true });
    for (let i = 0; i <= INBOX_DROP_MAX_FILES; i++) fs.writeFileSync(path.join(big, `f${i}.csv`), 'id\nA\n');
    const results = await copyIntoInbox([big]);
    assert.equal(results[0].ok, false);
    assert.match(results[0].reason, /too large/);
    const { dropDir } = await import('../src/ontology/engine.js');
    assert.ok(!fs.existsSync(path.join(dropDir(), 'huge')));
  });

  test('a nonexistent path reports instead of throwing', async () => {
    const results = await copyIntoInbox([path.join(tmpHome, 'ghost.csv')]);
    assert.equal(results[0].ok, false);
  });
});

// ── Daemon drop-scan announcement ────────────────────────────────────────────

describe('daemon integration', () => {
  test('boot scan ingests pre-existing drops and publishes ontology events on the real bus', async () => {
    // A file dropped while the daemon was down must be there after boot.
    const sub = path.join(dropDir(), 'sales');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'items.csv'), 'id,label\nI1,Widget\nI2,Gadget\n');

    const { Daemon } = await import('../src/kernel/daemon.js');
    const daemon = new Daemon({ timers: false });
    const seen = [];
    await daemon.start({ adopt: false });
    try {
      daemon.bus.subscribe('ontology', (evt) => seen.push(evt));
      // start() already ran the scan before we could subscribe — run the same
      // hook again; content addressing makes the second scan a no-op for the
      // store, so we assert on the FIRST scan's effects via the store, and on
      // the event path by dropping one more file and re-running the hook.
      const proj = loadProjection('sales');
      assert.equal(proj.counts.instance, 2, 'the boot scan ingested the pre-existing drop');

      // The boot scan filed items.csv into intake and pruned the emptied
      // sales/ folder — recreate it, as a user dropping a new file would.
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, 'extra.csv'), 'id\nX1\n');
      await daemon._startOntology();
      assert.ok(seen.some((e) => e.payload?.action === 'ingested' && e.payload?.file === 'extra.csv'),
        'a new drop is announced on the bus as an ontology event');
      const ingested = seen.find((e) => e.payload?.file === 'extra.csv');
      assert.ok(ingested.payload.graphPath, 'the announcement carries the refreshed graph path');
      assert.ok(fs.existsSync(ingested.payload.graphPath));
    } finally {
      await daemon.stop({ drain: false });
    }
  });
});
