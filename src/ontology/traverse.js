// src/ontology/traverse.js
// G3 — deterministic traversal primitives. No model anywhere in this file:
// walking a graph is arithmetic, and an answer assembled by traversal cites
// rows a hallucination has no path to. These primitives are the retrieval
// half of GraphRAG — generation (query.js) consumes what they return.
//
// Works over a live projection OR a pinned release: `projectionFromRelease`
// shapes a release's approved-only docs into the same {kind → Map} form
// loadProjection returns, so every primitive is release-agnostic.

/** Shape a loaded release record into a projection-like {kind → Map}. */
export function projectionFromRelease(releaseRec) {
  const proj = { domain: releaseRec.domain, release: releaseRec.id };
  for (const [kind, docs] of Object.entries(releaseRec.docs || {})) {
    proj[kind] = new Map(Object.entries(docs).map(([id, payload]) => [id, { ...payload }]));
  }
  for (const kind of ['object_type', 'relationship_type', 'instance', 'relationship']) {
    if (!proj[kind]) proj[kind] = new Map();
  }
  return proj;
}

/**
 * Build an adjacency view over a projection's INSTANCE plane.
 * Nodes are live instances (retired ones are excluded — a merged duplicate is
 * named by its keeper's sameAs field, not present as its own node). Edges are
 * the live instance-level relationship docs between live nodes.
 */
export function graphFromProjection(proj) {
  const nodes = new Map();
  for (const [id, inst] of proj.instance || new Map()) {
    if (inst.state === 'retired') continue;
    nodes.set(id, {
      id, type: inst.type, key: inst.key,
      properties: inst.properties || {},
      state: inst.state,
      ...(inst.sameAs?.length ? { sameAs: inst.sameAs } : {}),
    });
  }
  const edges = [];
  for (const [id, rel] of proj.relationship || new Map()) {
    if (rel.state === 'retired') continue;
    if (!rel.from || !rel.to) continue; // type-level references have no endpoints here
    if (!nodes.has(rel.from) || !nodes.has(rel.to)) continue;
    edges.push({ id, name: rel.name, kind: rel.kind || 'edge', from: rel.from, to: rel.to });
  }
  const out = new Map();
  const incoming = new Map();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e);
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to).push(e);
  }
  return { nodes, edges, out, in: incoming };
}

/** Immediate neighbors of a node, optionally filtered by relation name/direction. */
export function neighbors(graph, nodeId, { relation = null, direction = 'both' } = {}) {
  const hits = [];
  if (direction === 'out' || direction === 'both') {
    for (const e of graph.out.get(nodeId) || []) {
      if (relation && e.name !== relation) continue;
      hits.push({ node: graph.nodes.get(e.to), via: e, direction: 'out' });
    }
  }
  if (direction === 'in' || direction === 'both') {
    for (const e of graph.in.get(nodeId) || []) {
      if (relation && e.name !== relation) continue;
      hits.push({ node: graph.nodes.get(e.from), via: e, direction: 'in' });
    }
  }
  return hits;
}

/**
 * BFS paths from a node to a target type or id, up to maxHops. Returns up to
 * `limit` paths, each a list of {node, via} steps starting at `fromId`.
 * Multi-hop questions ("which customer had a ticket on an order above 1M")
 * are exactly this walk — no similarity search involved.
 */
export function findPaths(graph, fromId, { toType = null, toId = null, maxHops = 3, limit = 5 } = {}) {
  if (!graph.nodes.has(fromId)) return [];
  if (!toType && !toId) return [];
  const found = [];
  const queue = [[{ node: graph.nodes.get(fromId), via: null }]];
  const seen = new Set([fromId]);
  while (queue.length && found.length < limit) {
    const path = queue.shift();
    const last = path[path.length - 1].node;
    if (path.length - 1 >= 1) {
      if ((toId && last.id === toId) || (!toId && toType && last.type === toType)) {
        found.push(path);
        continue;
      }
    }
    if (path.length - 1 >= maxHops) continue;
    for (const n of neighbors(graph, last.id)) {
      if (!n.node || seen.has(n.node.id)) continue;
      seen.add(n.node.id);
      queue.push([...path, { node: n.node, via: n.via }]);
    }
  }
  return found;
}

/**
 * Filter a type's live instances by simple predicates:
 *   { city: 'Tokyo' }                 equality (string, trimmed)
 *   { total: { gte: 1000, lte: 5e6 }} numeric range
 *   { name: { contains: 'gpu' } }     case-insensitive substring
 */
export function filterInstances(proj, typeName, predicates = {}) {
  const out = [];
  for (const [id, inst] of proj.instance || new Map()) {
    if (inst.state === 'retired' || inst.type !== typeName) continue;
    let match = true;
    for (const [prop, cond] of Object.entries(predicates)) {
      const raw = String(inst.properties?.[prop] ?? '').trim();
      if (cond && typeof cond === 'object') {
        const num = Number(raw.replace(/[,¥$]/g, ''));
        if (cond.gte != null && !(Number.isFinite(num) && num >= cond.gte)) { match = false; break; }
        if (cond.lte != null && !(Number.isFinite(num) && num <= cond.lte)) { match = false; break; }
        if (cond.contains != null && !raw.toLowerCase().includes(String(cond.contains).toLowerCase())) { match = false; break; }
      } else if (raw !== String(cond).trim()) { match = false; break; }
    }
    if (match) out.push({ id, ...inst });
  }
  return out;
}

/** Aggregate a numeric property over a type's live instances. */
export function aggregateInstances(proj, typeName, property, op = 'count', { predicates = {} } = {}) {
  const rows = filterInstances(proj, typeName, predicates);
  if (op === 'count') return { op, type: typeName, property, count: rows.length, value: rows.length };
  const nums = rows
    .map((r) => Number(String(r.properties?.[property] ?? '').replace(/[,¥$]/g, '')))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return { op, type: typeName, property, count: 0, value: null };
  const sum = nums.reduce((a, b) => a + b, 0);
  const value = op === 'sum' ? sum
    : op === 'avg' ? sum / nums.length
    : op === 'min' ? Math.min(...nums)
    : op === 'max' ? Math.max(...nums)
    : null;
  if (value === null) throw new Error(`unknown aggregate op "${op}" (count|sum|avg|min|max)`);
  return { op, type: typeName, property, count: nums.length, value };
}

// ── Lexical seed selection ───────────────────────────────────────────────────
//
// Deterministic retrieval: score instances by how many question tokens appear
// in their key, property values, or type name. No embeddings, no model — the
// graph does the semantic work once seeds are found, because edges carry the
// meaning similarity search only approximates.

function tokens(text) {
  return String(text || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
}

const STOP = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'are',
  'was', 'what', 'which', 'who', 'how', 'many', 'much', 'does', 'do', 'did',
  'with', 'about', 'their', 'that', 'this', 'has', 'have', 'had', 'show', 'list',
]);

/** Top instances lexically matching a question. Deterministic and stable. */
export function selectSeeds(proj, question, { limit = 5 } = {}) {
  const qTokens = [...new Set(tokens(question).filter((t) => !STOP.has(t)))];
  if (!qTokens.length) return [];
  const scored = [];
  for (const [id, inst] of proj.instance || new Map()) {
    if (inst.state === 'retired') continue;
    const hay = [
      inst.key, inst.type,
      ...Object.keys(inst.properties || {}),
      ...Object.values(inst.properties || {}),
    ].join(' ').toLowerCase();
    let score = 0;
    for (const t of qTokens) if (hay.includes(t)) score++;
    if (score > 0) scored.push({ id, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, limit)
    .map((s) => s.id);
}

/**
 * Expand seeds into a bounded subgraph: BFS `hops` out from every seed,
 * collecting at most maxNodes nodes and the edges among them.
 */
export function subgraphAround(graph, seedIds, { hops = 2, maxNodes = 50 } = {}) {
  const keep = new Set();
  let frontier = seedIds.filter((id) => graph.nodes.has(id));
  frontier.forEach((id) => keep.add(id));
  for (let h = 0; h < hops && keep.size < maxNodes; h++) {
    const next = [];
    for (const id of frontier) {
      for (const n of neighbors(graph, id)) {
        if (!n.node || keep.has(n.node.id)) continue;
        if (keep.size >= maxNodes) break;
        keep.add(n.node.id);
        next.push(n.node.id);
      }
    }
    frontier = next;
  }
  const nodes = [...keep].sort().map((id) => graph.nodes.get(id));
  const edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return { nodes, edges };
}

export default {
  projectionFromRelease, graphFromProjection, neighbors, findPaths,
  filterInstances, aggregateInstances, selectSeeds, subgraphAround,
};
