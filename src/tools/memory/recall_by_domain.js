// src/tools/memory/recall_by_domain.js
// Kairos tool: recall recent episodic memories for a domain (stage or tool name).
// The episodic store indexes every step by `domain`, so this answers
// "what have I done in <domain>?" directly from the CEI temporal index.

import { getPalaceSession } from '../../palace/session.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'recall_by_domain',
    description: 'Recall the most recent episodic memories for a domain (a stage like "verification"/"execution" or a tool name). Answers "what have I done in this area?" from the episodic store.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain to recall (e.g. "verification", "execution", "run_command")' },
        topK:   { type: 'integer', description: 'Max results (default: 10)', default: 10 },
      },
      required: ['domain'],
    },
  },
};

export function handler({ domain, topK = 10 }) {
  const session = getPalaceSession();
  if (!session) return ok('Memory palace not active (AGENT_USE_PALACE=0).');
  if (!domain) return fail('Provide a domain to recall (e.g. "verification").');

  const { store } = session;
  let results;
  try {
    results = store.queryRecent(topK, domain);
  } catch (err) {
    return fail(`Domain recall failed: ${err.message}`);
  }

  if (!results || results.length === 0) {
    return ok(`No episodic memories found for domain="${domain}".`);
  }

  const lines = results.map((e) => {
    const ts  = new Date(e.timestamp * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const txt = (e.summary || e.verbatim || '').slice(0, 200);
    const err = e.note && /ERROR/i.test(e.note) ? ' ⚠' : '';
    return `${ts}${err}: ${txt}`;
  });

  return ok(`## Episodic Memory — domain "${domain}" (${results.length})\n${lines.join('\n')}`);
}
