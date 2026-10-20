// src/tools/memory/recall_temporal.js
// Kairos tool: "what happened before/after X?" — uses CEI queryBefore/queryAfter.

import { getPalaceSession } from '../../palace/session.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'recall_temporal',
    description: 'Recall what happened before or after a specific time, or within a time window. Uses the episodic store\'s temporal index — the key query type flat vector search cannot do.',
    parameters: {
      type: 'object',
      properties: {
        mode:      { type: 'string', enum: ['before', 'after', 'range'], description: 'Query mode' },
        timestamp: { type: 'number', description: 'Unix timestamp for before/after queries' },
        t_start:   { type: 'number', description: 'Start timestamp for range queries' },
        t_end:     { type: 'number', description: 'End timestamp for range queries' },
        domain:    { type: 'string', description: 'Optional domain filter (e.g. "testing", "coding")' },
        topK:      { type: 'integer', description: 'Max results (default: 5)', default: 5 },
      },
      required: ['mode'],
    },
  },
};

export function handler({ mode, timestamp, t_start, t_end, domain = null, topK = 5 }) {
  const session = getPalaceSession();
  if (!session) return ok('Memory palace not active (AGENT_USE_PALACE=0).');

  const { store } = session;

  let results;
  try {
    if (mode === 'before') {
      const cutoff = timestamp ?? (Date.now() / 1000);
      results = store.queryBefore(cutoff, domain, topK);
    } else if (mode === 'after') {
      const cutoff = timestamp ?? 0;
      results = store.queryAfter(cutoff, domain, topK);
    } else if (mode === 'range') {
      const start = t_start ?? 0;
      const end   = t_end   ?? (Date.now() / 1000);
      results = store.queryTemporal(start, end, domain, topK);
    } else {
      return fail(`Unknown mode "${mode}". Use: before, after, range.`);
    }
  } catch (err) {
    return fail(`Temporal recall failed: ${err.message}`);
  }

  if (!results || results.length === 0) {
    return ok(`No episodic memories found for mode="${mode}"${domain ? `, domain="${domain}"` : ''}.`);
  }

  const lines = results.map(e => {
    const ts  = new Date(e.timestamp * 1000).toISOString();
    const who = e.who ? ` [${e.who}]` : '';
    const txt = (e.summary || e.verbatim || '').slice(0, 200);
    return `${ts}${who} (${e.domain || 'general'}): ${txt}`;
  });

  return ok(`## Episodic Memory — ${mode}\n${lines.join('\n')}`);
}
