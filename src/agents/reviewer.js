// src/agents/reviewer.js
// Phase 3 — Reviewer specialist: verification + audit.
// Reads artifact, runs tests, checks edge cases, flags issues.

import { runAgent } from './agentRunner.js';

export const ROLE = 'reviewer';

export const DESCRIPTION = 'Reads the artifact and verifies correctness: runs tests, checks edge cases, flags issues.';

/**
 * Run the Reviewer agent.
 * @param {{ task: string, workspace: string, sessionId: string, budget?: object, onStep?: function }} opts
 */
export async function runReviewer(opts) {
  return runAgent({ ...opts, role: ROLE });
}
