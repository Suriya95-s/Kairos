// src/palace/rooms.js
// Memory Palace — Room Graph builder.
// Rooms = files/dirs in the workspace. Corridors = import/require edges.
// Graph is rebuilt lazily and cached in .agent/palace/rooms.json.

import fs   from 'node:fs';
import path from 'node:path';

const JS_EXT  = /\.(js|mjs|cjs|ts|tsx|jsx)$/;
const PY_EXT  = /\.py$/;
const IMPORT_RE = /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const PY_IMPORT_RE = /^\s*(?:from\s+([\w./]+)\s+import|import\s+([\w./]+))/gm;

/**
 * @typedef {{ id: string, type: 'file'|'dir', parent: string|null, ext: string }} RoomNode
 * @typedef {{ src: string, dst: string, type: 'parent'|'import' }} RoomEdge
 * @typedef {{ nodes: Map<string, RoomNode>, edges: RoomEdge[] }} RoomGraph
 */

/**
 * Build the room graph for a workspace.
 * Nodes = relative file/dir paths. Edges = parent-child + import relationships.
 *
 * @param {string} workspaceRoot
 * @param {{ maxDepth?: number, ignore?: RegExp[] }} opts
 * @returns {RoomGraph}
 */
export function buildRoomGraph(workspaceRoot, opts = {}) {
  const maxDepth = opts.maxDepth ?? 8;
  const ignore   = opts.ignore   ?? [/node_modules/, /\.git/, /\.agent/, /dist/, /build/, /coverage/];

  /** @type {Map<string, RoomNode>} */
  const nodes = new Map();
  /** @type {RoomEdge[]} */
  const edges = [];

  function shouldIgnore(relPath) {
    return ignore.some(re => re.test(relPath));
  }

  function walk(absDir, relDir, depth) {
    if (depth > maxDepth) return;
    if (shouldIgnore(relDir)) return;

    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (shouldIgnore(relPath)) continue;

      const type = entry.isDirectory() ? 'dir' : 'file';
      const ext  = path.extname(entry.name);
      nodes.set(relPath, { id: relPath, type, parent: relDir || null, ext });

      if (relDir) {
        edges.push({ src: relDir, dst: relPath, type: 'parent' });
      }

      if (entry.isDirectory()) {
        walk(path.join(absDir, entry.name), relPath, depth + 1);
      }
    }
  }

  // Seed root node
  nodes.set('.', { id: '.', type: 'dir', parent: null, ext: '' });
  walk(workspaceRoot, '', 0);

  // Extract import edges from JS/PY source files
  for (const [relPath, node] of nodes) {
    if (node.type !== 'file') continue;
    const absPath = path.join(workspaceRoot, relPath);
    try {
      const src = fs.readFileSync(absPath, 'utf-8');
      const importedPaths = extractImports(src, relPath);
      for (const imp of importedPaths) {
        if (nodes.has(imp)) {
          edges.push({ src: relPath, dst: imp, type: 'import' });
        }
      }
    } catch { /* skip unreadable files */ }
  }

  return { nodes, edges };
}

/**
 * Extract imported relative file paths from a source file.
 * Resolves relative imports to workspace-relative paths.
 */
function extractImports(src, fromRelPath) {
  const dir      = path.dirname(fromRelPath);
  const results  = new Set();
  const isJs     = JS_EXT.test(fromRelPath);
  const isPy     = PY_EXT.test(fromRelPath);

  if (isJs) {
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const raw = m[1] || m[2];
      if (!raw || !raw.startsWith('.')) continue; // skip npm packages
      const resolved = normalizePath(path.join(dir, raw));
      // Try with and without extension
      for (const ext of ['', '.js', '.mjs', '/index.js']) {
        results.add(resolved + ext);
      }
    }
  } else if (isPy) {
    let m;
    PY_IMPORT_RE.lastIndex = 0;
    while ((m = PY_IMPORT_RE.exec(src)) !== null) {
      const raw = (m[1] || m[2] || '').replace(/\./g, '/');
      if (raw) results.add(raw + '.py');
    }
  }

  return [...results];
}

function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/^\//, '');
}

/**
 * Serialize a RoomGraph to a plain object (for JSON storage).
 * @param {RoomGraph} graph
 */
export function serializeGraph(graph) {
  return {
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
    builtAt: new Date().toISOString(),
  };
}

/**
 * Deserialize a plain object back to a RoomGraph.
 */
export function deserializeGraph(raw) {
  return {
    nodes: new Map(raw.nodes.map(n => [n.id, n])),
    edges: raw.edges,
  };
}

/**
 * Get all nodes directly connected to a given room (file/dir).
 * Returns { parents, children, importedBy, imports }.
 */
export function getRoomNeighbors(graph, roomId) {
  const parents    = [];
  const children   = [];
  const imports    = [];
  const importedBy = [];

  for (const edge of graph.edges) {
    if (edge.src === roomId) {
      if (edge.type === 'parent') children.push(edge.dst);
      if (edge.type === 'import') imports.push(edge.dst);
    }
    if (edge.dst === roomId) {
      if (edge.type === 'parent') parents.push(edge.src);
      if (edge.type === 'import') importedBy.push(edge.src);
    }
  }

  return { parents, children, imports, importedBy };
}
