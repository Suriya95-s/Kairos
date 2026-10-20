// src/learning/reflection.js
// Post-session reflection writeup → .agent/reflections/<sessionId>.md
// Called from loop.js at session end (all exit paths).
// Task 5.5

import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { workspaceResolve } from '../runtime/workspacePath.js';

function resolve(rel) {
  return workspaceResolve(rel);
}

/**
 * Write a reflection report for a completed session.
 * @param {string} sessionId — episode UUID
 * @param {object} loopResult — { exitReason, summary, totalSteps, totalCharsUsed, compactionCount, memoriesFlushed, skillsCreated }
 * @param {object[]} recentMemory — last N memory entries from WorkingMemory
 * @param {string} task — original task description
 * @returns {string} path to the written reflection file
 */
export function writeReflection(sessionId, loopResult, recentMemory = [], task = '') {
  const reflDir = resolve(config.reflectionsDir);
  fs.mkdirSync(reflDir, { recursive: true });

  const {
    exitReason = 'unknown',
    summary = '',
    totalSteps = 0,
    totalCharsUsed = 0,
    compactionCount = 0,
    memoriesFlushed = 0,
    skillsCreated = 0,
  } = loopResult;

  // Analyse memory entries for patterns
  const errors = recentMemory.filter(e => e.error);
  const tools = recentMemory.map(e => e.action).filter(Boolean);
  const toolCounts = tools.reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {});
  const topTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const errorRate = recentMemory.length > 0 ? (errors.length / recentMemory.length) : 0;

  // Extract any hallucination entries from traces (best-effort)
  let hallucinationCount = 0;
  try {
    const tracesFile = resolve(config.trainingTracesFile);
    if (fs.existsSync(tracesFile)) {
      const lines = fs.readFileSync(tracesFile, 'utf-8').split('\n').filter(Boolean);
      const sessionTraces = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(t => t && t.episode_id === sessionId);
      hallucinationCount = sessionTraces.filter(t => t.hallucination_detected).length;
    }
  } catch { /* non-critical */ }

  const succeeded = exitReason === 'completed';
  const timestamp = new Date().toISOString();

  const md = [
    `# Session Reflection — ${sessionId.slice(0, 8)}`,
    ``,
    `**Date:** ${timestamp}`,
    `**Exit:** ${exitReason} ${succeeded ? '✅' : '⚠️'}`,
    `**Task:** ${task.slice(0, 200) || '(not recorded)'}`,
    ``,
    `## Metrics`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total steps | ${totalSteps} |`,
    `| Total chars | ${totalCharsUsed.toLocaleString()} |`,
    `| Compactions | ${compactionCount} |`,
    `| Memories flushed | ${memoriesFlushed} |`,
    `| Skills created | ${skillsCreated} |`,
    `| Error rate | ${(errorRate * 100).toFixed(1)}% |`,
    `| Hallucinations detected | ${hallucinationCount} |`,
    ``,
    `## Summary`,
    ``,
    summary || '(no summary)',
    ``,
    `## Top Tools Used`,
    ``,
    topTools.length > 0
      ? topTools.map(([t, n]) => `- \`${t}\` × ${n}`).join('\n')
      : '(no tools recorded)',
    ``,
    `## What Worked`,
    ``,
    succeeded
      ? `- Task completed in ${totalSteps} steps`
      : `(session did not complete)`,
    skillsCreated > 0 ? `- Created ${skillsCreated} new skill(s)` : '',
    memoriesFlushed > 0 ? `- Flushed ${memoriesFlushed} memories before compaction` : '',
    ``,
    `## What to Improve`,
    ``,
    errors.length > 0
      ? `- ${errors.length} error(s) occurred — review recovery handling`
      : '- No errors recorded',
    hallucinationCount > 0
      ? `- ${hallucinationCount} hallucination(s) detected — check LLM action descriptions`
      : '',
    exitReason === 'max_steps' ? `- Hit step limit — task may need decomposition` : '',
    exitReason === 'budget_exceeded' ? `- Exceeded character budget — consider more targeted context` : '',
  ].filter(l => l !== undefined).join('\n');

  const filePath = path.join(reflDir, `${sessionId}.md`);
  fs.writeFileSync(filePath, md);
  return filePath;
}
