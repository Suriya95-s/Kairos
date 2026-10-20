// src/agents/scout.js
// Phase 3 — Scout specialist: read-only project discovery.
// Returns a project map in ≤10 steps. Uses only read-only tools.

import { runAgent } from './agentRunner.js';

/** Scout role definition. */
export const ROLE = 'scout';

export const DESCRIPTION = 'Read-only discovery: maps the project, identifies what exists and what is missing.';

/**
 * Run the Scout agent for a given discovery task.
 * Convenience wrapper over runAgent with scout defaults.
 *
 * @param {{ task: string, workspace: string, sessionId: string, budget?: object, onStep?: function }} opts
 */
export async function runScout(opts) {
  return runAgent({ ...opts, role: ROLE });
}
