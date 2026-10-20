// src/agents/dag.js
// Wave D-3 — Typed dependency DAG for the conductor.
// Turns a flat assignment list (with dependsOn) into execution "waves": each wave
// is the set of roles whose dependencies are all already satisfied, so independent
// roles in the same wave can run concurrently. Detects cycles and unknown deps.

/**
 * @typedef {{ role: string, task?: string, dependsOn?: string[], maxSteps?: number }} Assignment
 */

/**
 * Build a DAG view of the assignments: per-role node + dependency edges.
 * Dependencies that reference an unknown role (not in the assignment set) are
 * dropped with the unknown name recorded, so a typo in `dependsOn` can't wedge
 * the whole pipeline.
 * @param {Assignment[]} assignments
 * @returns {{ nodes: Map<string, Assignment>, deps: Map<string, string[]>, droppedDeps: string[] }}
 */
export function buildDag(assignments) {
  const nodes = new Map();
  for (const a of assignments) nodes.set(a.role, a);

  const deps = new Map();
  const droppedDeps = [];
  for (const a of assignments) {
    const valid = [];
    for (const d of a.dependsOn || []) {
      if (nodes.has(d)) valid.push(d);
      else droppedDeps.push(`${a.role}->${d}`);
    }
    deps.set(a.role, valid);
  }
  return { nodes, deps, droppedDeps };
}

/**
 * Compute execution waves via Kahn's algorithm. Each returned wave is an array of
 * assignments whose dependencies are all satisfied by earlier waves. Roles within
 * a wave are mutually independent and may run concurrently.
 *
 * On a dependency cycle (or any unresolvable remainder), the cycle members are
 * returned as a final wave in their original input order and `hasCycle` is true —
 * callers should fall back to sequential execution for safety.
 *
 * @param {Assignment[]} assignments
 * @returns {{ waves: Assignment[][], hasCycle: boolean, cycleRoles: string[] }}
 */
export function topoWaves(assignments) {
  const { nodes, deps } = buildDag(assignments);

  // Remaining indegree per role.
  const indegree = new Map();
  for (const role of nodes.keys()) indegree.set(role, (deps.get(role) || []).length);

  const done = new Set();
  const waves = [];

  while (done.size < nodes.size) {
    // Ready = not done, all deps done.
    const ready = [];
    for (const [role, a] of nodes) {
      if (done.has(role)) continue;
      const unmet = (deps.get(role) || []).filter(d => !done.has(d));
      if (unmet.length === 0) ready.push(a);
    }

    if (ready.length === 0) {
      // Cycle (or unresolvable): emit the remaining roles in input order as a
      // final wave and signal the caller to treat it sequentially.
      const remaining = assignments.filter(a => !done.has(a.role));
      return { waves: [...waves, remaining], hasCycle: true, cycleRoles: remaining.map(a => a.role) };
    }

    // Preserve input order within the wave for deterministic dispatch.
    ready.sort((x, y) => assignments.indexOf(x) - assignments.indexOf(y));
    waves.push(ready);
    for (const a of ready) done.add(a.role);
  }

  return { waves, hasCycle: false, cycleRoles: [] };
}
