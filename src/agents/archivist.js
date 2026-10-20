// src/agents/archivist.js
// Phase 3 — Archivist specialist: finalization + memory writeup.
// Produces summary.md, writes palace memories, creates reusable skills.

import { runAgent } from './agentRunner.js';

export const ROLE = 'archivist';

export const DESCRIPTION = 'Finalizes: writes summary.md, adds learnings, updates MEMORY.md, creates reusable skills.';

/**
 * Run the Archivist agent.
 * @param {{ task: string, workspace: string, sessionId: string, budget?: object, onStep?: function }} opts
 */
export async function runArchivist(opts) {
  return runAgent({ ...opts, role: ROLE });
}
