// src/tools/graph/graph_aggregate.js
// Kairos tool: aggregate over an ontology type's instances (G3).
// Deterministic arithmetic over the graph — count/sum/avg/min/max with simple
// predicates, optionally pinned to a release so the number never drifts.

import { ok, fail } from '../utils/toolResult.js';
import { loadProjection, loadRelease, listDomains } from '../../ontology/store.js';
import { aggregateInstances, projectionFromRelease } from '../../ontology/traverse.js';

export const definition = {
  type: 'function',
  function: {
    name: 'graph_aggregate',
    description: 'Aggregate over an ontology domain\'s instances: count, sum, avg, min or max of a property, with optional equality/range filters. Deterministic — no model. Call with no domain to list available domains and their types.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Ontology domain name; omit to list domains' },
        type: { type: 'string', description: 'Object type name (e.g. "Order")' },
        property: { type: 'string', description: 'Property to aggregate (ignored for count)' },
        op: { type: 'string', description: 'count | sum | avg | min | max (default: count)', default: 'count' },
        where: { type: 'object', description: 'Predicates, e.g. {"city":"Tokyo"} or {"total":{"gte":1000000}}' },
        release: { type: 'string', description: 'Optional pinned release id' },
      },
      required: [],
    },
  },
};

export function handler({ domain, type, property = null, op = 'count', where = {}, release = null }) {
  try {
    if (!domain) {
      const domains = listDomains();
      if (!domains.length) return ok('No ontology domains yet — drop a data file into the Kairos drop folder first.');
      const lines = domains.map((d) => {
        const proj = loadProjection(d);
        const types = [...proj.object_type.values()].filter((t) => t.state !== 'retired').map((t) => t.name);
        return `${d}: ${types.join(', ') || '(no types)'}`;
      });
      return ok(`## Ontology domains\n${lines.join('\n')}`);
    }
    if (!type) return fail('Provide a type name (call without domain to list them).');
    const proj = release ? projectionFromRelease(loadRelease(domain, release)) : loadProjection(domain);
    const res = aggregateInstances(proj, type, property, op, { predicates: where || {} });
    const what = op === 'count' ? `${res.count} instance(s)` : `${op}(${property}) = ${res.value} over ${res.count} value(s)`;
    return ok(`${type} in "${domain}"${release ? ` @ ${release}` : ''}: ${what}${Object.keys(where || {}).length ? `  [where ${JSON.stringify(where)}]` : ''}`);
  } catch (err) {
    return fail(`graph_aggregate failed: ${err.message}`);
  }
}
