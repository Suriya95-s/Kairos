// src/ontology/query.js
// G3 — query plans: the governed half of GraphRAG.
//
// A question over a domain becomes a PLAN OBJECT that pins three things:
//   1. what was searched (live projection or an immutable release),
//   2. the exact retrieved subgraph (nodes + edges, content-addressed id),
//   3. the allowed claims — the node ids an answer may cite.
// Generation receives THE SUBGRAPH, never the journal. The answer must cite
// node ids that exist in the plan ([cite:inst:Customer:C1]); a claim with no
// path is structurally ungrounded and the whole answer falls back to the
// deterministic floor. The lexical-grounding trick from LOGOS becomes
// unnecessary where the path itself is the proof.
//
// PII discipline unchanged: the model sees redacted values and answers in
// tokens; rehydration happens locally on the way to the user's screen.

import crypto from 'node:crypto';
import { loadProjection, loadRelease, assertDomain } from './store.js';
import {
  graphFromProjection, projectionFromRelease, selectSeeds, subgraphAround,
} from './traverse.js';
import {
  loadPiiMap, savePiiMap, redactInstanceProperties, redactText, rehydrateText, assertNoRawPii,
} from './redact.js';

export const MAX_SUBGRAPH_NODES = 50;
const CITE_RE = /\[cite:([^\]\s]+)\]/g;

/** Replace every raw value the domain's pii map already knows with its token. */
function redactKnownValues(text, map) {
  let out = String(text);
  for (const value of Object.keys(map.entries || {}).sort((a, b) => b.length - a.length)) {
    if (value.length < 3) continue;
    out = out.split(value).join(map.entries[value]);
  }
  return out;
}

/**
 * Build a query plan: seeds → bounded subgraph → pinned, content-addressed
 * plan object. Deterministic — same domain state and question, same plan id.
 */
export function buildQueryPlan(domain, question, { releaseId = null, hops = 2, maxNodes = MAX_SUBGRAPH_NODES } = {}) {
  assertDomain(domain);
  const proj = releaseId ? projectionFromRelease(loadRelease(domain, releaseId)) : loadProjection(domain);
  const graph = graphFromProjection(proj);
  const seeds = selectSeeds(proj, question, { limit: 5 });
  const { nodes, edges } = subgraphAround(graph, seeds, { hops, maxNodes });
  const basis = JSON.stringify({ domain, release: releaseId, question: String(question).trim().toLowerCase(), nodes: nodes.map((n) => n.id) });
  return {
    id: `qplan:${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16)}`,
    domain,
    release: releaseId,
    question: String(question),
    seeds,
    subgraph: { nodes, edges },
    allowedClaims: nodes.map((n) => n.id),
    createdAt: Date.now(),
  };
}

/**
 * Structural grounding: every [cite:...] in the answer must name a node the
 * plan retrieved. Zero cites is ungrounded too — an answer that cites nothing
 * is an answer the graph cannot vouch for.
 */
export function groundAnswer(plan, answerText) {
  const allowed = new Set(plan.allowedClaims || []);
  const cites = [...String(answerText).matchAll(CITE_RE)].map((m) => m[1]);
  const unknown = [...new Set(cites.filter((c) => !allowed.has(c)))];
  return { grounded: cites.length > 0 && unknown.length === 0, cites: [...new Set(cites)], unknown };
}

/** The deterministic floor: the subgraph itself, rendered as citable facts. */
export function renderFacts(plan) {
  const lines = [];
  for (const n of plan.subgraph.nodes) {
    const props = Object.entries(n.properties || {})
      .filter(([, v]) => String(v ?? '').trim())
      .map(([k, v]) => `${k}: ${v}`).join(', ');
    lines.push(`◆ ${n.type} ${n.key} [cite:${n.id}]${props ? ` — ${props}` : ''}`);
  }
  for (const e of plan.subgraph.edges) {
    lines.push(`→ ${e.from} —${e.name}→ ${e.to}`);
  }
  return lines.join('\n');
}

/**
 * Answer a question over a domain's graph.
 *
 * Without a model (llm null): returns the retrieved subgraph as citable facts
 * — deterministic, grounded by construction, zero tokens.
 * With a model: the redacted subgraph goes in, an answer citing node ids
 * comes out, the structural grounding check decides whether it may be shown;
 * an ungrounded answer is DISCARDED and the floor answers instead.
 */
export async function answerQuestion(domain, question, { llm = null, releaseId = null, hops = 2 } = {}) {
  const plan = buildQueryPlan(domain, question, { releaseId, hops });
  if (plan.subgraph.nodes.length === 0) {
    return {
      domain, ok: true, plan: { id: plan.id, release: plan.release, nodes: 0 },
      answer: null, grounded: false,
      reason: 'nothing in the graph matches the question — no seeds found',
    };
  }

  if (typeof llm !== 'function') {
    return {
      domain, ok: true, floor: 'no model',
      plan: { id: plan.id, release: plan.release, nodes: plan.subgraph.nodes.length },
      answer: renderFacts(plan), grounded: true, cites: plan.allowedClaims,
    };
  }

  // The model-bound copy is redacted with the domain's stable token map; the
  // user-bound answer is rehydrated locally after grounding passes.
  const piiMap = loadPiiMap(domain);
  const redactedNodes = plan.subgraph.nodes.map((n) => ({
    id: n.id, type: n.type,
    properties: redactInstanceProperties(n.properties || {}, piiMap),
  }));
  // The question is the user's own words, but it may name a person the domain
  // already knows ("contact Tanaka Hiroshi") — every value the pii map has
  // seen is scrubbed from the outbound copy too, longest first.
  const redactedQuestion = redactKnownValues(redactText(String(question), piiMap), piiMap);
  savePiiMap(domain, piiMap);

  const system = [
    'You answer questions using ONLY the graph subgraph provided — it is your',
    'entire world. Every factual claim in your answer MUST carry a citation of',
    'the form [cite:<node id>] using ids from the subgraph. Follow the edges:',
    'they are verified relations. If the subgraph cannot answer the question,',
    'say exactly that, with no invented facts. Values like [PII_EMAIL_1] are',
    'redaction tokens — repeat them verbatim, never expand or invent them.',
    'Answer in 1–4 sentences.',
  ].join('\n');
  const user = JSON.stringify({
    question: redactedQuestion,
    subgraph: { nodes: redactedNodes, edges: plan.subgraph.edges },
  }, null, 2);
  assertNoRawPii(system, 'graph answer system prompt');
  assertNoRawPii(user, 'graph answer user prompt');

  let reply;
  try {
    reply = await llm([{ role: 'system', content: system }, { role: 'user', content: user }]);
    // Accept a bare string OR a chatCompletion-style {content} envelope — an
    // adapter that forgets .content must not turn the answer into "[object Object]".
    if (reply && typeof reply === 'object' && 'content' in reply) reply = reply.content;
  } catch (err) {
    return {
      domain, ok: true, floor: `model call failed: ${err.message}`,
      plan: { id: plan.id, release: plan.release, nodes: plan.subgraph.nodes.length },
      answer: renderFacts(plan), grounded: true, cites: plan.allowedClaims,
    };
  }

  const check = groundAnswer(plan, reply);
  if (!check.grounded) {
    // A fluent answer with no path is exactly the failure mode this plane
    // exists to kill. The facts answer instead.
    return {
      domain, ok: true, floor: check.cites.length === 0
        ? 'model answer cited nothing — discarded'
        : `model cited nodes outside the plan (${check.unknown.join(', ')}) — discarded`,
      plan: { id: plan.id, release: plan.release, nodes: plan.subgraph.nodes.length },
      answer: renderFacts(plan), grounded: true, cites: plan.allowedClaims,
    };
  }

  return {
    domain, ok: true,
    plan: { id: plan.id, release: plan.release, nodes: plan.subgraph.nodes.length },
    answer: rehydrateText(String(reply).trim(), piiMap),
    grounded: true, cites: check.cites,
  };
}

export default { MAX_SUBGRAPH_NODES, buildQueryPlan, groundAnswer, renderFacts, answerQuestion };
