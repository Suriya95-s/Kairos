// src/agents/planner.js
// Phase 3 — Planner specialist: produces structured plan.md from a task.

import { runAgent } from './agentRunner.js';

export const ROLE = 'planner';

export const DESCRIPTION = 'Produces a structured plan.md: ordered tasks, file targets, acceptance criteria.';

/**
 * Run the Planner agent.
 * @param {{ task: string, workspace: string, sessionId: string, budget?: object, onStep?: function }} opts
 */
export async function runPlanner(opts) {
  return runAgent({ ...opts, role: ROLE });
}
