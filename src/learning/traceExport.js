// src/learning/traceExport.js
// Export accepted training traces to HuggingFace dataset format (RLHF-ready JSONL).
// Each trace becomes a conversational record with messages + reward signal.
// Runs redaction pass (Q6) before export.
// Task 5.7

import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { workspaceResolve } from '../runtime/workspacePath.js';
import { redactTrace } from './redactor.js';

function resolve(rel) {
  return workspaceResolve(rel);
}

/**
 * Convert a single Kairos training trace to HuggingFace conversational format.
 * Schema: { id, messages: [{role, content}], reward, metadata }
 *
 * The "conversation" is modelled as:
 *   user: the agent's context/task at this step
 *   assistant: the action taken (tool + args + thought)
 * Reward comes from trace.reward_placeholder.
 */
function traceToHfRecord(trace) {
  const userContent = [
    `Task: ${trace.subtask || '(none)'}`,
    `Stage: ${trace.stage || 'unknown'}`,
    `Step: ${trace.step}`,
    trace.input_summary ? `Context: ${trace.input_summary}` : '',
  ].filter(Boolean).join('\n');

  const action = trace.controller_action || {};
  const assistantContent = [
    trace.input_summary ? `Action: ${trace.input_summary}` : `Action: ${action.tool || 'unknown'}`,
    action.args ? `Args: ${JSON.stringify(action.args)}` : '',
    `Outcome: ${trace.tool_outcome}`,
  ].filter(Boolean).join('\n');

  return {
    id: `${trace.episode_id || 'unknown'}_${trace.step}`,
    messages: [
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    ],
    reward: trace.reward_placeholder ?? null,
    metadata: {
      episode_id: trace.episode_id,
      step: trace.step,
      stage: trace.stage,
      tool_outcome: trace.tool_outcome,
      hallucination_detected: trace.hallucination_detected,
      latency_ms: trace.latency_ms,
      timestamp: trace.timestamp,
    },
  };
}

/**
 * Export accepted traces to an RLHF-ready JSONL file.
 * @param {string} outputPath — absolute or workspace-relative path for the export
 * @param {object} opts
 * @param {boolean} [opts.includeRejected=false] — also export rejected traces (labelled)
 * @param {number} [opts.minReward=0]             — filter out traces below this reward
 * @param {boolean} [opts.redact=true]            — apply redaction pass (Q6)
 * @returns {{ exported: number, skipped: number, outputPath: string }}
 */
export function exportTraces(outputPath, { includeRejected = false, minReward = 0, redact = true } = {}) {
  const absOutput = path.isAbsolute(outputPath) ? outputPath : resolve(outputPath);
  fs.mkdirSync(path.dirname(absOutput), { recursive: true });

  const sources = [resolve(config.trainingAcceptedFile)];
  if (includeRejected) sources.push(resolve(config.trainingRejectedFile));

  let exported = 0;
  let skipped = 0;
  const lines_out = [];

  for (const srcFile of sources) {
    if (!fs.existsSync(srcFile)) continue;
    const lines = fs.readFileSync(srcFile, 'utf-8').split('\n').filter(Boolean);

    for (const line of lines) {
      let trace;
      try { trace = JSON.parse(line); }
      catch { skipped++; continue; }

      // Filter by minimum reward
      if (trace.reward_placeholder !== null && trace.reward_placeholder < minReward) {
        skipped++;
        continue;
      }

      // Redact secrets before export
      if (redact) trace = redactTrace(trace);

      lines_out.push(JSON.stringify(traceToHfRecord(trace)));
      exported++;
    }
  }

  fs.writeFileSync(absOutput, lines_out.join('\n') + (lines_out.length ? '\n' : ''), 'utf-8');
  return { exported, skipped, outputPath: absOutput };
}
