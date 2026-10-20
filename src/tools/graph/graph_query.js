// src/tools/graph/graph_query.js
// Kairos tool: retrieve a citable subgraph from an ontology domain (G3).
// Deterministic — lexical seeds + bounded traversal, no model inside the
// tool. The mission's own reasoning consumes the facts; every fact carries a
// [cite:<node id>] the mission can quote, so graph answers stay grounded.

import { ok, fail } from '../utils/toolResult.js';
import { buildQueryPlan, renderFacts } from '../../ontology/query.js';

export const definition = {
  type: 'function',
  function: {
    name: 'graph_query',
    description: 'Query an ontology domain\'s knowledge graph: lexically match the question to instances, walk their relations, and return the connected facts with citable node ids. Use for structured questions ("which customer ordered X", "what is linked to Y") over ingested business data. Use graph_aggregate with no domain to list available domains.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Ontology domain name (e.g. "btoshop", "kairos")' },
        question: { type: 'string', description: 'The question to match against the graph' },
        hops: { type: 'integer', description: 'How far to walk from matched seeds (default: 2)', default: 2 },
        release: { type: 'string', description: 'Optional pinned release id — same release, same answer, forever' },
      },
      required: ['domain', 'question'],
    },
  },
};

export function handler({ domain, question, hops = 2, release = null }) {
  let plan;
  try {
    plan = buildQueryPlan(domain, question, { hops, releaseId: release || null });
  } catch (err) {
    return fail(`graph_query failed: ${err.message}`);
  }
  if (!plan.subgraph.nodes.length) {
    return ok(`No graph facts in domain "${domain}" match that question. The domain may be empty or use different terms.`);
  }
  return ok(`## Graph facts — domain "${domain}" (plan ${plan.id}${plan.release ? `, release ${plan.release}` : ''})\n${renderFacts(plan)}\nCite facts using their [cite:...] ids.`);
}
