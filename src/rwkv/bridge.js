import config from '../config.js';
import { chatCompletion, selectModelForStage } from '../llm.js';
import {
  getStateHash,
  readRwkvMeta,
  readRwkvStateBuffer,
  writeRwkvMeta,
  writeRwkvStateBuffer,
} from '../state.js';

function buildMetaPatch(patch = {}) {
  const current = readRwkvMeta();
  return {
    ...current,
    ...patch,
    version: 1,
    lastUpdatedAt: new Date().toISOString(),
  };
}

export function loadRwkvControllerState() {
  const stateBuffer = readRwkvStateBuffer();
  const meta = readRwkvMeta();
  return {
    stateBuffer,
    meta: {
      ...meta,
      stateHash: getStateHash(stateBuffer),
    },
  };
}

export function saveRwkvControllerState({
  step = 0,
  stage = '',
  confidence = 0,
  fallbackReason = '',
  stateBuffer = null,
  controllerAvailable = false,
}) {
  const nextBuffer = stateBuffer || Buffer.from(JSON.stringify({
    step,
    stage,
    confidence,
    fallbackReason,
    savedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
  writeRwkvStateBuffer(nextBuffer);
  const stateHash = getStateHash(nextBuffer);
  writeRwkvMeta(buildMetaPatch({
    controllerAvailable,
    stateHash,
    lastConfidence: confidence,
    lastControllerReason: fallbackReason || (controllerAvailable ? 'rwkv_active' : 'hosted_llm_fallback'),
  }));
  return stateHash;
}

export async function runControllerStep(messages, opts = {}) {
  const { meta } = loadRwkvControllerState();

  // Honest current behavior: the hosted LLM remains the active controller unless
  // a separate RWKV runner is integrated. We still persist controller state and
  // expose the exact fallback reason so the runtime can reason about it.
  const fallbackReason = config.rwkvEnabled
    ? (meta.controllerAvailable ? 'rwkv_runner_not_integrated' : 'rwkv_unavailable')
    : 'rwkv_disabled';
  const response = await chatCompletion(messages, { model: selectModelForStage(opts.stage), ...opts });
  const controller = {
    mode: 'hosted-llm',
    confidence: 0,
    fallbackReason,
    usedFallback: true,
  };
  saveRwkvControllerState({
    step: opts.step || 0,
    stage: opts.stage || '',
    confidence: controller.confidence,
    fallbackReason,
    controllerAvailable: false,
  });

  return {
    response,
    controller,
  };
}

export function noteRwkvFallback(reason) {
  const meta = readRwkvMeta();
  writeRwkvMeta(buildMetaPatch({
    controllerAvailable: false,
    fallbackCount: Number(meta.fallbackCount || 0) + 1,
    lastControllerReason: reason,
  }));
}
