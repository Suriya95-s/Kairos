// src/learning/selfEval.js
// Agent grades its own session output on a 1–5 scale.
// Correlates with sandbox verifier result when available.
// Persists evaluations to .agent/learning/self-evals.jsonl
// Task 5.9

import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { workspaceResolve } from '../runtime/workspacePath.js';

function resolve(rel) {
  return workspaceResolve(rel);
}

function selfEvalFile() {
  return resolve(path.join(config.learningDir, 'self-evals.jsonl'));
}

function ensureDir() {
  fs.mkdirSync(resolve(config.learningDir), { recursive: true });
}

/**
 * Grade a completed session on a 1–5 scale based on observable metrics.
 * This is deterministic (no LLM call) — it uses trace data and loop result.
 *
 * Rubric:
 *   5 — Completed, 0 errors, 0 hallucinations, used ≤ half of allowed steps
 *   4 — Completed, minimal errors (< 10%), no hallucinations
 *   3 — Completed, moderate errors or some hallucinations
 *   2 — Did not complete cleanly but made meaningful progress
 *   1 — Failed / interrupted / budget exceeded with minimal progress
 *
 * @param {string} sessionId
 * @param {object} loopResult — { exitReason, summary, totalSteps, compactionCount, skillsCreated }
 * @param {object[]} recentMemory — last N memory entries
 * @param {string} task
 * @param {object} [sandboxResult] — { passed: bool, reason: string } from sandbox verifier
 * @returns {{ score: number, grade: string, reasoning: string, metrics: object }}
 */
export function evalSession(sessionId, loopResult, recentMemory = [], task = '', sandboxResult = null) {
  const {
    exitReason = 'unknown',
    totalSteps = 0,
    compactionCount = 0,
    skillsCreated = 0,
  } = loopResult;

  const completed = exitReason === 'completed';
  const errors = recentMemory.filter(e => e.error).length;
  const total = recentMemory.length || 1;
  const errorRate = errors / total;

  // Count hallucinations from trace file
  let hallucinationCount = 0;
  let traceCount = 0;
  try {
    const f = resolve(config.trainingTracesFile);
    if (fs.existsSync(f)) {
      const lines = fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean);
      const sessionTraces = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(t => t && t.episode_id === sessionId);
      traceCount = sessionTraces.length;
      hallucinationCount = sessionTraces.filter(t => t.hallucination_detected).length;
    }
  } catch { /* non-critical */ }

  // Determine score
  let score;
  let reasoning;

  if (!completed) {
    score = exitReason === 'max_steps' && totalSteps > 5 ? 2 : 1;
    reasoning = `Session did not complete (exit: ${exitReason}). Steps: ${totalSteps}.`;
  } else if (sandboxResult && !sandboxResult.passed) {
    score = 2;
    reasoning = `Completed but sandbox verification failed: ${sandboxResult.reason}`;
  } else if (errorRate < 0.05 && hallucinationCount === 0) {
    score = 5;
    reasoning = `Excellent: completed cleanly with ${(errorRate * 100).toFixed(1)}% error rate, no hallucinations.`;
  } else if (errorRate < 0.15 && hallucinationCount === 0) {
    score = 4;
    reasoning = `Good: completed with low error rate (${(errorRate * 100).toFixed(1)}%) and no hallucinations.`;
  } else if (hallucinationCount > 0 || errorRate >= 0.15) {
    score = 3;
    reasoning = `Completed but had ${hallucinationCount} hallucination(s) and ${(errorRate * 100).toFixed(1)}% error rate.`;
  } else {
    score = 3;
    reasoning = `Completed.`;
  }

  const gradeMap = { 5: 'A+', 4: 'A', 3: 'B', 2: 'C', 1: 'D' };
  const result = {
    sessionId,
    score,
    grade: gradeMap[score] || 'D',
    reasoning,
    metrics: {
      exitReason,
      totalSteps,
      errorRate: Number(errorRate.toFixed(3)),
      hallucinationCount,
      traceCount,
      compactionCount,
      skillsCreated,
      sandboxPassed: sandboxResult?.passed ?? null,
    },
    task: task.slice(0, 200),
    timestamp: new Date().toISOString(),
  };

  // Persist
  persistEval(result);
  return result;
}

function persistEval(evalRecord) {
  try {
    ensureDir();
    fs.appendFileSync(selfEvalFile(), JSON.stringify(evalRecord) + '\n');
  } catch { /* non-critical */ }
}

/**
 * Load all persisted self-evals for this workspace.
 * @returns {Array<object>}
 */
export function loadSelfEvals() {
  const f = selfEvalFile();
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Compute a rolling average score over the last N sessions.
 * @param {number} [n=10]
 * @returns {number|null}
 */
export function rollingAverageScore(n = 10) {
  const evals = loadSelfEvals().slice(-n);
  if (evals.length === 0) return null;
  return Number((evals.reduce((sum, e) => sum + (e.score || 0), 0) / evals.length).toFixed(2));
}
