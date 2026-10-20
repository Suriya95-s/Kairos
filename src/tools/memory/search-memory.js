import { searchMemory as searchMem } from '../../memory-store.js';
import { ok } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'search_memory',
    description: 'Search across all persistent memory files (daily logs, MEMORY.md, learnings) for a keyword or pattern. Results are relevance-ranked.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query or pattern' },
        type: { type: 'string', description: 'Optional: filter by memory type (world, experience, decision, opinion, gotcha)', default: '' },
      },
      required: ['query'],
    },
  },
};

export function handler({ query, type }) {
  return ok(String(searchMem(query, { type: type || undefined })));
}
