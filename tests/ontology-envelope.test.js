// tests/ontology-envelope.test.js
// The lens llm-adapter contract, pinned from a LIVE failure.
//
// The first real `ontology verify --model gpt-5.4-mini` run floored with
// "reply was not the required JSON shape" — the CLI adapter handed the lenses
// chatCompletion's whole {content, usage, …} envelope, String() turned it into
// "[object Object]", and every scripted test had returned bare strings so
// nothing caught it. Two fixes, both pinned here: the adapters now return
// .content, AND the lenses accept either shape so a future adapter that
// forgets cannot silently floor a paid model run.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendDocument, evidenceRef } from '../src/ontology/store.js';
import { verifyDomain } from '../src/ontology/verifier.js';
import { resolveEntities } from '../src/ontology/resolve.js';
import { answerQuestion, buildQueryPlan } from '../src/ontology/query.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-envelope-'));
  process.env.KAIROS_HOME = tmpHome;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* Windows locks */ }
});

const EV = [evidenceRef('snapshot:aaa', 'header')];

function seedTicketDomain(domain) {
  appendDocument(domain, {
    kind: 'object_type', id: 'type:Ticket',
    payload: {
      name: 'Ticket', keyProperty: 'title', state: 'candidate', proposedBy: 'kairos-induction', evidence: EV,
      properties: [{ name: 'title', type: 'string', sources: ['snapshot:aaa'] }],
    },
  });
  appendDocument(domain, {
    kind: 'instance', id: 'inst:Ticket:1',
    payload: { type: 'Ticket', key: 'gpu drivers crashing', properties: { title: 'gpu drivers crashing' }, state: 'candidate', proposedBy: 'kairos-induction', evidence: EV },
  });
  appendDocument(domain, {
    kind: 'instance', id: 'inst:Ticket:2',
    payload: { type: 'Ticket', key: 'printer jam', properties: { title: 'printer jam' }, state: 'candidate', proposedBy: 'kairos-induction', evidence: EV },
  });
}

describe('lenses accept a chatCompletion-style {content} envelope', () => {
  test('verifyDomain: an envelope reply parses instead of flooring', async () => {
    seedTicketDomain('env1');
    const llm = async () => ({ content: '{"proposals":[]}', usage: { prompt_tokens: 10, completion_tokens: 2 } });
    const res = await verifyDomain('env1', { llm });
    assert.equal(res.floor, undefined, `must not floor — got reason "${res.reason}"`);
    assert.equal(res.ok, true);
  });

  test('resolveEntities: an envelope reply parses instead of flooring', async () => {
    appendDocument('env2', {
      kind: 'object_type', id: 'type:Person',
      payload: {
        name: 'Person', keyProperty: 'name', state: 'candidate', proposedBy: 'kairos-induction', evidence: EV,
        properties: [{ name: 'name', type: 'string', sources: ['snapshot:aaa'] }, { name: 'email', type: 'string', sources: ['snapshot:aaa'] }],
      },
    });
    // Same normalized email → one candidate pair, so the judge is consulted.
    appendDocument('env2', { kind: 'instance', id: 'inst:Person:1', payload: { type: 'Person', key: 'Ann', properties: { name: 'Ann', email: 'ann@example.com' }, state: 'candidate', proposedBy: 'kairos-induction', evidence: EV } });
    appendDocument('env2', { kind: 'instance', id: 'inst:Person:2', payload: { type: 'Person', key: 'Ann K', properties: { name: 'Ann K', email: 'ann@example.com' }, state: 'candidate', proposedBy: 'kairos-induction', evidence: EV } });
    const llm = async () => ({ content: '{"judgments":[]}', usage: {} });
    const res = await resolveEntities('env2', { llm });
    assert.equal(res.floor, undefined, `must not floor — got reason "${res.reason}"`);
    assert.equal(res.ok, true);
  });

  test('answerQuestion: an envelope reply grounds and answers — never "[object Object]"', async () => {
    seedTicketDomain('env3');
    const question = 'which ticket was about gpu drivers';
    // Learn a citable node id the same way the lens will.
    const plan = buildQueryPlan('env3', question);
    assert.ok(plan.subgraph.nodes.length > 0, 'the seeded domain must yield a subgraph');
    const nodeId = plan.subgraph.nodes[0].id;
    const llm = async () => ({ content: `The gpu issue is that ticket [cite:${nodeId}]`, usage: {} });
    const res = await answerQuestion('env3', question, { llm });
    assert.ok(res.answer, 'must produce an answer');
    assert.equal(res.answer.includes('[object Object]'), false, 'the envelope must be unwrapped, not stringified');
    assert.equal(res.grounded, true, `expected a grounded answer — got floor "${res.floor}" reason "${res.reason}"`);
  });
});
