// tests/ontology-g2.test.js
// G2 — agentic graph engineering: five new proposal ops with store-applied
// branches, the verifier's wider permission slip, incremental per-slice
// verification, entity resolution, and the critic lens. Every model
// interaction is scripted — the whole slice is offline.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendDocument, loadProjection, applyProposal, setPublicationState,
  evidenceRef, PROPOSAL_OPS,
} from '../src/ontology/store.js';
import {
  ALLOWED_ACTIONS, buildProjection, sliceKeys, verifyDomain, critiqueDomain, MIN_CONFIDENCE,
} from '../src/ontology/verifier.js';
import { candidatePairs, resolveEntities } from '../src/ontology/resolve.js';
import { hasPiiTokens } from '../src/ontology/redact.js';
import { ingestFile } from '../src/ontology/engine.js';

let tmpHome, dataDir;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-g2-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-g2-data-'));
  process.env.KAIROS_HOME = tmpHome;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  for (const d of [tmpHome, dataDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows locks */ }
  }
});

function writeData(name, content) {
  const p = path.join(dataDir, name);
  fs.writeFileSync(p, content);
  return p;
}

const EV = [evidenceRef('snapshot:aaa', 'header')];
const EV2 = [evidenceRef('snapshot:bbb', 'header')];

function seedType(domain, id, name, { properties = [], state = 'candidate', evidence = EV, extra = {} } = {}) {
  appendDocument(domain, {
    kind: 'object_type', id,
    payload: { name, properties, keyProperty: null, state, proposedBy: 'kairos-induction', evidence, ...extra },
  });
}

function seedInstance(domain, id, type, key, properties, { evidence = EV } = {}) {
  appendDocument(domain, {
    kind: 'instance', id,
    payload: { type, key, properties, state: 'candidate', proposedBy: 'kairos-induction', evidence },
  });
}

function seedProposal(domain, id, { target, change, proposedBy = 'kairos-verifier', evidence = EV, confidence = 0.9 } = {}) {
  appendDocument(domain, {
    kind: 'proposal', id,
    payload: { target, change, rationale: 'test', confidence, state: 'candidate', proposedBy, evidence },
  });
}

// ── The new apply branches ───────────────────────────────────────────────────

describe('G2 apply: merge_types', () => {
  test('keeper absorbs properties and alias; loser retires pointing home', () => {
    seedType('m1', 'type:Customer', 'Customer', {
      properties: [{ name: 'id', type: 'string', sources: ['snapshot:aaa'] }],
      state: 'candidate',
    });
    setPublicationState('m1', 'object_type', 'type:Customer', 'approved', 'the-owner');
    seedType('m1', 'type:Client', 'Client', {
      properties: [{ name: 'id', type: 'string', sources: ['snapshot:bbb'] }, { name: 'tier', type: 'string', sources: ['snapshot:bbb'] }],
      evidence: EV2,
    });
    seedProposal('m1', 'proposal:merge_types:t1', {
      target: { kind: 'object_type', id: 'type:Customer' },
      change: { op: 'merge_types', keep: 'type:Customer', retire: 'type:Client' },
      evidence: [...EV, ...EV2],
    });
    const res = applyProposal('m1', 'proposal:merge_types:t1', 'owner');
    assert.equal(res.op, 'merge_types');
    const proj = loadProjection('m1');
    const keeper = proj.object_type.get('type:Customer');
    assert.deepEqual(keeper.properties.map((p) => p.name).sort(), ['id', 'tier'], 'union, not last-write');
    const id = keeper.properties.find((p) => p.name === 'id');
    assert.deepEqual(id.sources.sort(), ['snapshot:aaa', 'snapshot:bbb'], 'per-property provenance survives the merge');
    assert.deepEqual(keeper.aliases, ['Client'], 'the loser lives on as an alias');
    assert.equal(keeper.state, 'approved', 'the keeper keeps its human signature');
    const loser = proj.object_type.get('type:Client');
    assert.equal(loser.state, 'retired');
    assert.equal(loser.mergedInto, 'type:Customer');
  });

  test('TWO-PHASE GUARANTEE: a failing merge never journals the approval', () => {
    seedType('m2', 'type:Customer', 'Customer');
    seedProposal('m2', 'proposal:merge_types:bad', {
      target: { kind: 'object_type', id: 'type:Customer' },
      change: { op: 'merge_types', keep: 'type:Customer', retire: 'type:Ghost' },
    });
    assert.throws(() => applyProposal('m2', 'proposal:merge_types:bad', 'owner'), /target missing/);
    assert.equal(loadProjection('m2').proposal.get('proposal:merge_types:bad').state, 'candidate',
      'an approved-but-unapplied proposal would be a lie in the journal');
  });

  test('merging a type into itself is refused', () => {
    seedType('m3', 'type:A', 'A');
    seedProposal('m3', 'proposal:merge_types:self', {
      target: { kind: 'object_type', id: 'type:A' },
      change: { op: 'merge_types', keep: 'type:A', retire: 'type:A' },
    });
    assert.throws(() => applyProposal('m3', 'proposal:merge_types:self', 'owner'), /distinct/);
  });
});

describe('G2 apply: retire_relation', () => {
  test('an induced reference relation retires with attribution', () => {
    appendDocument('r1', {
      kind: 'relationship', id: 'rel:refers:Order.status->Priority',
      payload: {
        name: 'Order.status → Priority', kind: 'reference', fromType: 'Order', toType: 'Priority',
        viaProperty: 'status', coverage: 0.8, state: 'candidate', proposedBy: 'kairos-induction', evidence: EV,
      },
    });
    seedProposal('r1', 'proposal:retire_relation:x', {
      target: { kind: 'relationship', id: 'rel:refers:Order.status->Priority' },
      change: { op: 'retire_relation' },
      proposedBy: 'kairos-critic',
    });
    applyProposal('r1', 'proposal:retire_relation:x', 'owner');
    const rel = loadProjection('r1').relationship.get('rel:refers:Order.status->Priority');
    assert.equal(rel.state, 'retired');
    assert.equal(rel.retiredBy, 'owner');
  });

  test('only relationship kinds retire this way — an object_type target is refused', () => {
    seedType('r2', 'type:A', 'A');
    seedProposal('r2', 'proposal:retire_relation:bad', {
      target: { kind: 'object_type', id: 'type:A' },
      change: { op: 'retire_relation' },
    });
    assert.throws(() => applyProposal('r2', 'proposal:retire_relation:bad', 'owner'), /must be a relationship/);
  });
});

describe('G2 apply: retype_property', () => {
  test('the property changes type and remembers what it was', () => {
    seedType('t1', 'type:Order', 'Order', {
      properties: [{ name: 'shipped', type: 'string', sources: ['snapshot:aaa'] }],
    });
    seedProposal('t1', 'proposal:retype_property:x', {
      target: { kind: 'object_type', id: 'type:Order' },
      change: { op: 'retype_property', property: 'shipped', type: 'date' },
    });
    applyProposal('t1', 'proposal:retype_property:x', 'owner');
    const prop = loadProjection('t1').object_type.get('type:Order').properties.find((p) => p.name === 'shipped');
    assert.equal(prop.type, 'date');
    assert.equal(prop.retypedFrom, 'string');
  });

  test('an unknown property fails before the approval is journaled', () => {
    seedType('t2', 'type:Order', 'Order', { properties: [{ name: 'id', type: 'string' }] });
    seedProposal('t2', 'proposal:retype_property:bad', {
      target: { kind: 'object_type', id: 'type:Order' },
      change: { op: 'retype_property', property: 'ghost', type: 'date' },
    });
    assert.throws(() => applyProposal('t2', 'proposal:retype_property:bad', 'owner'), /not a property/);
    assert.equal(loadProjection('t2').proposal.get('proposal:retype_property:bad').state, 'candidate');
  });
});

describe('G2 apply: merge_instances', () => {
  test('keeper gains sameAs and BOTH evidence trails; loser retires; no values rewritten', () => {
    seedInstance('i1', 'inst:Customer:C1', 'Customer', 'C1', { id: 'C1', name: 'Tanaka', city: 'Tokyo' }, { evidence: EV });
    seedInstance('i1', 'inst:Customer:CU-1', 'Customer', 'CU-1', { id: 'CU-1', name: 'Tanaka' }, { evidence: EV2 });
    seedProposal('i1', 'proposal:merge_instances:x', {
      target: { kind: 'instance', id: 'inst:Customer:C1' },
      change: { op: 'merge_instances', keep: 'inst:Customer:C1', retire: 'inst:Customer:CU-1' },
      proposedBy: 'kairos-resolver', evidence: [...EV, ...EV2],
    });
    applyProposal('i1', 'proposal:merge_instances:x', 'owner');
    const proj = loadProjection('i1');
    const keeper = proj.instance.get('inst:Customer:C1');
    assert.deepEqual(keeper.sameAs, ['inst:Customer:CU-1']);
    assert.equal(keeper.evidence.length, 2, 'the keeper cites both source files');
    assert.deepEqual(keeper.properties, { id: 'C1', name: 'Tanaka', city: 'Tokyo' },
      'instances mirror source bytes — merging never invents a combined row');
    const loser = proj.instance.get('inst:Customer:CU-1');
    assert.equal(loser.state, 'retired');
    assert.equal(loser.mergedInto, 'inst:Customer:C1');
  });

  test('instances of different types never merge', () => {
    seedInstance('i2', 'inst:Customer:C1', 'Customer', 'C1', { id: 'C1' });
    seedInstance('i2', 'inst:Order:O1', 'Order', 'O1', { id: 'O1' });
    seedProposal('i2', 'proposal:merge_instances:bad', {
      target: { kind: 'instance', id: 'inst:Customer:C1' },
      change: { op: 'merge_instances', keep: 'inst:Customer:C1', retire: 'inst:Order:O1' },
    });
    assert.throws(() => applyProposal('i2', 'proposal:merge_instances:bad', 'owner'), /different types never merge/);
  });

  test('separation of duties: the resolver cannot approve its own merge', () => {
    seedInstance('i3', 'inst:Customer:A', 'Customer', 'A', { id: 'A' });
    seedInstance('i3', 'inst:Customer:B', 'Customer', 'B', { id: 'B' });
    seedProposal('i3', 'proposal:merge_instances:own', {
      target: { kind: 'instance', id: 'inst:Customer:A' },
      change: { op: 'merge_instances', keep: 'inst:Customer:A', retire: 'inst:Customer:B' },
      proposedBy: 'kairos-resolver',
    });
    assert.throws(() => applyProposal('i3', 'proposal:merge_instances:own', 'kairos-resolver'), /separation of duties/);
  });
});

describe('G2 apply: annotate', () => {
  test('tags union across annotations; the note updates', () => {
    seedType('a1', 'type:Order', 'Order', { properties: [{ name: 'total', type: 'number' }] });
    seedProposal('a1', 'proposal:annotate:1', {
      target: { kind: 'object_type', id: 'type:Order' },
      change: { op: 'annotate', annotation: { tags: ['unit:JPY'], note: 'money is yen' } },
    });
    applyProposal('a1', 'proposal:annotate:1', 'owner');
    seedProposal('a1', 'proposal:annotate:2', {
      target: { kind: 'object_type', id: 'type:Order' },
      change: { op: 'annotate', annotation: { tags: ['unit:JPY', 'domain:commerce'] } },
    });
    applyProposal('a1', 'proposal:annotate:2', 'owner');
    const ann = loadProjection('a1').object_type.get('type:Order').annotations;
    assert.deepEqual(ann.tags, ['unit:JPY', 'domain:commerce'], 'tags union, never duplicate');
    assert.equal(ann.note, 'money is yen', 'an annotation without a note keeps the old note');
  });
});

// ── Verifier growth ──────────────────────────────────────────────────────────

describe('G2 verifier permission slip', () => {
  test('the closed set grew together: prompt ops and store ops stay one list', () => {
    assert.deepEqual(Object.keys(ALLOWED_ACTIONS).sort(), [...PROPOSAL_OPS].sort());
    for (const op of ['merge_types', 'retire_relation', 'retype_property', 'merge_instances', 'annotate']) {
      assert.ok(PROPOSAL_OPS.includes(op), `${op} missing from the store's closed set`);
    }
  });

  test('induced reference relations now reach the model-visible projection', () => {
    const csv = writeData('customers.csv', 'id,region_id\nC1,R1\nC2,R2\n');
    const csv2 = writeData('regions.csv', 'id,name\nR1,Kanto\nR2,Kansai\n');
    assert.equal(ingestFile('vp', csv).ok, true);
    assert.equal(ingestFile('vp', csv2).ok, true);
    const { data } = buildProjection('vp');
    const ref = data.relations.find((r) => r.kind === 'relationship');
    assert.ok(ref, 'the syntactic FK guesses are part of what the verifier reviews');
    assert.match(ref.id, /^rel:refers:/);
    assert.equal(ref.from, 'Customer');
    assert.equal(ref.to, 'Region');
  });

  test('a scripted merge_types proposal lands with BOTH types\' evidence', async () => {
    const c1 = writeData('customers.csv', 'id,name\nC1,Alpha\nC2,Beta\n');
    const c2 = writeData('clients.csv', 'id,tier\nK1,gold\nK2,silver\n');
    assert.equal(ingestFile('vm', c1).ok, true);
    assert.equal(ingestFile('vm', c2).ok, true);
    const llm = async () => JSON.stringify({
      proposals: [{
        op: 'merge_types', merge: { keep: 'type:Customer', retire: 'type:Client' },
        rationale: 'clients and customers are the same concept here', confidence: 0.8,
      }],
    });
    const res = await verifyDomain('vm', { llm });
    assert.equal(res.proposals.length, 1);
    const p = loadProjection('vm').proposal.get(res.proposals[0]);
    assert.equal(p.change.op, 'merge_types');
    assert.equal(p.change.keep, 'type:Customer');
    const snapshots = new Set(p.evidence.map((e) => e.snapshot));
    assert.equal(snapshots.size, 2, 'a merge claim cites both sides\' bytes');
  });

  test('invented merges, unknown properties, bad types and empty annotations are discarded', async () => {
    const csv = writeData('orders.csv', 'id,total\nO1,100\nO2,200\n');
    assert.equal(ingestFile('vd', csv).ok, true);
    const llm = async () => JSON.stringify({
      proposals: [
        { op: 'merge_types', merge: { keep: 'type:Order', retire: 'type:Ghost' }, confidence: 0.9 },
        { op: 'merge_types', merge: { keep: 'type:Order', retire: 'type:Order' }, confidence: 0.9 },
        { op: 'retype_property', target: { kind: 'object_type', id: 'type:Order' }, property: 'ghost', type: 'date', confidence: 0.9 },
        { op: 'retype_property', target: { kind: 'object_type', id: 'type:Order' }, property: 'total', type: 'money', confidence: 0.9 },
        { op: 'annotate', target: { kind: 'object_type', id: 'type:Order' }, annotation: { tags: [] }, confidence: 0.9 },
        { op: 'retire_relation', target: { kind: 'relationship', id: 'rel:refers:Fake' }, confidence: 0.9 },
        { op: 'merge_instances', merge: { keep: 'inst:Order:O1', retire: 'inst:Ghost:X' }, confidence: 0.9 },
      ],
    });
    const res = await verifyDomain('vd', { llm });
    assert.equal(res.proposals.length, 0);
    assert.equal(res.discarded, 7, 'every invented claim dies at validation');
  });

  test('a valid retype_property proposal survives and applies end to end', async () => {
    const csv = writeData('orders.csv', 'id,shipped\nO1,Jan 5 2026\nO2,Feb 1 2026\n');
    assert.equal(ingestFile('vr', csv).ok, true);
    const llm = async () => JSON.stringify({
      proposals: [{
        op: 'retype_property', target: { kind: 'object_type', id: 'type:Order' },
        property: 'shipped', type: 'date', rationale: 'these are dates', confidence: 0.9,
      }],
    });
    const res = await verifyDomain('vr', { llm });
    assert.equal(res.proposals.length, 1);
    applyProposal('vr', res.proposals[0], 'owner');
    const prop = loadProjection('vr').object_type.get('type:Order').properties.find((p) => p.name === 'shipped');
    assert.equal(prop.type, 'date');
  });
});

// ── Incremental verification ─────────────────────────────────────────────────

describe('G2 incremental slices', () => {
  test('slice keys are content-addressed per type subgraph', () => {
    const csv = writeData('customers.csv', 'id,name\nC1,A\nC2,B\n');
    assert.equal(ingestFile('s1', csv).ok, true);
    const k1 = sliceKeys(buildProjection('s1').data);
    const k2 = sliceKeys(buildProjection('s1').data);
    assert.deepEqual(k1, k2, 'same subgraph, same keys');
    assert.match(k1[0].key, /^enrichment:slice:[0-9a-f]{16}$/);
    const csv2 = writeData('customers2.csv', 'id,name\nC1,A\nC2,B\nC3,C\n');
    fs.copyFileSync(csv2, path.join(dataDir, 'customers.csv'));
    assert.equal(ingestFile('s1', path.join(dataDir, 'customers.csv')).ok, true);
    const k3 = sliceKeys(buildProjection('s1').data);
    assert.notEqual(k3[0].key, k1[0].key, 'new instances re-arm the slice');
  });

  test('a second unrelated file re-reviews ONLY its own slice', async () => {
    const customers = writeData('customers.csv', 'id,name\nC1,A\nC2,B\n');
    assert.equal(ingestFile('s2', customers).ok, true);
    const prompts = [];
    const llm = async (messages) => { prompts.push(messages.map((m) => m.content).join('\n')); return '{"proposals":[]}'; };
    const first = await verifyDomain('s2', { llm });
    assert.equal(first.slices.reviewed, 1);
    // A file with no FK into customers: the Customer slice is untouched.
    const products = writeData('products.csv', 'sku,title\nP1,GPU\nP2,SSD\n');
    assert.equal(ingestFile('s2', products).ok, true);
    const second = await verifyDomain('s2', { llm });
    assert.equal(second.slices.total, 2);
    assert.equal(second.slices.reviewed, 1, 'only the Product slice went to the model');
    assert.equal(second.slices.skipped, 1);
    assert.ok(prompts[1].includes('Product'));
    assert.ok(!prompts[1].includes('"name": "Customer"'), 'the unchanged Customer slice is cut from the model\'s view');
  });

  test('a new FK re-arms BOTH slices it touches', async () => {
    const customers = writeData('customers.csv', 'id,name\nC1,A\nC2,B\n');
    assert.equal(ingestFile('s3', customers).ok, true);
    const llm = async () => '{"proposals":[]}';
    await verifyDomain('s3', { llm });
    // orders.customer_id points at customers — the Customer subgraph changed.
    const orders = writeData('orders.csv', 'id,customer_id\nO1,C1\nO2,C2\n');
    assert.equal(ingestFile('s3', orders).ok, true);
    const res = await verifyDomain('s3', { llm });
    assert.equal(res.slices.reviewed, 2, 'the FK made Customer part of the changed subgraph');
    assert.equal(res.slices.skipped, 0);
  });

  test('unchanged domain still replays with zero model calls', async () => {
    const csv = writeData('customers.csv', 'id,name\nC1,A\nC2,B\n');
    assert.equal(ingestFile('s4', csv).ok, true);
    let calls = 0;
    const llm = async () => { calls++; return '{"proposals":[]}'; };
    await verifyDomain('s4', { llm });
    const again = await verifyDomain('s4', { llm });
    assert.equal(again.replay, true);
    assert.equal(calls, 1);
  });
});

// ── Entity resolution ────────────────────────────────────────────────────────

function seedDuplicates(domain) {
  // The same person under two keys — exactly what two exports produce.
  seedInstance(domain, 'inst:Customer:C1', 'Customer', 'C1',
    { id: 'C1', name: 'Tanaka Hiroshi', email: 'tanaka@example.jp', city: 'Tokyo' }, { evidence: EV });
  seedInstance(domain, 'inst:Customer:CU-001', 'Customer', 'CU-001',
    { id: 'CU-001', name: 'TANAKA, Hiroshi', email: 'tanaka@example.jp' }, { evidence: EV2 });
  seedInstance(domain, 'inst:Customer:C2', 'Customer', 'C2',
    { id: 'C2', name: 'Suzuki Ai', email: 'ai@example.jp' }, { evidence: EV });
}

describe('G2 entity resolution', () => {
  test('candidate pairs come from shared identity values, deterministically', () => {
    seedDuplicates('e1');
    const pairs = candidatePairs(loadProjection('e1'));
    assert.equal(pairs.length, 1, 'only the true collision pairs up');
    assert.equal(pairs[0].type, 'Customer');
    assert.equal(pairs[0].via, 'email');
    assert.deepEqual([pairs[0].a, pairs[0].b].sort(), ['inst:Customer:C1', 'inst:Customer:CU-001']);
    assert.deepEqual(candidatePairs(loadProjection('e1')), pairs, 'same projection, same pairs');
  });

  test('clean data yields no pairs and never calls the model', async () => {
    seedInstance('e2', 'inst:Customer:C1', 'Customer', 'C1', { id: 'C1', name: 'Alpha', email: 'a@x.jp' });
    seedInstance('e2', 'inst:Customer:C2', 'Customer', 'C2', { id: 'C2', name: 'Beta', email: 'b@x.jp' });
    let calls = 0;
    const res = await resolveEntities('e2', { llm: async () => { calls++; return '{}'; } });
    assert.ok(res.skipped);
    assert.equal(calls, 0);
  });

  test('a confident SAME verdict becomes a merge proposal citing both files; approval applies it', async () => {
    seedDuplicates('e3');
    const llm = async () => JSON.stringify({
      judgments: [{ pair: 0, same: true, confidence: 0.9, rationale: 'same email, same person, formatted differently' }],
    });
    const res = await resolveEntities('e3', { llm });
    assert.equal(res.proposals.length, 1);
    const p = loadProjection('e3').proposal.get(res.proposals[0]);
    assert.equal(p.change.op, 'merge_instances');
    assert.equal(p.proposedBy, 'kairos-resolver');
    assert.equal(p.change.keep, 'inst:Customer:C1', 'the richer record is the keeper');
    assert.equal(p.change.retire, 'inst:Customer:CU-001');
    assert.equal(new Set(p.evidence.map((e) => e.snapshot)).size, 2, 'evidence from BOTH sides');
    applyProposal('e3', res.proposals[0], 'owner');
    const proj = loadProjection('e3');
    assert.deepEqual(proj.instance.get('inst:Customer:C1').sameAs, ['inst:Customer:CU-001']);
    assert.equal(proj.instance.get('inst:Customer:CU-001').state, 'retired');
  });

  test('DIFFERENT verdicts and weak confidence produce nothing', async () => {
    seedDuplicates('e4');
    const llm = async () => JSON.stringify({
      judgments: [{ pair: 0, same: false, confidence: 0.9, rationale: 'father and son share the address' }],
    });
    const res = await resolveEntities('e4', { llm });
    assert.equal(res.proposals.length, 0);
    assert.equal(res.keptApart, 1, 'a confident "different" is an answer, not noise');
    const weak = await resolveEntities('e4', {
      llm: async () => JSON.stringify({ judgments: [{ pair: 0, same: true, confidence: MIN_CONFIDENCE - 0.1 }] }),
      force: true,
    });
    assert.equal(weak.proposals.length, 0);
    assert.equal(weak.discarded, 1);
  });

  test('DETERMINISTIC FLOOR: a dead model leaves the journal byte-identical', async () => {
    seedDuplicates('e5');
    const before = fs.readFileSync(path.join(tmpHome, 'ontology', 'e5', 'documents.jsonl'), 'utf-8');
    const res = await resolveEntities('e5', { llm: async () => { throw new Error('429'); } });
    assert.equal(res.floor, true);
    const after = fs.readFileSync(path.join(tmpHome, 'ontology', 'e5', 'documents.jsonl'), 'utf-8');
    assert.equal(before, after);
  });

  test('PII: the judge sees tokens, never raw emails or names', async () => {
    seedDuplicates('e6');
    const seen = [];
    await resolveEntities('e6', { llm: async (messages) => { seen.push(...messages); return '{"judgments":[]}'; } });
    const all = seen.map((m) => m.content).join('\n');
    assert.ok(!all.includes('tanaka@example.jp'), 'raw email leaked to the judge');
    assert.ok(!all.includes('Tanaka Hiroshi'), 'raw person name leaked to the judge');
    assert.ok(hasPiiTokens(all));
    assert.ok(all.includes('[PII_EMAIL_1]'), 'both records show the SAME token — comparable identity');
  });

  test('IDEMPOTENCY: unchanged pairs replay without a second spend', async () => {
    seedDuplicates('e7');
    let calls = 0;
    const llm = async () => { calls++; return '{"judgments":[]}'; };
    await resolveEntities('e7', { llm });
    const second = await resolveEntities('e7', { llm });
    assert.equal(second.replay, true);
    assert.equal(calls, 1);
    await resolveEntities('e7', { llm, force: true });
    assert.equal(calls, 2, '--force re-runs deliberately');
  });
});

// ── The critic lens ──────────────────────────────────────────────────────────

function seedFalseJoin(domain) {
  // status values {open,closed} overlapping a Priority id column — the classic
  // false FK the ≥60%-overlap heuristic invents.
  appendDocument(domain, {
    kind: 'relationship', id: 'rel:refers:Ticket.status->Priority',
    payload: {
      name: 'Ticket.status → Priority', kind: 'reference', fromType: 'Ticket', toType: 'Priority',
      viaProperty: 'status', coverage: 0.75, state: 'candidate', proposedBy: 'kairos-induction', evidence: EV,
    },
  });
  seedType(domain, 'type:Ticket', 'Ticket', { properties: [{ name: 'status', type: 'string' }] });
  seedType(domain, 'type:Priority', 'Priority', { properties: [{ name: 'id', type: 'string' }] });
}

describe('G2 critic lens', () => {
  test('a refutation becomes a retire_relation proposal; approval retires the join', async () => {
    seedFalseJoin('c1');
    const llm = async () => JSON.stringify({
      refutations: [{ id: 'rel:refers:Ticket.status->Priority', rationale: 'status is an enum, not a foreign key', confidence: 0.85 }],
    });
    const res = await critiqueDomain('c1', { llm });
    assert.equal(res.proposals.length, 1);
    const p = loadProjection('c1').proposal.get(res.proposals[0]);
    assert.equal(p.change.op, 'retire_relation');
    assert.equal(p.proposedBy, 'kairos-critic');
    assert.ok(p.evidence.length > 0, 'grounded in the relation\'s own evidence');
    applyProposal('c1', res.proposals[0], 'owner');
    assert.equal(loadProjection('c1').relationship.get('rel:refers:Ticket.status->Priority').state, 'retired');
  });

  test('invented ids and weak confidence are discarded; the critic cannot touch sound joins', async () => {
    seedFalseJoin('c2');
    const llm = async () => JSON.stringify({
      refutations: [
        { id: 'rel:refers:Imaginary', rationale: 'hallucinated', confidence: 0.9 },
        { id: 'rel:refers:Ticket.status->Priority', rationale: 'meh', confidence: MIN_CONFIDENCE - 0.1 },
      ],
    });
    const res = await critiqueDomain('c2', { llm });
    assert.equal(res.proposals.length, 0);
    assert.equal(res.discarded, 2);
  });

  test('DETERMINISTIC FLOOR: garbage output changes nothing', async () => {
    seedFalseJoin('c3');
    const res = await critiqueDomain('c3', { llm: async () => 'in my opinion these joins are fine' });
    assert.equal(res.floor, true);
    assert.equal(loadProjection('c3').counts.proposal || 0, 0);
  });

  test('IDEMPOTENCY: unchanged suspects replay; a retired join leaves the docket', async () => {
    seedFalseJoin('c4');
    let calls = 0;
    const llm = async () => { calls++; return '{"refutations":[]}'; };
    await critiqueDomain('c4', { llm });
    const second = await critiqueDomain('c4', { llm });
    assert.equal(second.replay, true);
    assert.equal(calls, 1);
    setPublicationState('c4', 'relationship', 'rel:refers:Ticket.status->Priority', 'retired', 'owner');
    const after = await critiqueDomain('c4', { llm });
    assert.ok(after.skipped, 'nothing candidate left to refute — no spend');
    assert.equal(calls, 1);
  });

  test('an empty domain is skipped without a model call', async () => {
    let calls = 0;
    const res = await critiqueDomain('c5', { llm: async () => { calls++; return '{}'; } });
    assert.ok(res.skipped);
    assert.equal(calls, 0);
  });
});
