// src/tools/memory/recall_room.js
// Kairos tool: recall memories associated with a specific file/directory (room).

import { getPalaceSession }   from '../../palace/session.js';
import { findRoom, walk }     from '../../palace/walker.js';
import { retrieve, formatRetrievalResults } from '../../palace/retrieval.js';
import { ok } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'recall_room',
    description: 'Recall memories associated with a specific file or directory. Returns episodic events, semantic facts, and procedural recipes related to that path.',
    parameters: {
      type: 'object',
      properties: {
        path:  { type: 'string', description: 'File or directory path (relative to workspace root)' },
        topK:  { type: 'integer', description: 'Max results to return (default: 10)', default: 10 },
      },
      required: ['path'],
    },
  },
};

export function handler({ path: filePath, topK = 10 }) {
  const session = getPalaceSession();
  if (!session) return ok('Memory palace not active (AGENT_USE_PALACE=0).');

  const { store, graph } = session;

  // Find the closest room in the graph
  const rooms = findRoom(graph, filePath, 1);
  if (rooms.length === 0) {
    return ok(`No room found matching "${filePath}" in the workspace graph.`);
  }

  const results = retrieve({
    episodicStore: store,
    roomGraph:     graph,
    query:         filePath,
    currentFile:   rooms[0],
    topK,
  });

  if (results.length === 0) {
    return ok(`No memories found for "${filePath}".`);
  }

  return ok(formatRetrievalResults(results));
}
