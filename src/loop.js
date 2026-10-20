// advanced-agent-loop/src/loop.js
// THE core execution loop — the longest-running, most stable autonomous agent.
//
// Architecture (from research):
//   - 5-layer context assembly (identity → knowledge → state → session → guidance)
//   - Pre-compaction memory flush (save critical context before destruction)
//   - Post-compaction identity recovery (re-orient after context compression)
//   - Dynamic skill system (agent creates its own tools)
//   - Heartbeat memory checks (periodic persistent memory saves)
//   - Focus chain (human-editable priority steering)
//   - Crash recovery via checkpoint.json
//
// The simplest loop that can run for HUNDREDS of steps stably.
// No framework. No graph. Just step → decide → execute → record → persist.

import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { chatCompletion, countMessageChars } from './llm.js';
import { snapshotWorkspace, sandboxVerify } from './sandbox-verifier.js';
import { buildMessages } from './context.js';
import { executeTool } from './tools.js';
import { WorkingMemory } from './memory.js';
import { route } from './routing/router.js';
import { getToolCategory } from './routing/toolRegistry.js';
import { getExposedTools } from './routing/toolManager.js';
import { compactMemory, shouldCompactByInterval } from './compaction.js';
import { getCurrentSubtask, getFocusChain } from './plan.js';
import { bootstrapIdentity, getIdentityLoadTrace, isFirstRun, readLongTermMemory } from './identity.js';
import { loadSkills } from './skills.js';
import { heartbeatMemoryCheck, saveMemory } from './memory-store.js';
import { prepareLmmaStep, finalizeLmmaStep } from './lmma/index.js';
import { runControllerStep, loadRwkvControllerState } from './rwkv/bridge.js';
import { emitTrainingTrace } from './training/trace-logger.js';
import {
  initAgentDir,
  seedLmmaBanksFromContext,
  writeTask,
  readTask,
  readPlan,
  getWorkspace,
  appendProgress,
  saveCheckpoint,
  loadCheckpoint,
  restoreFilesTracking,
  setCommandTrackingContext,
  trackRecoveryEvent,
  readRecoveryEvents,
  readCommandsRun,
  getFileFreshnessStatus,
  markFileRequiresReread,
  clearCommandDedup,
  readLmmaActiveRoute,
  readLmmaWorkingMemory,
  getStateHash,
} from './state.js';
import {
  createInitialStageState,
  tickAndAdvanceStage,
  getStageGuidance,
  filterToolsByStage,
  completionGuard,
  ensureStageArtifacts,
  inspectStageState,
  getProfileGates,
  getProfileName,
} from './stages.js';
// verifyCompletion is deliberately NOT imported: the live finish gate is
// sandboxVerify (below). It remains exported from verification.js for callers
// that want a cheaper judge, but wiring it here would double-charge every finish.
import { buildCompactionAnchor } from './verification.js';
import { selectProfile, getProfile } from './missions/profiles.js';
import { detectHallucination } from './hallucinationDetector.js';
import { requestApproval, isPaused, pause as hitlPause, resume as hitlResume, appendAudit as hitlAudit, emitEvent as hitlEmit, pauseAgeMs } from './hitl/gateway.js';
import { consumeSteering } from './hitl/steeringChannel.js';
import { consumeAnswers } from './hitl/clarificationQueue.js';
import { writeReflection } from './learning/reflection.js';
import logger from './logger.js';
import { evalSession } from './learning/selfEval.js';
import { recordFailure, getSkillSuggestions } from './learning/failureLearner.js';
import { startSession as costStart, recordUsage as costRecord, flushCost, sessionCost } from './observability/costTracker.js';
import { initTelemetry, track as telTrack } from './observability/telemetry.js';
import { startTrace, recordSpan, flushSpans } from './otel.js';

// ── Extracted modules ────────────────────────────────────────
import { parseAction, safeSlice } from './parser.js';
import {
  AgentContext,
  getAmbientContext,
  currentContext,
  currentContextOrNull,
  runWithContext,
} from './runtime/context.js';
import {
  normalizeCommandForComparison,
  detectLoopGuard,
  detectIdenticalStreak,
  isSameAsLastUserAction,
  getLastUserAction,
  buildRepeatedActionBlock,
  buildCrossFileDiagnostic,
  buildMissingArtifactPriorityBlock,
  extractCallerFromTraceback,
} from './guards.js';
import {
  buildParseRecoveryGuidance,
  applyVerificationRepairToolFilter,
  buildPrematureSuccessArtifactBlock,
  buildToolFailureGuidance,
  getRequiredVerificationFailure,
  buildCompletionGuardRecoveryGuidance,
  buildRepairStallEscalation,
} from './recovery.js';

// ── Backward-compatible re-exports (tests import from loop.js) ──
export { parseAction } from './parser.js';
export {
  buildRepeatedFailureRetryBlock,
  buildRepeatedActionBlock,
  buildRepeatedObservationRetryBlock,
} from './guards.js';
export {
  buildParseRecoveryGuidance,
  buildToolFailureGuidance,
  buildPrematureSuccessArtifactBlock,
  applyVerificationRepairToolFilter,
  buildCompletionGuardRecoveryGuidance,
} from './recovery.js';

/**
 * Tools whose successful execution changes state outside the agent's own notes.
 * Used by the errand profile's actuation-receipts gate. Read-only tools
 * (read_file, search, webfetch) and bookkeeping tools (think, save_memory,
 * update_plan) are deliberately excluded — none of them constitute "doing" the
 * errand. Any MCP tool counts, since MCP is how real-world actions arrive.
 * @param {string} toolName
 * @returns {boolean}
 */
export function isStateChangingTool(toolName) {
  const name = String(toolName || '');
  if (name.includes('__')) return true;   // MCP tool → external side effect
  return [
    'write_file', 'edit_file', 'patch',
    'create_dir', 'move_path', 'copy_path', 'delete_path',
    'run_command',
  ].includes(name);
}

/**
 * @typedef {Object} LoopResult
 * @property {'completed'|'max_steps'|'budget_exceeded'|'error'|'interrupted'} exitReason
 * @property {string} summary
 * @property {number} totalSteps
 * @property {number} totalCharsUsed
 * @property {number} compactionCount
 * @property {number} memoriesFlushed
 * @property {number} skillsCreated
 * @property {number} avgStepLatencyMs
 * @property {number} p95StepLatencyMs
 */

/**
 * Run the agent loop.
 * @param {Object} opts
 * @param {string} opts.task - The task to accomplish
 * @param {string} [opts.workspace] - Workspace directory
 * @param {boolean} [opts.resume] - Resume from checkpoint
 * @param {function} [opts.onStep] - Callback per step: (step, action, result) => void
 * @returns {Promise<LoopResult>}
 */
export async function runLoop(opts = {}) {
  // ── Phase 1.2: establish this run's context ──────────────────
  // Resolution order, and why:
  //   1. an explicit `ctx`      — the daemon dispatching an isolated mission
  //   2. the enclosing run's    — a conductor specialist re-entering runLoop;
  //      it must share the parent mission's workspace, not fork a new one
  //   3. the ambient context    — the CLI path, where cli.js has already called
  //      setWorkspace() on ambient before getting here
  // Everything inside then resolves through AsyncLocalStorage, so state.js and
  // the observability modules follow the run without any call site passing ctx.
  const runCtx = opts.ctx instanceof AgentContext
    ? opts.ctx
    : (currentContextOrNull() ?? getAmbientContext());
  if (opts.ctx instanceof AgentContext && opts.workspace) {
    runCtx.setWorkspace(opts.workspace);
  }
  // Phase 1.5/1.6: a caller may name this run and/or declare that a host owns
  // process lifecycle, without having to construct a context itself.
  if (opts.missionId != null) runCtx.missionId = opts.missionId;
  if (opts.daemonMode != null) runCtx.daemonMode = !!opts.daemonMode;
  return runWithContext(runCtx, () => _runLoop(opts));
}

async function _runLoop({ task, workspace, resume = false, onStep, _noConduct = false, model = null, maxSteps = null, profile = null }) {
  // Per-agent config overrides (Wave D-1): de-globalized. When the conductor or
  // agentRunner dispatches a specialist, it passes model/maxSteps explicitly
  // rather than mutating the global config singleton — this makes concurrent
  // dispatch safe. Fall back to the global config when not overridden.
  const modelOverride = model || null;
  const effectiveMaxSteps = (maxSteps != null && maxSteps > 0) ? maxSteps : config.maxSteps;
  // Multi-agent entrypoint: the Conductor decomposes the task and dispatches
  // specialists, each of which re-enters runLoop. Those inner calls MUST set
  // _noConduct so they execute the single-agent loop rather than recursing back
  // into conductTask (which would never run an LLM step). See conductor.js /
  // agentRunner.js.
  if (config.multiAgentEnabled && !_noConduct) {
    const { conductTask } = await import('./agents/conductor.js');
    return conductTask({ task, workspace, onStep });
  }

  // ── Setup ──────────────────────────────────────────────────

  // This run's context, established by the runLoop() wrapper above. Used for
  // mission-scoped paths (1.5) and to decide whether this run owns process
  // lifecycle (1.6). Everything else reaches it implicitly via state.js.
  const runtimeCtx = currentContext();

  // Initialize directory structure
  initAgentDir();

  // Bootstrap identity layer (SOUL.md, AGENTS.md, USER.md, MEMORY.md)
  const firstRun = isFirstRun();
  bootstrapIdentity();
  const identityTrace = getIdentityLoadTrace();
  if (firstRun) {
    log('First run — identity layer bootstrapped (SOUL.md, AGENTS.md, USER.md, MEMORY.md)');
  }
  log(`Kairos identity re-anchored: ${identityTrace.map((file) => `${file.path}(${file.chars} chars)`).join(' -> ')}`);

  // Load dynamic skills from .agent/skills/
  const skills = loadSkills();
  if (skills.length > 0) {
    log(`Loaded ${skills.length} custom skill(s): ${skills.map(s => s.name).join(', ')}`);
  }

  // Palace session — declared here to avoid TDZ when assigned below
  let _palaceSession = null;

  // Initialize Memory Palace if enabled (AGENT_USE_PALACE=1)
  if (config.palaceEnabled) {
    const { initPalace, closePalace } = await import('./palace/session.js');
    _palaceSession = await initPalace({ noMigrate: resume });
    // Phase 1.6: 'exit' handlers run with no async-context store, so they
    // resolve to the AMBIENT context — which closes the wrong handle (or none)
    // for a mission running in its own context. In daemon mode the context's
    // disposer owns teardown instead; the palace slot already registers one.
    if (!runtimeCtx.daemonMode) process.on('exit', closePalace);
    log('Memory palace initialized (episodic store + room graph)');
  }

  // Connect MCP servers if enabled (AGENT_MCP_ENABLED=1)
  if (config.mcpEnabled) {
    const { connectAll, disconnectAll } = await import('./mcp/connectionManager.js');
    const { refreshRegistry } = await import('./mcp/registry.js');
    await connectAll(getWorkspace());
    const toolCount = await refreshRegistry(getWorkspace());
    log(`MCP: ${toolCount} tool(s) loaded from connected servers`);
    // Ensure clean shutdown. Do NOT register a SIGINT handler that calls
    // process.exit(0): it would run before handleShutdownSignal (below) and
    // hard-exit mid-step, losing unsaved state. The graceful path returns
    // 'interrupted' after checkpointing, the process then exits normally, and
    // this 'exit' listener disconnects MCP servers.
    // In daemon mode the context disposer owns this instead — see the palace
    // note above; a per-mission 'exit' listener would also leak one listener
    // per mission for the life of the daemon.
    if (runtimeCtx.daemonMode) {
      runtimeCtx.slot('mcp:connections', () => ({}), { dispose: () => disconnectAll() });
    } else {
      process.on('exit', disconnectAll);
    }
  }

  // Snapshot workspace state so the sandbox verifier can diff what actually changed
  const workspaceSnapshot = resume
    ? loadWorkspaceSnapshot()   // restore from .agent/workspace-snapshot.json
    : snapshotWorkspace(getWorkspace());

  if (!resume) {
    saveWorkspaceSnapshot(workspaceSnapshot);
  }

  // Record pre-existing test/smoke files — the agent must NOT overwrite these.
  // They are the authoritative ground-truth tests provided by the task author.
  const protectedFiles = new Set(
    Object.keys(workspaceSnapshot).filter(f =>
      /(_smoke_test\.|_test\.|\btest_|\bspec_|\.test\.|\.spec\.)/.test(f) &&
      !f.startsWith('.agent/')
    )
  );
  if (protectedFiles.size > 0) {
    log(`Protected test files (agent may not overwrite): ${[...protectedFiles].join(', ')}`);
  }

  // Loop state variables
  let step, totalCharsUsed, consecutiveErrors, lastErrorTool;
  let lastErrorMessage;
  let lastCompactionStep, compactionCount, memoriesFlushed, skillsCreated;
  let memory, postCompaction, runtimeGuidance, parseErrorStreak, verificationFailures;
  let stepLatencies = [];
  let stageLatencies = {};   // stage → { totalMs, steps } for per-stage observability
  let stageState, stageMisalignedStreak = 0;
  let currentController = { mode: 'hosted-llm', confidence: 0, fallbackReason: 'not_started', usedFallback: true };
  // Session-level write counter: tracks how many times each file has been written
  // this session, surviving across compaction boundaries. Used for write-thrash detection.
  let fileWriteCounters = {};
  // Fix A: last failed run_command output — persists across non-error tool successes
  // so write-thrash guard always has a traceback to parse even after a successful think/read.
  let lastFailedCommandOutput = '';
  // Fix B: thrash-path hard block — prevents agent from writing the thrash file for N steps
  // after a write-thrash redirect fires, enforcing the redirect rather than just suggesting it.
  let thrashBlock = { path: '', stepsRemaining: 0 };
  // Routing state: pendingFreeze holds the tool chosen last step so next step
  // exposes only that tool + finish (single-step freeze mechanism).
  let pendingFreeze = null;
  // ── Phase 2: resolve this mission's profile ────────────────
  // Precedence: explicit opts.profile > AGENT_MISSION_PROFILE > task-text
  // heuristic. The heuristic is a default, never an override.
  const _profileChoice = selectProfile(task || readTask(), {
    explicit: profile || config.missionProfile || '',
  });
  const missionProfileName = _profileChoice.name;
  const missionProfile = getProfile(missionProfileName);
  // A profile with no stages (converse) disables the stage machine outright —
  // there is nothing to gate, and forcing intake→finalization on a conversation
  // is what made the loop unusable for anything but building software.
  const stagesEnabled = config.enableStages && missionProfile.stages.length > 0;
  log(`Mission profile: ${missionProfileName} (${_profileChoice.reason})${stagesEnabled ? '' : ' — stage machine disabled'}`);

  const stageBudgetMaxSteps = effectiveMaxSteps > 0 ? effectiveMaxSteps : 500;
  const hardMaxSteps = effectiveMaxSteps > 0 ? effectiveMaxSteps : Number.POSITIVE_INFINITY;
  const episodeId = `ep-${Date.now()}`;
  costStart(episodeId);
  startTrace(episodeId);
  initTelemetry(workspace || process.cwd(), episodeId);
  telTrack('session.start', { task: task?.slice(0, 200), resume });
  hitlEmit({ type: 'session_start', episodeId, task: task?.slice(0, 200), model: modelOverride || config.model, step: 0, status: 'running', resume });

  if (resume) {
    const cp = loadCheckpoint();
    restoreFilesTracking();
    step = cp.step || 0;
    totalCharsUsed = cp.totalCharsUsed || 0;
    consecutiveErrors = 0;  // reset on resume: crash-point streak doesn't carry over
    lastErrorTool = cp.lastErrorTool || '';
    lastErrorMessage = cp.lastErrorMessage || '';
    lastCompactionStep = cp.lastCompactionStep || 0;
    compactionCount = cp.compactionCount || 0;
    memoriesFlushed = cp.memoriesFlushed || 0;
    skillsCreated = cp.skillsCreated || 0;
    fileWriteCounters = cp.fileWriteCounters || {};
    lastFailedCommandOutput = cp.lastFailedCommandOutput || '';
    thrashBlock = cp.thrashBlock || { path: '', stepsRemaining: 0 };
    memory = WorkingMemory.fromJSON(cp.workingMemory || []);
    postCompaction = false;
    runtimeGuidance = cp.runtimeGuidance || '';
    parseErrorStreak = 0;  // reset on resume: fresh start, don't re-exit immediately
    stageMisalignedStreak = cp.stageMisalignedStreak || 0;
    verificationFailures = cp.verificationFailures || 0;
    // On resume the checkpoint's own profile wins — a mission must not change
    // lifecycle mid-flight because the heuristic scored the text differently.
    stageState = cp.stageState || createInitialStageState(readTask(), stageBudgetMaxSteps, null, missionProfileName);
    ensureStageArtifacts(stageState, getWorkspace(), readTask());
    currentController = {
      mode: 'hosted-llm',
      confidence: 0,
      fallbackReason: cp.rwkv?.fallbackReason || 'resume',
      usedFallback: true,
    };
    if (cp.lastErrorContext && !runtimeGuidance) {
      runtimeGuidance = `Resumed from error state: ${cp.lastErrorContext.type} (streak: ${cp.lastErrorContext.streak}). ${cp.lastErrorContext.lastErrorMessage || ''}`.trim();
    }

    // Annotate unknown-tool error entries so resumed session is not confused about
    // which tools exist.  These are entries where the model called a non-existent
    // tool name (e.g. list_directory, ask_user) — keep them in context so the model
    // sees what happened, but prefix with a correction note.
    const INTERNAL_ACTIONS = new Set(['parse_error', 'llm_error', 'verification_failed', 'loop_guard']);
    for (const entry of memory.entries) {
      if (entry.error && !INTERNAL_ACTIONS.has(entry.action) && getToolCategory(entry.action) === null) {
        entry.result = `[RESUME NOTE: "${entry.action}" is not a registered tool — use the exact names in the Tool Name Quick Reference above.] ${entry.result}`;
      }
    }
    log(`Resuming from step ${step} (${compactionCount} compactions, ${memoriesFlushed} memories flushed)`);

    // Save a memory about the resume event
    saveMemory(
      `Session resumed from step ${step}. Compaction count: ${compactionCount}.`,
      'experience',
      ['session', 'resume']
    );
  } else {
    step = 0;
    totalCharsUsed = 0;
    consecutiveErrors = 0;
    lastErrorTool = '';
    lastErrorMessage = '';
    lastCompactionStep = 0;
    compactionCount = 0;
    memoriesFlushed = 0;
    skillsCreated = 0;
    fileWriteCounters = {};
    lastFailedCommandOutput = '';
    thrashBlock = { path: '', stepsRemaining: 0 };
    memory = new WorkingMemory();
    postCompaction = false;
    runtimeGuidance = '';
    parseErrorStreak = 0;
    verificationFailures = 0;
    stageState = createInitialStageState(task, stageBudgetMaxSteps, null, missionProfileName);
    currentController = {
      mode: 'hosted-llm',
      confidence: 0,
      fallbackReason: 'fresh_start',
      usedFallback: true,
    };
    writeTask(task);
    seedLmmaBanksFromContext(task, readLongTermMemory());
    ensureStageArtifacts(stageState, getWorkspace(), task, { reset: true });
    appendProgress(`# Task: ${task}\nStarted: ${new Date().toISOString()}\n`);
    log(`Starting new task: ${task.slice(0, 100)}...`);

    // Save initial memory
    saveMemory(`New task started: ${task.slice(0, 200)}`, 'experience', ['task', 'start']);
  }

  // ── Graceful Shutdown ──────────────────────────────────────
  // Phase 1.6: in daemon mode the HOST owns process lifecycle. A mission must
  // not install process-level signal handlers, because (a) N concurrent
  // missions would each register a listener and trip Node's max-listeners
  // warning, and (b) a second Ctrl-C would let one mission call process.exit(1)
  // and kill the daemon plus every sibling mission with it. The daemon stops a
  // mission cooperatively via requestShutdown() instead.
  let shuttingDown = false;
  const handleShutdownSignal = (signal) => {
    if (shuttingDown) {
      log(`Second ${signal} received — force exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    log(`${signal} received — will save checkpoint and exit after current step.`);
  };
  const ownsProcessSignals = !runtimeCtx.daemonMode;
  if (ownsProcessSignals) {
    process.on('SIGTERM', handleShutdownSignal);
    process.on('SIGINT', handleShutdownSignal);
  } else {
    // Cooperative stop: the host flips this and the loop exits after the
    // current step with a normal 'interrupted' result and a saved checkpoint —
    // the same path a SIGINT takes, minus the process-level coupling.
    runtimeCtx.requestShutdown = () => {
      shuttingDown = true;
      log('Shutdown requested by host — will save checkpoint and exit after current step.');
    };
  }

  // ── Main Loop ──────────────────────────────────────────────
  try {
  while (step < hardMaxSteps) {
    step++;
    const _stepStartMs = Date.now();
    // Set by forced-think recovery branches: their runtimeGuidance is assigned
    // AFTER this step's prompt was built, so it is meant for the NEXT step. The
    // injected `think` action succeeds, so without this flag the success-path
    // wipe below would erase the recovery guidance before the model ever sees it.
    let guidanceInjectedThisStep = false;

    // Graceful shutdown check
    if (shuttingDown) {
      log(`Graceful shutdown at step ${step}.`);
      saveMemory(`Session interrupted at step ${step}`, 'experience', ['session', 'interrupted']);
      saveState();
      return result('interrupted', `Interrupted by signal at step ${step}`);
    }

    // ── Steering + clarification injection (always active) ───────────────────
    const steeringMessages = consumeSteering();
    if (steeringMessages.length > 0) {
      const injection = steeringMessages.map(m => `[HUMAN STEERING]: ${m}`).join('\n');
      log(`Step ${step}: injecting ${steeringMessages.length} steering message(s)`);
      runtimeGuidance = injection + (runtimeGuidance ? '\n' + runtimeGuidance : '');
    }

    const clarAnswers = consumeAnswers();
    if (clarAnswers.length > 0) {
      const injection = clarAnswers.map(a => `[HUMAN ANSWER to "${a.question}"]: ${a.answer}`).join('\n');
      log(`Step ${step}: injecting ${clarAnswers.length} clarification answer(s)`);
      runtimeGuidance = injection + (runtimeGuidance ? '\n' + runtimeGuidance : '');
    }

    // ── HITL: Block-on-pause (only when hitlEnabled) ──────────────────────────
    if (config.hitlEnabled) {
      while (isPaused() && !shuttingDown) {
        if (config.pauseDeadlineMs > 0 && pauseAgeMs() > config.pauseDeadlineMs) {
          log(`Step ${step}: pause deadline exceeded (${config.pauseDeadlineMs}ms) — auto-resuming`);
          hitlResume();
          break;
        }
        log(`Step ${step}: paused — waiting for resume...`);
        await new Promise(r => setTimeout(r, 2000));
      }
      if (shuttingDown) {
        saveState();
        return result('interrupted', `Interrupted while paused at step ${step}`);
      }
    }

    // Budget check
    if (config.maxTotalChars > 0 && totalCharsUsed > config.maxTotalChars) {
      log(`Budget exceeded (${totalCharsUsed} chars). Stopping.`);
      saveMemory(`Session ended: budget exceeded at step ${step}`, 'experience', ['session', 'end']);
      saveState();
      return result('budget_exceeded', `Exceeded character budget at step ${step}`);
    }

    // ── 1. Compaction Check ──────────────────────────────────
    const needsCompaction = memory.needsCompaction() ||
      shouldCompactByInterval(step, lastCompactionStep, config.compactionIntervalSteps);

    if (needsCompaction && memory.getOld().length > 0) {
      log(`Compacting memory (step ${step}, ${memory.getOld().length} old entries)...`);
      try {
        const oldEntries = memory.getOld();
        const formatted = memory.formatForCompaction(oldEntries);
        const fromStep = oldEntries[0].step;
        const toStep = oldEntries[oldEntries.length - 1].step;

        // Call compactMemory with raw entries for pre-compaction flush + compression
        const compactionAnchor = buildCompactionAnchor(stageState, memory);
        const { usage, flushedCount, mode } = await compactMemory(formatted, fromStep, toStep, oldEntries, compactionAnchor);
        totalCharsUsed += (usage.prompt_tokens || 0) * 4 + (usage.completion_tokens || 0) * 4;
        memory.trimToWindow();
        lastCompactionStep = step;
        compactionCount++;
        memoriesFlushed += flushedCount;
        hitlEmit({ type: 'compaction', step, count: compactionCount });
        postCompaction = true; // Flag for next context build
        fileWriteCounters = {}; // Reset per compaction window — prevents pre-compaction writes blocking post-compaction work

        log(`Compacted steps ${fromStep}-${toStep} | mode=${mode} | flushed ${flushedCount} memories | compaction #${compactionCount}`);
      } catch (err) {
        log(`Compaction failed: ${err.message} (continuing without compaction)`);
        lastCompactionStep = step; // cooldown: prevent retry-thrashing every step
      }
    }

    // ── 2. Heartbeat Memory Check ────────────────────────────
    const currentTask = getCurrentSubtask();
    heartbeatMemoryCheck(step, currentTask?.task);

    let stageGuidance = '';
    if (stagesEnabled) {
      const advanced = tickAndAdvanceStage(stageState, step, getWorkspace(), readPlan());
      stageState = advanced.stageState;
      ensureStageArtifacts(stageState, getWorkspace(), readTask());
      if (advanced.changed) {
        appendProgress(`\n## Stage Transition\n${advanced.reason}\n`);
      }
      stageGuidance = getStageGuidance(stageState.currentStage, step, stageState.stageStep, stageState.profile);

      const remainingSteps = effectiveMaxSteps > 0 ? Math.max(0, effectiveMaxSteps - step) : Number.POSITIVE_INFINITY;
      const runtime = inspectStageState(stageState, getWorkspace());
      if (effectiveMaxSteps > 0 && remainingSteps <= Math.max(15, Math.floor(effectiveMaxSteps * 0.08)) && runtime.finalizationReady && stageState.currentStage !== 'finalization') {
        stageState = {
          ...stageState,
          currentStage: 'finalization',
          stageStartedAt: new Date().toISOString(),
          stageCompletedAt: new Date().toISOString(),
          stageStep: 1,
          stageBlockedReason: runtime.stageBlockedReason,
          finishAllowed: runtime.finishAllowed,
          finalizationReady: runtime.finalizationReady,
          nextRequiredActionHint: runtime.nextRequiredActionHint,
          missingDeliverables: [...runtime.missingWorkspaceArtifacts, ...runtime.missingOutputs],
          missingCommandEvidence: runtime.missingCommandEvidence,
          recentRecoveryRule: 'late_step_finalization_rescue',
          lastStageTransitionReason: `late_step_rescue:${advanced.stageState?.currentStage || 'verification'}->finalization`,
        };
        trackRecoveryEvent(
          'late_step_finalization_rescue',
          `remaining_steps=${remainingSteps}`,
          'Advance directly to finalization and prioritize artifact repair/finish.',
          { stage: stageState.currentStage, step }
        );
        appendProgress(`\n## Stage Transition\nlate_step_rescue:${advanced.stageState?.currentStage || 'verification'}->finalization\n`);
        stageGuidance = getStageGuidance(stageState.currentStage, step, stageState.stageStep, stageState.profile);
      }
    }

    // ── 2.5 Repair-mode escape hatch ─────────────────────────
    // Track how long the agent has been stuck in local verification-repair
    // mode. After repairStallEscalateSteps unproductive steps, inject a
    // stronger last-chance instruction; after repairStallExitSteps, exit
    // cleanly so a cascading repair can never hang the loop forever.
    if (stagesEnabled && stageState) {
      if (stageState.repairModeActive) {
        stageState.repairModeSteps = (stageState.repairModeSteps || 0) + 1;
        if (stageState.repairModeSteps >= config.repairStallExitSteps) {
          const cmd = stageState.lastFailedRequiredCommand || 'the required command';
          const msg = `Repair stalled: ${stageState.repairModeSteps} steps in local repair mode without \`${cmd}\` passing.`;
          log(`Step ${step}: ${msg} — exiting.`);
          saveMemory(`Session ended: ${msg}`, 'experience', ['session', 'repair_stalled']);
          trackRecoveryEvent('repair_stalled', msg, 'Exit loop; report unresolved verification failure honestly.', { stage: stageState.currentStage, step });
          saveState();
          return result('repair_stalled', msg);
        }
        if (stageState.repairModeSteps >= config.repairStallEscalateSteps && !stageState.repairEscalated) {
          stageState.repairEscalated = true;
          const escalation = buildRepairStallEscalation(stageState);
          runtimeGuidance = runtimeGuidance ? `${escalation}\n${runtimeGuidance}` : escalation;
          trackRecoveryEvent('repair_stall_escalation', `steps=${stageState.repairModeSteps}`, escalation, { stage: stageState.currentStage, step });
          log(`Step ${step}: [REPAIR-ESCALATION] ${stageState.repairModeSteps} steps in repair mode`);
        }
      } else {
        stageState.repairModeSteps = 0;
        stageState.repairEscalated = false;
      }
    }

    // ── 3. Route tools + Build Context ───────────────────────
    // Apply freeze from previous step, then route to a category.
    const frozenTool = pendingFreeze;
    pendingFreeze = null;

    const lastEntry   = memory.getRecent(1)[0] ?? null;
    const taskText    = readTask();
    const category    = frozenTool
      ? null                                              // freeze: skip routing
      : route(taskText, lastEntry ? { action: lastEntry.action, error: lastEntry.error } : null, step - 1);
    let routedTools = getExposedTools(frozenTool ? 'planning' : category, frozenTool);
    if (stagesEnabled) {
      const filtered = filterToolsByStage(routedTools, stageState.currentStage, stageState.profile);
      if (filtered.length > 0) routedTools = filtered;
      const repairFiltered = applyVerificationRepairToolFilter(routedTools, stageState);
      if (repairFiltered.length > 0) routedTools = repairFiltered;
    }

    const effectiveGuidance = [stageGuidance, runtimeGuidance].filter(Boolean).join('\n');
    const lmmaTask = currentTask?.task || taskText;
    const rwkvState = loadRwkvControllerState();
    currentController = {
      mode: rwkvState.meta.controllerAvailable ? 'rwkv' : 'hosted-llm',
      confidence: Number(rwkvState.meta.lastConfidence || 0),
      fallbackReason: rwkvState.meta.lastControllerReason || 'pre_step',
      usedFallback: !rwkvState.meta.controllerAvailable,
    };
    prepareLmmaStep({
      step,
      stage: stageState?.currentStage || '',
      task: taskText,
      currentSubtask: lmmaTask,
      memory,
      controller: currentController,
    });

    const buildArgs = {
      step,
      memory,
      consecutiveErrors,
      lastErrorTool,
      postCompaction,
      preCompactionFlush: false,
      runtimeGuidance: effectiveGuidance,
      routedTools,
      stageGuidance,
      stageState,
      workspace: getWorkspace(),
      lastCompactionStep,
      compactionCount,
    };
    let messages = buildMessages(buildArgs);
    let contextChars = countMessageChars(messages);

    // ── Context-size hard guard ──────────────────────────────
    // Never silently overflow the model window. If the assembled prompt
    // exceeds contextHardLimitRatio of the window (chars ≈ tokens×4),
    // progressively shrink the *displayed* working-memory window and rebuild.
    // This is lossless: old entries remain in memory for normal compaction.
    const hardCharLimit = Math.floor(config.contextWindow * config.charsPerToken * (config.contextHardLimitRatio || 0.9));
    if (hardCharLimit > 0 && contextChars > hardCharLimit) {
      let windowOverride = config.workingMemoryWindow;
      while (contextChars > hardCharLimit && windowOverride > 2) {
        windowOverride = Math.max(2, Math.floor(windowOverride / 2));
        messages = buildMessages({ ...buildArgs, memoryWindow: windowOverride });
        contextChars = countMessageChars(messages);
      }
      log(`Step ${step}: [CONTEXT-GUARD] prompt exceeded ${hardCharLimit} chars — trimmed working window to ${windowOverride}, now ${contextChars} chars`);
      trackRecoveryEvent('context_overflow_guard', `chars>${hardCharLimit}`, `Trimmed working-memory window to ${windowOverride} for this step.`, { stage: stageState?.currentStage || '', step });
    }

    // Clear post-compaction flag immediately after building messages (consumed)
    postCompaction = false;

    log(`Step ${step}: context=${contextChars} chars, memory=${memory.entries.length} entries, compactions=${compactionCount}`);

    // ── 4. LLM Decision + Parse ──────────────────────────────
    // Forced-tool injection: when the model has produced malformed JSON 2+ times
    // consecutively, skip the LLM call entirely and inject a synthetic `think`
    // action. This breaks the 10-20 step stall caused by models drifting into
    // prose/reasoning text that can't be parsed. The think result appears in
    // working memory, the think-guard fires next step forcing a concrete action,
    // and runtimeGuidance primes the model to emit clean JSON.
    //
    // Threshold is 2 (not 3): with maxConsecutiveErrors=3 the parse-error exit
    // below fires on the 3rd consecutive parse error, so a threshold of 3 could
    // never be reached — recovery must fire at 2 to actually break the stall.
    let action;
    let llmResponse;
    forceInject: {
      if (parseErrorStreak >= 2) {
        const injectedThought = `I have produced malformed JSON ${parseErrorStreak} times consecutively. I must stop generating prose. My next response must be exactly one JSON object: {"thought":"brief reason","tool":"tool_name","args":{}}. Nothing before or after the JSON.`;
        action = { thought: injectedThought, tool: 'think', args: { thought: injectedThought } };
        log(`Step ${step}: [FORCED-THINK] injecting recovery action (parseErrorStreak was ${parseErrorStreak})`);
        appendProgress(`\n## Step ${step} — FORCED-THINK (parse error streak=${parseErrorStreak})\n${injectedThought}\n`);
        // Give partial credit — reduce but don't zero consecutiveErrors so threshold still guards
        consecutiveErrors = Math.max(0, consecutiveErrors - 1);
        parseErrorStreak = 0;
        runtimeGuidance = 'PARSE RECOVERY: Your last outputs were malformed and were auto-recovered. Your NEXT response MUST be a single valid JSON object — no text before or after it. Use the exact format: {"thought":"...","tool":"...","args":{...}}';
        guidanceInjectedThisStep = true;
        trackRecoveryEvent(
          'forced_think_injection',
          'parse_error_burst',
          'Auto-injected think action to break parse error loop. Next step must emit clean JSON.',
          { stage: stageState?.currentStage || '', step }
        );
        break forceInject;
      }

      // Session write-thrash guard: fires when the same file has been rewritten many
      // times across compaction boundaries (memory-based churn detection misses this).
      // Evaluated BEFORE the repeat-guard so it isn't short-circuited by the lower-threshold
      // repeat-guard firing first via break forceInject.
      // Threshold 5 means the agent has tried and failed 5 full rewrites — time to stop.
      if (Object.keys(fileWriteCounters).length > 0) {
        const [thrashPath, thrashCount] = Object.entries(fileWriteCounters)
          .reduce((a, b) => b[1] > a[1] ? b : a, ['', 0]);
        if (thrashCount >= 5) {
          const isTestFile = /(_smoke_test|_test\.|test_)/.test(thrashPath);
          const caller = !isTestFile ? extractCallerFromTraceback(lastFailedCommandOutput || lastErrorMessage, thrashPath) : null;
          const callerHint = caller
            ? ` The error is caused by \`${caller.file}\` line ${caller.line} calling a method/attribute that does not exist in \`${thrashPath}\`. I must fix the CALLER (\`${caller.file}\`) — not add the missing thing to \`${thrashPath}\`.`
            : '';
          const injectedThought = isTestFile
            ? `I have rewritten \`${thrashPath}\` ${thrashCount} times this session. Rewriting the test file is not fixing the problem. The bug is in my SOURCE CODE. I must run the test with run_command to see the actual error traceback, then fix the SOURCE module that is failing — NOT rewrite the test.`
            : `I have rewritten \`${thrashPath}\` ${thrashCount} times this session without resolving the issue.${callerHint} I must stop touching \`${thrashPath}\` and instead fix the file that is CALLING the broken method.`;
          action = { thought: injectedThought, tool: 'think', args: { thought: injectedThought } };
          log(`Step ${step}: [FORCED-THINK] session write-thrash on ${thrashPath} (${thrashCount} writes)${caller ? ` — caller: ${caller.file}:${caller.line}` : ''}`);
          appendProgress(`\n## Step ${step} — FORCED-THINK (session write-thrash ×${thrashCount} on ${thrashPath})\n${injectedThought}\n`);
          runtimeGuidance = isTestFile
            ? `STALL RECOVERY: You have rewritten \`${thrashPath}\` ${thrashCount} times this session. STOP rewriting the test. Run it with run_command, read the error output carefully, find which SOURCE module is broken, fix that file, then rerun the test.`
            : caller
              ? `STALL RECOVERY: You have rewritten \`${thrashPath}\` ${thrashCount} times without fixing the issue. The root cause is in \`${caller.file}\` line ${caller.line} — that file calls a method that does not exist in \`${thrashPath}\`. Read \`${caller.file}\` and fix the CALLER. Do NOT touch \`${thrashPath}\` again.`
              : `STALL RECOVERY: You have rewritten \`${thrashPath}\` ${thrashCount} times without fixing the issue. Run a validation command NOW to see the current error traceback. Find which file is calling the broken method, then fix THAT file — not \`${thrashPath}\`.`;
          guidanceInjectedThisStep = true;
          // Halve the counter so this fires again if thrashing resumes, but doesn't trigger every step
          fileWriteCounters[thrashPath] = Math.floor(thrashCount / 2);
          // Fix B: hard-block the thrash file for 3 steps if a caller was identified
          if (caller) thrashBlock = { path: thrashPath, stepsRemaining: 3 };
          trackRecoveryEvent(
            'session_write_thrash',
            `${thrashPath} written ${thrashCount} times`,
            injectedThought,
            { stage: stageState?.currentStage || '', step, target: thrashPath }
          );
          break forceInject;
        }
      }

      // Repeat-guard stall breaker: when the same action has been blocked 4+ consecutive
      // times (read/edit on the same file), the model is ignoring guidance. Force a
      // write_file rewrite instead of letting it try the same read_file again.
      // Placed AFTER write-thrash guard so the stronger session-level signal fires first.
      if (consecutiveErrors >= 4 && lastErrorTool) {
        const recentBlocked = memory.getRecent(6)
          .filter(e => e.error && (String(e.result || '').includes('RETRY_BLOCKED') || String(e.result || '').includes('EDIT_CHURN')));
        if (recentBlocked.length >= 3) {
          const targetFile = recentBlocked.map(e => e.args?.path).filter(Boolean)[0] || '';
          const isTestFile = targetFile.includes('_smoke_test') || targetFile.includes('_test') || targetFile.includes('test_');
          const injectedThought = isTestFile
            ? `I have been blocked ${recentBlocked.length} times on \`${targetFile}\`. The test file is probably correct. The bug is in my SOURCE CODE. I must run the test with run_command to see the error traceback, then fix the SOURCE module that is failing — NOT rewrite the test file.`
            : `I have been blocked ${recentBlocked.length} times trying to read/edit \`${targetFile}\`. My edit_file calls keep failing because I cannot match the exact whitespace. I MUST use write_file to completely rewrite this file instead of trying edit_file again. If the file has a syntax error, I should write the entire corrected file content.`;
          action = { thought: injectedThought, tool: 'think', args: { thought: injectedThought } };
          log(`Step ${step}: [FORCED-THINK] breaking repeat-guard stall (${recentBlocked.length} blocks on ${targetFile})`);
          appendProgress(`\n## Step ${step} — FORCED-THINK (repeat guard stall on ${targetFile})\n${injectedThought}\n`);
          consecutiveErrors = Math.max(0, consecutiveErrors - 2);
          guidanceInjectedThisStep = true;
          runtimeGuidance = isTestFile
            ? `STALL RECOVERY: You are stuck on \`${targetFile}\`. Do NOT rewrite it. The bug is in your source code. Run the test to see the error, then fix the broken source module.`
            : `STALL RECOVERY: You have been stuck reading/editing \`${targetFile}\` for multiple steps. Your edit_file calls fail because the oldString does not match. You MUST use write_file to rewrite the entire file with corrected content. Do NOT use edit_file or read_file on this file again — write the complete fixed file now.`;
          trackRecoveryEvent(
            'forced_think_injection',
            'repeat_guard_stall',
            `Broke repeat-guard stall on ${targetFile}. Forcing write_file rewrite.`,
            { stage: stageState?.currentStage || '', step, target: targetFile }
          );
          break forceInject;
        }
      }

      // ── Normal path: call LLM ─────────────────────────────
      try {
        const controllerResult = await runControllerStep(messages, {
          step,
          stage: stageState?.currentStage || '',
          ...(modelOverride ? { model: modelOverride } : {}),
        });
        llmResponse = controllerResult.response;
        currentController = controllerResult.controller;
        totalCharsUsed += (llmResponse.usage.prompt_tokens || 0) * 4 + (llmResponse.usage.completion_tokens || 0) * 4;
        costRecord(llmResponse.usage, stageState?.currentStage || '');
        const _cost = sessionCost();
        hitlEmit({ type: 'cost_update', step, costUsd: _cost.estimatedDollars, totalTokens: _cost.totalTokens });
      } catch (err) {
        log(`LLM error: ${err.message}`);
        consecutiveErrors++;
        trackRecoveryEvent(
          'llm_error',
          err.message,
          'Retry the loop with preserved runtime state and avoid repeating the same failing prompt path.',
          { stage: stageState?.currentStage || '', step }
        );
        memory.push({
          step,
          action: 'llm_error',
          args: {},
          result: `LLM request failed: ${err.message}`,
          error: true,
          timestamp: Date.now(),
        });
        appendProgress(`\n## Step ${step} — LLM ERROR\n${err.message}\n`);
        lastErrorMessage = err.message;
        saveState();

        if (consecutiveErrors >= config.maxConsecutiveErrors) {
          saveMemory(`Session ended: LLM failed ${consecutiveErrors} times`, 'experience', ['session', 'error']);
          return result('error', `LLM failed ${consecutiveErrors} times in a row: ${err.message}`);
        }
        continue;
      }

      // ── Parse LLM response into a structured action ───────
      try {
        action = parseAction(llmResponse.content);
        parseErrorStreak = 0;
      } catch (err) {
        log(`Parse error: ${err.message}`);
        consecutiveErrors++;
        parseErrorStreak++;
        runtimeGuidance = buildParseRecoveryGuidance(llmResponse.content, err.message, parseErrorStreak);
        trackRecoveryEvent(
          'parse_error',
          err.message,
          'Return exactly one valid JSON tool call. Do not repeat prose or malformed protocol output.',
          { stage: stageState?.currentStage || '', step }
        );
        if (parseErrorStreak >= 3) {
          trackRecoveryEvent(
            'parse_error_burst',
            `streak=${parseErrorStreak}`,
            'Stop repeating malformed output. Use the runtime blocker and emit one exact JSON tool call.',
            { stage: stageState?.currentStage || '', step }
          );
        }

        // Push a minimal parse_error entry to working memory so:
        //   (a) memory.entries.length advances (visible in the step log)
        //   (b) the LLM sees its own failed output in Recent Actions and
        //       understands why the recovery guidance is being injected
        const rawSnippet = safeSlice(String(llmResponse.content || ''), 200).replace(/\s+/g, ' ').trim();
        memory.push({
          step,
          action: 'parse_error',
          args: {},
          result: `Parse failed (${err.message}). Raw snippet: ${rawSnippet}`,
          error: true,
          timestamp: Date.now(),
        });

        appendProgress(`\n## Step ${step} — PARSE ERROR\n${err.message}\nRaw: ${llmResponse.content.slice(0, 300)}\n`);
        saveState();

        if (consecutiveErrors >= config.maxConsecutiveErrors) {
          saveMemory(`Session ended: parse failed ${consecutiveErrors} times in a row`, 'experience', ['session', 'error']);
          return result('error', `Parse failed ${consecutiveErrors} consecutive times. Last error: ${err.message}`);
        }
        continue;
      }
    } // end forceInject

    log(`Step ${step}: [${action.tool}] ${action.thought?.slice(0, 80) || ''}`);
    let _focus = [];
    try { _focus = getFocusChain(); } catch { /* plan parse must never break the loop */ }
    hitlEmit({ type: 'step', step, tool: action.tool, thought: (action.thought || '').slice(0, 120), stage: stageState?.currentStage || '', model: modelOverride || config.model, focus: _focus });

    const blockedRetry = buildRepeatedActionBlock(memory, action, stageState);
    if (blockedRetry) {
      appendProgress(`\n## Step ${step} — ${action.tool}\n**Thought:** ${action.thought || 'none'}\n**Args:** ${JSON.stringify(action.args)}\n`);
      appendProgress(`**Result:** ❌ ${blockedRetry}\n`);
      memory.push({
        step,
        action: action.tool,
        args: action.args,
        result: blockedRetry,
        error: true,
        timestamp: Date.now(),
      });
      consecutiveErrors++;
      lastErrorTool = action.tool;
      runtimeGuidance = blockedRetry;
      trackRecoveryEvent(
        'repeat_guard',
        `${action.tool}:${JSON.stringify(action.args || {})}`,
        blockedRetry,
        { stage: stageState?.currentStage || '', step, target: action.args?.path || action.args?.command || '' }
      );
      if (blockedRetry.includes('stage-misaligned action')) {
        stageMisalignedStreak = (stageMisalignedStreak || 0) + 1;
        trackRecoveryEvent(
          'stage_misaligned_action',
          `${stageState?.currentStage || 'unknown'}:${action.tool}`,
          blockedRetry,
          { stage: stageState?.currentStage || '', step, target: action.args?.path || action.args?.command || '' }
        );
        // Safety valve: if blocked 4+ consecutive times, force stage back to execution
        // so the agent can continue its work instead of being stuck.
        if (stageMisalignedStreak >= 4 && stageState.currentStage !== 'execution') {
          const streakCount = stageMisalignedStreak;
          log(`Step ${step}: [STAGE-RESET] forcing stage back to execution after ${streakCount} consecutive stage-misaligned blocks`);
          stageState.currentStage = 'execution';
          stageState.stageStep = 1;
          stageState.stageStartedAt = new Date().toISOString();
          stageMisalignedStreak = 0;
          runtimeGuidance = 'STAGE RESET: The stage system was blocking your actions. Stage has been reset to execution. Continue building the required files.';
          appendProgress(`\n## Stage Reset (forced)\nReset to execution after ${streakCount} consecutive stage-misaligned blocks.\n`);
        }
      } else {
        stageMisalignedStreak = 0;
      }
      saveState();
      continue;
    }

    const prematureArtifactWrite = buildPrematureSuccessArtifactBlock(action, stageState, getWorkspace());
    if (prematureArtifactWrite) {
      appendProgress(`\n## Step ${step} — ${action.tool}\n**Thought:** ${action.thought || 'none'}\n**Args:** ${JSON.stringify(action.args)}\n`);
      appendProgress(`**Result:** ❌ ${prematureArtifactWrite}\n`);
      memory.push({
        step,
        action: action.tool,
        args: action.args,
        result: prematureArtifactWrite,
        error: true,
        timestamp: Date.now(),
      });
      consecutiveErrors++;
      lastErrorTool = action.tool;
      lastErrorMessage = prematureArtifactWrite;
      runtimeGuidance = prematureArtifactWrite;
      trackRecoveryEvent(
        'premature_success_artifact_block',
        `${action.tool}:${action.args?.path || ''}`,
        prematureArtifactWrite,
        { stage: stageState?.currentStage || '', step, target: action.args?.path || '' }
      );
      saveState();
      continue;
    }

    // ── 5b. Thrash-block guard (Fix B) ──────────────────────
    // After a write-thrash redirect fires pointing to a caller file, the thrash
    // file is hard-blocked for N steps so the agent cannot immediately undo the
    // redirect by writing it again.
    if (thrashBlock.stepsRemaining > 0) {
      thrashBlock.stepsRemaining--;
      if (['write_file', 'edit_file'].includes(action.tool)) {
        const targetPath = String(action.args?.path || '');
        if (targetPath === thrashBlock.path) {
          const blockMsg = `RETRY_BLOCKED: \`${targetPath}\` is temporarily blocked for ${thrashBlock.stepsRemaining + 1} more step(s). You were redirected away from this file because the error originates in its CALLER. Fix the caller file instead — do NOT write \`${targetPath}\` until the block expires.`;
          log(`Step ${step}: [THRASH-BLOCK] blocked write to ${targetPath} (${thrashBlock.stepsRemaining + 1} steps remaining)`);
          appendProgress(`\n## Step ${step} — ${action.tool}\n**Result:** ❌ ${blockMsg}\n`);
          memory.push({ step, action: action.tool, args: action.args, result: blockMsg, error: true, timestamp: Date.now() });
          consecutiveErrors++;
          lastErrorTool = action.tool;
          runtimeGuidance = blockMsg;
          saveState();
          continue;
        }
      }
    }

    // ── 5c. Protected file guard ─────────────────────────────
    // Block write_file / edit_file on pre-existing test files. These were provided
    // by the task author as authoritative tests and must not be modified by the agent.
    if (['write_file', 'edit_file'].includes(action.tool) && protectedFiles.size > 0) {
      const targetPath = String(action.args?.path || '');
      const targetBase = targetPath.split('/').pop(); // basename only
      if (protectedFiles.has(targetPath) || protectedFiles.has(targetBase)) {
        const guardMsg = `PROTECTED: \`${targetPath}\` is an authoritative test file provided by the task author. You MUST NOT modify it. Fix your SOURCE CODE to make this test pass instead. Run \`node ${targetPath}\` to see the exact failure, then edit the source module.`;
        log(`Step ${step}: [PROTECTED-FILE] blocked write to ${targetPath}`);
        appendProgress(`\n## Step ${step} — ${action.tool}\n**Thought:** ${action.thought || 'none'}\n**Args:** ${JSON.stringify(action.args)}\n`);
        appendProgress(`**Result:** ❌ ${guardMsg}\n`);
        memory.push({ step, action: action.tool, args: action.args, result: guardMsg, error: true, timestamp: Date.now() });
        consecutiveErrors++;
        lastErrorTool = action.tool;
        runtimeGuidance = guardMsg;
        trackRecoveryEvent('protected_file_blocked', targetPath, guardMsg, { stage: stageState?.currentStage || '', step, target: targetPath });
        saveState();
        continue;
      }
    }

    // ── 5c. Missing artifact priority guard ──────────────────
    // Block writes to unrelated files while required deliverables are still missing.
    // Fail-safe: returns '' when no locked targets or all artifacts exist.
    const missingArtifactBlock = buildMissingArtifactPriorityBlock(action, stageState, getWorkspace());
    if (missingArtifactBlock) {
      log(`Step ${step}: [MISSING-ARTIFACT-PRIORITY] blocked ${action.tool} on ${action.args?.path || ''}`);
      appendProgress(`\n## Step ${step} — ${action.tool}\n**Thought:** ${action.thought || 'none'}\n**Args:** ${JSON.stringify(action.args)}\n`);
      appendProgress(`**Result:** ❌ ${missingArtifactBlock}\n`);
      memory.push({ step, action: action.tool, args: action.args, result: missingArtifactBlock, error: true, timestamp: Date.now() });
      consecutiveErrors++;
      lastErrorTool = action.tool;
      runtimeGuidance = missingArtifactBlock;
      trackRecoveryEvent('missing_artifact_priority_block', `${action.tool}:${action.args?.path || ''}`, missingArtifactBlock, { stage: stageState?.currentStage || '', step, target: action.args?.path || '' });
      saveState();
      continue;
    }

    // ── 6. Execute Tool ──────────────────────────────────────
    // Log action BEFORE execution (crash safety)
    appendProgress(`\n## Step ${step} — ${action.tool}\n**Thought:** ${action.thought || 'none'}\n**Args:** ${JSON.stringify(action.args)}\n`);

    // ── HITL: Gateway approval gate ───────────────────────────
    if (config.hitlEnabled) {
      const gatewayResult = await requestApproval(action.tool, action.args, action.thought || '');
      if (!gatewayResult.approved) {
        const denyMsg = `HITL: action blocked — ${gatewayResult.reason}`;
        appendProgress(`**Blocked:** ${denyMsg}\n`);
        log(`Step ${step}: HITL blocked ${action.tool} — ${gatewayResult.reason}`);
        memory.push({ step, action: action.tool, args: action.args, result: denyMsg, error: true, timestamp: Date.now() });
        consecutiveErrors++;
        lastErrorTool = action.tool;
        continue;
      }
    }

    setCommandTrackingContext({
      stage: stageState?.currentStage || '',
      step,
      retryCount: Math.max(0, consecutiveErrors),
    });
    const { result: toolResult, error: toolError } = await executeTool(action.tool, action.args);
    hitlEmit({ type: 'tool_result', step, tool: action.tool, result: toolResult.slice(0, 400), error: toolError });

    // Log result AFTER execution
    appendProgress(`**Result:** ${toolError ? '❌ ' : ''}${toolResult.slice(0, 500)}\n`);

    // Track skill creation (createSkill() already calls loadSkills() internally)
    if (action.tool === 'create_skill' && !toolError) {
      skillsCreated++;
    }

    // Track session-level write counts for write-thrash detection (survives compaction)
    if (action.tool === 'write_file' && !toolError) {
      const writePath = String(action.args?.path || '');
      if (writePath && !writePath.startsWith('.agent/')) {
        fileWriteCounters[writePath] = (fileWriteCounters[writePath] || 0) + 1;
      }
    }

    // Schedule tool freeze for next step (expose only this tool + finish).
    // Don't freeze on meta-tools or on errors — let the router re-route freely.
    // If this call repeats the previous user action with identical args, skip
    // freezing so the next step can re-route and escape the local loop.
    const repeatedSameCall = isSameAsLastUserAction(memory, action.tool, action.args);
    if (!toolError && !repeatedSameCall && !['finish', 'think', 'loop_guard', 'update_plan'].includes(action.tool)) {
      pendingFreeze = action.tool;
    } else {
      pendingFreeze = null;
    }

    // ── 8a. Episodic write (palace) ───────────────────────────
    if (config.palaceEnabled) {
      try {
        const { getPalaceSession } = await import('./palace/session.js');
        const palaceSess = getPalaceSession();
        if (palaceSess) {
          palaceSess.store.insert({
            verbatim:  `Step ${step}: ${action.tool} → ${toolResult.slice(0, 400)}`,
            domain:    stageState?.currentStage || action.tool,
            summary:   (action.thought || `${action.tool} ${JSON.stringify(action.args || {})}`).slice(0, 200),
            note:      toolError ? `ERROR: ${toolResult.slice(0, 200)}` : '',
            who:       'kairos',
            timestamp: Date.now() / 1000,
          });
          if (!toolError) {
            const { recordSuccess } = await import('./palace/proceduralIndex.js');
            recordSuccess({ tool: action.tool, args: action.args || {}, result: toolResult, domain: stageState?.currentStage || '' });
            const FILE_TOOLS = new Set(['write_file', 'edit_file', 'create_dir', 'move_path', 'copy_path']);
            if (FILE_TOOLS.has(action.tool) && action.args?.path) {
              const { assert: assertTriple } = await import('./palace/semanticGraph.js');
              assertTriple(action.args.path, 'modified_by', action.tool, 1.0);
            }
          }
        }
      } catch { /* non-critical — never block the loop */ }
    }

    // ── 8. Record in Memory ──────────────────────────────────
    memory.push({
      step,
      action: action.tool,
      args: action.args,
      result: toolResult,
      error: toolError,
      timestamp: Date.now(),
    });
    finalizeLmmaStep({
      step,
      stage: stageState?.currentStage || '',
      action,
      toolResult,
      toolError,
    });
    const activeRouteAfterTool = readLmmaActiveRoute();
    const hallucinationResult = detectHallucination({
      tool: action.tool,
      args: action.args,
      toolResult,
      toolError,
      actionDescription: action.thought || '',
      previousCommand: lastFailedCommandOutput ? (action.tool === 'run_command' ? String(action.args?.command || '') : '') : '',
      workspaceSnapshot,
    });
    emitTrainingTrace({
      episodeId,
      step,
      stage: stageState?.currentStage || '',
      subtask: getCurrentSubtask()?.task || '',
      inputSummary: `${action.tool} ${JSON.stringify(action.args || {})}`.slice(0, 240),
      lmmaRoute: activeRouteAfterTool?.routePath || [activeRouteAfterTool?.primaryBank].filter(Boolean),
      retrievedMemoryIds: (activeRouteAfterTool?.retrievalHits || []).map((item) => item.memory_id).filter(Boolean),
      controllerAction: { tool: action.tool, args: action.args, controller: currentController },
      toolOutcome: toolError ? 'error' : 'success',
      planDelta: action.tool === 'update_plan' ? 'plan_updated' : '',
      completion: action.tool === 'finish' && !toolError,
      hallucinationDetected: hallucinationResult.hallucination_detected,
      hallucinationReasons: hallucinationResult.reasons,
      latencyMs: llmResponse?.latencyMs || 0,
      recoveryAttemptLogged: !toolError || consecutiveErrors > 0,
      repetitiveErrorLoopDetected: consecutiveErrors >= 3,
    });

    // Track errors
    if (toolError) {
      consecutiveErrors++;
      lastErrorTool = action.tool;
      lastErrorMessage = String(toolResult || '').slice(0, 240);
      // Fix A: persist run_command failure output separately so write-thrash guard
      // always has a traceback even after the agent does a successful think/read_file.
      if (action.tool === 'run_command') {
        lastFailedCommandOutput = String(toolResult || '').slice(0, 600);
        // Fix C: cross-file mismatch detection — append caller/definition diagnosis to guidance
        const crossFileDiag = buildCrossFileDiagnostic(lastFailedCommandOutput, getWorkspace());
        if (crossFileDiag) {
          runtimeGuidance = (runtimeGuidance ? runtimeGuidance + ' ' : '') + crossFileDiag;
        }
      }
      if (action.tool === 'run_command' && stageState?.currentStage === 'verification') {
        const requiredFailure = getRequiredVerificationFailure(action, stageState, toolResult);
        if (requiredFailure) {
          stageState.lastFailedRequiredCommand = requiredFailure.command;
          stageState.relatedRepairTargets = requiredFailure.targets;
          stageState.expectedRepairScope = 'local_verification_repair';
          stageState.repairModeActive = true;
          stageState.narrativeRecoverySuppressed = true;
        }
      }
      // Phase 5.6: record failure for pattern learning
      try {
        const suggestion = recordFailure(action.tool, action.args, lastErrorMessage);
        if (suggestion) log(`Step ${step}: failure pattern detected (${suggestion.count}×) — ${suggestion.suggestion?.split('\n')[0] || ''}`);
      } catch { /* non-critical */ }

      const toolAdvice = buildToolFailureGuidance(action, toolResult, stageState);
      runtimeGuidance = toolAdvice
        ? `Previous tool call failed (${action.tool}). ${toolAdvice}`
        : `Previous tool call failed (${action.tool}). Inspect the exact error result and change arguments/tool choice before retrying.`;
      trackRecoveryEvent(
        'tool_error',
        `${action.tool}: ${lastErrorMessage}`,
        runtimeGuidance,
        { stage: stageState?.currentStage || '', step, target: action.args?.path || action.args?.command || '' }
      );
      if (action.tool === 'edit_file' && /EDIT_ERROR_STRING_NOT_FOUND/i.test(String(toolResult || ''))) {
        markFileRequiresReread(
          String(action.args?.path || ''),
          'Previous edit target no longer matched the current file. Re-read the exact current file contents before another edit.',
          { step }
        );
      }
    } else {
      consecutiveErrors = 0;
      lastErrorTool = '';
      lastErrorMessage = '';
      if (action.tool === 'run_command' && stageState?.repairModeActive) {
        const normalizedCommand = normalizeCommandForComparison(action.args?.command || '');
        const repairedTarget = normalizeCommandForComparison(stageState.lastFailedRequiredCommand || '');
        if (!repairedTarget || normalizedCommand === repairedTarget || normalizedCommand.includes(repairedTarget) || repairedTarget.includes(normalizedCommand)) {
          stageState.lastFailedRequiredCommand = '';
          stageState.relatedRepairTargets = [];
          stageState.expectedRepairScope = '';
          stageState.repairModeActive = false;
          stageState.narrativeRecoverySuppressed = false;
          stageState.repairModeSteps = 0;
          stageState.repairEscalated = false;
          // Re-arm command dedup: repair changed files, so any composite setup
          // command that was "recently successful" is now stale and must be
          // allowed to re-run as fresh post-repair evidence.
          clearCommandDedup();
        }
      }
      if (parseErrorStreak === 0 && !guidanceInjectedThisStep) {
        runtimeGuidance = '';
      }
    }

    const guardMessage = detectLoopGuard(memory, parseErrorStreak, stageState);
    if (guardMessage) {
      if (runtimeGuidance !== guardMessage) {
        appendProgress(`\n## Loop Guard\n${guardMessage}\n`);
        memory.push({
          step,
          subStep: 'loop_guard',
          action: 'loop_guard',
          args: {},
          result: guardMessage,
          error: false,
          timestamp: Date.now(),
        });
      }
      runtimeGuidance = guardMessage;
      trackRecoveryEvent(
        'loop_guard',
        guardMessage,
        'Switch to a different action and stop repeating the same stalled pattern.',
        { stage: stageState?.currentStage || '', step, target: action.args?.path || action.args?.command || '' }
      );

      // Hard stop: if same-tool-same-args stall persists for 4+ steps, terminate.
      // This gives one additional step for recovery after guidance injection.
      const identicalStreak = detectIdenticalStreak(memory);
      if (identicalStreak >= 4) {
        const lastAct = getLastUserAction(memory);
        saveMemory(`Session ended: stall on ${lastAct} × ${identicalStreak}`, 'experience', ['session', 'stall']);
        saveState();
        return result('error', `Stall: \`${lastAct}\` called ${identicalStreak} times with identical args. Stopping.`);
      }
    } else if (!toolError && parseErrorStreak === 0 && !guidanceInjectedThisStep) {
      runtimeGuidance = '';
    }

    // ── Tool Failure Rate Guard (FLAW 7) ─────────────────────
    // Alternating success/fail hides chronic failures from consecutiveErrors.
    // If ≥6 of the last 10 real actions errored, inject soft recovery guidance.
    if (!runtimeGuidance && step >= 10) {
      const recentWindow = memory.getRecent(10).filter(e => !['loop_guard', 'parse_error', 'llm_error'].includes(e.action));
      if (recentWindow.length >= 5) {
        const errorCount = recentWindow.filter(e => e.error).length;
        if (errorCount >= Math.ceil(recentWindow.length * 0.6)) {
          runtimeGuidance = `High tool failure rate: ${errorCount}/${recentWindow.length} recent actions failed. Re-read key files, verify paths and arguments, or try a completely different approach.`;
        }
      }
    }

    // ── 8. Check Finish ──────────────────────────────────────
    if (toolResult.startsWith('__FINISH__:')) {
      if (stagesEnabled && stageState.currentStage !== 'finalization') {
        runtimeGuidance = `Finish blocked: current stage is "${stageState.currentStage}". Advance to finalization stage first.`;
        trackRecoveryEvent(
          'finish_blocked',
          `stage=${stageState.currentStage}`,
          runtimeGuidance,
          { stage: stageState.currentStage, step }
        );
        memory.push({
          step,
          subStep: 'finish_blocked',
          action: 'verification_failed',
          args: {},
          result: runtimeGuidance,
          error: true,
          timestamp: Date.now(),
        });
        saveState();
        continue;
      }

      if (stagesEnabled) {
        const guard = completionGuard(stageState, getWorkspace());
        if (guard) {
          runtimeGuidance = buildCompletionGuardRecoveryGuidance(guard);
          trackRecoveryEvent(
            'completion_guard',
            guard,
            runtimeGuidance,
            { stage: stageState.currentStage, step }
          );
          memory.push({
            step,
            subStep: 'completion_guard',
            action: 'verification_failed',
            args: {},
            result: runtimeGuidance,
            error: true,
            timestamp: Date.now(),
          });
          saveState();
          continue;
        }
      }

      const summary = toolResult.replace('__FINISH__:', '');
      log(`Agent signaled finish: ${summary.slice(0, 100)}`);

      // ── Verification circuit breaker ──────────────────────────
      // The finish gates below exist to force repair, and repair has a bounded
      // number of useful attempts. verificationFailures had no ceiling, and it
      // showed: a misrouted mission (a written study run under the build
      // profile) was gate-blocked 52 consecutive times — each attempt a full
      // LLM round-trip — and burned a weekly token quota proving a markdown
      // file can't print "SMOKE OK". Past the cap the mission is
      // misconfigured, not unfinished: stop and say so. The work already on
      // disk is preserved; only the loop ends.
      if (verificationFailures >= config.verifyMaxFailures) {
        const msg = `Finish blocked ${verificationFailures} times by the '${getProfileName(stageState)}' profile's verification gates — circuit breaker tripped. ` +
          `The task likely cannot produce the evidence this profile demands (wrong profile for the task?). ` +
          `Any artifacts already written remain in the workspace. Last finish summary: ${summary.slice(0, 300)}`;
        log(`Verification circuit breaker: OPEN after ${verificationFailures} failures (cap ${config.verifyMaxFailures})`);
        saveMemory(`Mission aborted by verification circuit breaker after ${verificationFailures} blocked finishes`, 'experience', ['session', 'error']);
        appendProgress(`\n## ABORTED (verification circuit breaker)\n${msg}\n`);
        saveState();
        return result('error', msg);
      }

      // ── Hard smoke test gate ──────────────────────────────────
      // For application tasks, require evidence that a smoke test was actually run.
      // This prevents the model from bypassing the LLM-based verification by
      // finishing repeatedly with no new evidence.
      // Require SMOKE OK in the result — just running the smoke test isn't enough,
      // it must actually pass. Check both current memory and compacted context.
      // Disable with AGENT_REQUIRE_SMOKE_TEST=false for chatbot / non-build tasks.
      // Phase 2: the smoke gate is a BUILD-profile requirement, not a universal
      // one. Demanding "SMOKE OK" from a research or errand mission made those
      // tasks impossible to finish at all. `config.requireSmokeTest` remains an
      // operator kill-switch that can only relax the profile, never tighten it.
      const _gates = getProfileGates(stageState);
      const _smokeRequired = config.requireSmokeTest && _gates.requireSmokeTest !== false;
      const smokeTestEvidence = !_smokeRequired || memory.entries.some(e =>
        e.action === 'run_command' && !e.error &&
        String(e.result || '').includes('SMOKE OK') &&
        // Reject console.assert-style fake passes: assert failure is printed to stderr
        // but the process still exits 0 and prints "SMOKE OK" at the end.
        !String(e.result || '').includes('Assertion failed:')
      );
      if (!smokeTestEvidence) {
        // Prefer pre-existing authoritative test files (from snapshot) — direct agent to run those first.
        const authTests = [...protectedFiles].filter(f => /(_smoke_test\.(js|py)|_test\.(js|py)|\.test\.js|\.spec\.js)$/.test(f));
        const smokeTestRan = memory.entries.some(e =>
          e.action === 'run_command' &&
          (String(e.args?.command || '').includes('_smoke_test') || String(e.args?.command || '').includes('_test'))
        );
        let smokeMsg;
        if (authTests.length > 0) {
          const testList = authTests.map(f => `\`node ${f}\``).join(', ');
          smokeMsg = smokeTestRan
            ? `Finish BLOCKED: No passing test detected. Pre-existing authoritative tests exist: ${testList}. Run them with run_command. If they fail, your SOURCE CODE has a bug — fix the source, not the test. The test must print "SMOKE OK" at the end.`
            : `Finish BLOCKED: You must verify your work before finishing. Run the pre-existing test file(s): ${testList}. If all pass, they will print "SMOKE OK". Do NOT write new test files — use the ones already in the workspace.`;
        } else {
          smokeMsg = smokeTestRan
            ? 'Finish BLOCKED: Your smoke test ran but did NOT produce a clean "SMOKE OK" (either it never printed it, or it printed assertion failures before it). Do NOT rewrite the smoke test file. Your SOURCE CODE has a bug. Run the smoke test with run_command, read the error output carefully, find which source module is failing, fix THAT file, then rerun the smoke test.'
            : 'Finish BLOCKED: No passing smoke test detected. Write a _smoke_test.js (or _smoke_test.py) that: (1) imports the key exported functions/classes, (2) calls them with known inputs, (3) uses throw-based assertions — NOT console.assert, which exits 0 even on failure — so the process exits with a non-zero code when a check fails, (4) prints "SMOKE OK" only after ALL checks pass. Run it with run_command. It must exit 0 and print "SMOKE OK" with no assertion errors before it.';
        }
        log(`Smoke test gate: BLOCKED (attempt ${verificationFailures + 1})`);
        runtimeGuidance = smokeMsg;
        memory.push({
          step,
          subStep: 'smoke_test_gate',
          action: 'verification_failed',
          args: {},
          result: smokeMsg,
          error: true,
          timestamp: Date.now(),
        });
        verificationFailures++;
        consecutiveErrors++;
        saveState();
        continue;
      }

      // ── Actuation receipts gate (errand profile) ──────────────
      // An errand is judged by what it DID, not by what it wrote. The failure
      // mode this exists to catch: the model narrates "I've sent the email" in
      // its finish summary having never called a state-changing tool. So finish
      // requires at least one *successful* state-changing action on record.
      if (_gates.requireActuationReceipts) {
        const receipts = memory.entries.filter(e => !e.error && isStateChangingTool(e.action));
        if (receipts.length === 0) {
          const attempted = memory.entries.filter(e => e.error && isStateChangingTool(e.action));
          const receiptMsg = attempted.length > 0
            ? `Finish BLOCKED: no action succeeded. ${attempted.length} state-changing action(s) were attempted and all failed (last: ${attempted[attempted.length - 1].action}). Either retry with corrected arguments, or call finish with an explicit report that the errand could NOT be completed and why — do not report intent as outcome.`
            : 'Finish BLOCKED: this is an errand and no state-changing action was taken. Nothing was actually done. Either perform the requested action with a real tool call, or finish with an explicit statement that you could not act and why.';
          log(`Actuation receipts gate: BLOCKED (${attempted.length} failed attempt(s))`);
          runtimeGuidance = receiptMsg;
          memory.push({
            step,
            subStep: 'actuation_receipts_gate',
            action: 'verification_failed',
            args: {},
            result: receiptMsg,
            error: true,
            timestamp: Date.now(),
          });
          trackRecoveryEvent('actuation_receipts_missing', `receipts=0 attempted=${attempted.length}`, receiptMsg, { stage: stageState?.currentStage || '', step });
          verificationFailures++;
          consecutiveErrors++;
          saveState();
          continue;
        }
        log(`Actuation receipts: ${receipts.length} successful state-changing action(s)`);
      }

      // Sandbox verification — diffs workspace changes and runs an LLM judge
      // Phase 2: the sandbox verifier judges a workspace DIFF. For profiles
      // whose outcome is not a file change (errand, converse) there is nothing
      // to diff, so the judge would reject every finish attempt forever.
      const sandboxResult = _gates.requireSandboxVerify === false
        ? { verified: true, reason: `sandbox verification not applicable to the ${getProfileName(stageState)} profile` }
        : await sandboxVerify(readTask(), getWorkspace(), workspaceSnapshot, verificationFailures, memory.getRecent(30));
      if (sandboxResult.verified) {
        // Save completion memory
        saveMemory(
          `Task completed: ${summary.slice(0, 300)}`,
          'experience',
          ['task', 'complete']
        );
        appendProgress(`\n## COMPLETED\n${summary}\n`);
        saveState();
        return result('completed', summary, sandboxResult);
      } else {
        log(`Sandbox verification failed: ${sandboxResult.reason}`);
        trackRecoveryEvent(
          'finish_verification_failed',
          summary.slice(0, 200),
          'Repair missing evidence, update artifacts, and only then call finish again.',
          { stage: stageState?.currentStage || '', step }
        );
        const escalation = _smokeRequired
          ? (verificationFailures >= 2
            ? `CRITICAL (attempt ${verificationFailures + 1}): Your finish was rejected AGAIN. Verifier reason: ${sandboxResult.reason}. You MUST: 1) Write _smoke_test.py that imports key classes using package imports, 2) Run it with run_command, 3) Fix any errors until it prints "SMOKE OK", 4) ONLY THEN call finish.`
            : `Your completion was not verified. Verifier reason: ${sandboxResult.reason}. Before calling finish again: 1) Write and run a _smoke_test.py, 2) Update the plan to mark completed subtasks with [x], 3) Verify your work actually produced the expected output, 4) Include specific evidence in your finish summary.`)
          : (verificationFailures >= 2
            ? `CRITICAL (attempt ${verificationFailures + 1}): Your finish was rejected AGAIN. Verifier reason: ${sandboxResult.reason}. Re-read the original task requirements, check which deliverables are missing or broken, fix them, then call finish with specific evidence of what you fixed.`
            : `Your completion was not verified. Verifier reason: ${sandboxResult.reason}. Before calling finish again: 1) Re-read the original task requirements, 2) Check that all required files exist and are correct, 3) Run any relevant commands to confirm the work is done, 4) Include specific evidence in your finish summary.`);
        memory.push({
          step,
          subStep: 'verification_failed',
          action: 'verification_failed',
          args: {},
          result: escalation,
          error: true,
          timestamp: Date.now(),
        });
        verificationFailures++;
        consecutiveErrors++;
        // Clear command dedup so the agent can re-run the same verification
        // commands as fresh evidence on the next attempt.
        clearCommandDedup();
        // Don't break — continue the loop
      }
    }

    // ── 10. Save Checkpoint ──────────────────────────────────
    saveState();

    // ── 10. Per-step + per-stage latency ─────────────────────
    const _stepDur = Date.now() - _stepStartMs;
    stepLatencies.push(_stepDur);
    recordSpan('step', { step, tool: action.tool, stage: stageState?.currentStage || '' }, _stepStartMs, Date.now(), toolError ? 'error' : 'ok');

    // Per-stage cost + latency breakdown → TUI metrics view.
    const _stg = stageState?.currentStage || 'unknown';
    const _sl = stageLatencies[_stg] || { totalMs: 0, steps: 0 };
    _sl.totalMs += _stepDur; _sl.steps++;
    stageLatencies[_stg] = _sl;
    const _costStages = sessionCost().stages || {};
    const _breakdown = {};
    for (const st of new Set([...Object.keys(stageLatencies), ...Object.keys(_costStages)])) {
      const lat = stageLatencies[st];
      _breakdown[st] = {
        steps: lat?.steps || 0,
        avgLatencyMs: lat && lat.steps ? Math.round(lat.totalMs / lat.steps) : 0,
        tokens: _costStages[st]?.totalTokens || 0,
        dollars: _costStages[st]?.dollars || 0,
      };
    }
    hitlEmit({
      type: 'stage_metrics',
      step,
      stage: _stg,
      breakdown: _breakdown,
      controller: { mode: currentController.mode, fallbackReason: currentController.fallbackReason || '', confidence: currentController.confidence || 0 },
    });

    // ── 10. Callback ─────────────────────────────────────────
    if (onStep) {
      try { onStep(step, action, toolResult); } catch {}
    }
  }

  // Loop exhausted
  if (effectiveMaxSteps > 0) {
    log(`Max steps reached (${effectiveMaxSteps})`);
    saveMemory(`Session ended: reached max ${effectiveMaxSteps} steps`, 'experience', ['session', 'max-steps']);
    saveState();
    return result('max_steps', `Reached maximum ${effectiveMaxSteps} steps`);
  }

  throw new Error('Unreachable: unbounded loop exited unexpectedly.');
  } finally {
    if (ownsProcessSignals) {
      process.removeListener('SIGTERM', handleShutdownSignal);
      process.removeListener('SIGINT', handleShutdownSignal);
    } else {
      delete runtimeCtx.requestShutdown;
    }
  }

  // ── Helpers ────────────────────────────────────────────────
  function saveWorkspaceSnapshot(snapshot) {
    try {
      const p = path.join(getWorkspace(), config.agentDir, 'workspace-snapshot.json');
      fs.writeFileSync(p, JSON.stringify(snapshot), 'utf-8');
    } catch { /* non-fatal */ }
  }

  function loadWorkspaceSnapshot() {
    try {
      const p = path.join(getWorkspace(), config.agentDir, 'workspace-snapshot.json');
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch { /* ignore */ }
    return {};
  }

  function saveState() {
    // Phase 1.5: `_ephemeralCheckpoint` used to skip this write entirely,
    // because concurrent specialists shared one .agent/checkpoint.json and
    // would clobber each other. Checkpoints are now per-mission
    // (.agent/missions/<missionId>/checkpoint.json), so siblings are isolated
    // by path and every specialist gets a real, resumable checkpoint instead of
    // none. The conductor manifest remains the run-level recovery record.
    const recentRecoveryEvent = readRecoveryEvents().slice(-1)[0] || null;
    const activeRoute = readLmmaActiveRoute();
    const lmmaPacket = readLmmaWorkingMemory();
    const rwkvState = loadRwkvControllerState();
    saveCheckpoint({
      step,
      totalCharsUsed,
      consecutiveErrors,
      lastErrorTool,
      lastErrorMessage,
      lastCompactionStep,
      compactionCount,
      memoriesFlushed,
      skillsCreated,
      fileWriteCounters,
      lastFailedCommandOutput,
      thrashBlock,
      parseErrorStreak,
      stageMisalignedStreak,
      runtimeGuidance,
      verificationFailures,
      stageState: stageState ? {
        ...stageState,
        recentRecoveryRule: recentRecoveryEvent
          ? `${recentRecoveryEvent.type}: ${recentRecoveryEvent.correctiveAction}`
          : (stageState.recentRecoveryRule || ''),
      } : stageState,
      lastErrorContext: consecutiveErrors > 0 ? {
        type: parseErrorStreak > 0 ? 'parse_error' : 'tool_or_llm_error',
        streak: parseErrorStreak > 0 ? parseErrorStreak : consecutiveErrors,
        lastErrorMessage: String(lastErrorMessage || lastErrorTool || ''),
      } : null,
      bank_focus: activeRoute?.primaryBank || 'project',
      active_route: activeRoute?.routePath || [activeRoute?.primaryBank].filter(Boolean),
      active_ontology_tags: activeRoute?.ontologyTags || [],
      rwkv_state_hash: rwkvState.meta?.stateHash || getStateHash(rwkvState.stateBuffer),
      lmma_packet_version: 2,
      lmma: {
        activeRoute,
        workingMemory: lmmaPacket,
      },
      rwkv: {
        mode: currentController.mode,
        confidence: currentController.confidence,
        fallbackReason: currentController.fallbackReason || '',
      },
      workingMemory: memory.toJSON(),
      currentSubtask: getCurrentSubtask(),
      ...(config.palaceEnabled && _palaceSession ? {
        palace_db_path: _palaceSession.dbPath,
        last_episodic_event_id: _palaceSession.store.count(),
      } : {}),
    });
  }

  function result(exitReason, summary, sandboxResult = null) {
    const sorted = stepLatencies.slice().sort((a, b) => a - b);
    const avg = sorted.length > 0 ? Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length) : 0;
    const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;
    flushCost(workspace || process.cwd());
    flushSpans();
    telTrack('session.end', { exitReason, totalSteps: step, avgStepLatencyMs: avg, p95StepLatencyMs: p95 });
    const _cost = sessionCost();
    hitlEmit({ type: 'session_end', exitReason, totalSteps: step, summary: (summary || '').slice(0, 300), costUsd: _cost.estimatedDollars, totalTokens: _cost.totalTokens });
    const out = { exitReason, summary, totalSteps: step, totalCharsUsed, compactionCount, memoriesFlushed, skillsCreated, avgStepLatencyMs: avg, p95StepLatencyMs: p95, costUsd: _cost.estimatedDollars, totalTokens: _cost.totalTokens };
    try {
      writeReflection(episodeId, out, memory.getRecent(50), readTask());
      evalSession(episodeId, out, memory.getRecent(50), readTask(), sandboxResult);
    } catch { /* non-critical */ }
    return out;
  }

}

// ── Logger ───────────────────────────────────────────────────
// Delegates to structured logger (Task 6.1); output format controlled by KAIROS_LOG_JSON

function log(msg) {
  logger.info(msg);
}
