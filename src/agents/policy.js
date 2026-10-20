// src/agents/policy.js
// Phase 3 — Agent routing policy: role → model, maxSteps, tool subset.
// Q7: Conductor pinnable via KAIROS_CONDUCTOR_MODEL. Scout/Archivist = cheap. Coder/Reviewer = strong.

import config from '../config.js';

// ── Role definitions ──────────────────────────────────────────────────────────

export const ROLES = ['conductor', 'scout', 'planner', 'coder', 'reviewer', 'archivist'];

/**
 * Model for each role.
 * Each role checks its own env var first, then falls back to config.model.
 * Per Q7: Conductor is separately pinnable (high-volume, low-difficulty).
 * @param {string} role
 * @returns {string}
 */
export function getRoleModel(role) {
  const env = {
    conductor: process.env.KAIROS_CONDUCTOR_MODEL || config.cheapModel,
    scout:     process.env.KAIROS_SCOUT_MODEL,
    planner:   process.env.KAIROS_PLANNER_MODEL,
    coder:     process.env.KAIROS_CODER_MODEL,
    reviewer:  process.env.KAIROS_REVIEWER_MODEL,
    archivist: process.env.KAIROS_ARCHIVIST_MODEL,
  };
  return env[role] || config.model;
}

/**
 * Step budget per role.
 * Conductor and Archivist are bounded; Coder/Reviewer get more room.
 * @param {string} role
 * @returns {number}
 */
export function getRoleMaxSteps(role) {
  const defaults = {
    conductor: parseInt(process.env.KAIROS_CONDUCTOR_MAX_STEPS || '15',  10),
    scout:     parseInt(process.env.KAIROS_SCOUT_MAX_STEPS     || '10',  10),
    planner:   parseInt(process.env.KAIROS_PLANNER_MAX_STEPS   || '20',  10),
    coder:     parseInt(process.env.KAIROS_CODER_MAX_STEPS     || '100', 10),
    reviewer:  parseInt(process.env.KAIROS_REVIEWER_MAX_STEPS  || '30',  10),
    archivist: parseInt(process.env.KAIROS_ARCHIVIST_MAX_STEPS || '15',  10),
  };
  return defaults[role] ?? 50;
}

/**
 * Tool category for each role.
 * Used in the identity overlay to declare what the agent may use.
 * Hard enforcement is identity-based (soft) in Phase 3 RC;
 * worker_threads isolation is Phase 6.
 *
 * @param {string} role
 * @returns {{ allowed: string[], prohibited: string[] }}
 */
export function getRoleToolPolicy(role) {
  const readOnly = {
    allowed:    ['read_file', 'list_files', 'search_files', 'run_command', 'think', 'finish'],
    prohibited: ['write_file', 'edit_file', 'patch', 'delete_file'],
  };

  const policies = {
    conductor: {
      allowed:    ['read_file', 'list_files', 'think', 'finish', 'update_plan'],
      prohibited: ['write_file', 'edit_file', 'patch', 'delete_file', 'run_command'],
    },
    scout: readOnly,
    planner: {
      allowed:    ['read_file', 'list_files', 'think', 'update_plan', 'finish'],
      prohibited: ['write_file', 'edit_file', 'patch', 'delete_file', 'run_command'],
    },
    coder: {
      allowed:    ['*'],  // all tools
      prohibited: [],
    },
    reviewer: {
      allowed:    ['read_file', 'list_files', 'search_files', 'run_command', 'think', 'finish', 'update_plan', 'add_learning'],
      prohibited: ['write_file', 'edit_file', 'patch', 'delete_file'],
    },
    archivist: {
      allowed:    ['read_file', 'list_files', 'write_file', 'add_learning', 'create_skill', 'think', 'finish'],
      prohibited: ['run_command', 'edit_file', 'patch', 'delete_file'],
    },
  };

  return policies[role] ?? { allowed: ['*'], prohibited: [] };
}

/**
 * One-line description of each role's purpose (used in conductor prompts).
 * @param {string} role
 * @returns {string}
 */
export function getRoleDescription(role) {
  const descs = {
    conductor: 'Reads the task, decomposes it into subtasks, and dispatches to specialists.',
    scout:     'Read-only discovery: maps the project, identifies what exists and what is missing.',
    planner:   'Produces a structured plan.md: ordered tasks, file targets, acceptance criteria.',
    coder:     'Implements the plan: writes, edits, and tests code until all criteria pass.',
    reviewer:  'Reads the artifact and verifies correctness: runs tests, checks edge cases, flags issues.',
    archivist: 'Finalizes: writes summary.md, adds learnings, updates MEMORY.md, creates reusable skills.',
  };
  return descs[role] ?? role;
}
