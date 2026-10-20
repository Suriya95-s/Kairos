// src/palace/consolidation.js
// Consolidation pass: decay links, archive stale memories, merge semantic facts.
// Called during compaction (Phase 2.8, 2.14) after buildCompactionAnchor.

import { flush as flushSemantic } from './semanticGraph.js';
import { flush as flushProcedural } from './proceduralIndex.js';

/**
 * Run a full palace consolidation pass.
 *
 * @param {import('./episodic-store.js').EpisodicStore} store
 * @param {{ alpha?: number, deltaT?: number, theta?: number }} opts
 * @returns {{ decayed: number, pruned: number, message: string }}
 */
export function consolidate(store, opts = {}) {
  const alpha  = opts.alpha  ?? 0.01; // N4: α=0.01 per ablation
  const deltaT = opts.deltaT ?? 1.0;  // 1.0 = one compaction cycle
  const theta  = opts.theta  ?? 0.001;

  const { decayed, pruned } = store.consolidate(alpha, deltaT, theta);

  // Flush in-memory caches so next retrieval re-reads from disk
  flushSemantic();
  flushProcedural();

  const snapshot = store.exportSnapshot();
  const message  = `Palace consolidation: ${snapshot.count} events active, ${decayed} links surviving, ${pruned} links pruned (α=${alpha})`;

  return { decayed, pruned, message, snapshot };
}
