// src/agents/coder.js
// Phase 3 — Coder specialist: full implementation with all edit tools.
// Builds code end-to-end: write, edit, test until acceptance criteria pass.

import { runAgent } from './agentRunner.js';

export const ROLE = 'coder';

export const DESCRIPTION = 'Implements the plan: writes, edits, and tests code until all criteria pass.';

/**
 * Run the Coder agent.
 * @param {{ task: string, workspace: string, sessionId: string, budget?: object, onStep?: function }} opts
 */
export async function runCoder(opts) {
  return runAgent({ ...opts, role: ROLE });
}
