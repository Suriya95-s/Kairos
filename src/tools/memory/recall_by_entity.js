// src/tools/memory/recall_by_entity.js
// Kairos tool: recall memories that mention a specific entity (a symbol, file,
// function, class, or concept). Uses the palace hybrid retrieval (TF-IDF over the
// episodic pool + spatial + temporal), so it surfaces every memory touching the
// entity regardless of which step or domain produced it.

import { getPalaceSession } from '../../palace/session.js';
import { retrieve, formatRetrievalResults } from '../../palace/retrieval.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'recall_by_entity',
    description: 'Recall memories that mention a specific entity — a function, class, file, symbol, or concept. Surfaces every related episodic memory regardless of when or in which stage it happened.',
    parameters: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'The entity to recall (e.g. "parseAction", "loop.js", "compaction")' },
        topK:   { type: 'integer', description: 'Max results (default: 10)', default: 10 },
      },
      required: ['entity'],
    },
  },
};

export function handler({ entity, topK = 10 }) {
  const session = getPalaceSession();
  if (!session) return ok('Memory palace not active (AGENT_USE_PALACE=0).');
  if (!entity) return fail('Provide an entity to recall (e.g. a function or file name).');

  const { store, graph } = session;
  let results;
  try {
    results = retrieve({
      episodicStore: store,
      roomGraph:     graph,
      query:         String(entity),
      topK,
    });
  } catch (err) {
    return fail(`Entity recall failed: ${err.message}`);
  }

  // Keep only results that actually mention the entity (retrieve also returns
  // temporally/spatially-near memories; for an entity query we want mentions).
  const needle = String(entity).toLowerCase();
  const mentions = (results || []).filter((r) => String(r.content || '').toLowerCase().includes(needle));
  const finalResults = mentions.length > 0 ? mentions : (results || []);

  if (finalResults.length === 0) {
    return ok(`No memories found mentioning "${entity}".`);
  }
  return ok(formatRetrievalResults(finalResults));
}
