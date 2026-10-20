// tests/ontology-verifier.test.js
// O3 — the verifier agent: PII redaction, proposal store, the caged LLM.
// Every model interaction here is scripted — the whole slice is offline.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  redactText, redactValue, assertNoRawPii, hasPiiTokens,
  emptyPiiMap, loadPiiMap, savePiiMap,
} from '../src/ontology/redact.js';
import {
  appendDocument, loadProjection, applyProposal, evidenceRef, PROPOSAL_OPS,
} from '../src/ontology/store.js';
import {
  ALLOWED_ACTIONS, BLOCKED_ACTIONS, buildProjection, buildPrompt,
  enrichmentKey, verifyDomain, MIN_CONFIDENCE,
} from '../src/ontology/verifier.js';
import { ingestFile } from '../src/ontology/engine.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-overify-'));
  process.env.KAIROS_HOME = tmpHome;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* Windows locks */ }
});

/** Seed a domain the way the real engine does — by ingesting a file with PII. */
function seedCrm(domain = 'crm') {
  const f = path.join(tmpHome, 'customers.csv');
  fs.writeFileSync(f, [
    'customer_id,name,email,phone,credit_limit',
    'C1,Tanaka Hiroshi,tanaka@example.jp,090-1234-5678,300000',
    'C2,Sato Yuki,sato@example.jp,080-9876-5432,200000',
  ].join('\n'));
  const res = ingestFile(domain, f);
  assert.ok(res.ok);
  return domain;
}

// ── Redaction ────────────────────────────────────────────────────────────────

describe('PII redaction', () => {
  test('emails and phones become stable tokens; prices, dates and ids survive', () => {
    const map = emptyPiiMap();
    const out = redactText('mail tanaka@example.jp or call 090-1234-5678; total 2759200 on 2026-03-18 order O5001', map);
    assert.match(out, /\[PII_EMAIL_1\]/);
    assert.match(out, /\[PII_PHONE_1\]/);
    assert.ok(!out.includes('tanaka@example.jp'));
    assert.ok(out.includes('2759200'), 'a 7-digit price is not a phone number');
    assert.ok(out.includes('2026-03-18'), 'a date is not a phone number');
    assert.ok(out.includes('O5001'));
    // Stability: the same value maps to the same token forever.
    assert.equal(redactText('tanaka@example.jp again', map), '[PII_EMAIL_1] again');
    // Distinct values get distinct tokens.
    assert.equal(redactText('sato@example.jp', map), '[PII_EMAIL_2]');
  });

  test('contiguous JP phone numbers are caught; plain integers are not', () => {
    const map = emptyPiiMap();
    const out = redactText('call 09012345678, qty 4, total 89980', map);
    assert.ok(!out.includes('09012345678'));
    assert.ok(out.includes('89980'));
    assert.ok(out.includes('qty 4'));
  });

  test('redactValue deep-walks objects and arrays', () => {
    const map = emptyPiiMap();
    const out = redactValue({ who: { email: 'a@b.co' }, list: ['c@d.io', 42] }, map);
    assert.equal(out.who.email, '[PII_EMAIL_1]');
    assert.equal(out.list[0], '[PII_EMAIL_2]');
    assert.equal(out.list[1], 42);
    assert.ok(hasPiiTokens(JSON.stringify(out)));
  });

  test('assertNoRawPii is the fail-closed guard', () => {
    assert.throws(() => assertNoRawPii('reach me at x@y.com', 'test prompt'), /raw PII.*test prompt/);
    assert.doesNotThrow(() => assertNoRawPii('reach me at [PII_EMAIL_1]'));
  });

  test('the pii map persists per domain and tokens stay stable across loads', () => {
    const map = emptyPiiMap();
    redactText('a@b.co', map);
    savePiiMap('crm', map);
    const again = loadPiiMap('crm');
    assert.equal(redactText('a@b.co', again), '[PII_EMAIL_1]', 'reloaded map reuses the same token');
  });
});

// ── Proposal store ───────────────────────────────────────────────────────────

function seedTypeAndProposal(domain, { evidence = [evidenceRef('snapshot:abc', 'header')], proposedBy = 'kairos-verifier' } = {}) {
  appendDocument(domain, {
    kind: 'object_type', id: 'type:Warehou',
    payload: { name: 'Warehou', properties: [], state: 'candidate', proposedBy: 'kairos-induction', evidence },
  });
  appendDocument(domain, {
    kind: 'proposal', id: 'proposal:rename:x1',
    payload: {
      target: { kind: 'object_type', id: 'type:Warehou' },
      change: { op: 'rename', name: 'Warehouse' },
      rationale: 'plural file name was mangled', confidence: 0.9,
      state: 'candidate', proposedBy, evidence,
    },
  });
}

describe('proposal store', () => {
  test('applyProposal: approval and application are one act, attribution split', () => {
    seedTypeAndProposal('p1');
    const res = applyProposal('p1', 'proposal:rename:x1', 'owner');
    assert.equal(res.op, 'rename');
    const proj = loadProjection('p1');
    assert.equal(proj.object_type.get('type:Warehou').name, 'Warehouse', 'the rename landed');
    assert.equal(proj.object_type.get('type:Warehou').state, 'candidate', 'the target is NOT promoted by a rename');
    assert.equal(proj.proposal.get('proposal:rename:x1').state, 'approved');
    assert.equal(proj.proposal.get('proposal:rename:x1').approvedBy, 'owner');
  });

  test('separation of duties: the verifier cannot approve its own proposal', () => {
    seedTypeAndProposal('p2');
    assert.throws(() => applyProposal('p2', 'proposal:rename:x1', 'kairos-verifier'), /separation of duties/);
  });

  test('a proposal without evidence cannot be applied', () => {
    seedTypeAndProposal('p3', { evidence: [] });
    assert.throws(() => applyProposal('p3', 'proposal:rename:x1', 'owner'), /no evidence/);
  });

  test('an applied proposal cannot apply twice', () => {
    seedTypeAndProposal('p4');
    applyProposal('p4', 'proposal:rename:x1', 'owner');
    assert.throws(() => applyProposal('p4', 'proposal:rename:x1', 'owner'), /only candidates/);
  });

  test('add_relation births an approved semantic relation carrying the evidence', () => {
    appendDocument('p5', {
      kind: 'object_type', id: 'type:Order',
      payload: { name: 'Order', properties: [], state: 'candidate', proposedBy: 'kairos-induction', evidence: [evidenceRef('snapshot:o', 'header')] },
    });
    appendDocument('p5', {
      kind: 'proposal', id: 'proposal:add_relation:r1',
      payload: {
        target: { kind: 'relationship_type', id: 'new' },
        change: { op: 'add_relation', relation: { name: 'fulfilled_by', from: 'Order', to: 'Warehouse' } },
        rationale: 'orders ship from warehouses', confidence: 0.8,
        state: 'candidate', proposedBy: 'kairos-verifier', evidence: [evidenceRef('snapshot:o', 'header')],
      },
    });
    const res = applyProposal('p5', 'proposal:add_relation:r1', 'owner');
    const rel = loadProjection('p5').relationship_type.get(res.applied[0].id);
    assert.equal(rel.state, 'approved');
    assert.equal(rel.proposedBy, 'kairos-verifier', 'attribution stays with the proposer');
    assert.equal(rel.approvedBy, 'owner');
    assert.ok(rel.evidence.length > 0);
    assert.equal(rel.semantic, true);
  });
});

// ── Verifier ─────────────────────────────────────────────────────────────────

describe('verifier projection and prompt', () => {
  test('NEGATIVE-SPACE DRIFT TEST: every blocked and allowed action reaches the prompt verbatim', () => {
    // The LOGOS trap: planning.ts hand-copied 6 of 10 blocked actions. Here the
    // prompt is generated from the constants, and this test pins the equality.
    seedCrm('drift');
    const { data } = buildProjection('drift');
    const prompt = buildPrompt(data).map((m) => m.content).join('\n');
    for (const [op, why] of Object.entries(BLOCKED_ACTIONS)) {
      assert.ok(prompt.includes(`${op}: BLOCKED — ${why}`), `blocked action "${op}" missing from the prompt`);
    }
    for (const op of Object.keys(ALLOWED_ACTIONS)) assert.ok(prompt.includes(`- ${op}:`));
    assert.deepEqual(Object.keys(ALLOWED_ACTIONS).sort(), [...PROPOSAL_OPS].sort(),
      'what the prompt allows and what the store applies are the same closed set');
  });

  test('NEGATIVE CONTROL (PII): the model never sees a raw email or phone', async () => {
    seedCrm('pii');
    const seen = [];
    await verifyDomain('pii', { llm: async (messages) => { seen.push(...messages); return '{"proposals":[]}'; } });
    assert.ok(seen.length >= 2, 'the model was called');
    const all = seen.map((m) => m.content).join('\n');
    assert.ok(!all.includes('tanaka@example.jp'), 'raw email leaked to the model');
    assert.ok(!all.includes('090-1234-5678'), 'raw phone leaked to the model');
    assert.ok(all.includes('[PII_EMAIL_'), 'redaction tokens stand in for the values');
  });

  test('samples in the projection are redacted and the map persists', () => {
    seedCrm('proj');
    const { data } = buildProjection('proj');
    const customer = data.types.find((t) => t.name === 'Customer');
    assert.ok(customer.samples.length > 0);
    const flat = JSON.stringify(customer.samples);
    assert.ok(!flat.includes('@example.jp'));
    assert.ok(flat.includes('[PII_EMAIL_'));
  });
});

describe('verifyDomain', () => {
  test('valid proposals land as candidates by kairos-verifier with inherited evidence', async () => {
    seedCrm('v1');
    const typeId = [...loadProjection('v1').object_type.keys()][0];
    const llm = async () => JSON.stringify({
      proposals: [
        { op: 'describe', target: { kind: 'object_type', id: typeId }, description: 'A person or company that buys.', rationale: 'clarity', confidence: 0.9 },
        { op: 'rename', target: { kind: 'object_type', id: typeId }, name: 'Client', rationale: 'domain term', confidence: 0.7 },
      ],
    });
    const res = await verifyDomain('v1', { llm });
    assert.equal(res.ok, true);
    assert.equal(res.proposals.length, 2);
    const proj = loadProjection('v1');
    for (const id of res.proposals) {
      const p = proj.proposal.get(id);
      assert.equal(p.state, 'candidate');
      assert.equal(p.proposedBy, 'kairos-verifier');
      assert.ok(p.evidence.length > 0, 'inherits the target evidence so it is approvable');
    }
    // Nothing was applied: the type still has its induced name.
    assert.equal(proj.object_type.get(typeId).name, 'Customer');
  });

  test('the confidence gate discards weak proposals', async () => {
    seedCrm('v2');
    const typeId = [...loadProjection('v2').object_type.keys()][0];
    const llm = async () => JSON.stringify({
      proposals: [{ op: 'rename', target: { kind: 'object_type', id: typeId }, name: 'Meh', rationale: 'shrug', confidence: MIN_CONFIDENCE - 0.1 }],
    });
    const res = await verifyDomain('v2', { llm });
    assert.equal(res.proposals.length, 0);
    assert.equal(res.discarded, 1);
  });

  test('proposals against invented targets or types are discarded', async () => {
    seedCrm('v3');
    const llm = async () => JSON.stringify({
      proposals: [
        { op: 'rename', target: { kind: 'object_type', id: 'type:Imaginary' }, name: 'X', rationale: 'hallucinated', confidence: 0.9 },
        { op: 'add_relation', relation: { name: 'owns', from: 'Customer', to: 'Spaceship' }, rationale: 'hallucinated type', confidence: 0.9 },
      ],
    });
    const res = await verifyDomain('v3', { llm });
    assert.equal(res.proposals.length, 0);
    assert.equal(res.discarded, 2);
  });

  test('DETERMINISTIC FLOOR: a dead model changes nothing', async () => {
    seedCrm('v4');
    const before = fs.readFileSync(path.join(tmpHome, 'ontology', 'v4', 'documents.jsonl'), 'utf-8');
    const res = await verifyDomain('v4', { llm: async () => { throw new Error('429 quota exhausted'); } });
    assert.equal(res.ok, false);
    assert.equal(res.floor, true);
    const after = fs.readFileSync(path.join(tmpHome, 'ontology', 'v4', 'documents.jsonl'), 'utf-8');
    assert.equal(before, after, 'the journal is byte-identical — enrichment is strictly additive');
  });

  test('DETERMINISTIC FLOOR: garbage output changes nothing', async () => {
    seedCrm('v5');
    const res = await verifyDomain('v5', { llm: async () => 'sure! here are my thoughts, in prose…' });
    assert.equal(res.floor, true);
    assert.equal(loadProjection('v5').counts.proposal || 0, 0);
  });

  test('IDEMPOTENCY: an unchanged domain replays without a second model call', async () => {
    seedCrm('v6');
    let calls = 0;
    const llm = async () => { calls++; return '{"proposals":[]}'; };
    const first = await verifyDomain('v6', { llm });
    assert.equal(first.replay, undefined);
    const second = await verifyDomain('v6', { llm });
    assert.equal(second.replay, true);
    assert.equal(calls, 1, 'the second run spent zero tokens');
    const third = await verifyDomain('v6', { llm, force: true });
    assert.equal(third.replay, undefined);
    assert.equal(calls, 2, '--force re-runs deliberately');
  });

  test('a new ingest changes the enrichment key — verification re-arms itself', async () => {
    seedCrm('v7');
    const k1 = enrichmentKey(buildProjection('v7').data);
    const f = path.join(tmpHome, 'more.csv');
    fs.writeFileSync(f, 'order_id,customer_id\nO1,C1\n');
    ingestFile('v7', f);
    const k2 = enrichmentKey(buildProjection('v7').data);
    assert.notEqual(k1, k2);
  });

  test('an empty domain is skipped without calling the model', async () => {
    let calls = 0;
    const res = await verifyDomain('nothing-here', { llm: async () => { calls++; return '{}'; } });
    assert.ok(res.skipped);
    assert.equal(calls, 0);
  });
});
