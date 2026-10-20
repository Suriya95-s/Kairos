// advanced-agent-loop/src/config.js
// Central configuration — all tunables in one place.
// Designed for the longest-running, most stable autonomous agent loop.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Model Profiles ────────────────────────────────────────────────
// Pre-tuned settings per model. Selected via AGENT_PROFILE env var or
// auto-matched from AGENT_MODEL. All values can still be overridden
// by their individual env vars (AGENT_CONTEXT_WINDOW, etc.).
const MODEL_PROFILES = {
  // Local vLLM models
  'gpt-oss-120b': {
    provider: 'vllm',
    temperature: 0.15,
    contextWindow: 32000,
    maxOutputTokens: 6144,
    notes: 'Largest local model. Clean code but slow (~10-20s/step). Gets stuck on subtle import issues. Shared server hits 429 rate limits. Use qwen3-coder for speed.',
  },
  'gpt-oss-20b': {
    provider: 'vllm',
    temperature: 0.2,
    contextWindow: 32000,
    maxOutputTokens: 4096,
    notes: 'Smaller variant of gpt-oss. Faster but less capable for multi-file tasks.',
  },
  'minimax-m2.1-reap': {
    provider: 'vllm',
    temperature: 0.2,
    contextWindow: 16384,
    maxOutputTokens: 2949,
    noThinking: true,
    notes: 'Good reasoning via REAP but slow (~60s/step). Generates typos in code (glass/snike). Struggles with edit_file whitespace matching. Write churn on multi-file tasks. OK for simple bug fixes.',
  },
  'qwen2.5-coder-32b': {
    provider: 'vllm',
    temperature: 0.1,
    contextWindow: 32000,
    maxOutputTokens: 4096,
    notes: 'Code-specialized. Strong JSON discipline. Best for pure coding tasks.',
  },
  'qwen3-coder-30b': {
    provider: 'vllm',
    temperature: 0.1,
    contextWindow: 16384,
    maxOutputTokens: 2949,
    noThinking: true,
    notes: 'Best local model for agent loop. 1-3s/step, 0 truncations, clean JSON. MoE 30B/3B. Requires AGENT_NO_THINKING=1. Tested: 9-file project in 47s/20 steps, 11-file in 141s/34 steps.',
  },
  'qwen3-30b': {
    provider: 'vllm',
    temperature: 0.2,
    contextWindow: 16384,
    maxOutputTokens: 2949,
    noThinking: true,
    notes: 'MoE 30B/3B AWQ variant. Same arch as qwen3-coder. Needs AGENT_NO_THINKING=1 or thinking tokens consume output budget.',
  },
  'qwen3-8b': {
    provider: 'vllm',
    temperature: 0.2,
    contextWindow: 32000,
    maxOutputTokens: 2048,
    noThinking: true,
    notes: 'Smallest Qwen3. Fast but limited reasoning. Needs AGENT_NO_THINKING=1.',
  },
  'qwen3.6-35b': {
    provider: 'vllm',
    temperature: 0.1,
    contextWindow: 131072,
    maxOutputTokens: 8192,
    noThinking: true,
    notes: 'Qwen3.6-35B-A3B MoE. 512K ctx on server; default 128K here to stay safe. Needs AGENT_NO_THINKING=1.',
  },
  'nemotron-30b': {
    provider: 'vllm',
    temperature: 0.1,
    contextWindow: 32000,
    maxOutputTokens: 4096,
    notes: 'NVIDIA Nemotron-3 Nano 30B. MoE 30B/3B BF16. Use for coding tasks.',
  },
  // API models
  'claude': {
    provider: 'anthropic',
    temperature: 0.1,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    notes: 'Best overall. Huge context, excellent JSON, strong coding. API cost applies.',
  },
  'codex': {
    provider: 'openai',
    temperature: 0.1,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    notes: 'OpenAI Codex. Large context, strong at code generation. API cost applies.',
  },
  'gpt-4o': {
    provider: 'openai',
    temperature: 0.1,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    notes: 'GPT-4o. Good all-around. API cost applies.',
  },
};

function matchProfile(modelId) {
  const id = String(modelId || '').toLowerCase();
  for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
    if (id.includes(key.replace(/-/g, '').replace(/\./g, '')) || id.includes(key)) return profile;
  }
  // Fuzzy match common patterns
  if (id.includes('qwen3.6') || id.includes('qwen/qwen3.6')) return MODEL_PROFILES['qwen3.6-35b'];
  if (id === 'qwen3') return MODEL_PROFILES['qwen3-30b'];
  if (id.includes('minimax') && id.includes('reap')) return MODEL_PROFILES['minimax-m2.1-reap'];
  if (id.includes('qwen3') && id.includes('coder')) return MODEL_PROFILES['qwen3-coder-30b'];
  if (id.includes('qwen') && id.includes('coder') && id.includes('2.5')) return MODEL_PROFILES['qwen2.5-coder-32b'];
  if (id.includes('qwen') && id.includes('coder')) return MODEL_PROFILES['qwen3-coder-30b'];
  if (id.includes('qwen3') && id.includes('30b')) return MODEL_PROFILES['qwen3-30b'];
  if (id.includes('qwen3') && id.includes('8b')) return MODEL_PROFILES['qwen3-8b'];
  if (id.includes('nemotron')) return MODEL_PROFILES['nemotron-30b'];
  if (id.includes('claude')) return MODEL_PROFILES['claude'];
  if (id.includes('codex')) return MODEL_PROFILES['codex'];
  if (id.includes('gpt-4o')) return MODEL_PROFILES['gpt-4o'];
  if (id.includes('gpt-oss') && id.includes('120')) return MODEL_PROFILES['gpt-oss-120b'];
  if (id.includes('gpt-oss')) return MODEL_PROFILES['gpt-oss-20b'];
  return null;
}

// ── Model registry fallback (`kairos llm use <name>`) ────────────
// The kernel's models.json names the endpoint the user picked; env vars stay
// the explicit per-process override. Read inline rather than via
// kernel/models.js so config.js keeps zero internal imports (no cycles, and
// mission children that never speak to an LLM pay nothing extra).
//
// NEVER under the test runner. Before this fallback existed, config depended
// only on environment variables and hardcoded defaults, so the suite was
// hermetic. Reading the developer's real ~/.kairos/models.json broke that:
// registering a 128K-context model on one laptop moved `contextWindow` from
// 32000 to 131072, which moved a truncation limit in context.js from 8000 to
// 32000 chars, which failed an unrelated context-building test. The suite must
// not depend on whether someone has run `kairos llm add`.
const UNDER_TEST = !!process.env.NODE_TEST_CONTEXT || process.env.KAIROS_NO_MODEL_REGISTRY === '1';
const registryModel = (() => {
  if (UNDER_TEST) return null;
  const envUrl = process.env.AGENT_BASE_URL || process.env.OPENAI_BASE_URL;
  const envModel = process.env.AGENT_MODEL || process.env.OPENAI_MODEL;
  if (envUrl && envModel) return null; // fully specified by env — skip the disk read
  try {
    const override = process.env.KAIROS_HOME;
    const brand = (process.env.KAIROS_BRAND || 'kairos').trim().toLowerCase();
    const home = override && override.trim() ? path.resolve(override.trim()) : path.join(os.homedir(), `.${brand}`);
    const reg = JSON.parse(fs.readFileSync(path.join(home, 'models.json'), 'utf-8'));
    return reg?.active ? (reg.models?.[reg.active] ?? null) : null;
  } catch {
    return null;
  }
})();

// Resolve profile: explicit AGENT_PROFILE > auto-match from model name > defaults
const modelId = process.env.AGENT_MODEL || process.env.OPENAI_MODEL || registryModel?.model || 'gpt-oss-120b';
const explicitProfile = process.env.AGENT_PROFILE ? MODEL_PROFILES[process.env.AGENT_PROFILE] : null;
const autoProfile = matchProfile(modelId);
const profile = explicitProfile || autoProfile || {};

// Auto-set AGENT_NO_THINKING for models that need it (Qwen3 thinking token issue)
if (profile.noThinking && !process.env.AGENT_NO_THINKING) {
  process.env.AGENT_NO_THINKING = '1';
}

// Validated numeric env parsing: a typo'd value (e.g. AGENT_MAX_OUTPUT=abc) must
// fall back to the default with a warning rather than propagating NaN into
// max_tokens / context-window math (which silently corrupts API calls and
// compaction). `float: true` allows decimals (temperature); otherwise integer.
function numEnv(name, fallback, { float = false, min = undefined } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = float ? parseFloat(raw) : parseInt(raw, 10);
  if (!Number.isFinite(parsed) || (min !== undefined && parsed < min)) {
    console.error(`[config] Invalid ${name}="${raw}" — using default ${fallback}.`);
    return fallback;
  }
  return parsed;
}

const config = {
  // ── LLM Provider ──────────────────────────────────────────────
  provider: profile.provider || 'vllm',
  baseURL: process.env.AGENT_BASE_URL || process.env.OPENAI_BASE_URL || registryModel?.baseURL || 'http://localhost:8000/v1',
  model: modelId,
  // May be a `vault:scope.key` reference (from the model registry) — llm.js
  // resolves it at request time, so processes that never call out never open the vault.
  apiKey: process.env.AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? registryModel?.apiKey ?? '',
  contextWindow: numEnv('AGENT_CONTEXT_WINDOW', profile.contextWindow || 32000, { min: 1 }),
  maxOutputTokens: numEnv('AGENT_MAX_OUTPUT', profile.maxOutputTokens || 4096, { min: 1 }),
  temperature: numEnv('AGENT_TEMPERATURE', profile.temperature ?? 0.2, { float: true, min: 0 }),
  modelProfile: profile,  // expose for logging

  // ── Loop Budgets ──────────────────────────────────────────────
  maxSteps: numEnv('AGENT_MAX_STEPS', 0, { min: 0 }),         // 0 disables the hard max-step stop

  // ── Mission profile (Phase 2) ─────────────────────────────────
  // Which lifecycle a task runs under: build | research | errand | converse.
  // Empty = infer from the task text. An explicit --profile flag beats this.
  // See src/missions/profiles.js.
  missionProfile: process.env.AGENT_MISSION_PROFILE || '',

  maxTotalChars: numEnv('AGENT_MAX_CHARS', 0, { min: 0 }), // 0 disables the cumulative char budget hard-stop
  enableStages: process.env.AGENT_ENABLE_STAGES !== 'false',
  stageBudgetRatios: {
    intake: 0.05,
    discovery: 0.10,
    planning: 0.10,
    execution: 0.55,
    verification: 0.10,
    finalization: 0.10,
  },

  // ── Memory & Compaction ───────────────────────────────────────
  workingMemoryWindow: parseInt(process.env.AGENT_MEMORY_WINDOW || '20', 10),       // keep last N steps
  compactionThresholdChars: parseInt(process.env.AGENT_COMPACT_THRESHOLD || '20000', 10),
  compactionIntervalSteps: parseInt(process.env.AGENT_COMPACT_INTERVAL || '15', 10),
  memoryFlushEnabled: true,    // Pre-compaction memory flush (OpenClaw-inspired)
  memoryHeartbeatInterval: parseInt(process.env.AGENT_HEARTBEAT || '10', 10),      // save heartbeat every N steps

  // ── Focus & Anti-Drift ────────────────────────────────────────
  maxConsecutiveErrors: numEnv('AGENT_MAX_ERRORS', 3, { min: 1 }),
  maxSameToolErrors: numEnv('AGENT_MAX_SAME_ERRORS', 3, { min: 1 }),
  // Circuit breaker on blocked finish attempts (smoke/receipts/sandbox gates).
  // Was defined-but-never-consumed for its whole life; wired in after a
  // misrouted mission was gate-blocked 52 consecutive times. 8 = a healthy
  // mission's worst case (2–3 blocks) plus several escalated-guidance rounds.
  verifyMaxFailures: numEnv('AGENT_VERIFY_MAX_FAILURES', 8, { min: 1 }),
  requireSmokeTest: process.env.AGENT_REQUIRE_SMOKE_TEST !== 'false',  // Set to 'false' to skip smoke test gate

  // ── Repair-mode escape hatch (verification repair stall) ──────
  // While stuck in local verification-repair mode, escalate guidance after
  // N unproductive steps, then exit cleanly ('repair_stalled') after M, so a
  // cascading repair can never hang the loop forever.
  repairStallEscalateSteps: parseInt(process.env.AGENT_REPAIR_ESCALATE || '6', 10),
  repairStallExitSteps: parseInt(process.env.AGENT_REPAIR_EXIT || '10', 10),

  // ── Token estimation ──────────────────────────────────────────
  // Single chars-per-token ratio used by all estimators in the codebase.
  // 3.5 is the conservative default for code-heavy content (range: 3–4).
  charsPerToken: numEnv('AGENT_CHARS_PER_TOKEN', 3.5, { float: true, min: 0.5 }),

  // ── Context-size hard guard ───────────────────────────────────
  // If the assembled prompt exceeds this fraction of the context window
  // (chars ≈ tokens×charsPerToken), force an early compaction / window trim
  // that step instead of silently overflowing the model.
  contextHardLimitRatio: parseFloat(process.env.AGENT_CONTEXT_HARD_LIMIT_RATIO || '0.9'),

  // ── Identity Layer (OpenClaw SOUL.md System) ──────────────────
  soulFile: 'SOUL.md',                        // Agent identity — who it is
  agentsFile: 'AGENTS.md',                    // Operating protocol — how it works
  userFile: 'USER.md',                        // User profile — who it serves
  memoryFile: 'MEMORY.md',                    // Curated long-term memory

  // ── Agent State Directory ─────────────────────────────────────
  agentDir: '.agent',
  taskFile: '.agent/task.md',
  planFile: '.agent/plan.md',
  progressFile: '.agent/progress.md',
  contextSummaryFile: '.agent/context-summary.md',
  checkpointFile: '.agent/checkpoint.json',
  focusChainFile: '.agent/focus-chain.md',     // Human-editable focus chain

  // ── Persistent Memory ─────────────────────────────────────────
  memoryDir: '.agent/memory',                  // Daily logs + structured memories
  filesTouchedFile: '.agent/memory/files-touched.json',
  commandsRunFile: '.agent/memory/commands-run.json',
  recoveryEventsFile: '.agent/memory/recovery-events.json',
  learningsFile: '.agent/memory/learnings.md',

  // ── Skills System ─────────────────────────────────────────────
  skillsDir: '.agent/skills',                  // Agent-created skills live here

  // ── Tool Limits ───────────────────────────────────────────────
  // LMMA Memory Routing
  lmmaDir: '.agent/lmma',
  lmmaBanksDir: '.agent/lmma/banks',
  lmmaOntologyFile: '.agent/lmma/ontology.json',
  lmmaTaxonomyFile: '.agent/lmma/taxonomy.json',
  lmmaRulesFile: '.agent/lmma/rules.json',
  lmmaBankRegistryFile: '.agent/lmma/bank-registry.json',
  lmmaLayerMapsFile: '.agent/lmma/layer-maps.json',
  lmmaCrossMapGraphFile: '.agent/lmma/cross-map-graph.json',
  lmmaRouteTracesFile: '.agent/lmma/route-traces.jsonl',
  lmmaActiveRouteFile: '.agent/lmma/active-route.json',
  lmmaWorkingMemoryFile: '.agent/lmma/working-memory.json',
  lmmaRetrievalCacheFile: '.agent/lmma/retrieval-cache.json',
  lmmaImportanceFile: '.agent/lmma/importance.json',

  // RWKV Controller Integration
  rwkvDir: '.agent/rwkv',
  rwkvStateFile: '.agent/rwkv/state.bin',
  rwkvMetaFile: '.agent/rwkv/state.json',
  rwkvEnabled: process.env.AGENT_ENABLE_RWKV !== 'false',
  rwkvMinConfidence: parseFloat(process.env.AGENT_RWKV_MIN_CONFIDENCE || '0.5'),
  rwkvFallbackToHostedLLM: process.env.AGENT_RWKV_FALLBACK !== 'false',

  // RMT Long-Context Processor
  rmtDir: '.agent/rmt',
  rmtSummariesDir: '.agent/rmt/summaries',
  rmtEnabled: process.env.AGENT_ENABLE_RMT !== 'false',
  rmtSegmentTokens: parseInt(process.env.AGENT_RMT_SEGMENT_TOKENS || '2048', 10),
  rmtOverlapTokens: parseInt(process.env.AGENT_RMT_OVERLAP_TOKENS || '128', 10),
  rmtLargeFileTokenThreshold: parseInt(process.env.AGENT_RMT_FILE_THRESHOLD || '8000', 10),
  rmtLargeTraceTokenThreshold: parseInt(process.env.AGENT_RMT_TRACE_THRESHOLD || '6000', 10),
  rmtLargeFileCountThreshold: parseInt(process.env.AGENT_RMT_FILECOUNT_THRESHOLD || '10', 10),

  // Offline Self-Training / Trace Collection
  trainingDir: '.agent/training',
  trainingTracesFile: '.agent/training/traces.jsonl',
  trainingAcceptedFile: '.agent/training/accepted-traces.jsonl',
  trainingRejectedFile: '.agent/training/rejected-traces.jsonl',
  trainingMergeDecisionsFile: '.agent/training/merge-decisions.jsonl',
  trainingEnabled: process.env.AGENT_ENABLE_TRAINING !== 'false',

  maxToolOutputChars: 400_000,
  maxTerminalLines: 1000,
  maxFileReadLines: 500,

  // ── run_command safety ────────────────────────────────────────
  // Default per-command timeout, and a hard ceiling so the model can't set an
  // unbounded timeout. Timed-out commands are killed (SIGTERM) by execSync.
  runCommandTimeoutMs: parseInt(process.env.AGENT_CMD_TIMEOUT || '30000', 10),
  runCommandMaxTimeoutMs: parseInt(process.env.AGENT_CMD_MAX_TIMEOUT || '600000', 10),
  // Workspace path confinement: block destructive commands (rm/mv/…) and output
  // redirects that target absolute paths outside the workspace or escape it via
  // `..`. Default ON — an autonomous agent should not be able to `rm -rf` outside
  // its workspace. Opt out (e.g. tasks that legitimately write elsewhere) with
  // AGENT_CONFINE_PATHS=0.
  confinePaths: process.env.AGENT_CONFINE_PATHS !== '0',

  // Multi-model routing — stage-aware cheap/strong model selection (Task 6.8)
  // Strong model: planning + verification + finalization stages
  // Cheap model: discovery + execution stages (high-frequency calls)
  // Unset → falls back to config.model for all stages
  cheapModel: process.env.AGENT_CHEAP_MODEL || '',
  strongModel: process.env.AGENT_STRONG_MODEL || '',
  conductorModel: process.env.KAIROS_CONDUCTOR_MODEL || process.env.AGENT_CHEAP_MODEL || '',

  // Multi-Agent Orchestration — Phase 3
  // Q4: default-OFF in RC; flip to default-ON at v3.0 GA.
  multiAgentEnabled: process.env.AGENT_MULTI_AGENT === '1',
  // Wave D — Conductor production knobs.
  // Retries per role before marking it failed (default 1 = one retry).
  conductorMaxRetries: numEnv('AGENT_CONDUCTOR_MAX_RETRIES', 1, { min: 0 }),
  // Parallel dispatch of independent DAG nodes within a wave (default on).
  // Set to 'false' to force one-node-per-wave sequential execution (debugging).
  conductorParallel: process.env.AGENT_CONDUCTOR_PARALLEL !== 'false',
  // USD ceiling for a whole multi-agent run; 0 = unbounded (default).
  conductorMaxDollars: numEnv('AGENT_CONDUCTOR_MAX_DOLLARS', 0, { float: true, min: 0 }),

  // Chat Session Persistence
  chatsDir: '.agent/chats',

  // Memory Palace — Phase 2
  palaceEnabled: process.env.AGENT_USE_PALACE === '1',
  palaceDir: '.agent/palace',
  palaceDbFile: '.agent/palace/episodic.db',

  // Observability — Phase 6
  otelEnabled: process.env.KAIROS_OTEL === '1',
  telemetryEnabled: process.env.KAIROS_TELEMETRY === '1',
  telemetryDir: '.agent/telemetry',

  // Self-Improvement — Phase 5
  learningDir: '.agent/learning',
  reflectionsDir: '.agent/reflections',

  // Human-in-the-Loop — Phase 4
  // Q5: default deny on timeout. Default-OFF in RC per 4.1 pact.
  hitlEnabled: process.env.AGENT_HITL_REQUIRED === '1',
  hitlDir: '.agent/hitl',
  hitlPendingDir: '.agent/hitl/pending',
  hitlResponsesDir: '.agent/hitl/responses',
  hitlClarifyDir: '.agent/hitl/clarify',
  hitlSteerDir: '.agent/hitl/steer',
  hitlAuditFile: '.agent/hitl/audit.jsonl',
  hitlTimeoutMs: parseInt(process.env.AGENT_HITL_TIMEOUT || '600000', 10),
  hitlPollIntervalMs: parseInt(process.env.AGENT_HITL_POLL_INTERVAL || '2000', 10),
  hitlPolicyFile: process.env.AGENT_HITL_POLICY || 'hitl-policy.json',
  hitlWebUiPort: parseInt(process.env.AGENT_HITL_WEB_PORT || '5180', 10),
  // Pause deadline: if > 0, auto-resume after this many ms when paused. 0 = unbounded (default).
  pauseDeadlineMs: numEnv('AGENT_PAUSE_DEADLINE_MS', 0, { min: 0 }),

  // MCP (Model Context Protocol) — Phase 1
  mcpEnabled: process.env.AGENT_MCP_ENABLED === '1',
  mcpConfigFile: process.env.AGENT_MCP_CONFIG || 'mcp-servers.json',
  mcpDefaultConfigFile: 'mcp-servers.default.json',
  mcpConnectTimeoutMs: parseInt(process.env.AGENT_MCP_CONNECT_TIMEOUT || '10000', 10),
  mcpCallTimeoutMs: parseInt(process.env.AGENT_MCP_CALL_TIMEOUT || '30000', 10),
  mcpHealthIntervalMs: parseInt(process.env.AGENT_MCP_HEALTH_INTERVAL || '30000', 10),
  mcpMaxReconnectAttempts: parseInt(process.env.AGENT_MCP_MAX_RECONNECT || '3', 10),
};

export default config;
