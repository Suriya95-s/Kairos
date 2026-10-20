// src/agents/conductor.js
// Phase 3 — Conductor agent: task decomposition + specialist dispatch.
// The Conductor reads the task, emits a taskSpec, and runs each specialist in order.
// Default-OFF in RC (AGENT_MULTI_AGENT=0); single-agent fallback via runLoop directly.

import { runLoop }           from '../loop.js';
import logger                from '../logger.js';
import config                from '../config.js';
import { runAgent }          from './agentRunner.js';
import { parseTaskSpec, defaultDecomposition } from './taskSpec.js';
import { getRoleModel, getRoleMaxSteps }       from './policy.js';
import { defaultBudget }     from './budget.js';
import { clearHandoffs }     from './handoff.js';
import { topoWaves }         from './dag.js';
import { initManifest, writeManifest, readManifest, clearManifest } from './manifest.js';
import { getWorkspace }      from '../state.js';

/**
 * Conduct a multi-agent task run.
 *
 * 1. Run the Conductor agent to decompose the task into a taskSpec.
 * 2. Parse the taskSpec.
 * 3. Run each specialist in dependency order.
 * 4. Return the aggregate result.
 *
 * @param {{
 *   task:       string,
 *   workspace?: string,
 *   onStep?:    function,
 *   sessionId?: string,
 * }} opts
 * @returns {Promise<ConductorResult>}
 */
export async function conductTask({ task, workspace, onStep, sessionId, resume = false }) {
  workspace = workspace || getWorkspace();
  sessionId = sessionId || `ep-${Date.now()}`;

  const log = (msg) => logger.info(`[conductor/${sessionId}] ${msg}`);

  // ── Resume? Reuse the durable manifest (Wave D-2) and skip re-decomposition ─
  const priorManifest = resume ? readManifest(workspace, sessionId) : null;
  if (!resume) {
    // Fresh start: clear stale handoffs + manifest from a previous same-id run.
    clearHandoffs(sessionId);
    clearManifest(workspace);
  }
  log(`${priorManifest ? 'Resuming' : 'Starting'} multi-agent run — task: ${task.slice(0, 80)}...`);

  // ── Step 1+2: Decompose into assignments (skip on resume — manifest has them) ─
  let assignments;
  if (priorManifest?.assignments?.length) {
    assignments = priorManifest.assignments;
    log(`Resumed ${assignments.length} assignment(s) from manifest.`);
  } else {
    // Per-agent model/maxSteps passed explicitly to runLoop (Wave D-1) — no global
    // config mutation, so the dispatch below is concurrency-safe.
    const conductorTask = buildConductorTask(task);
    let conductorOutput = '';
    const conductorResult = await runLoop({
      task:      conductorTask,
      workspace,
      resume:    false,
      _noConduct: true,
      model:     getRoleModel('conductor'),
      maxSteps:  getRoleMaxSteps('conductor'),
      // runLoop invokes onStep positionally: (step, action, toolResult).
      // The taskspec block lives in the conductor's reasoning (action.thought)
      // and/or its finish summary (action.args.summary) — capture both.
      onStep: (step, action, toolResult) => {
        if (action?.thought) conductorOutput += '\n' + action.thought;
        if (action?.args?.summary) conductorOutput += '\n' + action.args.summary;
        onStep?.(step, action, toolResult);
      },
    });
    conductorOutput += '\n' + (conductorResult.summary || '');

    assignments = parseTaskSpec(conductorOutput);
    if (assignments.length === 0) {
      log('No taskSpec in conductor output — using default Scout→Planner→Coder→Reviewer→Archivist pipeline.');
      assignments = defaultDecomposition(task);
    }
  }
  log(`Dispatching ${assignments.length} agent(s): ${assignments.map(a => a.role).join(' → ')}`);

  // ── Step 3: Budget (steps + USD ceiling, Wave D-4) ────────────────────────
  const perRole = Object.fromEntries(
    assignments.map(a => [a.role, a.maxSteps ?? getRoleMaxSteps(a.role)])
  );
  const budget = defaultBudget(perRole, config.conductorMaxDollars);

  // ── Step 4: Manifest (durable state, Wave D-2) ────────────────────────────
  const manifest = priorManifest || initManifest(sessionId, task, assignments);
  if (!priorManifest) writeManifest(workspace, manifest);

  const results = [...(manifest.results || [])];
  const completed = new Set(['conductor',
    ...Object.entries(manifest.status).filter(([, s]) => s === 'completed').map(([r]) => r)]);
  const failedOrSkipped = new Set(
    Object.entries(manifest.status).filter(([, s]) => s === 'failed' || s === 'skipped').map(([r]) => r));

  const setStatus = (role, status, result) => {
    manifest.status[role] = status;
    if (result) {
      const idx = results.findIndex(r => r.role === role);
      if (idx >= 0) results[idx] = result; else results.push(result);
      manifest.results = results;
    }
    manifest.budget = budget.snapshot();
    writeManifest(workspace, manifest);
  };

  // Retry-wrapped single-role dispatch (Wave D-3 retries with backoff).
  async function dispatchRole(assignment) {
    const { role, task: subtask } = assignment;
    let last;
    for (let attempt = 0; attempt <= config.conductorMaxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = 250 * attempt;
        log(`Retrying ${role} (attempt ${attempt + 1}/${config.conductorMaxRetries + 1}) after ${backoff}ms...`);
        await new Promise(r => setTimeout(r, backoff));
      }
      try {
        last = await runAgent({
          role, task: subtask, workspace, sessionId,
          maxSteps: assignment.maxSteps,
          budget, onStep,
        });
        if (last.exitReason === 'completed') return last;
      } catch (err) {
        last = { role, exitReason: 'error', summary: err.message, steps: 0, costUsd: 0 };
      }
    }
    return last; // non-completed after retries
  }

  // ── Step 5: Execute the typed DAG wave-by-wave (Wave D-3) ──────────────────
  const topo = topoWaves(assignments);
  if (topo.droppedDeps?.length) log(`Dropped unknown dependencies: ${topo.droppedDeps.join(', ')}`);
  let waves = topo.waves;
  if (topo.hasCycle) {
    log(`Dependency cycle among [${topo.cycleRoles.join(', ')}] — falling back to sequential order.`);
    waves = assignments.map(a => [a]); // one node per wave, input order
  }
  if (!config.conductorParallel) {
    waves = waves.flatMap(w => w.map(a => [a])); // force one-node-per-wave (debugging)
  }

  outer:
  for (const wave of waves) {
    // Filter: skip already-completed (resume) and dependency-failed roles.
    const toRun = [];
    for (const a of wave) {
      if (completed.has(a.role)) continue;
      const deadDep = (a.dependsOn || []).find(d => failedOrSkipped.has(d));
      if (deadDep) {
        log(`Skipping ${a.role}: dependency "${deadDep}" did not complete.`);
        failedOrSkipped.add(a.role);
        setStatus(a.role, 'skipped', { role: a.role, exitReason: 'skipped', summary: `Dependency ${deadDep} did not complete`, steps: 0 });
        continue;
      }
      const gate = budget.canStep(a.role, budget.snapshot().roleConsumed[a.role] || 0);
      if (!gate.ok) {
        log(`Budget gate: ${gate.reason} — stopping before ${a.role}.`);
        setStatus(a.role, 'failed', { role: a.role, exitReason: 'budget_exceeded', summary: gate.reason, steps: 0 });
        break outer;
      }
      toRun.push(a);
    }
    if (toRun.length === 0) continue;

    // Phase 1.5: parallelism no longer implies "skip checkpointing". Each
    // specialist runs in a child context with its own missionId, so concurrent
    // siblings checkpoint to separate files and stay individually resumable.
    const parallel = toRun.length > 1;
    toRun.forEach(a => { manifest.status[a.role] = 'running'; });
    writeManifest(workspace, manifest);

    const settle = (a, res) => {
      budget.recordCost(a.role, res.costUsd || 0);
      if (res.exitReason === 'completed') { completed.add(a.role); setStatus(a.role, 'completed', res); }
      else { failedOrSkipped.add(a.role); setStatus(a.role, 'failed', res); }
      log(`${a.role} → ${res.exitReason} (${res.steps || 0} steps, $${(res.costUsd || 0).toFixed(4)})`);
    };

    if (parallel) {
      const settled = await Promise.allSettled(toRun.map(a => dispatchRole(a)));
      settled.forEach((s, i) => {
        const a = toRun[i];
        settle(a, s.status === 'fulfilled'
          ? s.value
          : { role: a.role, exitReason: 'error', summary: String(s.reason), steps: 0, costUsd: 0 });
      });
    } else {
      const a = toRun[0];
      settle(a, await dispatchRole(a));
    }
  }

  const budgetSnap = budget.snapshot();
  manifest.budget = budgetSnap;
  writeManifest(workspace, manifest);
  log(`Multi-agent run complete — ${budgetSnap.consumed} steps, $${budgetSnap.dollarsConsumed.toFixed(4)} across ${results.length} agent(s).`);

  return {
    sessionId,
    assignments,
    results,
    budget: budgetSnap,
    success: results.length > 0 && results.every(r => r.exitReason === 'completed'),
  };
}

/** Build the conductor's own task prompt. */
function buildConductorTask(task) {
  return `# Role: CONDUCTOR
You are the Conductor agent. Your job is to decompose the following task into a clear, ordered sequence of specialist agent assignments.

## Master Task
${task}

## Instructions
1. Analyze the task carefully.
2. Decide which specialists are needed: scout, planner, coder, reviewer, archivist.
3. Write a \`\`\`taskspec block specifying what each specialist should do, in order.
4. Use \`dependsOn\` to declare ordering dependencies.
5. Keep each subtask description clear and self-contained (specialists won't see the original task).
6. Then call \`finish\` with a one-sentence summary.

## Example taskspec format
\`\`\`taskspec
- role: scout
  task: "Map what currently exists in the project. Report: languages, existing tests, entry points, missing files."
- role: planner
  task: "Create plan.md for adding a REST API to an Express app. Include: endpoints, file targets, test strategy."
  dependsOn: [scout]
- role: coder
  task: "Implement the plan.md REST API. Write tests. Ensure all tests pass."
  dependsOn: [planner]
- role: reviewer
  task: "Verify the REST API: run tests, check edge cases, ensure error handling is correct."
  dependsOn: [coder]
- role: archivist
  task: "Write .agent/summary.md summarizing what was built. Add learnings."
  dependsOn: [reviewer]
\`\`\`

Now write the taskspec for the master task, then call finish.`;
}
