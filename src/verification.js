// src/verification.js
// Completion verification and compaction anchor — extracted from loop.js (Phase 0 cleanup).
// These are pure functions: no loop-local state; safe to import anywhere.

import { chatCompletion } from './llm.js';
import { saveMemory } from './memory-store.js';
import logger from './logger.js';
import { buildVerificationMessages } from './context.js';
import {
  getWorkspace,
  readRecoveryEvents,
  readCommandsRun,
} from './state.js';
import { inspectStageState } from './stages.js';

function log(msg) {
  logger.info(`[verification] ${msg}`);
}

/**
 * Build the compaction anchor snapshot used to orient the LLM after context compression.
 * Captures the current stage, missing outputs, last milestone, and verification snapshot
 * so the compaction summary is grounded in reality rather than hallucinated state.
 *
 * @param {Object} currentStageState
 * @param {import('./memory.js').WorkingMemory} workingMemory
 * @returns {Object|null}
 */
export function buildCompactionAnchor(currentStageState, workingMemory) {
  if (!currentStageState) return null;
  const runtime = inspectStageState(currentStageState, getWorkspace());
  const lockedRoot = (currentStageState.lockedTargets || [])
    .find((item) => !/\/[^/]+\.[A-Za-z0-9]+$/.test(String(item || ''))) || '';
  const recentRecoveryEvent = readRecoveryEvents().slice(-1)[0] || null;
  const recentSuccess = [...workingMemory.getRecent(12)]
    .reverse()
    .find((entry) =>
      !entry.error &&
      !['loop_guard', 'verification_failed', 'parse_error'].includes(entry.action)
    );

  // Verification snapshot: ground-truth of which checks currently pass/fail.
  // Prevents compaction LLM from summarising a wrong diagnosis (e.g. "board.py is broken"
  // when board.py actually passes and game.py is the failing file).
  let verificationSnapshot = '';
  try {
    const cmdHistory = readCommandsRun();
    const seen = new Map();
    for (const entry of cmdHistory.slice().reverse()) {
      if (entry.skipped) continue;
      const cmd = String(entry.command || '').trim();
      if (!cmd || seen.has(cmd)) continue;
      const isCheck =
        /^python3?\s+\S+\.py\b/.test(cmd) ||
        /^python3?\s+-c\b/.test(cmd) ||
        /^node\s+(--test|src\/|tests?\/)/.test(cmd) ||
        /^pytest\b/.test(cmd) ||
        /^npm\s+test\b/.test(cmd);
      if (isCheck) seen.set(cmd, entry);
    }
    if (seen.size > 0) {
      const lines = [...seen.entries()].map(([cmd, entry]) => {
        const status = Number(entry.exitCode) === 0 ? 'PASS' : 'FAIL';
        const snippet = String(entry.outputSnippet || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        return `  ${status}: ${cmd.slice(0, 80)}${snippet ? ` → ${snippet}` : ''}`;
      });
      verificationSnapshot = lines.join('\n');
    }
  } catch { /* non-critical */ }

  return {
    currentStage: currentStageState.currentStage,
    lockedRoot,
    blockedReason: runtime.stageBlockedReason,
    missingOutputs: [...runtime.missingWorkspaceArtifacts, ...runtime.missingOutputs],
    nextRequiredAction: runtime.nextRequiredActionHint,
    lastSuccessfulMilestone: recentSuccess
      ? `Step ${recentSuccess.step}: ${recentSuccess.action}`
      : '',
    recentRecoveryRule: recentRecoveryEvent
      ? `${recentRecoveryEvent.type}: ${recentRecoveryEvent.correctiveAction}`
      : '',
    verificationSnapshot,
  };
}

/**
 * Ask the verification LLM whether the task summary represents genuine completion.
 * Retries up to MAX_RETRIES on transient failures; force-accepts only after a very
 * high number of total failures across the session to avoid stranding the agent.
 *
 * @param {string} summary
 * @param {import('./memory.js').WorkingMemory} memory
 * @param {number} priorFailures
 * @returns {Promise<boolean>}
 */
export async function verifyCompletion(summary, memory, priorFailures = 0, stageState = null) {
  const MAX_RETRIES = 2;
  const MAX_TOTAL_FAILURES = parseInt(process.env.AGENT_VERIFY_MAX_FAILURES || '6', 10);
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const messages = buildVerificationMessages(summary, memory, stageState);
      const response = await chatCompletion(messages, { temperature: 0.1 });
      // Truncated output is never trustworthy — count as failure and retry
      if (response.finishReason === 'length') {
        throw new Error('Verification response truncated (finish_reason=length) — output budget exceeded');
      }
      const text = response.content.trim();

      try {
        const jsonMatch = text.match(/\{[\s\S]*"verified"[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          log(`Verification: ${result.verified ? 'PASSED' : 'FAILED'} — ${result.reason || 'no reason'}`);
          return result.verified === true;
        }
      } catch {}

      // Fallback: keyword check — require positive signal WITHOUT negation nearby
      const lower = text.toLowerCase();
      const hasPositive = lower.includes('verified') || lower.includes('complete') || lower.includes('true');
      const hasNegative =
        lower.includes('not verified') || lower.includes('not complete') ||
        lower.includes('incomplete') || lower.includes('false') ||
        lower.includes('fail') || lower.includes('missing') ||
        lower.includes('not true') || lower.includes('rejected');
      return hasPositive && !hasNegative;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const delay = 2000 * (attempt + 1);
        log(`Verification attempt ${attempt + 1} failed: ${err.message} — retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  log(`Verification failed after ${MAX_RETRIES + 1} attempts: ${lastErr?.message || 'unknown error'} — rejecting completion.`);
  if ((priorFailures + 1) >= MAX_TOTAL_FAILURES) {
    log(`Verification forced-accept after ${priorFailures + 1} total failures (verification LLM unreliable).`);
    saveMemory(
      'Forced task completion after repeated verification failures — LLM verification was unreliable, not necessarily task complete',
      'experience',
      ['verification', 'forced']
    );
    return true;
  }
  return false;
}
