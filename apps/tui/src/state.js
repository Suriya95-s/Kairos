// src/state.js — single mutable state object + update helper

import { DEFAULT_COUNCIL_MODELS } from './council.js';

const envTemperature = Number.parseFloat(process.env.AGENT_TEMPERATURE || '');
const envMaxSteps = Number.parseInt(process.env.AGENT_MAX_STEPS || '0', 10);

export const BUILTIN_MODELS = [
  { id: 'qwen2.5-coder:32b',    label: 'Qwen2.5-Coder 32B',   provider: 'ollama' },
  { id: 'qwen3-coder-30b',      label: 'Qwen3-Coder 30B',      provider: 'vllm' },
  { id: 'qwen3-8b',             label: 'Qwen3 8B',             provider: 'vllm' },
  { id: 'llama3.1:8b',          label: 'Llama 3.1 8B',         provider: 'ollama' },
  { id: 'llama3.1:70b',         label: 'Llama 3.1 70B',        provider: 'ollama' },
  { id: 'codellama:34b',        label: 'CodeLlama 34B',        provider: 'ollama' },
  { id: 'deepseek-coder-v2:16b',label: 'DeepSeek-Coder-V2',   provider: 'ollama' },
  { id: 'nemotron-30b',         label: 'Nemotron 30B',         provider: 'vllm' },
  { id: 'claude-opus-4-7',      label: 'Claude Opus 4.7',      provider: 'anthropic' },
  { id: 'claude-sonnet-4-6',    label: 'Claude Sonnet 4.6',    provider: 'anthropic' },
  { id: 'gpt-4o',               label: 'GPT-4o',               provider: 'openai' },
];

export const state = {
  // connection
  connected: false,
  connecting: false,
  port: 5180,
  reconnectAttempts: 0,
  connDiag: '',   // actionable connectivity diagnostic shown when disconnected

  // session
  episodeId: '',
  task: 'No active session',
  status: 'disconnected',   // 'connecting'|'running'|'paused'|'completed'|'error'|'disconnected'
  step: 0,
  stage: '',
  model: process.env.AGENT_MODEL || '',
  serverUrl: process.env.AGENT_BASE_URL || '',
  apiKey: process.env.AGENT_API_KEY || '',
  provider: process.env.AGENT_PROVIDER || 'ollama',
  temperature: Number.isFinite(envTemperature) ? envTemperature : 0.1,
  maxSteps: Number.isFinite(envMaxSteps) ? envMaxSteps : 0,

  // advanced loop/memory config (env-backed). 0 = "use agent default" — only
  // applied to the spawned agent when non-zero, so we never override defaults silently.
  contextWindow:    Number.parseInt(process.env.AGENT_CONTEXT_WINDOW || '0', 10) || 0,
  maxOutput:        Number.parseInt(process.env.AGENT_MAX_OUTPUT || '0', 10) || 0,
  memoryWindow:     Number.parseInt(process.env.AGENT_MEMORY_WINDOW || '0', 10) || 0,
  compactThreshold: Number.parseInt(process.env.AGENT_COMPACT_THRESHOLD || '0', 10) || 0,
  compactInterval:  Number.parseInt(process.env.AGENT_COMPACT_INTERVAL || '0', 10) || 0,
  usePalace:        process.env.AGENT_USE_PALACE === '1',
  noThinking:       process.env.AGENT_NO_THINKING === '1',

  // voice view (page 6) — fed by daemon `voice` bus events
  voice: {
    events: [],          // newest first, capped in foldVoiceEvent
    speaking: false,
    speakingText: '',
    lastHeard: null,
    lastAnswer: null,
    brain: null,         // {arousal, load, confidence} from B1
    pipeline: null,      // probed when the view opens
    pipelineAt: 0,
    animFrame: 0,        // advanced by a timer only while speaking
  },

  // ontology view (page 7) — fed by daemon `ontology` bus events
  ontology: {
    events: [],          // newest first, capped in foldOntologyEvent
    domains: null,       // probed when the view opens / after ingests
    dropDir: '',
    lastGraphPath: '',
    probedAt: 0,
    proposals: [],       // G4 review queue: candidate proposals across domains
    cursor: 0,           // selected row in the review queue (a=approve, x=reject)
  },

  // steps ring buffer (newest first, max 500)
  steps: [],
  stepsScroll: 0,    // rows scrolled up from bottom
  pinnedIdx: null,   // null = live; number = pinned step index in steps[]
  outputScroll: 0,   // rows scrolled up in output panel

  // cost + latency
  costUsd: 0,
  totalTokens: 0,
  stepLatenciesMs: [],  // last 200 step durations
  costHistory: [],      // last 200 cumulative-cost samples (session-only), for the trend sparkline

  // HITL
  pendingApprovals: [],
  pendingClarifications: [],   // [{id, question, ...}] from /api/pending
  hitlCursor: 0,
  denyInput: '',
  denyInputActive: false,

  // generic scrollable info overlay (memory inspection, clarify list, status)
  infoTitle: '',
  infoLines: [],
  infoScroll: 0,

  // multi-agent
  agentPipeline: null,    // null = single; [{role, status, steps}]
  focusChain: [],         // [{text, state}] the agent's plan items for the cockpit strip
  attachments: [],        // [{path, name, bytes, content, truncated}] dropped files to attach to the next steer

  // ── LLM Council (5th view) ──────────────────────────────────────────────────
  openrouterKey:   process.env.OPENROUTER_API_KEY || '',
  councilModels:   DEFAULT_COUNCIL_MODELS.map(m => ({ ...m })),  // editable lineup [{id,label,on}]
  councilChairman: (DEFAULT_COUNCIL_MODELS.find(m => m.on) || DEFAULT_COUNCIL_MODELS[0]).id,
  council:         null,  // live run snapshot from runCouncil(): {topic,stage,status,members,final,error}
  councilScroll:   0,
  councilCfgOpen:  false,  // lineup editor overlay
  councilCfgIdx:   0,

  // ── Guided model selection (API | Local) + history ──────────────────────────
  modelSource:     ['openai', 'anthropic', 'openrouter'].includes(process.env.AGENT_PROVIDER || '') ? 'api' : 'local',
  keyHistory:      [],     // [{provider, key, last4}] remembered API keys
  recentEndpoints: [],     // [url] remembered local endpoints
  recentModels:    {},     // { [scope]: string[] } recent model ids per provider/endpoint
  fetchedModels:   {},     // { [scope]: string[] } live /v1/models results (session-only)
  pickerOpen:      false,  // the searchable dropdown overlay
  pickerKind:      '',     // 'provider' | 'apiKey' | 'endpoint' | 'model'
  pickerFilter:    '',     // type-to-filter text
  pickerIdx:       0,
  pickerFetching:  false,
  activeRole: null,

  // chat view
  chatMessages: [],       // display entries [{role, content, ts, ...}]
  chatApiMessages: [],    // OpenAI-format messages for LLM context
  chatScroll: 0,          // lines from bottom (0 = latest)
  chatPending: false,     // LLM call in flight
  chatToolApproval: null, // {name, args, callId} when awaiting user approval

  // views
  view: 'live',           // 'live'|'hitl'|'memory'|'metrics'|'chat'
  theme: 'aurora',        // accent theme: 'aurora' | 'ocean' | 'ember' | 'lime' (mono overrides)
  layoutPreset: 'split',  // Live layout: 'split' (3-col) | 'focus' (rail+output+ribbon) | 'wide' (output+spine)
  density: 'comfortable', // 'comfortable' | 'compact' (drops blank sub-lines, tightens INFO)
  prevView: 'live',
  overlay: null,          // null|'steer'|'help'|'session_end'
  steerInput: '',
  sessionEndData: null,

  // command bar input (always-active)
  cmdInput: '',
  cmdInputActive: false,
  cmdHistory: [],
  cmdHistoryIdx: -1,
  cmdSuggestions: [],
  cmdSugIdx: -1,

  // model registry (used by resolveModelChoice + loadSettings custom-model merge)
  modelList: [...BUILTIN_MODELS],
  customModels: [],

  // settings overlay
  settingsOpen: false,
  settingsIdx: 0,
  settingsEditing: null,
  settingsDraft: '',
  showApiKey: false,

  // notification toast
  toast: null,

  // memory view
  memMode: 'temporal',    // 'temporal'|'rooms'|'search'
  memSearch: '',
  memSearchActive: false,
  palaceEvents: [],       // [{step, tool, who, domain, summary, timestamp}]
  memScroll: 0,
  memFocus: 'events',     // 'events'|'skills'|'reflections'
  skills: [],             // [{name, grade, reuse}]
  reflections: [],        // [{episodeId, exit, score, steps, costUsd, ago}]
  rooms: [],              // [{path, eventCount, children}]

  // metrics
  stageMetrics: {},      // stage → {steps, avgLatencyMs, tokens, dollars}
  spend: {               // persistent ledger (kernel/usage.js) — probed on view entry
    probedAt: 0,
    data: null,          // {month, monthly, allTime} from probeSpend()
  },
  controllerInfo: null,  // {mode, fallbackReason, confidence}
  errors: 0,
  hallucinations: 0,
  compactions: 0,
  skillsCreated: 0,
  hitlTotal: 0,
  hitlApproved: 0,
  hitlDenied: 0,

  // splash screen — shown on startup, dismissed on first input or session_start
  showSplash: true,

  // launcher hub (shown on splash in launcher mode)
  launcherTasks: [],       // [{task, ts}] recent tasks for this project
  launcherWorkspaces: [],  // [{root, ts}] recent workspaces (global)
  launcherCursor: 0,       // selected recent-task index

  // internal
  _spinFrame: 0,
  _dirty: true,
  _lastStepMs: 0,
  _toastTimer: null,
};

let _listeners = [];

export function onStateChange(fn) { _listeners.push(fn); }

export function setState(patch) {
  Object.assign(state, patch);
  state._dirty = true;
  for (const fn of _listeners) fn();
}

export function addStep(stepData) {
  state.steps.unshift(stepData);    // newest first
  if (state.steps.length > 500) state.steps.pop();
  state._dirty = true;
}

export function addPalaceEvent(ev) {
  state.palaceEvents.unshift(ev);
  if (state.palaceEvents.length > 300) state.palaceEvents.pop();
  state._dirty = true;
}

export function latencyP(pct) {
  const arr = state.stepLatenciesMs.slice().sort((a, b) => a - b);
  if (!arr.length) return 0;
  return arr[Math.floor(arr.length * pct)] ?? arr[arr.length - 1];
}

export function avgLatency() {
  const arr = state.stepLatenciesMs;
  if (!arr.length) return 0;
  return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
}
