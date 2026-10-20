import config from '../config.js';
import { appendTrainingTrace } from '../state.js';

function buildReward(trace) {
  const taskSuccess = trace.completion ? 1 : trace.tool_outcome === 'success' ? 0.7 : 0.2;
  const retrievalPrecision = trace.retrieved_memory_ids?.length ? 0.75 : 0.35;
  const factualCorrectness = trace.hallucination_detected ? 0 : 1;
  const latencyEfficiency = trace.latency_ms && trace.latency_ms > 0
    ? Math.max(0.1, Math.min(1, 1500 / trace.latency_ms))
    : 0.6;
  const safetyScore = trace.hallucination_detected ? 0 : (trace.tool_outcome === 'error' ? 0.85 : 1);
  const planConsistency = trace.plan_delta ? 0.8 : 0.55;
  return Number((
    0.35 * taskSuccess +
    0.20 * retrievalPrecision +
    0.15 * factualCorrectness +
    0.10 * latencyEfficiency +
    0.10 * safetyScore +
    0.10 * planConsistency
  ).toFixed(3));
}

// Phase 5.4: Stricter acceptance gate using hallucination heuristic + new criteria.
const LATENCY_STALL_MS = 120_000; // traces with LLM latency > 2 min indicate a stall
const MIN_REWARD = 0.30;          // reject low-quality traces regardless of other flags

function isAccepted(trace) {
  if (trace.hallucination_detected) return false;
  if (trace.repetitive_error_loop_detected) return false;
  if (trace.safety_score < 0.85) return false;
  // Reject error traces with no recovery attempt (no learning signal)
  if (trace.tool_outcome !== 'success' && !trace.recovery_attempt_logged) return false;
  // Phase 5.4 additions:
  // Reject stalled traces (LLM took > 2 min — likely timeout/retry noise)
  if (trace.latency_ms > 0 && trace.latency_ms > LATENCY_STALL_MS) return false;
  // Reject traces that scored below minimum reward threshold
  if (trace.reward_placeholder !== null && trace.reward_placeholder < MIN_REWARD) return false;
  return true;
}

export function emitTrainingTrace({
  episodeId,
  step,
  stage,
  subtask = '',
  inputSummary = '',
  lmmaRoute = [],
  retrievedMemoryIds = [],
  controllerAction = null,
  toolOutcome = 'success',
  planDelta = '',
  completion = false,
  hallucinationDetected = false,
  latencyMs = 0,
  recoveryAttemptLogged = false,
  repetitiveErrorLoopDetected = false,
}) {
  if (!config.trainingEnabled) return null;

  const trace = {
    episode_id: episodeId,
    step,
    stage,
    subtask,
    input_summary: inputSummary,
    lmma_route: lmmaRoute,
    retrieved_memory_ids: retrievedMemoryIds,
    controller_action: controllerAction,
    tool_outcome: toolOutcome,
    plan_delta: planDelta,
    reward_placeholder: null,
    completion,
    hallucination_detected: hallucinationDetected,
    latency_ms: latencyMs,
    recovery_attempt_logged: recoveryAttemptLogged,
    repetitive_error_loop_detected: repetitiveErrorLoopDetected,
    safety_score: hallucinationDetected ? 0 : (toolOutcome === 'error' ? 0.85 : 1),
    timestamp: new Date().toISOString(),
  };
  trace.reward_placeholder = buildReward(trace);

  const accepted = isAccepted(trace);
  appendTrainingTrace(trace, null);
  appendTrainingTrace(trace, accepted);
  return { trace, accepted };
}
