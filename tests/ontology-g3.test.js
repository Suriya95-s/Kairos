// tests/ontology-g3.test.js
// G3 — the graph as the loop's memory: deterministic traversal primitives,
// pinned query plans with structural grounding, the "ask <domain>" router
// plane, mission tools, and the loop memory bridge. All model interactions
// scripted — offline end to end.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendDocument, loadProjection, setPublicationState, createRelease,
} from '../src/ontology/store.js';
import {
  graphFromProjection, projectionFromRelease, neighbors, findPaths,
  filterInstances, aggregateInstances, selectSeeds, subgraphAround,
} from '../src/ontology/traverse.js';
import {
  buildQueryPlan, groundAnswer, renderFacts, answerQuestion,
} from '../src/ontology/query.js';
import { proposeMissionOutcome, LOOP_DOMAIN } from '../src/ontology/bridge.js';
import { ingestFile } from '../src/ontology/engine.js';
import { dispatch } from '../src/router/dispatch.js';
import { handler as graphQueryTool } from '../src/tools/graph/graph_query.js';
import { handler as graphAggregateTool } from '../src/tools/graph/graph_aggregate.js';

let tmpHome, dataDir;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-g3-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-g3-data-'));
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

/** A three-hop world: customers → orders → tickets, with real FK links. */
function seedShop(domain = 'shop') {
  assert.equal(ingestFile(domain, writeData('customers.csv',
    'id,name,email,city\nC1,Tanaka Hiroshi,tanaka@example.jp,Tokyo\nC2,Suzuki Ai,ai@example.jp,Osaka\n')).ok, true);
  assert.equal(ingestFile(domain, writeData('orders.csv',
    'id,customer_id,total\nO1,C1,1200000\nO2,C2,89000\nO3,C1,45000\n')).ok, true);
  assert.equal(ingestFile(domain, writeData('tickets.csv',
    'id,order_id,issue\nT1,O1,gpu driver crash\nT2,O2,late delivery\n')).ok, true);
  return domain;
}

// ── Traversal primitives ─────────────────────────────────────────────────────

describe('G3 traversal', () => {
  test('the instance graph has typed nodes and FK edges; retired nodes drop out', () => {
    seedShop();
    const proj = loadProjection('shop');
    const graph = graphFromProjection(proj);
    assert.ok(graph.nodes.has('inst:Customer:C1'));
    assert.ok(graph.edges.some((e) => e.from === 'inst:Order:O1' && e.to === 'inst:Customer:C1'),
      'the customer_id FK became a walkable edge');
    setPublicationState('shop', 'instance', 'inst:Customer:C2', 'retired', 'owner');
    const after = graphFromProjection(loadProjection('shop'));
    assert.ok(!after.nodes.has('inst:Customer:C2'), 'retired instances leave the graph');
    assert.ok(!after.edges.some((e) => e.to === 'inst:Customer:C2'), 'and their edges go with them');
  });

  test('neighbors respects direction and relation filters', () => {
    seedShop();
    const graph = graphFromProjection(loadProjection('shop'));
    const around = neighbors(graph, 'inst:Customer:C1');
    assert.deepEqual(around.map((n) => n.node.id).sort(), ['inst:Order:O1', 'inst:Order:O3'],
      'both of C1\'s orders point at it');
    assert.equal(neighbors(graph, 'inst:Customer:C1', { direction: 'out' }).length, 0,
      'FK edges run order→customer, so a customer has no out-edges');
    const viaTicket = neighbors(graph, 'inst:Order:O1', { relation: 'orderId' });
    assert.deepEqual(viaTicket.map((n) => n.node.id), ['inst:Ticket:T1']);
  });

  test('multi-hop paths walk customer → order → ticket', () => {
    seedShop();
    const graph = graphFromProjection(loadProjection('shop'));
    const paths = findPaths(graph, 'inst:Customer:C1', { toType: 'Ticket', maxHops: 2 });
    assert.ok(paths.length >= 1, 'the two-hop path exists');
    const ids = paths[0].map((s) => s.node.id);
    assert.deepEqual(ids, ['inst:Customer:C1', 'inst:Order:O1', 'inst:Ticket:T1']);
    assert.equal(findPaths(graph, 'inst:Customer:C1', { toType: 'Ticket', maxHops: 1 }).length, 0,
      'maxHops is a hard bound');
  });

  test('filterInstances handles equality, ranges and contains', () => {
    seedShop();
    const proj = loadProjection('shop');
    assert.equal(filterInstances(proj, 'Customer', { city: 'Tokyo' }).length, 1);
    const big = filterInstances(proj, 'Order', { total: { gte: 1000000 } });
    assert.deepEqual(big.map((r) => r.id), ['inst:Order:O1']);
    const gpu = filterInstances(proj, 'Ticket', { issue: { contains: 'GPU' } });
    assert.deepEqual(gpu.map((r) => r.id), ['inst:Ticket:T1'], 'contains is case-insensitive');
  });

  test('aggregates: count, sum, avg, min, max — and unknown ops refuse', () => {
    seedShop();
    const proj = loadProjection('shop');
    assert.equal(aggregateInstances(proj, 'Order', null, 'count').value, 3);
    assert.equal(aggregateInstances(proj, 'Order', 'total', 'sum').value, 1334000);
    assert.equal(aggregateInstances(proj, 'Order', 'total', 'max').value, 1200000);
    assert.equal(aggregateInstances(proj, 'Order', 'total', 'min').value, 45000);
    assert.equal(aggregateInstances(proj, 'Order', 'total', 'count', { predicates: { total: { gte: 50000 } } }).value, 2);
    assert.throws(() => aggregateInstances(proj, 'Order', 'total', 'median'), /unknown aggregate/);
  });

  test('lexical seeds find the right instances and ignore stopwords', () => {
    seedShop();
    const proj = loadProjection('shop');
    const seeds = selectSeeds(proj, 'what is the gpu driver ticket about');
    assert.equal(seeds[0], 'inst:Ticket:T1', 'the ticket mentioning "gpu driver" scores highest');
    assert.deepEqual(selectSeeds(proj, 'what is the of and'), [], 'pure stopwords match nothing');
  });

  test('subgraphAround expands by hops and respects the node cap', () => {
    seedShop();
    const graph = graphFromProjection(loadProjection('shop'));
    const one = subgraphAround(graph, ['inst:Ticket:T1'], { hops: 1 });
    assert.deepEqual(one.nodes.map((n) => n.id).sort(), ['inst:Order:O1', 'inst:Ticket:T1']);
    const two = subgraphAround(graph, ['inst:Ticket:T1'], { hops: 2 });
    assert.ok(two.nodes.some((n) => n.id === 'inst:Customer:C1'), 'two hops reaches the customer');
    const capped = subgraphAround(graph, ['inst:Customer:C1'], { hops: 3, maxNodes: 2 });
    assert.equal(capped.nodes.length, 2, 'maxNodes is a hard cap');
  });

  test('a pinned release traverses ONLY what humans approved', () => {
    seedShop();
    setPublicationState('shop', 'instance', 'inst:Customer:C1', 'approved', 'owner');
    setPublicationState('shop', 'object_type', 'type:Customer', 'approved', 'owner');
    const rel = createRelease('shop', { createdBy: 'owner' });
    const releaseProj = projectionFromRelease(
      JSON.parse(fs.readFileSync(rel.file, 'utf-8')));
    const graph = graphFromProjection(releaseProj);
    assert.ok(graph.nodes.has('inst:Customer:C1'));
    assert.ok(!graph.nodes.has('inst:Customer:C2'), 'candidates never enter a release');
    assert.ok(!graph.nodes.has('inst:Order:O1'));
  });
});

// ── Query plans and structural grounding ─────────────────────────────────────

describe('G3 query plans', () => {
  test('plans are content-addressed and pin their subgraph', () => {
    seedShop();
    const p1 = buildQueryPlan('shop', 'gpu driver ticket');
    const p2 = buildQueryPlan('shop', 'gpu driver ticket');
    assert.equal(p1.id, p2.id, 'same state, same question, same plan');
    assert.match(p1.id, /^qplan:[0-9a-f]{16}$/);
    assert.notEqual(buildQueryPlan('shop', 'late delivery').id, p1.id);
    assert.ok(p1.allowedClaims.includes('inst:Ticket:T1'));
    assert.ok(p1.subgraph.edges.length > 0, 'the plan carries the walked edges');
  });

  test('grounding: cites must exist in the plan; no cites is no grounding', () => {
    seedShop();
    const plan = buildQueryPlan('shop', 'gpu driver ticket');
    assert.equal(groundAnswer(plan, 'The GPU ticket [cite:inst:Ticket:T1] sits on order [cite:inst:Order:O1].').grounded, true);
    const invented = groundAnswer(plan, 'Clearly [cite:inst:Ticket:T99] is the issue.');
    assert.equal(invented.grounded, false);
    assert.deepEqual(invented.unknown, ['inst:Ticket:T99']);
    assert.equal(groundAnswer(plan, 'It was probably a driver problem.').grounded, false,
      'a fluent answer with no path is exactly what gets discarded');
  });

  test('DETERMINISTIC FLOOR: no model still answers, with citable facts', async () => {
    seedShop();
    const res = await answerQuestion('shop', 'gpu driver ticket');
    assert.equal(res.grounded, true);
    assert.ok(res.floor, 'flagged as the deterministic path');
    assert.ok(res.answer.includes('[cite:inst:Ticket:T1]'));
    assert.ok(res.answer.includes('gpu driver crash'), 'local facts show raw values — nothing left the machine');
  });

  test('a grounded model answer comes back REHYDRATED — the user sees values the model never saw', async () => {
    seedShop();
    const seen = [];
    const llm = async (messages) => {
      seen.push(...messages);
      return 'The customer [cite:inst:Customer:C1] can be reached at [PII_EMAIL_1].';
    };
    const res = await answerQuestion('shop', 'how do I contact the customer Tanaka Hiroshi', { llm });
    const promptText = seen.map((m) => m.content).join('\n');
    assert.ok(!promptText.includes('tanaka@example.jp'), 'raw email never reached the model');
    assert.ok(!promptText.includes('Tanaka'), 'the question itself was redacted too');
    assert.equal(res.grounded, true);
    assert.ok(res.answer.includes('tanaka@example.jp'), 'rehydrated locally for the user');
    assert.ok(!res.floor);
  });

  test('an ungrounded model answer is DISCARDED and the facts answer instead', async () => {
    seedShop();
    const res = await answerQuestion('shop', 'gpu driver ticket', {
      llm: async () => 'Everything looks fine, no issues at all [cite:inst:Ticket:T99].',
    });
    assert.match(res.floor, /outside the plan/);
    assert.ok(res.answer.includes('[cite:inst:Ticket:T1]'), 'the deterministic facts stood in');
    const silent = await answerQuestion('shop', 'late delivery order', {
      llm: async () => 'It was late because of weather.',
    });
    assert.match(silent.floor, /cited nothing/);
  });

  test('a dead model floors gracefully', async () => {
    seedShop();
    const res = await answerQuestion('shop', 'gpu driver ticket', {
      llm: async () => { throw new Error('429 quota'); },
    });
    assert.match(res.floor, /model call failed/);
    assert.equal(res.grounded, true);
  });

  test('no lexical match says so instead of guessing', async () => {
    seedShop();
    const res = await answerQuestion('shop', 'quarterly zeppelin throughput');
    assert.equal(res.answer, null);
    assert.match(res.reason, /no seeds/);
  });

  test('a plan pinned to a release answers from the approved set only', async () => {
    seedShop();
    setPublicationState('shop', 'instance', 'inst:Ticket:T1', 'approved', 'owner');
    setPublicationState('shop', 'object_type', 'type:Ticket', 'approved', 'owner');
    const rel = createRelease('shop', { createdBy: 'owner' });
    const pinned = await answerQuestion('shop', 'gpu driver ticket', { releaseId: rel.id });
    assert.ok(pinned.answer.includes('inst:Ticket:T1'));
    assert.ok(!pinned.answer.includes('inst:Order:O1'), 'the unapproved order is not in the pinned world');
    assert.equal(pinned.plan.release, rel.id);
  });
});

// ── Router integration ───────────────────────────────────────────────────────

describe('G3 "ask <domain>" routing', () => {
  test('an ask hits the graph plane and returns grounded metadata', async () => {
    const out = await dispatch('ask shop which ticket mentions the gpu', {
      sessionId: 's1',
      askGraph: async (domain, question) => {
        assert.equal(domain, 'shop');
        assert.match(question, /gpu/);
        return {
          answer: 'Ticket T1 [cite:inst:Ticket:T1].', grounded: true,
          cites: ['inst:Ticket:T1'], plan: { id: 'qplan:abc', release: null },
        };
      },
    });
    assert.equal(out.action, 'answered');
    assert.match(out.text, /Ticket T1/);
    assert.equal(out.graph.grounded, true);
    assert.equal(out.graph.plan, 'qplan:abc');
    assert.equal(out.decision.intent, 'graph_ask');
  });

  test('an unknown domain falls through to the normal pipeline', async () => {
    const out = await dispatch('ask yourself why the build failed', {
      sessionId: 's2',
      askGraph: async () => null,
      runReflex: async () => ({ text: 'normal path answered' }),
    });
    assert.equal(out.graph, undefined, 'no graph metadata — this was not a graph ask');
  });

  test('without an askGraph dep nothing changes', async () => {
    const out = await dispatch('ask shop about orders', {
      sessionId: 's3',
      runReflex: async () => ({ text: 'reflex answered' }),
    });
    assert.equal(out.graph, undefined);
  });
});

// ── Mission tools ────────────────────────────────────────────────────────────

describe('G3 mission tools', () => {
  test('graph_query returns citable facts for missions', () => {
    seedShop();
    const out = graphQueryTool({ domain: 'shop', question: 'gpu driver ticket' });
    assert.equal(out.ok, true);
    assert.ok(out.data.includes('[cite:inst:Ticket:T1]'));
    assert.ok(out.data.includes('plan qplan:'), 'the plan id makes the retrieval auditable');
    const empty = graphQueryTool({ domain: 'shop', question: 'zeppelin throughput' });
    assert.ok(empty.data.includes('No graph facts'));
  });

  test('graph_aggregate counts, sums and lists domains', () => {
    seedShop();
    const count = graphAggregateTool({ domain: 'shop', type: 'Order' });
    assert.ok(count.data.includes('3 instance(s)'));
    const sum = graphAggregateTool({ domain: 'shop', type: 'Order', property: 'total', op: 'sum' });
    assert.ok(sum.data.includes('1334000'));
    const filtered = graphAggregateTool({ domain: 'shop', type: 'Order', op: 'count', where: { total: { gte: 1000000 } } });
    assert.ok(filtered.data.includes('1 instance(s)'));
    const listing = graphAggregateTool({});
    assert.ok(listing.data.includes('shop:'), 'no domain → the domain map');
    assert.ok(listing.data.includes('Order'));
  });
});

// ── The loop memory bridge ───────────────────────────────────────────────────

describe('G3 loop memory bridge', () => {
  const mission = {
    id: 'm-2026-001', task: 'study about ontology', state: 'done',
    workspace: 'C:/work/proj', profile: 'research', exitReason: 'completed',
    endedAt: 1750000000000,
    learnings: ['router signals need real coverage audits'],
  };

  test('an ended mission becomes candidate graph facts by kairos-loop, evidence-backed', () => {
    const res = proposeMissionOutcome(mission);
    assert.ok(res.appended > 0);
    const proj = loadProjection(LOOP_DOMAIN);
    const inst = proj.instance.get('inst:MissionOutcome:m-2026-001');
    assert.equal(inst.state, 'candidate', 'the loop proposes; humans dispose');
    assert.equal(inst.proposedBy, 'kairos-loop');
    assert.ok(inst.evidence.length > 0, 'backed by a content-addressed outcome snapshot');
    assert.equal(inst.properties.task, 'study about ontology');
    const learning = proj.instance.get('inst:Learning:m-2026-001-1');
    assert.equal(learning.properties.lesson, 'router signals need real coverage audits');
    const edge = proj.relationship.get('rel:taught:m-2026-001:1');
    assert.equal(edge.from, 'inst:MissionOutcome:m-2026-001');
    assert.equal(edge.to, 'inst:Learning:m-2026-001-1');
  });

  test('delivering the ended event twice cannot double the graph', () => {
    proposeMissionOutcome(mission);
    const second = proposeMissionOutcome(mission);
    assert.equal(second.appended, 0, 'content addressing makes the bridge replay-safe');
  });

  test('the bridge never throws — bad input reports instead of failing the mission', () => {
    assert.deepEqual(proposeMissionOutcome(null), { appended: 0, error: 'no mission id' });
    assert.equal(proposeMissionOutcome({}).appended, 0);
  });

  test('round trip: what the loop learned is queryable as graph memory', () => {
    proposeMissionOutcome(mission);
    const out = graphQueryTool({ domain: LOOP_DOMAIN, question: 'what did the ontology study mission learn' });
    assert.ok(out.data.includes('inst:MissionOutcome:m-2026-001'));
    assert.ok(out.data.includes('router signals need real coverage audits'),
      'the lesson is one hop from the outcome');
  });
});
