// src/palace/walker.js
// Spatial walk retrieval — BFS from a starting room, returning ranked neighbors.
// Used for spatial memory retrieval: "what do I know about files near X?"

import { getRoomNeighbors } from './rooms.js';

/**
 * BFS walk from a starting room, up to maxHops.
 * Returns nodes in BFS order with their hop distance (relevance proxy).
 *
 * @param {import('./rooms.js').RoomGraph} graph
 * @param {string} startRoom  — relative file/dir path
 * @param {{ maxHops?: number, maxNodes?: number, types?: string[] }} opts
 * @returns {{ id: string, hop: number, type: string }[]}
 */
export function walk(graph, startRoom, opts = {}) {
  const maxHops  = opts.maxHops  ?? 2;
  const maxNodes = opts.maxNodes ?? 20;
  const types    = opts.types;  // optional filter: ['file'] or ['dir']

  if (!graph.nodes.has(startRoom)) return [];

  const visited = new Set([startRoom]);
  const queue   = [{ id: startRoom, hop: 0 }];
  const results = [];

  while (queue.length > 0 && results.length < maxNodes) {
    const { id, hop } = queue.shift();
    const node = graph.nodes.get(id);
    if (!node) continue;

    if (id !== startRoom) {
      if (!types || types.includes(node.type)) {
        results.push({ id, hop, type: node.type });
      }
    }

    if (hop >= maxHops) continue;

    const { parents, children, imports, importedBy } = getRoomNeighbors(graph, id);
    for (const neighbor of [...parents, ...children, ...imports, ...importedBy]) {
      if (!visited.has(neighbor) && graph.nodes.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ id: neighbor, hop: hop + 1 });
      }
    }
  }

  // Sort by hop (closer = higher rank), then alphabetically within same hop
  return results.sort((a, b) => a.hop - b.hop || a.id.localeCompare(b.id));
}

/**
 * Find the closest room(s) matching a path fragment.
 * @param {import('./rooms.js').RoomGraph} graph
 * @param {string} fragment — e.g. 'loop.js' or 'lmma'
 * @param {number} topK
 * @returns {string[]} matching room ids
 */
export function findRoom(graph, fragment, topK = 3) {
  const lower = fragment.toLowerCase();
  const matches = [];
  for (const [id] of graph.nodes) {
    if (id.toLowerCase().includes(lower)) {
      matches.push(id);
    }
  }
  // Prefer shorter paths (more specific match)
  matches.sort((a, b) => a.length - b.length);
  return matches.slice(0, topK);
}
