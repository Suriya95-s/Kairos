// src/agents/agentRunner.js
// Phase 3 — Shared agent runner: wraps runLoop() with per-role configuration.
// Each specialist agent (Scout, Planner, Coder, Reviewer, Archivist) delegates here.
//
// Design: per-agent model/maxSteps are passed explicitly to runLoop (Wave D-1),
// not mutated onto the global config singleton — so concurrent dispatch is safe.

import fs   from 'node:fs';
import { fileURLToPath }    from 'node:url';
import { runLoop }          from '../loop.js';
import { getRoleModel, getRoleMaxSteps, getRoleToolPolicy, getRoleDescription } from './policy.js';
import { buildHandoffContext, writeHandoff } from './handoff.js';
import { getWorkspace, readFilesTouched } from '../state.js';
import { currentContext } from '../runtime/context.js';

/**
 * Run a single specialist agent.
 *
 * @param {{
 *   role:       string,      — one of: scout, planner, coder, reviewer, archivist
 *   task:       string,      — the subtask for this agent
 *   workspace:  string,      — workspace root
 *   sessionId:  string,      — shared session ID for handoffs (e.g. "ep-<ts>")
 *   maxSteps?:  number,      — overrides the role default
 *   budget?:    object,      — Budget instance from budget.js
 *   onStep?:    function,    — step callback (passed to runLoop)
 * }} opts
 * @returns {Promise<{ role: string, exitReason: string, summary: string, steps: number }>}
 */
export async function runAgent({ role, task, workspace, sessionId, maxSteps, budget, onStep }) {
  // fileURLToPath — `.pathname` yields "/C:/..." on Windows, so the overlay is
  // never found and every specialist silently loses its identity block.
  const overlayPath = fileURLToPath(new URL(`./identity-overlays/${role}.md`, import.meta.url));
  const overlayText = fs.existsSync(overlayPath)
    ? fs.readFileSync(overlayPath, 'utf-8')
    : '';

  const toolPolicy   = getRoleToolPolicy(role);
  const roleModel    = getRoleModel(role);
  const roleMaxSteps = maxSteps ?? getRoleMaxSteps(role);

  // Build a full task string: identity overlay + handoffs + actual task
  const handoffCtx = buildHandoffContext(sessionId, role);
  const fullTask = [
    `# Role: ${role.toUpperCase()}`,
    `_${getRoleDescription(role)}_`,
    '',
    overlayText ? `## Role Guidelines\n${overlayText}` : '',
    toolPolicy.prohibited.length
      ? `## Tool Restrictions\nDo NOT use: ${toolPolicy.prohibited.join(', ')}.`
      : '',
    handoffCtx,
    `## Your Subtask\n${task}`,
  ].filter(Boolean).join('\n\n');

  // Per-agent model + maxSteps are passed explicitly to runLoop (Wave D-1) — no
  // global config mutation, so this is safe under concurrent dispatch.
  // Phase 1.5: each specialist runs in its own child context. The child shares
  // the parent mission's workspace state (file tracking, palace) but carries a
  // distinct missionId, so parallel siblings write separate checkpoints instead
  // of clobbering one shared file — which is what `_ephemeralCheckpoint` used
  // to avoid by not checkpointing at all, leaving specialists unresumable.
  const specialistCtx = currentContext().child({
    missionId: `${sessionId}-${role}`,
    id:        `agent/${role}`,
  });

  const result = await runLoop({
    task:      fullTask,
    workspace,
    resume:    false,
    _noConduct: true,
    model:     roleModel,
    maxSteps:  roleMaxSteps,
    ctx:       specialistCtx,
    onStep:    budget
      ? (stepInfo) => {
          budget.recordStep(role);
          onStep?.(stepInfo);
        }
      : onStep,
  });

  // Write handoff for subsequent agents
  writeHandoff(sessionId, role, {
    summary:   result.summary || `${role} completed in ${result.totalSteps} steps.`,
    artifacts: extractArtifacts(),
    notes:     result.exitReason === 'completed' ? '' : `Exited early: ${result.exitReason}`,
  });

  return {
    role,
    exitReason: result.exitReason,
    summary:    result.summary,
    steps:      result.totalSteps,
    model:      roleModel,
    costUsd:     result.costUsd || 0,
    totalTokens: result.totalTokens || 0,
  };
}

/**
 * Read the files-touched tracker to get artifacts written this run.
 * Used for the handoff's artifact list. The tracker lives at
 * .agent/memory/files-touched.json with shape { reads, writes, freshness };
 * artifacts are the keys of `writes`.
 */
function extractArtifacts() {
  try {
    const raw = readFilesTouched();
    return Object.keys(raw.writes || {}).filter(f => !f.startsWith('.agent/')).slice(0, 20);
  } catch { return []; }
}
