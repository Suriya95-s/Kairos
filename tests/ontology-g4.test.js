// tests/ontology-g4.test.js
// G4 — living graph & review UX: temporal as-of views, release diffs, the
// proposal overlay in the graph HTML, and the TUI review queue with
// approve/reject keys. No model anywhere — G4 is pure surface over the store.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendDocument, loadProjection, loadProjectionAsOf, setPublicationState,
  createRelease, diffReleases, evidenceRef, domainDir, applyProposal,
} from '../src/ontology/store.js';
import { graphData, renderGraphHtml, writeGraphHtml } from '../src/ontology/graph.js';
import { ingestFile } from '../src/ontology/engine.js';
import {
  probeOntology, proposalSummary, actOnProposal, renderOntology, PROPOSAL_QUEUE_CAP,
} from '../apps/tui/src/views/ontology.js';
import { state } from '../apps/tui/src/state.js';

let tmpHome, dataDir;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-g4-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-g4-data-'));
  process.env.KAIROS_HOME = tmpHome;
  state.ontology = {
    events: [], domains: null, dropDir: '', lastGraphPath: '', probedAt: 0,
    proposals: [], cursor: 0,
  };
  state.pendingApprovals = [];
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  for (const d of [tmpHome, dataDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows locks */ }
  }
});

const EV = [evidenceRef('snapshot:aaa', 'header')];

function seedProposal(domain, id, { target, change, proposedBy = 'kairos-verifier', confidence = 0.8 } = {}) {
  appendDocument(domain, {
    kind: 'proposal', id,
    payload: { target, change, rationale: 'test', confidence, state: 'candidate', proposedBy, evidence: EV },
  });
}

/** Write journal lines with EXPLICIT timestamps — deterministic history. */
function writeJournal(domain, docs) {
  const file = path.join(domainDir(domain), 'documents.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, docs.map((d) => JSON.stringify(d) + '\n').join(''));
}

// ── Temporal as-of views ─────────────────────────────────────────────────────

describe('G4 as-of views', () => {
  test('the journal replays any instant: earlier fold, earlier truth', () => {
    writeJournal('history', [
      { kind: 'object_type', id: 'type:Order', version: 1, at: 1000, payload: { name: 'Order', state: 'candidate' } },
      { kind: 'object_type', id: 'type:Order', version: 2, at: 2000, payload: { name: 'Order', state: 'approved', approvedBy: 'owner' } },
      { kind: 'object_type', id: 'type:Ticket', version: 1, at: 3000, payload: { name: 'Ticket', state: 'candidate' } },
    ]);
    const early = loadProjectionAsOf('history', 1500);
    assert.equal(early.object_type.get('type:Order').state, 'candidate', 'before the approval, it was a candidate');
    assert.ok(!early.object_type.has('type:Ticket'), 'Ticket did not exist yet');
    assert.equal(early.counts.object_type, 1);
    const late = loadProjectionAsOf('history', 3000);
    assert.equal(late.object_type.get('type:Order').state, 'approved');
    assert.ok(late.object_type.has('type:Ticket'));
    assert.equal(late.asOf, 3000, 'the projection says what moment it is');
    assert.throws(() => loadProjectionAsOf('history', 'yesterday'), /epoch-ms/);
  });

  test('the live projection and as-of(now) agree', () => {
    const csv = path.join(dataDir, 'orders.csv');
    fs.writeFileSync(csv, 'id,total\nO1,100\n');
    assert.equal(ingestFile('nowcheck', csv).ok, true);
    const live = loadProjection('nowcheck');
    const asOf = loadProjectionAsOf('nowcheck', Date.now() + 1000);
    assert.deepEqual(asOf.counts, { ...live.counts });
  });
});

// ── Release diffs ────────────────────────────────────────────────────────────

describe('G4 release diffs', () => {
  test('added, removed and changed documents between two pinned releases', () => {
    appendDocument('rel', { kind: 'object_type', id: 'type:A', payload: { name: 'A', state: 'candidate', proposedBy: 'x', evidence: EV } });
    appendDocument('rel', { kind: 'object_type', id: 'type:B', payload: { name: 'B', state: 'candidate', proposedBy: 'x', evidence: EV } });
    setPublicationState('rel', 'object_type', 'type:A', 'approved', 'owner');
    setPublicationState('rel', 'object_type', 'type:B', 'approved', 'owner');
    const r1 = createRelease('rel', { createdBy: 'owner' });
    // Change A (new description version), remove B (retire), add C.
    const a = loadProjection('rel').object_type.get('type:A');
    const { _version, _at, ...aPayload } = a;
    appendDocument('rel', { kind: 'object_type', id: 'type:A', payload: { ...aPayload, description: 'the A of it all' } });
    setPublicationState('rel', 'object_type', 'type:B', 'retired', 'owner');
    appendDocument('rel', { kind: 'object_type', id: 'type:C', payload: { name: 'C', state: 'candidate', proposedBy: 'x', evidence: EV } });
    setPublicationState('rel', 'object_type', 'type:C', 'approved', 'owner');
    const r2 = createRelease('rel', { createdBy: 'owner' });
    const d = diffReleases('rel', r1.id, r2.id);
    assert.deepEqual(d.added, ['object_type/type:C']);
    assert.deepEqual(d.removed, ['object_type/type:B'], 'retired means out of the approved set');
    assert.deepEqual(d.changed, ['object_type/type:A']);
  });

  test('identical releases diff to nothing; a tampered side refuses to diff', () => {
    appendDocument('rel2', { kind: 'object_type', id: 'type:A', payload: { name: 'A', state: 'candidate', proposedBy: 'x', evidence: EV } });
    setPublicationState('rel2', 'object_type', 'type:A', 'approved', 'owner');
    const r = createRelease('rel2', { createdBy: 'owner' });
    const d = diffReleases('rel2', r.id, r.id);
    assert.deepEqual([d.added, d.removed, d.changed], [[], [], []]);
    const rec = JSON.parse(fs.readFileSync(r.file, 'utf-8'));
    rec.docs.object_type['type:A'].name = 'Sneaky';
    fs.writeFileSync(r.file, JSON.stringify(rec));
    assert.throws(() => diffReleases('rel2', r.id, r.id), /tampered/);
  });
});

// ── Proposal overlay in the graph ────────────────────────────────────────────

function seedOverlayDomain(domain = 'ov') {
  const c = path.join(dataDir, 'customers.csv');
  const o = path.join(dataDir, 'orders.csv');
  fs.writeFileSync(c, 'id,name\nC1,Ada\nC2,Lin\n');
  fs.writeFileSync(o, 'id,customer_id\nO1,C1\nO2,C2\n');
  assert.equal(ingestFile(domain, c).ok, true);
  assert.equal(ingestFile(domain, o).ok, true);
  return domain;
}

describe('G4 proposal overlay', () => {
  test('pending proposals become badges, dashed edges and panel commands', () => {
    seedOverlayDomain();
    seedProposal('ov', 'proposal:rename:1', {
      target: { kind: 'object_type', id: 'type:Customer' },
      change: { op: 'rename', name: 'Client' },
    });
    seedProposal('ov', 'proposal:add_relation:1', {
      target: { kind: 'relationship_type', id: 'new' },
      change: { op: 'add_relation', relation: { name: 'places', from: 'Customer', to: 'Order' } },
    });
    seedProposal('ov', 'proposal:merge_types:1', {
      target: { kind: 'object_type', id: 'type:Customer' },
      change: { op: 'merge_types', keep: 'type:Customer', retire: 'type:Order' },
    });
    const data = graphData(loadProjection('ov'));
    const customer = data.nodes.find((n) => n.id === 'type:Customer');
    assert.equal(customer.pending, 3, 'rename + add_relation + merge all touch Customer');
    assert.equal(customer.detail.pendingProposals.length, 3);
    const proposalEdges = data.edges.filter((e) => e.kind === 'proposal');
    assert.equal(proposalEdges.length, 2, 'the proposed relation and the proposed merge are dashed ghosts');
    assert.ok(proposalEdges.some((e) => e.label === 'places?'));
    assert.ok(proposalEdges.some((e) => e.label === 'merge?'));
    assert.equal(data.meta.openProposals, 3);
  });

  test('a retire_relation proposal strikes through its reference edge', () => {
    seedOverlayDomain('ov2');
    const refId = [...loadProjection('ov2').relationship.entries()]
      .find(([, r]) => r.kind === 'reference')[0];
    seedProposal('ov2', 'proposal:retire_relation:1', {
      target: { kind: 'relationship', id: refId },
      change: { op: 'retire_relation' },
      proposedBy: 'kairos-critic',
    });
    const data = graphData(loadProjection('ov2'));
    const edge = data.edges.find((e) => e.id === refId);
    assert.equal(edge.pendingRetire, true);
    assert.equal(edge.proposal.by, 'kairos-critic');
  });

  test('applied proposals leave the overlay — only candidates ghost', () => {
    seedOverlayDomain('ov3');
    seedProposal('ov3', 'proposal:rename:x', {
      target: { kind: 'object_type', id: 'type:Customer' },
      change: { op: 'rename', name: 'Client' },
    });
    // Approve it through the real boundary, then the ghost must vanish.
    applyProposal('ov3', 'proposal:rename:x', 'owner');
    const data = graphData(loadProjection('ov3'));
    const customer = data.nodes.find((n) => n.kind === 'type' && n.label === 'Client');
    assert.ok(customer, 'the rename itself landed');
    assert.equal(customer.pending, undefined);
    assert.equal(data.meta.openProposals, 0);
  });

  test('the HTML renders the overlay: dashed strokes, legend, human commands', () => {
    seedOverlayDomain('ov4');
    seedProposal('ov4', 'proposal:rename:h', {
      target: { kind: 'object_type', id: 'type:Customer' },
      change: { op: 'rename', name: 'Client' },
    });
    const html = renderGraphHtml(loadProjection('ov4'));
    assert.ok(html.includes('setLineDash'), 'proposal edges are dashed');
    assert.ok(html.includes('◇ proposal (dashed)'), 'the legend explains the ghosts');
    assert.ok(html.includes('kairos ontology approve'), 'the panel hands the human the exact command');
    assert.ok(html.includes('pending proposal'), 'the header counts what awaits review');
  });

  test('as-of graphs write beside the live one, never over it', () => {
    seedOverlayDomain('ov5');
    const live = writeGraphHtml('ov5');
    const before = fs.readFileSync(live, 'utf-8');
    const asOf = writeGraphHtml('ov5', { asOf: Date.now() + 1000 });
    assert.notEqual(asOf, live);
    assert.ok(asOf.endsWith('graph-asof.html'));
    assert.ok(fs.readFileSync(asOf, 'utf-8').includes('as of '), 'the header says what moment this is');
    assert.equal(fs.readFileSync(live, 'utf-8'), before, 'the live view is untouched');
  });
});

// ── TUI review queue ─────────────────────────────────────────────────────────

describe('G4 TUI review queue', () => {
  test('proposalSummary covers every op in one line', () => {
    assert.match(proposalSummary({ target: { id: 't' }, change: { op: 'rename', name: 'X' } }), /rename t/);
    assert.match(proposalSummary({ change: { op: 'merge_types', keep: 'a', retire: 'b' } }), /merge b into a/);
    assert.match(proposalSummary({ target: { id: 'r' }, change: { op: 'retire_relation' } }), /retire r/);
    assert.match(proposalSummary({ target: { id: 't' }, change: { op: 'retype_property', property: 'p', type: 'date' } }), /retype t\.p → date/);
    assert.match(proposalSummary({ target: { id: 't' }, change: { op: 'annotate', annotation: { tags: ['unit:JPY'] } } }), /annotate t \[unit:JPY\]/);
  });

  test('probeOntology flattens candidate proposals across domains, newest first', async () => {
    seedOverlayDomain('q1');
    seedProposal('q1', 'proposal:rename:1', {
      target: { kind: 'object_type', id: 'type:Customer' }, change: { op: 'rename', name: 'Client' },
    });
    seedOverlayDomain('q2');
    seedProposal('q2', 'proposal:describe:1', {
      target: { kind: 'object_type', id: 'type:Customer' }, change: { op: 'describe', description: 'buyers' },
    });
    const probe = await probeOntology();
    assert.equal(probe.proposals.length, 2);
    const domains = probe.proposals.map((p) => p.domain).sort();
    assert.deepEqual(domains, ['q1', 'q2']);
    assert.ok(probe.proposals.every((p) => p.summary && p.id && p.by));
    assert.ok(probe.proposals.length <= PROPOSAL_QUEUE_CAP);
  });

  test('the view shows the queue with keys; without proposals the section vanishes', async () => {
    state.ontology.probedAt = Date.now();
    state.ontology.domains = [{ name: 'q', counts: { object_type: 1 } }];
    state.ontology.proposals = [{ domain: 'q', id: 'proposal:rename:1', op: 'rename', summary: 'rename type:X → "Y"', confidence: 0.8, by: 'kairos-verifier' }];
    const withQueue = renderOntology(100, 34).join('\n');
    assert.ok(withQueue.includes('PROPOSALS'));
    assert.ok(withQueue.includes('[a]pprove'));
    assert.ok(withQueue.includes('rename type:X'));
    state.ontology.proposals = [];
    const without = renderOntology(100, 34).join('\n');
    assert.ok(!without.includes('PROPOSALS'), 'an empty docket takes no space');
  });

  test('approve key path APPLIES through the real boundary; reject retires', async () => {
    seedOverlayDomain('act');
    seedProposal('act', 'proposal:rename:go', {
      target: { kind: 'object_type', id: 'type:Customer' }, change: { op: 'rename', name: 'Client' },
    });
    const res = await actOnProposal({ domain: 'act', id: 'proposal:rename:go' }, 'approve', 'owner');
    assert.equal(res.ok, true);
    const proj = loadProjection('act');
    assert.equal(proj.object_type.get('type:Customer').name, 'Client', 'approval applied the rename');
    assert.equal(proj.proposal.get('proposal:rename:go').state, 'approved');

    seedProposal('act', 'proposal:rename:no', {
      target: { kind: 'object_type', id: 'type:Customer' }, change: { op: 'rename', name: 'Kunde' },
    });
    const rej = await actOnProposal({ domain: 'act', id: 'proposal:rename:no' }, 'reject', 'owner');
    assert.equal(rej.ok, true);
    assert.equal(loadProjection('act').proposal.get('proposal:rename:no').state, 'retired');
    assert.equal(loadProjection('act').object_type.get('type:Customer').name, 'Client', 'a rejected rename never lands');
  });

  test('separation of duties surfaces as a toast, not a crash', async () => {
    seedOverlayDomain('sod');
    seedProposal('sod', 'proposal:rename:own', {
      target: { kind: 'object_type', id: 'type:Customer' }, change: { op: 'rename', name: 'Me' },
      proposedBy: 'the-owner',
    });
    const res = await actOnProposal({ domain: 'sod', id: 'proposal:rename:own' }, 'approve', 'the-owner');
    assert.equal(res.ok, false);
    assert.match(res.text, /separation of duties/);
    assert.equal(loadProjection('sod').proposal.get('proposal:rename:own').state, 'candidate', 'nothing moved');
  });
});
