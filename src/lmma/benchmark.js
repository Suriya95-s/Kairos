import fs from 'node:fs';
import path from 'node:path';

function safeReadJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function safeReadJSONL(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function countRepeatedMistakes(recoveryEvents = [], commandsRun = []) {
  const recoveryCount = recoveryEvents.filter((event) =>
    ['parse_error', 'tool_error', 'loop_guard', 'repeat_guard'].includes(event.type)
  ).length;

  let repeatedCommandFailures = 0;
  const streaks = new Map();
  for (const entry of commandsRun) {
    const key = String(entry.command || '').trim();
    if (!key) continue;
    if (entry.success) {
      streaks.set(key, 0);
      continue;
    }
    const next = (streaks.get(key) || 0) + 1;
    streaks.set(key, next);
    if (next >= 2) repeatedCommandFailures++;
  }

  return recoveryCount + repeatedCommandFailures;
}

function countCompactionRecoveries(recoveryEvents = [], checkpoint = {}) {
  const postCompactionRecoveries = recoveryEvents.filter((event) =>
    String(event.type || '').includes('compaction')
  ).length;
  return postCompactionRecoveries + Number(checkpoint.compactionCount || 0);
}

export function buildRunMetrics({
  stepCount = 0,
  routeTraces = [],
  recoveryEvents = [],
  commandsRun = [],
  checkpoint = {},
}) {
  const finished = Boolean(
    checkpoint?.stageState?.currentStage === 'finalization' ||
    checkpoint?.verificationFailures >= 0
  );
  const routeStability = routeTraces.length <= 1
    ? 1
    : Number(
      (
        routeTraces.filter((trace, index) =>
          index === 0 || trace.primary_bank === routeTraces[index - 1].primary_bank
        ).length / routeTraces.length
      ).toFixed(2)
    );

  return {
    stepCount: Number(stepCount || checkpoint.step || 0),
    routeTraceCount: routeTraces.length,
    repeatedMistakes: countRepeatedMistakes(recoveryEvents, commandsRun),
    compactionRecoveries: countCompactionRecoveries(recoveryEvents, checkpoint),
    routeStability,
    finished,
  };
}

export function compareRunMetrics(baseline, lmma) {
  const stepReduction = baseline.stepCount > 0
    ? Number(((baseline.stepCount - lmma.stepCount) / baseline.stepCount).toFixed(2))
    : 0;
  const mistakeReduction = baseline.repeatedMistakes > 0
    ? Number(((baseline.repeatedMistakes - lmma.repeatedMistakes) / baseline.repeatedMistakes).toFixed(2))
    : 0;
  const compactionRecoveryGain = baseline.compactionRecoveries > 0
    ? Number(((lmma.compactionRecoveries - baseline.compactionRecoveries) / baseline.compactionRecoveries).toFixed(2))
    : Number(lmma.compactionRecoveries > 0 ? 1 : 0);

  return {
    stepReduction,
    mistakeReduction,
    routeStabilityDelta: Number((lmma.routeStability - baseline.routeStability).toFixed(2)),
    compactionRecoveryGain,
    finishedDelta: Number(lmma.finished) - Number(baseline.finished),
  };
}

export function loadRunMetricsFromWorkspace(workspacePath) {
  const checkpoint = safeReadJSON(path.join(workspacePath, '.agent', 'checkpoint.json'), {});
  const recoveryEvents = safeReadJSON(path.join(workspacePath, '.agent', 'memory', 'recovery-events.json'), []);
  const commandsRun = safeReadJSON(path.join(workspacePath, '.agent', 'memory', 'commands-run.json'), []);
  const routeTraces = safeReadJSONL(path.join(workspacePath, '.agent', 'lmma', 'route-traces.jsonl'));

  return buildRunMetrics({
    stepCount: checkpoint.step || 0,
    routeTraces,
    recoveryEvents,
    commandsRun,
    checkpoint,
  });
}
