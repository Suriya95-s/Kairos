// src/app.js — render loop, key handling, SSE event dispatch

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFrame, resetFrameBuffer, setActiveTheme, padEnd, visLen, clip, cell, cy, C, gr, y, r, g, bold, dim, vi, bandLR, dboxTop, dboxBot, dboxRow, moveTo, showCursor, hideCursor, altOn, altOff, reducedMotion } from './render.js';
import { state, setState, addStep, avgLatency, latencyP, BUILTIN_MODELS } from './state.js';
import { renderHeader } from './components/header.js';
import { renderCommandBar } from './components/commandBar.js';
import { renderLive } from './views/live.js';
import { renderMemory } from './views/memory.js';
import { renderMetrics, probeSpend } from './views/metrics.js';
import { renderChat } from './views/chat.js';
import { renderCouncil, renderCouncilConfig } from './views/council.js';
import { renderVoice, foldVoiceEvent, probeVoicePipeline } from './views/voice.js';
import { renderOntology, foldOntologyEvent, probeOntology, copyIntoInbox, actOnProposal } from './views/ontology.js';
import { runCouncil, makeOpenRouterCall } from './council.js';
import { getSettingsItems, renderSettings, primeRegistry, activateRegistryModel, PROVIDERS as SETTING_PROVIDERS, PROVIDER_PRESETS as SETTING_PRESETS } from './views/settings.js';
import { renderPicker, filteredItems, fetchModels, modelScope } from './views/picker.js';
import { startKeyListener, KEYS, extractPastePaths } from './keys.js';
import { connectSSE } from './client/sse.js';
import { api, setTokenProvider } from './client/api.js';
import { readWebUiToken } from './client/token.js';
import { resolveBackend } from './client/backend.js';
import { daemonEventAdapter } from './client/daemonEvents.js';
import { externalizeSecrets, resolveSecrets } from './settingsSecrets.js';
import { loadTasks, recordTask, loadWorkspaces, recordWorkspace } from './launcher.js';
import { CHAT_TOOLS, getChatSystemPrompt } from './chatConfig.js';
import { usageReport, historyReport, removePreview, removeForce, runLens } from './commands/ontologyCmds.js';

const SPIN_INTERVAL_MS  = 120;
const RENDER_INTERVAL_MS = 80;  // ~12 FPS
const TUI_MODEL_PATH = path.join(process.cwd(), '.agent', 'tui-model');
const SETTINGS_PATH  = path.join(process.cwd(), '.agent', 'tui-settings.json');
const SLASH_COMMANDS = [
  { cmd: '/live',     description: 'Live view (approvals appear here inline)' },
  { cmd: '/memory',   description: 'Switch to memory view' },
  { cmd: '/metrics',  description: 'Switch to metrics view' },
  { cmd: '/model',    description: 'Switch model (opens picker or /model <name>)' },
  { cmd: '/settings', description: 'Open settings panel' },
  { cmd: '/key',      description: 'Set API key safely (/key <key> or opens settings)' },
  { cmd: '/apikey',   description: 'Alias of /key' },
  { cmd: '/chat',     description: 'Switch to chat view (direct LLM)' },
  { cmd: '/arena',    description: 'AI Arena (/arena <topic> | /arena key <k>)' },
  { cmd: '/council',  description: 'AI Arena (alias of /arena)' },
  { cmd: '/clearchat',description: 'Clear chat message history' },
  { cmd: '/steer',    description: 'Send steering message to agent' },
  { cmd: '/approve',  description: 'Approve a HITL request (/approve [id])' },
  { cmd: '/deny',     description: 'Deny a HITL request (/deny [id] [reason])' },
  { cmd: '/clarify',  description: 'Answer a clarification (/clarify <id> <answer>; bare lists pending)' },
  { cmd: '/pause',    description: 'Pause the agent' },
  { cmd: '/resume',   description: 'Resume the agent' },
  { cmd: '/clear',    description: 'Clear step history in TUI' },
  { cmd: '/export',   description: 'Export metrics to JSON' },
  { cmd: '/usage',    description: 'Spend ledger: tokens + dollars (/usage [YYYY-MM|all])' },
  { cmd: '/history',  description: 'Ontology history (/history [domain] [limit])' },
  { cmd: '/remove',   description: 'Delete an ontology domain (/remove <domain> --force)' },
  { cmd: '/verify',   description: 'Verifier lens, spends tokens: /verify <domain> [model]' },
  { cmd: '/resolve',  description: 'Entity-resolution lens: /resolve <domain> [model]' },
  { cmd: '/critique', description: 'Critic lens: /critique <domain> [model]' },
  { cmd: '/proposals',description: 'Review queue — jump to the Graph view' },
  { cmd: '/layout',   description: 'Cycle Live layout: split / focus / wide' },
  { cmd: '/theme',    description: 'Cycle accent theme: aurora / ocean / ember / lime' },
  { cmd: '/status',   description: 'Show current session status' },
  { cmd: '/help',     description: 'Show keyboard reference' },
  { cmd: '/reconnect',description: 'Reconnect to agent' },
  { cmd: '/run',      description: 'Start agent with a task: /run <task>' },
  { cmd: '/quit',     description: 'Quit the TUI' },
];

// ── Tool approval mechanism ───────────────────────────────────────────────────

let _toolApprovalResolve = null;

function requestToolApproval(toolInfo) {
  return new Promise(resolve => {
    _toolApprovalResolve = resolve;
    setState({ chatToolApproval: toolInfo });
    scheduleRender();
  });
}

function approveTool() {
  if (!_toolApprovalResolve) return;
  setState({ chatToolApproval: null });
  const fn = _toolApprovalResolve;
  _toolApprovalResolve = null;
  fn(true);
  scheduleRender();
}

function denyTool() {
  if (!_toolApprovalResolve) return;
  setState({ chatToolApproval: null });
  const fn = _toolApprovalResolve;
  _toolApprovalResolve = null;
  fn(false);
  scheduleRender();
}

// (Removed dead in-TUI tool executor: `executeTool`/`safePath` had zero callers
// and shipped an unguarded `execSync(args.command)` — a command-injection footgun
// if ever wired up. The TUI is a viewer/controller; tool execution belongs to the
// agent loop, not here.)

// ── Splash screen ────────────────────────────────────────────────────────────

const KAIROS_ART = [
  '  ██╗  ██╗  █████╗  ██╗  ██████╗   ██████╗  ███████╗',
  '  ██║ ██╔╝ ██╔══██╗ ██║  ██╔══██╗ ██╔═══██╗ ██╔════╝',
  '  █████╔╝  ███████║ ██║  ██████╔╝ ██║   ██║ ███████╗',
  '  ██╔═██╗  ██╔══██║ ██║  ██╔══██╗ ██║   ██║ ╚════██║',
  '  ██║  ██╗ ██║  ██║ ██║  ██║  ██║ ╚██████╔╝ ███████║',
  '  ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝  ╚═╝  ╚═════╝  ╚══════╝',
];

/**
 * The next incomplete onboarding step, or null when set up (redesign §7). Drives
 * the active splash wizard: provider/key (API) or endpoint (Local) → model.
 * Exported for tests.
 */
export function nextSetupStep() {
  if (state.modelSource === 'local') {
    if (!state.serverUrl) return 'endpoint';
    if (!state.model)     return 'model';
    return null;
  }
  if (!state.apiKey) return 'apiKey';
  if (!state.model)  return 'model';
  return null;
}

/**
 * Setup checklist lines for the splash (Workstream D). Reflects whether a model
 * and a credential/endpoint are configured, with the key that fixes each gap.
 * Exported for tests. Returns styled lines (centering is the caller's job).
 */
export function buildSetupChecklist() {
  const ok = (b) => (b ? g('✓') : r('✗'));
  const apiMode = state.modelSource !== 'local';
  const hasModel = !!state.model;
  const credLabel = apiMode ? 'API key' : 'Endpoint';
  const credVal = apiMode ? state.apiKey : state.serverUrl;
  const hasCred = !!credVal;
  const credShown = apiMode
    ? (hasCred ? 'set' : 'none')
    : (hasCred ? credVal : 'none');
  return [
    `  ${ok(hasModel)} ${bold('Model')}     ${gr('[M]')}  ${hasModel ? C.cyan + state.model + C.reset : gr('not set')}`,
    `  ${ok(hasCred)} ${bold(credLabel.padEnd(8))} ${gr('[,]')}  ${hasCred ? gr(credShown) : gr('none')}`,
    `  ${gr('•')} ${bold('Run a task')} ${gr('[r]')}  ${gr('or type a task + Enter')}`,
  ];
}

function renderSplash(W, H) {
  const lines = [];
  const ART_W = 54;
  const sub   = 'Autonomous Agent Loop  ·  Intelligence in Motion';
  const hint  = _launcherMode
    ? 'Type your task and press Enter to start the agent'
    : 'Type a task or  /  for commands  ·  Press any key to begin';

  // Status indicator
  let statusLine;
  if (state.connected) {
    statusLine = `${C.green}●${C.reset}  Connected on port ${state.port}`;
  } else if (state.connecting) {
    const spin = reducedMotion() ? '▷' : ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'][state._spinFrame % 10];
    statusLine = `${C.yellow}${spin}${C.reset}  Connecting to agent...`;
  } else {
    statusLine = `${C.grey}●  No agent connected — open TUI standalone${C.reset}`;
  }

  const blockH = KAIROS_ART.length + 6;
  const topPad = Math.max(2, Math.floor((H - blockH) / 2));

  for (let i = 0; i < topPad; i++) lines.push('');

  // KAIROS art centered in violet
  for (const line of KAIROS_ART) {
    const pad = Math.max(0, Math.floor((W - ART_W) / 2));
    lines.push(C.violet + ' '.repeat(pad) + line + C.reset);
  }

  lines.push('');

  // Subtitle
  const subPad = Math.max(0, Math.floor((W - visLen(sub)) / 2));
  lines.push(C.grey + ' '.repeat(subPad) + sub + C.reset);

  lines.push('');

  // Status
  const stLen = visLen(statusLine);
  const stPad = Math.max(0, Math.floor((W - stLen) / 2));
  lines.push(' '.repeat(stPad) + statusLine);

  // Setup checklist (Workstream D) — guide first-run config.
  lines.push('');
  for (const cl of buildSetupChecklist()) {
    const clPad = Math.max(0, Math.floor((W - visLen(cl)) / 2));
    lines.push(' '.repeat(clPad) + cl);
  }

  // Actionable connectivity diagnostic (when disconnected)
  if (!state.connected && !state.connecting && state.connDiag) {
    lines.push('');
    for (const dl of state.connDiag.split('\n')) {
      const wrapped = dl.length > W - 6 ? dl.slice(0, W - 7) + '…' : dl;
      const dPad = Math.max(0, Math.floor((W - visLen(wrapped)) / 2));
      lines.push(C.yellow + ' '.repeat(dPad) + wrapped + C.reset);
    }
    const retryHint = '[R] retry connection';
    const rPad = Math.max(0, Math.floor((W - retryHint.length) / 2));
    lines.push(C.grey + ' '.repeat(rPad) + retryHint + C.reset);
  }

  lines.push('');

  // Launcher hub: recent tasks (selectable) + recent workspaces.
  if (_launcherMode && (state.launcherTasks.length || state.launcherWorkspaces.length)) {
    const center = (s) => {
      const pad = Math.max(0, Math.floor((W - visLen(s)) / 2));
      return ' '.repeat(pad) + s;
    };
    if (state.launcherTasks.length) {
      lines.push(center(`${C.bold}Recent tasks${C.reset}  ${gr('(↑↓ select · Enter run)')}`));
      state.launcherTasks.slice(0, 6).forEach((t, i) => {
        const selected = i === state.launcherCursor;
        const marker = selected ? `${C.cyan}${C.bold}❯${C.reset} ` : '  ';
        const txt = t.task.length > 56 ? t.task.slice(0, 56) + '…' : t.task;
        const col = selected ? C.white : C.grey;
        lines.push(center(`${marker}${col}${txt}${C.reset}`));
      });
      lines.push('');
    }
    if (state.launcherWorkspaces.length > 1) {
      lines.push(center(`${C.bold}Recent workspaces${C.reset}`));
      state.launcherWorkspaces.slice(0, 3).forEach((w) => {
        const name = w.root.split(/[\\/]/).filter(Boolean).slice(-1)[0] || w.root;
        const current = path.resolve(w.root) === path.resolve(_agentRoot);
        lines.push(center(`${current ? C.green + '● ' : C.grey + '○ '}${name}${C.reset}`));
      });
      lines.push('');
    }
  }

  // Hint
  const hubHint = _launcherMode && state.launcherTasks.length
    ? 'Type a task to start fresh  ·  ↑↓ + Enter to re-run  ·  Tab to resume last session'
    : hint;
  const hPad = Math.max(0, Math.floor((W - visLen(hubHint)) / 2));
  lines.push(C.grey + ' '.repeat(hPad) + hubHint + C.reset);

  // Fill remaining
  while (lines.length < H) lines.push('');

  return lines.slice(0, H);
}

let stopKeys = null;
let stopSSE  = null;
let _renderScheduled = false;
let _spinTimer = null;
let _renderTimer = null;
let _onResize = null;
let _onCont = null;
let _restored = false;
let _launcherMode = false;
let _agentRoot = '';

// Phase 3.6 — which backend to attach to, and (when it is the daemon) which of
// its missions this window is following. Module-level rather than in `state`
// because they are process configuration, not render state.
let _backendPreference  = 'auto';   // 'auto' | 'daemon' | 'legacy'
let _attachedMissionId  = null;     // null = follow every mission

/** Follow a single daemon mission, or null for all of them. */
export function attachToMission(missionId) {
  _attachedMissionId = missionId || null;
  connectAgent(state.port);
  return _attachedMissionId;
}

export function startApp(port, compact, launcher = false, root = '', backend = 'auto') {
  _backendPreference = backend || 'auto';
  _launcherMode = launcher;
  _agentRoot = root || process.cwd();
  loadSettings();
  // Launcher hub: load recent tasks (this project) + workspaces (global) and
  // record this workspace as recently used.
  if (_launcherMode) {
    recordWorkspace(_agentRoot);
    setState({ launcherTasks: loadTasks(_agentRoot), launcherWorkspaces: loadWorkspaces(), launcherCursor: 0 });
  }
  process.stdout.write(altOn);  // switch to alternate screen
  process.stdout.write('\x1b[2J');
  process.stdout.write('\x1b[?2004h');  // enable bracketed paste (F-3 file drop)

  stopKeys = startKeyListener(handleKey);
  connectAgent(state.port || port);

  // Spinner + render tick
  _spinTimer = setInterval(() => {
    state._spinFrame = (state._spinFrame + 1) % 10;
    if (state.status === 'running' || state.showSplash || state.chatPending) scheduleRender();
  }, SPIN_INTERVAL_MS);

  _renderTimer = setInterval(() => {
    if (_renderScheduled) {
      _renderScheduled = false;
      render();
    }
  }, RENDER_INTERVAL_MS);

  // Wave E-4: reflow on terminal resize instead of waiting for the next idle tick.
  // Drop the diff buffer (dimensions changed) and repaint immediately.
  _onResize = () => { resetFrameBuffer(); scheduleRender(); };
  process.stdout.on('resize', _onResize);

  // Recover after the process is suspended/resumed (Ctrl+Z → fg, terminal suspend,
  // some sleep/wake paths). On SIGCONT the tty often drops back to cooked mode and
  // leaves the alternate screen, so input "freezes" and the display goes stale.
  // Re-assert raw mode + alt screen + bracketed paste, then force a full repaint.
  _onCont = () => {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdout.write(altOn + '\x1b[?2004h');
    } catch { /* best-effort */ }
    resetFrameBuffer();
    scheduleRender();
  };
  process.on('SIGCONT', _onCont);

  scheduleRender();
}

/**
 * Restore the terminal to a sane state WITHOUT exiting: leave the alternate
 * screen, show the cursor, take stdin out of raw mode, and stop timers/listeners.
 * Idempotent and synchronous so it is safe to call from `process.on('exit')` and
 * from every crash path (uncaughtException / unhandledRejection) — otherwise an
 * async failure would strand the terminal in the alt-screen with a hidden cursor
 * and raw mode still on (an unusable shell).
 */
export function restoreTerminal() {
  if (_restored) return;
  _restored = true;
  try { stopKeys?.(); } catch {}
  try { stopSSE?.(); } catch {}
  if (_spinTimer) clearInterval(_spinTimer);
  if (_renderTimer) clearInterval(_renderTimer);
  if (_onResize) { try { process.stdout.off('resize', _onResize); } catch {} _onResize = null; }
  if (_onCont) { try { process.off('SIGCONT', _onCont); } catch {} _onCont = null; }
  if (state._toastTimer) clearTimeout(state._toastTimer);
  try { process.stdout.write('\x1b[?2004l' + altOff + showCursor); } catch {}  // disable bracketed paste
}

export function stopApp(code = 0) {
  restoreTerminal();
  process.exit(code);
}

function scheduleRender() { _renderScheduled = true; }

// Subsequence fuzzy score over `hay` for `needle`: sum of gap distances, or -1 if
// `needle` is not a subsequence. Lower is a tighter match. Exported for tests.
export function fuzzyScore(needle, hay) {
  let hi = 0, score = 0;
  for (const ch of needle) {
    const idx = hay.indexOf(ch, hi);
    if (idx === -1) return -1;
    score += idx - hi;
    hi = idx + 1;
  }
  return score;
}

// Command palette suggestions (redesign §7): prefix matches first, then fuzzy
// subsequence over the name, then a description-keyword match — so `/exp`→/export,
// `/aprv`→/approve, and `/key`→ the key/apikey commands all surface.
export function buildSuggestions(input) {
  if (!input.startsWith('/')) return [];
  const q = input.split(' ')[0].toLowerCase().slice(1);  // drop the leading '/'
  if (!q) return SLASH_COMMANDS.slice(0, 6);
  const scored = [];
  for (const entry of SLASH_COMMANDS) {
    const name = entry.cmd.slice(1).toLowerCase();
    if (name.startsWith(q)) { scored.push([0 + name.length / 100, entry]); continue; }
    const s = fuzzyScore(q, name);
    if (s >= 0) { scored.push([1 + s, entry]); continue; }
    if (entry.description.toLowerCase().includes(q)) scored.push([50, entry]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  return scored.slice(0, 6).map(([, e]) => e);
}

function persistModelSelection(modelId) {
  try {
    fs.mkdirSync(path.dirname(TUI_MODEL_PATH), { recursive: true });
    fs.writeFileSync(TUI_MODEL_PATH, `${modelId}\n`);
  } catch {}
}

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    // Secrets live in the vault; the file holds `vault:tui.apiKey`. Resolve for
    // in-memory use, then migrate any key still stored in plaintext by an older
    // build — on load rather than on save, so it happens even if the user never
    // touches their settings again.
    let data = raw;
    resolveSecrets(raw).then(resolved => {
      data = resolved;
      setState({
        ...(resolved.apiKey && { apiKey: resolved.apiKey }),
        ...(resolved.openrouterKey && { openrouterKey: resolved.openrouterKey }),
        ...(Array.isArray(resolved.keyHistory) && { keyHistory: resolved.keyHistory }),
      });
      const hadPlaintext =
        ['apiKey', 'openrouterKey'].some(k => typeof raw[k] === 'string' && raw[k] && !raw[k].startsWith('vault:'))
        || (Array.isArray(raw.keyHistory) && raw.keyHistory.length > 0);
      if (hadPlaintext) saveSettings();
    }).catch(() => { /* keep whatever the synchronous path loaded */ });
    const customModels = Array.isArray(data.customModels) ? data.customModels : [];
    setState({
      ...(data.model     && { model:       data.model }),
      ...(data.serverUrl && { serverUrl:   data.serverUrl }),
      ...(data.apiKey    && { apiKey:      data.apiKey }),
      ...(data.provider  && { provider:    data.provider }),
      ...(typeof data.temperature === 'number' && { temperature: data.temperature }),
      ...(typeof data.maxSteps    === 'number' && { maxSteps:    data.maxSteps }),
      ...(typeof data.port        === 'number' && { port:        data.port }),
      ...(typeof data.contextWindow    === 'number' && { contextWindow:    data.contextWindow }),
      ...(typeof data.maxOutput        === 'number' && { maxOutput:        data.maxOutput }),
      ...(typeof data.memoryWindow     === 'number' && { memoryWindow:     data.memoryWindow }),
      ...(typeof data.compactThreshold === 'number' && { compactThreshold: data.compactThreshold }),
      ...(typeof data.compactInterval  === 'number' && { compactInterval:  data.compactInterval }),
      ...(typeof data.usePalace  === 'boolean' && { usePalace:  data.usePalace }),
      ...(typeof data.noThinking === 'boolean' && { noThinking: data.noThinking }),
      ...(data.openrouterKey   && { openrouterKey:   data.openrouterKey }),
      ...(data.modelSource === 'api' || data.modelSource === 'local' ? { modelSource: data.modelSource } : {}),
      ...((data.theme === 'aurora' || data.theme === 'ocean' || data.theme === 'ember' || data.theme === 'lime') ? { theme: data.theme } : {}),
      ...((data.layoutPreset === 'split' || data.layoutPreset === 'focus' || data.layoutPreset === 'wide') ? { layoutPreset: data.layoutPreset } : {}),
      ...((data.density === 'comfortable' || data.density === 'compact') ? { density: data.density } : {}),
      ...(Array.isArray(data.keyHistory)      && { keyHistory:      data.keyHistory }),
      ...(Array.isArray(data.recentEndpoints) && { recentEndpoints: data.recentEndpoints }),
      ...(data.recentModels && typeof data.recentModels === 'object' && { recentModels: data.recentModels }),
      ...(Array.isArray(data.councilModels) && data.councilModels.length && { councilModels: data.councilModels }),
      ...(data.councilChairman && { councilChairman: data.councilChairman }),
      customModels,
      modelList: [...customModels, ...BUILTIN_MODELS],
    });
    setActiveTheme(state.theme || 'aurora');
  } catch {}
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    // 0600 is still set, but it is no longer what protects the key: Windows
    // reports this file as 666 whatever we ask for. The key itself now lives in
    // the encrypted vault and this file holds only a `vault:` reference.
    writeSettingsFile({
      model:        state.model,
      serverUrl:    state.serverUrl,
      apiKey:       state.apiKey,
      provider:     state.provider,
      temperature:  state.temperature,
      maxSteps:     state.maxSteps,
      port:         state.port,
      contextWindow:    state.contextWindow,
      maxOutput:        state.maxOutput,
      memoryWindow:     state.memoryWindow,
      compactThreshold: state.compactThreshold,
      compactInterval:  state.compactInterval,
      usePalace:        state.usePalace,
      noThinking:       state.noThinking,
      customModels: state.customModels,
      openrouterKey:   state.openrouterKey,
      modelSource:     state.modelSource,
      theme:           state.theme,
      layoutPreset:    state.layoutPreset,
      density:         state.density,
      keyHistory:      state.keyHistory,
      recentEndpoints: state.recentEndpoints,
      recentModels:    state.recentModels,
      councilModels:   state.councilModels.map(m => ({ id: m.id, label: m.label, on: !!m.on })),
      councilChairman: state.councilChairman,
    });
  } catch {}
}

/**
 * Persist settings with credentials externalised to the vault.
 *
 * Async under a synchronous caller on purpose: saveSettings() is called from
 * key handlers where blocking would drop input. A failed write is logged into
 * the settings-status line rather than thrown.
 */
function writeSettingsFile(settings) {
  externalizeSecrets(settings).then(({ settings: safe }) => {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(safe, null, 2), { mode: 0o600 });
    try { fs.chmodSync(SETTINGS_PATH, 0o600); } catch { /* non-POSIX */ }
  }).catch(() => {
    // Vault unavailable: fall back to the previous behaviour rather than
    // losing the user's settings entirely.
    try {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });
      fs.chmodSync(SETTINGS_PATH, 0o600);
    } catch { /* nothing further we can do */ }
  });
}

// ── Guided picker (provider / apiKey / endpoint / model) ──────────────────────
function openPicker(kind) {
  setState({ pickerOpen: true, pickerKind: kind, pickerFilter: '', pickerIdx: 0, settingsOpen: false });
  scheduleRender();
}

function pushHistory(kind, val) {
  if (kind === 'key') {
    const { provider, key } = val;
    const l4 = key.length <= 4 ? key : '…' + key.slice(-4);
    const hist = [{ provider, key, last4: l4 }, ...(state.keyHistory || []).filter(k => !(k.provider === provider && k.key === key))].slice(0, 10);
    setState({ keyHistory: hist });
  } else if (kind === 'endpoint') {
    setState({ recentEndpoints: [val, ...(state.recentEndpoints || []).filter(e => e !== val)].slice(0, 8) });
  } else if (kind === 'model') {
    const scope = modelScope();
    const cur = (state.recentModels && state.recentModels[scope]) || [];
    setState({ recentModels: { ...(state.recentModels || {}), [scope]: [val, ...cur.filter(m => m !== val)].slice(0, 8) } });
  }
}

function applyPicker(kind, value) {
  const v = String(value || '').trim();
  if (kind === 'provider') {
    const preset = SETTING_PRESETS[v];
    setState({ provider: v, ...(preset ? { serverUrl: preset } : {}), pickerOpen: false, pickerFilter: '' });
    saveSettings(); showToast(`Provider: ${v}`, 'green');
  } else if (kind === 'apiKey') {
    if (v) {
      pushHistory('key', { provider: state.provider, key: v });
      const orSync = state.provider === 'openrouter' ? { openrouterKey: v } : {};
      setState({ apiKey: v, ...orSync, pickerOpen: false, pickerFilter: '' });
      saveSettings(); showToast('API key set', 'green');
    } else setState({ pickerOpen: false, pickerFilter: '' });
  } else if (kind === 'endpoint') {
    if (v) { pushHistory('endpoint', v); setState({ serverUrl: v, pickerOpen: false, pickerFilter: '' }); saveSettings(); showToast(`Endpoint: ${v}`, 'green'); }
    else setState({ pickerOpen: false, pickerFilter: '' });
  } else if (kind === 'model') {
    if (v) { pushHistory('model', v); persistModelSelection(v); setState({ model: v, pickerOpen: false, pickerFilter: '' }); saveSettings(); showToast(`Model: ${v}`, 'green'); }
    else setState({ pickerOpen: false, pickerFilter: '' });
  } else if (kind === 'arenaAdd') {
    if (v) {
      const exists = state.councilModels.some(m => m.id === v);
      if (!exists) {
        const label = (v.split('/').pop() || v).replace(/:free$/, '').slice(0, 24);
        setState({ councilModels: [...state.councilModels, { id: v, label, on: true }] });
      }
      setState({ pickerOpen: false, pickerFilter: '' });
      saveSettings();
      showToast(exists ? `Already in lineup: ${v}` : `Added to Arena: ${v}`, exists ? 'yellow' : 'green');
    } else setState({ pickerOpen: false, pickerFilter: '' });
  }
  scheduleRender();
}

// Tab in the model picker: fetch the live list from the endpoint's /v1/models.
async function refreshPickerModels() {
  if (state.pickerFetching) return;
  // The Arena picker fetches OpenRouter's catalog (it runs on OpenRouter); the
  // model picker fetches from the active provider/endpoint.
  const arena = state.pickerKind === 'arenaAdd';
  const baseURL = arena
    ? 'https://openrouter.ai/api/v1'
    : (state.modelSource === 'api' ? (SETTING_PRESETS[state.provider] || state.serverUrl) : state.serverUrl);
  const key = arena ? state.openrouterKey : (state.modelSource === 'api' ? state.apiKey : '');
  if (!baseURL) { showToast('Set a provider/endpoint first', 'red'); return; }
  setState({ pickerFetching: true }); scheduleRender();
  try {
    const ids = await fetchModels(baseURL, key);
    const scope = arena ? 'openrouter' : modelScope();
    setState({ fetchedModels: { ...(state.fetchedModels || {}), [scope]: ids }, pickerFetching: false });
    showToast(`Fetched ${ids.length} model(s)`, 'green');
  } catch (err) {
    setState({ pickerFetching: false });
    showToast(`Fetch failed: ${describeFetchError(err, `${baseURL}/models`)}`, 'red');
  }
  scheduleRender();
}

function resolveModelChoice(input) {
  const needle = input.trim().toLowerCase();
  if (!needle) return null;
  return state.modelList.find(model =>
    model.id.toLowerCase() === needle ||
    model.label.toLowerCase() === needle ||
    model.id.toLowerCase().includes(needle) ||
    model.label.toLowerCase().includes(needle)
  ) || null;
}


function showToast(message, colour = 'green') {
  if (state._toastTimer) clearTimeout(state._toastTimer);
  const timer = setTimeout(() => {
    setState({ toast: null, _toastTimer: null });
    scheduleRender();
  }, 3000);
  setState({ toast: { message, colour }, _toastTimer: timer });
  scheduleRender();
}

// Open a scrollable info overlay with arbitrary preformatted text.
// Used for memory inspection output, clarification lists, and status dumps.
function openInfo(title, text) {
  const lines = String(text || '').split('\n');
  setState({ overlay: 'info', infoTitle: title || 'INFO', infoLines: lines, infoScroll: 0 });
  scheduleRender();
}

// The store changed under us (/remove, a finished lens run) — reprobe so the
// Graph view's domain table and review queue agree with it.
function refreshOntologyProbe() {
  probeOntology()
    .then(p => {
      state.ontology.dropDir = p.dropDir;
      state.ontology.domains = p.domains;
      state.ontology.proposals = p.proposals;
      state.ontology.cursor = Math.min(state.ontology.cursor || 0, Math.max(0, p.proposals.length - 1));
      state.ontology.probedAt = Date.now();
      scheduleRender();
    })
    .catch(() => {});
}

function activateCmdInput(initialChar) {
  setState({
    cmdInputActive: true,
    cmdInput: initialChar,
    cmdSuggestions: buildSuggestions(initialChar),
    cmdSugIdx: -1,
    cmdHistoryIdx: -1,
  });
  scheduleRender();
}

const ATTACH_MAX_FILES = 5;
const ATTACH_MAX_BYTES = 64 * 1024; // per file

// F-3: handle a paste/drop. If the paste names real files, attach their contents
// (to be injected with the next steer); otherwise treat it as text into the input.
function handlePaste(text) {
  // The picker is a modal text field (API key / model / endpoint). A paste here is
  // always the field value — never a file drop — so route it straight to the filter.
  if (state.pickerOpen) {
    const clean = String(text || '').replace(/[\r\n]+/g, ' ').trim();
    if (clean) { setState({ pickerFilter: state.pickerFilter + clean, pickerIdx: 0 }); scheduleRender(); }
    return;
  }
  // Page 7: a drop while the Ontology view is open (and no input is active)
  // means "build knowledge from this" — files AND folders go to the inbox,
  // not to the steer attachments. The daemon announces the rest in ACTIVITY.
  if (state.view === 'ontology' && !state.cmdInputActive && state.overlay !== 'steer' && !state.denyInputActive) {
    const real = extractPastePaths(text).filter((p) => {
      try { return path.isAbsolute(p) && !!fs.statSync(p); } catch { return false; }
    });
    if (real.length) {
      void copyIntoInbox(real).then((results) => {
        const ok = results.filter((r) => r.ok);
        const bad = results.find((r) => !r.ok);
        if (ok.length) showToast(`📥 ${ok.length} item(s) → ontology inbox — ingest lands in ACTIVITY`, 'green');
        if (bad) showToast(`✗ ${bad.name}: ${bad.reason}`, 'yellow');
        scheduleRender();
      });
      return;
    }
  }
  const added = [];
  for (const p of extractPastePaths(text)) {
    if (state.attachments.length + added.length >= ATTACH_MAX_FILES) break;
    try {
      const abs = path.isAbsolute(p) ? p : path.join(_agentRoot || process.cwd(), p);
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      if (state.attachments.some(a => a.path === abs) || added.some(a => a.path === abs)) continue;
      const content = fs.readFileSync(abs).slice(0, ATTACH_MAX_BYTES).toString('utf8');
      added.push({ path: abs, name: path.basename(abs), bytes: st.size, content, truncated: st.size > ATTACH_MAX_BYTES });
    } catch { /* not a readable file — ignore */ }
  }
  if (added.length) {
    setState({ attachments: [...state.attachments, ...added].slice(0, ATTACH_MAX_FILES) });
    showToast(`📎 attached ${added.length} file(s) — type a message + Enter to send`, 'green');
    scheduleRender();
    return;
  }
  // Not files → insert the text into whichever input is active (also fixes plain
  // multi-line paste). Collapse newlines so a paste stays one input line.
  const clean = String(text || '').replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return;
  if (state.denyInputActive)          setState({ denyInput: state.denyInput + clean });
  else if (state.overlay === 'steer') setState({ steerInput: state.steerInput + clean });
  else if (state.memSearchActive)     setState({ memSearch: state.memSearch + clean });
  else if (state.settingsEditing)     setState({ settingsDraft: state.settingsDraft + clean });
  else if (state.cmdInputActive)      setState({ cmdInput: state.cmdInput + clean, cmdSuggestions: buildSuggestions(state.cmdInput + clean) });
  else activateCmdInput(clean);
  scheduleRender();
}

function shouldUseCommandInput(char) {
  if (!char) return false;
  if (char === '/') return true;
  if (['?', ',', '1', '2', '3', '4', '5', '6', 'Q', 'P', 'S', 'M', 'R'].includes(char)) {
    return false;
  }
  const lower = char.toLowerCase();
  // a/d are handled globally as approve/deny ONLY while an approval is pending;
  // otherwise they're ordinary typed characters.
  if (state.view === 'memory' && ['t', 'r', 'f'].includes(lower)) return false;
  if (state.view === 'metrics' && lower === 'e') return false;
  if (state.view === 'council' && lower === 'm') return false;  // 'm' opens the lineup editor
  // Page 7 review queue: a/x act on the selected proposal (G4) — but only
  // while the queue is showing and no HITL approval wants the same keys.
  if (state.view === 'ontology' && ['a', 'x'].includes(lower)
    && (state.ontology.proposals || []).length && !state.pendingApprovals.length) return false;
  return true;
}

function beginSettingsEdit() {
  const items = getSettingsItems();
  const item = items[state.settingsIdx];
  if (!item) return;

  // Registry rows: Enter makes that model the system-wide default — the same
  // write `kairos llm use <name>` performs, through the same module.
  if (item.kind === 'action' && item.registryName) {
    if (item.registryActive) { showToast(`${item.registryName} is already active`, 'green'); return; }
    activateRegistryModel(item.registryName)
      .then(entry => {
        showToast(`Default model: ${item.registryName} (${entry.model}) — daemon picks it up on restart`, 'green');
        scheduleRender();
      })
      .catch(e => showToast(`could not activate: ${e.message}`, 'red'));
    return;
  }

  // pick → open the searchable dropdown for that field.
  if (item.kind === 'pick') {
    openPicker(item.key === 'serverUrl' ? 'endpoint' : item.key); // provider | apiKey | model | endpoint
    return;
  }

  // cycle → flip the API ↔ Local source toggle.
  if (item.kind === 'cycle') {
    if (item.key === 'theme') {
      const order = ['aurora', 'ocean', 'ember', 'lime'];
      const next = order[(order.indexOf(state.theme || 'aurora') + 1) % order.length];
      setState({ theme: next });
      setActiveTheme(next);
      resetFrameBuffer();
      saveSettings();
      showToast(`Theme: ${next}`, 'green');
      return;
    }
    if (item.key === 'density') {
      const next = state.density === 'compact' ? 'comfortable' : 'compact';
      setState({ density: next });
      resetFrameBuffer();
      saveSettings();
      showToast(`Density: ${next}`, 'green');
      return;
    }
    setState({ modelSource: state.modelSource === 'api' ? 'local' : 'api' });
    saveSettings();
    showToast(`Source: ${state.modelSource === 'api' ? 'API' : 'Local'}`, 'green');
    return;
  }

  if (item.kind === 'toggle') {
    const next = !state[item.key];
    setState({ [item.key]: next });
    saveSettings();
    const labelOn = item.key === 'noThinking' ? !next : next; // "Thinking" shows inverse of noThinking
    showToast(`${item.label}: ${labelOn ? 'on' : 'off'} (applies on next /run)`, 'green');
    return;
  }

  // numeric/text/secret → inline edit. Secret fields edit the real value, not dots.
  const draft = item.secret
    ? state[item.key] || ''
    : (item.value === '(none)' || item.value === '(default)' ? '' : item.value);
  setState({ settingsEditing: item.key, settingsDraft: draft });
  scheduleRender();
}

function saveSettingsEdit() {
  const key = state.settingsEditing;
  const draft = state.settingsDraft.trim();
  if (!key) return;

  if (key === 'serverUrl') {
    setState({ serverUrl: draft, settingsEditing: null, settingsDraft: '' });
    saveSettings();
    showToast('Server URL updated', 'green');
    return;
  }

  if (key === 'apiKey') {
    setState({ apiKey: draft, settingsEditing: null, settingsDraft: '' });
    saveSettings();
    showToast(draft ? 'API key updated' : 'API key cleared', 'green');
    return;
  }

  if (key === 'openrouterKey') {
    setState({ openrouterKey: draft, settingsEditing: null, settingsDraft: '' });
    saveSettings();
    showToast(draft ? 'OpenRouter key updated' : 'OpenRouter key cleared', 'green');
    return;
  }

  if (key === 'temperature') {
    const value = Number.parseFloat(draft);
    if (!Number.isFinite(value)) { showToast('Temperature must be a number', 'red'); return; }
    setState({ temperature: value, settingsEditing: null, settingsDraft: '' });
    saveSettings();
    showToast(`Temperature: ${value}`, 'green');
    return;
  }

  if (key === 'maxSteps') {
    const value = Number.parseInt(draft || '0', 10);
    if (!Number.isFinite(value) || value < 0) { showToast('Max steps must be ≥0', 'red'); return; }
    setState({ maxSteps: value, settingsEditing: null, settingsDraft: '' });
    saveSettings();
    showToast(`Max steps: ${value}`, 'green');
    return;
  }

  // Generic non-negative integer knobs (0 = use agent default)
  const NUMERIC_KNOBS = {
    contextWindow: 'Context window',
    maxOutput: 'Max output',
    memoryWindow: 'Memory window',
    compactThreshold: 'Compaction threshold',
    compactInterval: 'Compaction interval',
  };
  if (NUMERIC_KNOBS[key]) {
    const value = Number.parseInt(draft || '0', 10);
    if (!Number.isFinite(value) || value < 0) { showToast(`${NUMERIC_KNOBS[key]} must be ≥0`, 'red'); return; }
    setState({ [key]: value, settingsEditing: null, settingsDraft: '' });
    saveSettings();
    showToast(`${NUMERIC_KNOBS[key]}: ${value || 'default'} (applies on next /run)`, 'green');
    return;
  }

  if (key === 'port') {
    const value = Number.parseInt(draft, 10);
    if (!Number.isFinite(value) || value <= 0) { showToast('Port must be a positive number', 'red'); return; }
    setState({ port: value, settingsEditing: null, settingsDraft: '', settingsOpen: false });
    saveSettings();
    connectAgent(value);
    showToast(`Port set to ${value} — reconnecting`, 'green');
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

// Pure frame composer (Wave E-1): builds the base frame's line array from the
// current state without any terminal I/O. The overlays (steer/help/pickers/toast)
// are drawn on top afterward by render(). Exposed so golden-frame tests can feed a
// known state and snapshot the result, guarding the E-2 split against regressions.
// Narrow-terminal degradation (Wave E-4): below the 3-column layout's minimum,
// drop to a single-band frame that keeps the two operator-critical jobs working —
// situational awareness (status + current step) and intervention (pending approval
// + global keys) — instead of the old hard-fail "terminal too narrow" message.
// Usable down to ~40 columns (a phone SSH session can still approve a request).
function composeNarrowFrame(W, H) {
  const lines = [];
  const dot = state.status === 'running'   ? g('▶')
            : state.status === 'paused'    ? y('‖')
            : state.status === 'error'     ? r('✗')
            : state.status === 'completed' ? cy('✓')
            : gr('·');
  lines.push(padEnd(clip(` ${bold('KAIROS')} ${dot} ${gr('step ' + state.step)}`, W), W));
  lines.push(padEnd(gr('─'.repeat(Math.max(0, Math.min(W, 80)))), W));
  lines.push(padEnd(clip(` ${gr('task:')} ${state.task}`, W), W));

  const cur = state.steps[0];
  if (cur) {
    lines.push('');
    lines.push(padEnd(clip(` ${y('▶ NOW')} ${cur.tool}${cur.arg ? ' ' + cur.arg : ''}`, W), W));
    if (cur.thought) lines.push(padEnd(clip(`   ${gr(cur.thought)}`, W), W));
  }

  if (state.pendingApprovals.length) {
    const a = state.pendingApprovals[0];
    lines.push('');
    lines.push(padEnd(clip(` ${y('⚠ APPROVAL')} ${a.tool}`, W), W));
    lines.push(padEnd(clip(`   ${a.reason || ''}`, W), W));
    lines.push(padEnd(` ${g('[a]pprove')}  ${r('[d]eny')}`, W));
  }

  while (lines.length < H - 1) lines.push('');
  lines.length = Math.max(0, H - 1);
  lines.push(padEnd(clip(gr(' [space] pause  [?] help  [Q] quit · narrow mode'), W), W));
  return lines.slice(0, H);
}

// The NOW band (§7.2 rule 1: "the current step is sacred" · redesign §5/§7). The
// lone warm region — what the agent is doing right now, across every view. The slot
// is ALWAYS reserved (two rows) so the work area never jumps; when idle it shows a
// calm dim placeholder instead of collapsing. Empty only on the splash.
function renderNowBand(W) {
  if (state.showSplash) return [];
  const cur = state.steps[0];
  if (cur && state.status === 'running') {
    const elapsed = cur.startMs ? `${((Date.now() - cur.startMs) / 1000).toFixed(1)}s` : '';
    const spin = reducedMotion() ? '▷' : '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[state._spinFrame % 10];
    const left = ` ${C.amber}${spin}${C.reset}  ${C.bold}${C.amber}NOW${C.reset}  ${C.ink}${cur.tool}${C.reset}`
      + (cur.arg ? ` ${C.ink4}·${C.reset} ${C.ink2}${clip(cur.arg, 40)}${C.reset}` : '');
    const right = elapsed ? `${C.amber}⏱ ${elapsed}${C.reset} ` : '';
    const sub = cur.thought
      ? padEnd(`       ${C.amber}↳ ${C.reset}${C.ink3}${clip(cur.thought, W - 10)}${C.reset}`, W)
      : padEnd('', W);
    return [bandLR(left, right, W), sub];
  }
  // Reserved idle placeholder — the slot persists so layout rhythm stays stable.
  return [padEnd(` ${C.ink4}·  idle · waiting for next step${C.reset}`, W), padEnd('', W)];
}

// The focus-chain strip (§7.2 · redesign §5/§7): the agent's own plan, current item
// highlighted, so drift is visible the moment it happens. ALWAYS reserved (one row);
// shows "(no active plan)" when idle. Empty only on the splash.
function renderFocusStrip(W) {
  if (state.showSplash) return [];
  if (!Array.isArray(state.focusChain) || state.focusChain.length === 0) {
    return [padEnd(` ${C.ink3}plan${C.reset}  ${C.ink4}(no active plan)${C.reset}`, W)];
  }
  const parts = state.focusChain.map((it) => {
    const t = String(it.text || '').slice(0, 28);
    if (it.state === 'done')    return `${C.ink4}✓ ${t}${C.reset}`;
    if (it.state === 'current') return `${C.amber}▸ ${C.reset}${C.bold}${C.ink}${t}${C.reset}`;
    if (it.state === 'blocked') return `${C.coral}⚠ ${t}${C.reset}`;
    return `${C.ink4}· ${t}${C.reset}`;
  });
  return [padEnd(clip(` ${C.ink3}plan${C.reset}  ${parts.join('  ')}`, W), W)];
}

// ── Docked approval interrupt (redesign §4) ───────────────────────────────────
// A double-ruled bar that replaces the NOW slot on EVERY view. Escalates by
// border WEIGHT + glyph MULTIPLICITY + text — never by blink or color-only — so it
// reads with zero color (mono) and zero motion (reduced-motion). Exported for tests.
export function renderApprovalDock(W) {
  const list = state.pendingApprovals;
  const n = list.length;
  const i = Math.min(Math.max(0, state.hitlCursor || 0), n - 1);
  const a = list[i] || {};
  const argsStr = a.args ? (typeof a.args === 'string' ? a.args : JSON.stringify(a.args)) : '';

  const remMs = (a.timeoutMs || 0) - (Date.now() - (a.timestamp || Date.now()));
  // Escalation level: 0 calm · 1 (<15m) · 2 (<1m). Drives glyph count + weight + text.
  const level = a.timeoutMs ? (remMs <= 60000 ? 2 : remMs <= 15 * 60000 ? 1 : 0) : 0;
  const warn = '⚠'.repeat(level + 1);                      // ⚠ / ⚠⚠ / ⚠⚠⚠ — survives mono
  const bcol = level >= 1 ? C.coral : C.amber;             // reinforcement only
  const bbold = level >= 2 ? C.bold : '';                  // "heaviest available" weight
  const remStr = remMs > 0
    ? `${Math.floor(remMs / 60000)}m${Math.floor((remMs % 60000) / 1000)}s left`
    : 'expired';
  const remShown = level >= 2 ? `${C.bold}⏱ <1m${C.reset}` : `${C.amber}⏱ ${remStr}${C.reset}`;

  const border = (l, mid, rr) => `${bbold}${bcol}${l}${mid.repeat(W - 2)}${rr}${C.reset}`;
  const dline = (inner) => `${bbold}${bcol}║${C.reset}${cell(inner, W - 2)}${bbold}${bcol}║${C.reset}`;

  const head = ` ${bcol}${warn}${C.reset}  ${C.bold}${C.amber}APPROVAL REQUIRED${C.reset}`
    + (n > 1 ? `   ${C.ink3}(${i + 1}/${n})${C.reset}` : '')
    + `   ${C.ink2}${a.tool || '?'}${C.reset}`
    + (argsStr ? `   ${C.coral}${clip(argsStr, Math.max(0, W - 40))}${C.reset}` : '');
  const why = `     ${C.ink3}why${C.reset}  ${C.ink2}${clip(a.reason || '(no reason provided)', Math.max(0, W - 12))}${C.reset}`;
  const actions = state.denyInputActive
    ? `     ${C.coral}deny reason:${C.reset} ${state.denyInput || ''}${C.bold}█${C.reset}   ${C.ink4}[Enter] send  [Esc] cancel${C.reset}`
    : `     ${remShown}      ${C.bold}${C.jade}[a]${C.reset}${C.jade}pprove${C.reset}   ${C.bold}${C.coral}[d]${C.reset}${C.coral}eny${C.reset}`
      + (n > 1 ? `   ${C.ink3}[←→]${C.reset} ${C.ink4}${i + 1}/${n}${C.reset}` : '');

  return [border('╔', '═', '╗'), dline(head), dline(why), dline(actions), border('╚', '═', '╝')];
}

export function composeFrame(W, H) {
  if (W < 60) return composeNarrowFrame(W, H);
  const header = renderHeader(W);
  // Redesign §4: a pending approval DOCKS into the top band on every view, owning
  // the NOW slot so it can never be scrolled away or missed from Memory/Metrics/Chat.
  const topBand = (!state.showSplash && state.pendingApprovals && state.pendingApprovals.length)
    ? renderApprovalDock(W)
    : renderNowBand(W);
  const focusStrip = renderFocusStrip(W);
  const cmdBar = renderCommandBar(W);
  const viewH = H - 1 - topBand.length - focusStrip.length - cmdBar.length;

  let viewLines;
  if (state.showSplash) {
    viewLines = renderSplash(W, viewH);
  } else {
    switch (state.view) {
      case 'memory':  viewLines = renderMemory(W, viewH);  break;
      case 'metrics': viewLines = renderMetrics(W, viewH); break;
      case 'chat':    viewLines = renderChat(W, viewH);    break;
      case 'council': viewLines = renderCouncil(W, viewH); break;
      case 'voice':   viewLines = renderVoice(W, viewH);   break;
      case 'ontology': viewLines = renderOntology(W, viewH); break;
      default:        viewLines = renderLive(W, viewH);    break;
    }
  }
  return [header, ...topBand, ...padViewLines(viewLines, viewH, W), ...focusStrip, ...cmdBar];
}

function render() {
  const W = Math.max(40, process.stdout.columns || 120);
  const H = Math.max(10, process.stdout.rows    || 40);

  // Wave E-4: no more hard-fail under 60 columns — composeFrame degrades to a
  // single-band narrow layout that keeps NOW + intervention usable.
  writeFrame(composeFrame(W, H), W);

  // Overlays draw directly over the base frame; if any was drawn, the diff buffer
  // no longer reflects the screen, so force the next frame to fully repaint (which
  // clears the overlay residue once it closes).
  let overlayDrawn = false;
  const cmdBarLen = renderCommandBar(W).length;
  if (state.overlay === 'steer' || state.overlay === 'help' || state.overlay === 'session_end' || state.overlay === 'info') {
    renderOverlay(W, H); overlayDrawn = true;
  }
  if (state.settingsOpen)      { renderSettings(W, H);    overlayDrawn = true; }
  if (state.pickerOpen)        { renderPicker(W, H);      overlayDrawn = true; }
  if (state.councilCfgOpen)    { renderCouncilConfig(W, H); overlayDrawn = true; }
  if (state.chatToolApproval)  { renderChatApprovalOverlay(W, H); overlayDrawn = true; }
  if (state.toast)             { renderToast(W, H, cmdBarLen); overlayDrawn = true; }

  if (overlayDrawn) resetFrameBuffer();
  renderInlineCursor(H, cmdBarLen);
}

function padViewLines(lines, H, W) {
  const result = lines.slice(0, H);
  while (result.length < H) result.push('');
  return result;
}

function renderOverlay(W, H) {
  if (state.overlay === 'steer')        renderSteerOverlay(W, H);
  else if (state.overlay === 'help')    renderHelpOverlay(W, H);
  else if (state.overlay === 'session_end') renderSessionEndOverlay(W, H);
  else if (state.overlay === 'info')    renderInfoOverlay(W, H);
}

function renderInfoOverlay(W, H) {
  const OW = Math.min(100, W - 4);
  const bodyH = Math.max(6, Math.min(state.infoLines.length, H - 6));
  const OH = bodyH + 4;
  const sr = Math.floor((H - OH) / 2);
  const sc = Math.floor((W - OW) / 2);

  const maxScroll = Math.max(0, state.infoLines.length - bodyH);
  const scroll = Math.max(0, Math.min(state.infoScroll, maxScroll));
  const window = state.infoLines.slice(scroll, scroll + bodyH);
  const innerW = OW - 4;

  let out = moveTo(sr, sc) + dboxTop(OW, ` ${state.infoTitle} `);
  window.forEach((line, idx) => {
    // Truncate to inner width on a visible-length basis to avoid breaking the box
    let text = line;
    if (visLen(text) > innerW) text = text.slice(0, innerW - 1) + '…';
    out += moveTo(sr + 1 + idx, sc) + dboxRow(`  ${text}`, OW);
  });
  const footer = `  ${g('[↑↓/PgUp/Dn]')} scroll  ${gr(`${scroll + 1}-${scroll + window.length}/${state.infoLines.length}`)}  ${r('[Esc]')} close`;
  out += moveTo(sr + 1 + bodyH, sc) + dboxRow(footer, OW);
  out += moveTo(sr + 2 + bodyH, sc) + dboxBot(OW);
  process.stdout.write(out + hideCursor);
}

function renderToast(W, H, cmdBarHeight) {
  const { message, colour } = state.toast;
  const col = colour === 'green' ? C.green : colour === 'red' ? C.red : C.yellow;
  const toastStr = ` ${col}${message}${C.reset} `;
  const row = Math.max(2, H - cmdBarHeight);
  const colPos = Math.max(1, W - visLen(toastStr) - 1);
  process.stdout.write(moveTo(row, colPos) + toastStr);
}

function renderInlineCursor(H) {
  if (state.overlay === 'steer') return;
  const inputRow = H - 1;

  if (state.cmdInputActive) {
    process.stdout.write(showCursor + moveTo(inputRow, 4 + visLen(state.cmdInput)));
    return;
  }
  if (state.denyInputActive) {
    process.stdout.write(showCursor + moveTo(inputRow, 16 + visLen(state.denyInput)));
    return;
  }
  if (state.memSearchActive) {
    process.stdout.write(showCursor + moveTo(inputRow, 10 + visLen(state.memSearch)));
  }
}

function renderSteerOverlay(W, H) {
  const OW = Math.min(88, W - 4);
  const OH = 8;
  const sr = Math.floor((H - OH) / 2);
  const sc = Math.floor((W - OW) / 2);

  let out = moveTo(sr, sc) + dboxTop(OW, 'SEND STEERING MESSAGE');
  out += moveTo(sr + 1, sc) + dboxRow('', OW);
  out += moveTo(sr + 2, sc) + dboxRow(`  ${state.steerInput}█`, OW);
  out += moveTo(sr + 3, sc) + dboxRow('', OW);
  out += moveTo(sr + 4, sc) + dboxRow(`  ${g('[Enter]')} Send    ${r('[Esc]')} Cancel`, OW);
  out += moveTo(sr + 5, sc) + dboxRow('', OW);
  out += moveTo(sr + 6, sc) + dboxBot(OW);
  out += showCursor + moveTo(sr + 2, sc + 3 + state.steerInput.length);
  process.stdout.write(out);
}

function renderHelpOverlay(W, H) {
  const pad = (k) => k.padEnd(10);
  const lines = [
    '',
    `  ${bold('GLOBAL')}`,
    `  ${g(pad('1–7'))} ${gr('Live · Memory · Metrics · Chat · AI Arena · Voice · Graph')}`,
    `  ${g(pad(','))} ${gr('Settings')}   ${g(pad('?'))} ${gr('This help')}`,
    `  ${y(pad('Space/P'))} ${gr('Pause/Resume')}   ${g(pad('A'))} ${gr('Approve')}   ${r(pad('D'))} ${gr('Deny')}`,
    `  ${y(pad('S'))} ${gr('Steer')}   ${g(pad('/'))} ${gr('Commands')}   ${r(pad('Q'))} ${gr('Quit')}`,
    '',
    `  ${bold('LIVE')}  ${gr('(approvals appear here inline)')}`,
    `  ${g(pad('↑↓'))} ${gr('Scroll steps')}   ${g(pad('Enter'))} ${gr('Pin output')}   ${g(pad('Esc'))} ${gr('Unpin')}`,
    `  ${g(pad('PgUp/Dn'))} ${gr('Scroll output')}   ${g(pad('M'))} ${gr('Model picker')}   ${g(pad('←→'))} ${gr('Cycle approvals')}`,
    `  ${gr('Type a message + Enter to steer · drop a file to attach')}`,
    '',
    `  ${bold('MEMORY')}`,
    `  ${g(pad('T'))} ${gr('Temporal')}   ${g(pad('R'))} ${gr('Rooms')}   ${g(pad('/'))} ${gr('Search')}   ${g(pad('Tab'))} ${gr('Switch panel')}`,
    '',
    `  ${bold('METRICS')}`,
    `  ${g(pad('E'))} ${gr('Export to .agent/tui-export.json')}`,
    '',
    `  ${bold('COMMANDS')}  ${gr('(type / then Tab to complete)')}`,
    `  ${g('/model')} ${g('/steer')} ${g('/approve')} ${g('/deny')} ${g('/clarify')} ${g('/memory')}`,
    `  ${g('/chat')} ${g('/clearchat')} ${g('/pause')} ${g('/resume')} ${g('/clear')} ${g('/export')}`,
    `  ${g('/status')} ${g('/reconnect')} ${g('/quit')}`,
    '',
    `  ${gr('Accessibility: NO_COLOR / AGENT_TUI_MONO=1 · AGENT_TUI_NO_SPIN=1 · --no-tui (headless)')}`,
    `  ${gr('[any key] close help')}`,
    '',
  ];

  const OW = Math.min(72, W - 4);
  const OH = lines.length + 2;
  const sr = Math.floor((H - OH) / 2);
  const sc = Math.floor((W - OW) / 2);

  let out = moveTo(sr, sc) + dboxTop(OW, ' KAIROS TUI — KEYBOARD REFERENCE ');
  lines.forEach((line, idx) => {
    out += moveTo(sr + 1 + idx, sc) + dboxRow(line, OW);
  });
  out += moveTo(sr + lines.length + 1, sc) + dboxBot(OW);
  process.stdout.write(out + hideCursor);
}

function renderSessionEndOverlay(W, H) {
  const d = state.sessionEndData || {};
  const lines = [
    '',
    `  ${bold('Exit:')}      ${d.exitReason || '—'}`,
    `  ${bold('Steps:')}     ${d.totalSteps || 0}   Cost: $${(state.costUsd).toFixed(3)}   Duration: ${d.durationStr || '—'}`,
    `  ${bold('p95 lat:')}   ${d.p95 ? (d.p95 / 1000).toFixed(1) + 's' : '—'}`,
    '',
    `  ${g('[F4]')} Metrics    ${r('[Q]')} Quit    ${gr('[any key] dismiss')}`,
    '',
  ];

  const OW = Math.min(60, W - 4);
  const OH = lines.length + 2;
  const sr = Math.floor((H - OH) / 2);
  const sc = Math.floor((W - OW) / 2);

  let out = moveTo(sr, sc) + dboxTop(OW, ' SESSION COMPLETE ');
  lines.forEach((line, idx) => {
    out += moveTo(sr + 1 + idx, sc) + dboxRow(line, OW);
  });
  out += moveTo(sr + lines.length + 1, sc) + dboxBot(OW);
  process.stdout.write(out + hideCursor);
}

function renderChatApprovalOverlay(W, H) {
  const t = state.chatToolApproval;
  if (!t) return;

  const argLines = Object.entries(t.args || {}).map(([k, v]) => {
    const raw = typeof v === 'string' ? v : JSON.stringify(v);
    const display = raw.length > 60 ? raw.slice(0, 60) + '…' : raw;
    return `  ${C.grey}${k}:${C.reset} ${display}`;
  });

  const lines = [
    '',
    `  ${bold('Tool:')}  ${C.yellow}${t.name}${C.reset}`,
    '',
    ...argLines,
    '',
    `  ${g('[A]')} Approve    ${r('[D]')} Deny`,
    '',
  ];

  const OW = Math.min(72, W - 4);
  const OH = lines.length + 2;
  const sr = Math.floor((H - OH) / 2);
  const sc = Math.floor((W - OW) / 2);

  let out = moveTo(sr, sc) + dboxTop(OW, ' TOOL APPROVAL ');
  lines.forEach((line, idx) => {
    out += moveTo(sr + 1 + idx, sc) + dboxRow(line, OW);
  });
  out += moveTo(sr + lines.length + 1, sc) + dboxBot(OW);
  process.stdout.write(out + hideCursor);
}

// ── Key handling ─────────────────────────────────────────────────────────────

export async function handleKey({ key, char }) {
  // Bracketed paste / file drop (F-3): a dropped file attaches its contents to the
  // next steer; other pasted text drops into the active input.
  if (key === 'PASTE') { handlePaste(char); return; }

  // Tool approval takes highest priority — block all other input
  if (state.chatToolApproval) {
    if (char && char.toLowerCase() === 'a') { approveTool(); return; }
    if (char && char.toLowerCase() === 'd') { denyTool();   return; }
    return;
  }

  // Launcher hub navigation on the splash (only when recent tasks exist).
  // Arrows/Enter/Tab drive the hub; any printable char starts a fresh task.
  if (state.showSplash && _launcherMode && state.launcherTasks.length) {
    const tasks = state.launcherTasks.slice(0, 6);
    if (key === KEYS.UP)   { setState({ launcherCursor: Math.max(0, state.launcherCursor - 1) }); scheduleRender(); return; }
    if (key === KEYS.DOWN) { setState({ launcherCursor: Math.min(tasks.length - 1, state.launcherCursor + 1) }); scheduleRender(); return; }
    if (key === KEYS.TAB)  { setState({ showSplash: false }); spawnAgentResume(); scheduleRender(); return; }
    if (key === KEYS.ENTER) {
      const chosen = tasks[state.launcherCursor];
      setState({ showSplash: false });
      if (chosen) spawnAgent(chosen.task);
      scheduleRender();
      return;
    }
    // fall through to default splash handling for printable chars / other keys
  }

  // On the disconnected splash, [R] retries the connection instead of dismissing.
  if (state.showSplash && !state.connected && char === 'R') {
    connectAgent(state.port);
    showToast('Reconnecting…', 'yellow');
    scheduleRender();
    return;
  }

  // Onboarding wizard (redesign §7): Enter on the splash jumps to the next
  // incomplete setup step (provider/key/endpoint → model) via its picker, instead
  // of dropping the operator at a blank cockpit.
  if (state.showSplash && key === KEYS.ENTER) {
    const step = nextSetupStep();
    setState({ showSplash: false });
    if (step) { openPicker(step); showToast(`Set up: ${step === 'apiKey' ? 'API key' : step}`, 'green'); }
    scheduleRender();
    return;
  }

  // Dismiss splash on any other keypress; route the char into the command input
  if (state.showSplash) {
    setState({ showSplash: false });
    if (char && char !== '\r' && char !== '\n') {
      activateCmdInput(char);
    }
    scheduleRender();
    return;
  }

  if (state.overlay === 'steer') {
    if (key === KEYS.ESC) { setState({ overlay: null, steerInput: '' }); scheduleRender(); return; }
    if (key === KEYS.ENTER) { await sendSteer(); return; }
    if (key === KEYS.BACKSPACE) { setState({ steerInput: state.steerInput.slice(0, -1) }); scheduleRender(); return; }
    if (char) { setState({ steerInput: state.steerInput + char }); scheduleRender(); return; }
    return;
  }

  if (state.overlay === 'info') {
    if (key === KEYS.ESC || key === KEYS.ENTER) { setState({ overlay: null, infoLines: [], infoScroll: 0 }); scheduleRender(); return; }
    if (key === KEYS.UP)   { setState({ infoScroll: Math.max(0, state.infoScroll - 1) }); scheduleRender(); return; }
    if (key === KEYS.DOWN) { setState({ infoScroll: state.infoScroll + 1 }); scheduleRender(); return; }
    if (key === KEYS.PGUP) { setState({ infoScroll: Math.max(0, state.infoScroll - 10) }); scheduleRender(); return; }
    if (key === KEYS.PGDN) { setState({ infoScroll: state.infoScroll + 10 }); scheduleRender(); return; }
    return;
  }

  if (state.pickerOpen) {
    const items = filteredItems(state.pickerKind);
    if (key === KEYS.ESC) { setState({ pickerOpen: false, pickerFilter: '', pickerIdx: 0 }); scheduleRender(); return; }
    if (key === KEYS.UP)   { setState({ pickerIdx: Math.max(0, state.pickerIdx - 1) }); scheduleRender(); return; }
    if (key === KEYS.DOWN) { setState({ pickerIdx: Math.min(Math.max(0, items.length - 1), state.pickerIdx + 1) }); scheduleRender(); return; }
    // Tab fetches the live /v1/models list — for the model + Arena-add pickers.
    if (key === KEYS.TAB) {
      if (state.pickerKind === 'model' || state.pickerKind === 'arenaAdd') refreshPickerModels();
      return;
    }
    if (key === KEYS.ENTER) {
      const chosen = items[state.pickerIdx];
      if (chosen) applyPicker(state.pickerKind, chosen.value, !!chosen.custom);
      else setState({ pickerOpen: false, pickerFilter: '' });
      scheduleRender(); return;
    }
    if (key === KEYS.BACKSPACE) { setState({ pickerFilter: state.pickerFilter.slice(0, -1), pickerIdx: 0 }); scheduleRender(); return; }
    if (char) { setState({ pickerFilter: state.pickerFilter + char, pickerIdx: 0 }); scheduleRender(); return; }
    return;
  }

  if (state.councilCfgOpen) {
    const n = state.councilModels.length;
    if (key === KEYS.ESC || key === KEYS.ENTER) { saveSettings(); setState({ councilCfgOpen: false }); scheduleRender(); return; }
    if (key === KEYS.UP)   { setState({ councilCfgIdx: Math.max(0, state.councilCfgIdx - 1) }); scheduleRender(); return; }
    if (key === KEYS.DOWN) { setState({ councilCfgIdx: Math.min(n - 1, state.councilCfgIdx + 1) }); scheduleRender(); return; }
    if (char === ' ') {
      const models = state.councilModels.map((m, i) => i === state.councilCfgIdx ? { ...m, on: !m.on } : m);
      setState({ councilModels: models }); scheduleRender(); return;
    }
    if (char === '*') {
      const m = state.councilModels[state.councilCfgIdx];
      if (m) setState({ councilChairman: m.id, councilModels: state.councilModels.map(x => x.id === m.id ? { ...x, on: true } : x) });
      scheduleRender(); return;
    }
    if (char === 'a') {  // add a model to the Arena lineup via the searchable picker
      setState({ councilCfgOpen: false });
      openPicker('arenaAdd');
      return;
    }
    if (char === 'd' || key === KEYS.DELETE) {  // remove the selected model
      const m = state.councilModels[state.councilCfgIdx];
      if (m && state.councilModels.length > 1) {
        const models = state.councilModels.filter((_, i) => i !== state.councilCfgIdx);
        const chairman = state.councilChairman === m.id ? (models.find(x => x.on) || models[0]).id : state.councilChairman;
        setState({ councilModels: models, councilCfgIdx: Math.min(state.councilCfgIdx, models.length - 1), councilChairman: chairman });
        saveSettings(); showToast(`Removed: ${m.label}`, 'yellow');
      } else { showToast('Keep at least one model', 'red'); }
      scheduleRender(); return;
    }
    return;
  }

  if (state.settingsOpen) {
    if (state.settingsEditing) {
      if (key === KEYS.ESC) { setState({ settingsEditing: null, settingsDraft: '' }); scheduleRender(); return; }
      if (key === KEYS.ENTER) { saveSettingsEdit(); return; }
      if (key === KEYS.BACKSPACE) { setState({ settingsDraft: state.settingsDraft.slice(0, -1) }); scheduleRender(); return; }
      if (char) { setState({ settingsDraft: state.settingsDraft + char }); scheduleRender(); }
      return;
    }
    if (key === KEYS.ESC) { setState({ settingsOpen: false, settingsIdx: 0 }); scheduleRender(); return; }
    if (key === KEYS.UP) { setState({ settingsIdx: Math.max(0, state.settingsIdx - 1) }); scheduleRender(); return; }
    if (key === KEYS.DOWN) { setState({ settingsIdx: Math.min(getSettingsItems().length - 1, state.settingsIdx + 1) }); scheduleRender(); return; }
    if (key === KEYS.ENTER) { beginSettingsEdit(); return; }
    if (char && char.toLowerCase() === 'h') { setState({ showApiKey: !state.showApiKey }); scheduleRender(); return; }
    return;
  }

  if (state.denyInputActive) {
    if (key === KEYS.ESC) { setState({ denyInputActive: false, denyInput: '' }); scheduleRender(); return; }
    if (key === KEYS.ENTER) { await sendDeny(); return; }
    if (key === KEYS.BACKSPACE) { setState({ denyInput: state.denyInput.slice(0, -1) }); scheduleRender(); return; }
    if (char) { setState({ denyInput: state.denyInput + char }); scheduleRender(); return; }
    return;
  }

  if (state.memSearchActive) {
    if (key === KEYS.ESC || key === KEYS.ENTER) { setState({ memSearchActive: false }); scheduleRender(); return; }
    if (key === KEYS.BACKSPACE) { setState({ memSearch: state.memSearch.slice(0, -1) }); scheduleRender(); return; }
    if (char) { setState({ memSearch: state.memSearch + char }); scheduleRender(); return; }
    return;
  }

  if (state.cmdInputActive) {
    if (key === KEYS.ESC) {
      setState({ cmdInputActive: false, cmdInput: '', cmdSuggestions: [], cmdSugIdx: -1, cmdHistoryIdx: -1 });
      scheduleRender();
      return;
    }
    if (key === KEYS.ENTER) {
      await executeCmd(state.cmdInput);
      return;
    }
    if (key === KEYS.BACKSPACE) {
      const next = state.cmdInput.slice(0, -1);
      setState({
        cmdInput: next,
        cmdSuggestions: buildSuggestions(next),
        cmdSugIdx: -1,
        cmdInputActive: Boolean(next),
        cmdHistoryIdx: -1,
      });
      scheduleRender();
      return;
    }
    if (key === KEYS.TAB) {
      if (state.cmdSuggestions.length > 0) {
        const idx = (state.cmdSugIdx + 1) % state.cmdSuggestions.length;
        const completed = `${state.cmdSuggestions[idx].cmd} `;
        setState({
          cmdSugIdx: idx,
          cmdInput: completed,
          cmdSuggestions: buildSuggestions(completed),
        });
      }
      scheduleRender();
      return;
    }
    if (key === KEYS.UP) {
      if (!state.cmdHistory.length) return;
      const newIdx = Math.min(state.cmdHistory.length - 1, state.cmdHistoryIdx + 1);
      setState({ cmdHistoryIdx: newIdx, cmdInput: state.cmdHistory[newIdx] || '' });
      scheduleRender();
      return;
    }
    if (key === KEYS.DOWN) {
      const newIdx = Math.max(-1, state.cmdHistoryIdx - 1);
      setState({ cmdHistoryIdx: newIdx, cmdInput: newIdx === -1 ? '' : state.cmdHistory[newIdx] });
      scheduleRender();
      return;
    }
    if (char) {
      const next = state.cmdInput + char;
      setState({
        cmdInput: next,
        cmdSuggestions: buildSuggestions(next),
        cmdSugIdx: -1,
        cmdHistoryIdx: -1,
      });
      scheduleRender();
      return;
    }
    return;
  }

  if (state.overlay === 'help' || state.overlay === 'session_end') {
    if (key === KEYS.F4) setState({ overlay: null, view: 'metrics' });
    else if (key === KEYS.CTRL_C || (char && char.toLowerCase() === 'q')) stopApp();
    else setState({ overlay: null });
    scheduleRender();
    return;
  }

  if (key === KEYS.CTRL_C || char === 'Q') { stopApp(); return; }
  // Esc with queued file attachments (and no active input) clears them.
  if (key === KEYS.ESC && state.attachments.length) {
    setState({ attachments: [] }); showToast('Attachments cleared', 'yellow'); scheduleRender(); return;
  }
  // Views (HITL merged into Live — approvals render inline there).
  if (key === KEYS.F1 || char === '1') { switchView('live'); return; }
  if (key === KEYS.F2 || char === '2') { switchView('memory'); return; }
  if (key === KEYS.F3 || char === '3') { switchView('metrics'); return; }
  if (key === KEYS.F4 || char === '4') { switchView('chat'); return; }
  if (key === KEYS.F5 || char === '5') { switchView('council'); return; }
  if (key === KEYS.F6 || char === '6') { switchView('voice'); return; }
  if (key === KEYS.F7 || char === '7') { switchView('ontology'); return; }
  if (char === ',') {
    setState({ settingsOpen: true, settingsIdx: 0, settingsEditing: null, settingsDraft: '' });
    // The registry rows read from a primed cache — prime it as the panel opens
    // so the models registered with `kairos llm add` are there by first paint.
    primeRegistry().then(() => { if (state.settingsOpen) scheduleRender(); }).catch(() => {});
    scheduleRender();
    return;
  }
  if (char === 'M') { openPicker('model'); return; }
  if (char === 'L' && state.view === 'live') { cycleLayout(); return; }
  if (char && char.toLowerCase() === '?') { setState({ overlay: 'help' }); scheduleRender(); return; }
  if (char === 'S') { setState({ overlay: 'steer', steerInput: '' }); scheduleRender(); return; }
  if (char === 'R' && !state.connected) {
    connectAgent(state.port);
    showToast('Reconnecting...', 'yellow');
    return;
  }
  // Global intervention (Wave E-4b, §7.2 rule 2: "never more than one keystroke
  // deep"). Pause and approve/deny work from ANY view — you don't navigate to the
  // emergency brake. SPACE pauses; a/d act on the pending request when one exists.
  if (char === ' ' || char === 'P') {
    if (state.status === 'paused') {
      await api.resume(state.port).catch(() => {});
      showToast('Agent resumed', 'green');
    } else {
      await api.pause(state.port).catch(() => {});
      showToast('Agent paused', 'yellow');
    }
    scheduleRender();
    return;
  }
  if (state.pendingApprovals.length && char && char.toLowerCase() === 'a') {
    await sendApprove();
    return;
  }
  if (state.pendingApprovals.length && char && char.toLowerCase() === 'd') {
    // Open the deny-reason input in place and make sure the approval band is visible.
    setState({ denyInputActive: true, denyInput: '', view: 'live' });
    scheduleRender();
    return;
  }
  if (char && shouldUseCommandInput(char)) {
    activateCmdInput(char);
    return;
  }

  if (state.view === 'live') handleLiveKey(key);
  if (state.view === 'memory') handleMemoryKey(key, char);
  if (state.view === 'metrics') await handleMetricsKey(key, char);
  if (state.view === 'chat') handleChatKey(key);
  if (state.view === 'council') handleCouncilKey(key, char);
  if (state.view === 'ontology') await handleOntologyKey(key, char);
}

// G4 — the proposal review queue on page 7: ↑/↓ selects, a approves (which
// APPLIES the change through the publish boundary), x rejects. The daemon's
// HITL approval band keeps priority on a/d, so the queue only listens when
// no approval is pending.
async function handleOntologyKey(key, char) {
  const proposals = state.ontology.proposals || [];
  if (!proposals.length || state.pendingApprovals.length) return;
  const cursor = Math.min(state.ontology.cursor || 0, proposals.length - 1);
  if (key === KEYS.UP)   { state.ontology.cursor = Math.max(0, cursor - 1); scheduleRender(); return; }
  if (key === KEYS.DOWN) { state.ontology.cursor = Math.min(proposals.length - 1, cursor + 1); scheduleRender(); return; }
  const lower = char ? char.toLowerCase() : '';
  if (lower !== 'a' && lower !== 'x') return;
  const target = proposals[cursor];
  const approver = process.env.USERNAME || process.env.USER || 'owner';
  const res = await actOnProposal(target, lower === 'a' ? 'approve' : 'reject', approver);
  showToast(res.text, res.ok ? 'green' : 'red');
  // The store changed (or refused) — reprobe so the queue and counts agree with it.
  try {
    const p = await probeOntology();
    state.ontology.domains = p.domains;
    state.ontology.proposals = p.proposals;
    state.ontology.cursor = Math.min(cursor, Math.max(0, p.proposals.length - 1));
    state.ontology.probedAt = Date.now();
  } catch { /* next periodic probe will catch up */ }
  scheduleRender();
}

function handleCouncilKey(key, char) {
  if (char && char.toLowerCase() === 'm') { setState({ councilCfgOpen: true, councilCfgIdx: 0 }); scheduleRender(); return; }
  if (key === KEYS.UP)   { setState({ councilScroll: Math.max(0, state.councilScroll - 1) }); }
  if (key === KEYS.DOWN) { setState({ councilScroll: state.councilScroll + 1 }); }
  if (key === KEYS.PGUP) { setState({ councilScroll: Math.max(0, state.councilScroll - 10) }); }
  if (key === KEYS.PGDN) { setState({ councilScroll: state.councilScroll + 10 }); }
  if (key === KEYS.HOME) { setState({ councilScroll: 0 }); }
  scheduleRender();
}

// Cycle the Live layout preset (redesign §6): Split → Focus → Wide. Persisted.
function cycleLayout() {
  const order = ['split', 'focus', 'wide'];
  const next = order[(order.indexOf(state.layoutPreset) + 1) % order.length];
  setState({ layoutPreset: next, outputScroll: 0 });
  resetFrameBuffer();
  saveSettings();
  showToast(`Layout: ${next}`, 'green');
  scheduleRender();
}

function handleLiveKey(key) {
  // When an approval is pending, ←→ cycle through the requests in the inline band.
  if (state.pendingApprovals.length > 1 && (key === KEYS.LEFT || key === KEYS.RIGHT)) {
    const delta = key === KEYS.RIGHT ? 1 : -1;
    setState({ hitlCursor: Math.max(0, Math.min(state.pendingApprovals.length - 1, (state.hitlCursor || 0) + delta)) });
    scheduleRender();
    return;
  }
  if (key === KEYS.UP)    { setState({ stepsScroll: Math.max(0, state.stepsScroll - 1) }); }
  if (key === KEYS.DOWN)  { setState({ stepsScroll: Math.min(state.steps.length - 1, state.stepsScroll + 1) }); }
  if (key === KEYS.PGUP)  { setState({ outputScroll: state.outputScroll + 10 }); }
  if (key === KEYS.PGDN)  { setState({ outputScroll: Math.max(0, state.outputScroll - 10) }); }
  if (key === KEYS.END)   { setState({ outputScroll: 0, pinnedIdx: null }); }
  if (key === KEYS.HOME)  { setState({ stepsScroll: 0 }); }
  if (key === KEYS.ENTER) {
    const idx = Math.min(state.stepsScroll, state.steps.length - 1);
    setState({ pinnedIdx: idx === state.pinnedIdx ? null : idx, outputScroll: 0 });
  }
  if (key === KEYS.ESC)   { setState({ pinnedIdx: null, outputScroll: 0 }); }
  scheduleRender();
}

function handleMemoryKey(key, char) {
  if (char && char.toLowerCase() === 't') { setState({ memMode: 'temporal', memSearchActive: false }); }
  if (char && char.toLowerCase() === 'r') { setState({ memMode: 'rooms',    memSearchActive: false }); }
  if (char && char.toLowerCase() === 'f') { setState({ memMode: 'search', memSearchActive: true, memSearch: '' }); }
  if (key === KEYS.UP)   { setState({ memScroll: Math.max(0, state.memScroll - 1) }); }
  if (key === KEYS.DOWN) { setState({ memScroll: state.memScroll + 1 }); }
  if (key === KEYS.TAB)  {
    const order = ['events', 'skills', 'reflections'];
    const idx = order.indexOf(state.memFocus);
    setState({ memFocus: order[(idx + 1) % order.length] });
  }
  scheduleRender();
}

async function handleMetricsKey(key, char) {
  if (char && char.toLowerCase() === 'e') {
    await exportMetrics();
    showToast('Exported to .agent/tui-export.json', 'green');
  }
  scheduleRender();
}

function handleChatKey(key) {
  if (key === KEYS.UP)   setState({ chatScroll: state.chatScroll + 1 });
  if (key === KEYS.DOWN) setState({ chatScroll: Math.max(0, state.chatScroll - 1) });
  if (key === KEYS.PGUP) setState({ chatScroll: state.chatScroll + 10 });
  if (key === KEYS.PGDN) setState({ chatScroll: Math.max(0, state.chatScroll - 10) });
  if (key === KEYS.END)  setState({ chatScroll: 0 });
  scheduleRender();
}

// ── Actions ──────────────────────────────────────────────────────────────────

export async function executeCmd(raw) {
  const input = (raw || '').trim();
  if (!input) {
    setState({ cmdInputActive: false, cmdInput: '', cmdSuggestions: [], cmdSugIdx: -1, cmdHistoryIdx: -1 });
    // Enter on an empty line with files attached → send the attachments as a steer.
    if (state.attachments.length && state.view !== 'chat') { await sendSteer(); }
    scheduleRender();
    return;
  }

  const history = [input, ...state.cmdHistory.filter(entry => entry !== input)].slice(0, 50);
  setState({
    cmdInput: '',
    cmdInputActive: false,
    cmdSuggestions: [],
    cmdSugIdx: -1,
    cmdHistoryIdx: -1,
    cmdHistory: history,
  });

  const [cmd, ...rest] = input.split(' ');
  const arg = rest.join(' ').trim();

  try {
  switch (cmd.toLowerCase()) {
    case '/live':
    case '/hitl':  // HITL merged into Live — approvals render inline there
      switchView('live');
      showToast(state.pendingApprovals.length ? 'Live — approval pending below' : 'Switched to live view', 'green');
      break;
    case '/memory':
      if (arg) {
        const [sub, ...qrest] = arg.split(' ');
        const q = qrest.join(' ').trim();
        showToast(`Memory: ${sub}…`, 'yellow');
        try {
          const resp = await api.memory(state.port, sub, q);
          openInfo(`MEMORY — ${sub}${q ? ' ' + q : ''}`, resp?.text || '(no result)');
        } catch {
          showToast('Memory query failed (agent not connected?)', 'red');
        }
      } else {
        switchView('memory');
        showToast('Switched to memory view', 'green');
      }
      break;
    case '/metrics':
      switchView('metrics');
      showToast('Switched to metrics view', 'green');
      break;
    case '/chat':
      switchView('chat');
      showToast('Switched to chat view', 'green');
      break;
    case '/arena':
    case '/council': {  // /council kept as an alias of /arena
      const sub = rest[0];
      if (sub === 'key') {
        const k = rest.slice(1).join(' ').trim();
        if (k) { setState({ openrouterKey: k }); saveSettings(); showToast('OpenRouter key set (saved 0600)', 'green'); }
        else showToast('Usage: /arena key <openrouter-key>', 'red');
      } else if (arg) {
        startCouncil(arg);             // /arena <topic> — convene immediately
      } else {
        switchView('council');
        showToast('AI Arena — type a topic + Enter · [m] edit lineup · [a] add model', 'green');
      }
      break;
    }
    case '/clearchat':
      setState({ chatMessages: [], chatScroll: 0, chatPending: false });
      showToast('Chat history cleared', 'green');
      break;
    case '/model': {
      if (arg) {
        const chosen = resolveModelChoice(arg);
        applyPicker('model', chosen?.id || arg);
      } else {
        openPicker('model');
      }
      break;
    }
    case '/settings':
      setState({ settingsOpen: true, settingsIdx: 0, settingsEditing: null, settingsDraft: '' });
      primeRegistry().then(() => { if (state.settingsOpen) scheduleRender(); }).catch(() => {});
      break;
    case '/apikey':
    case '/key':
      if (arg) {
        applyPicker('apiKey', arg);   // remembers the key in history + syncs openrouterKey
      } else {
        openPicker('apiKey');         // shows remembered keys for the current provider + "new"
      }
      break;
    case '/steer':
      if (arg) {
        setState({ overlay: 'steer', steerInput: arg });
        await sendSteer();
      } else {
        setState({ overlay: 'steer', steerInput: '' });
      }
      break;
    case '/approve': {
      const id = arg.split(' ')[0];
      if (id) {
        try { await api.approve(state.port, id); } catch {}
        setState({ pendingApprovals: state.pendingApprovals.filter(a => a.id !== id), hitlCursor: 0 });
        showToast(`Approved ${id}`, 'green');
        if (!state.pendingApprovals.length) switchView(state.prevView || 'live');
      } else {
        await sendApprove();
      }
      break;
    }
    case '/deny': {
      const tokens = arg.split(' ').filter(Boolean);
      const known = state.pendingApprovals.find(a => a.id === tokens[0]);
      if (known) {
        const reason = tokens.slice(1).join(' ');
        try { await api.deny(state.port, known.id, reason); } catch {}
        setState({ pendingApprovals: state.pendingApprovals.filter(a => a.id !== known.id), hitlCursor: 0 });
        showToast(`Denied ${known.id}`, 'yellow');
        if (!state.pendingApprovals.length) switchView(state.prevView || 'live');
      } else {
        // No id given — deny the current cursor with arg as the reason
        setState({ denyInput: arg });
        await sendDeny();
      }
      break;
    }
    case '/clarify': {
      const tokens = arg.split(' ').filter(Boolean);
      if (tokens.length === 0) {
        // Refresh from the server so mid-session clarifications appear
        try {
          const payload = await api.pending(state.port);
          setState({ pendingClarifications: Array.isArray(payload?.clarify) ? payload.clarify : [] });
        } catch {}
        const cl = state.pendingClarifications;
        if (!cl.length) { showToast('No pending clarifications', 'green'); break; }
        const lines = cl.map(c => `${C.yellow}${c.id}${C.reset}\n  ${c.question || c.prompt || '(question)'}\n  ${gr('answer with')} /clarify ${c.id} <answer>`);
        openInfo('PENDING CLARIFICATIONS', lines.join('\n\n'));
      } else if (tokens.length === 1) {
        showToast('Usage: /clarify <id> <answer>', 'red');
      } else {
        const id = tokens[0];
        const answer = tokens.slice(1).join(' ');
        try {
          await api.clarify(state.port, id, answer);
          setState({ pendingClarifications: state.pendingClarifications.filter(c => c.id !== id) });
          showToast(`Clarification ${id} answered`, 'green');
        } catch {
          showToast('Failed to answer clarification', 'red');
        }
      }
      break;
    }
    case '/pause':
      await api.pause(state.port).catch(() => {});
      showToast('Agent paused', 'yellow');
      break;
    case '/resume':
      await api.resume(state.port).catch(() => {});
      showToast('Agent resumed', 'green');
      break;
    case '/clear':
      setState({ steps: [], stepsScroll: 0, pinnedIdx: null, outputScroll: 0 });
      showToast('Step history cleared', 'green');
      break;
    case '/export':
      await exportMetrics();
      showToast('Exported to .agent/tui-export.json', 'green');
      break;
    case '/usage': {
      const rep = await usageReport(arg);
      openInfo(rep.title, rep.lines.join('\n'));
      break;
    }
    case '/history': {
      const [dom, lim] = arg.split(' ').filter(Boolean);
      const rep = await historyReport(dom, lim);
      if (!rep.ok) { showToast(rep.text, 'red'); break; }
      openInfo(rep.title, rep.lines.join('\n'));
      break;
    }
    case '/remove': {
      const tokens = arg.split(' ').filter(Boolean);
      const domain = tokens.find(t => !t.startsWith('--'));
      if (!domain) { showToast('Usage: /remove <domain> [--force]', 'red'); break; }
      if (!tokens.includes('--force')) {
        // The ceremony — show what would be destroyed, never delete.
        const p = await removePreview(domain);
        if (!p.exists) { showToast(p.text, 'red'); break; }
        openInfo(`REMOVE ${domain}?`, p.lines.join('\n'));
      } else {
        const res = await removeForce(domain, { loopMemory: tokens.includes('--loop-memory') });
        showToast(res.text, res.ok ? 'green' : 'red');
        if (res.ok) refreshOntologyProbe();
      }
      break;
    }
    case '/verify':
    case '/resolve':
    case '/critique': {
      const kind = cmd.slice(1).toLowerCase();
      const [domain, model] = arg.split(' ').filter(Boolean);
      if (!domain) { showToast(`Usage: ${cmd} <domain> [model]`, 'red'); break; }
      showToast(`${kind} ${domain} running (spends tokens) — output opens when done`, 'yellow');
      // Deliberately not awaited: a lens run takes tens of seconds and the
      // TUI must stay responsive. The CLI child does the metering.
      runLens(kind, domain, model)
        .then((res) => {
          openInfo(`ONTOLOGY ${kind.toUpperCase()} — ${domain}${res.code ? ' (failed)' : ''}`, res.output || '(no output)');
          if (res.code === 0) refreshOntologyProbe();
          scheduleRender();
        })
        .catch((e) => { showToast(`${kind} failed: ${e?.message || e}`, 'red'); scheduleRender(); });
      break;
    }
    case '/proposals':
      switchView('ontology');
      showToast('Review queue — ↑↓ select · [a]pprove · [x] reject', 'green');
      break;
    case '/layout': {
      const order = ['split', 'focus', 'wide'];
      const a = arg.toLowerCase();
      const next = order.includes(a) ? a : order[(order.indexOf(state.layoutPreset) + 1) % order.length];
      setState({ view: 'live', layoutPreset: next, outputScroll: 0 });
      resetFrameBuffer(); saveSettings();
      showToast(`Layout: ${next}`, 'green');
      break;
    }
    case '/theme': {
      const order = ['aurora', 'ocean', 'ember', 'lime'];
      const a = arg.toLowerCase();
      const next = order.includes(a) ? a : order[(order.indexOf(state.theme || 'aurora') + 1) % order.length];
      setState({ theme: next }); setActiveTheme(next);
      resetFrameBuffer(); saveSettings();
      showToast(`Theme: ${next}`, 'green');
      break;
    }
    case '/status':
      showToast(`${String(state.status || 'unknown').toUpperCase()} - step ${state.step || 0} - $${Number(state.costUsd || 0).toFixed(3)}`, 'green');
      break;
    case '/help':
      setState({ overlay: 'help' });
      break;
    case '/reconnect':
      connectAgent(state.port);
      showToast('Reconnecting...', 'yellow');
      break;
    case '/quit':
      stopApp();
      return;
    case '/run':
      if (arg) {
        spawnAgent(arg);
      } else {
        showToast('Usage: /run <task description>', 'red');
      }
      break;
    default:
      if (!input.startsWith('/')) {
        if (state.view === 'council') {
          startCouncil(input);          // a topic in the council view convenes the council
        } else if (state.view === 'chat') {
          await sendChatMessage(input);
        } else if (_launcherMode && state.status === 'disconnected') {
          spawnAgent(input);
        } else {
          setState({ overlay: 'steer', steerInput: input });
          await sendSteer();
        }
      } else {
        showToast(`Unknown command: ${cmd} (try /help)`, 'red');
      }
      break;
  }
  } catch (err) {
    // A command branch failed — surface it without letting the rejection escape to
    // the process-level unhandledRejection handler (which would exit the TUI).
    showToast(`Command failed: ${err?.message || err}`, 'red');
  }

  scheduleRender();
}

async function sendApprove() {
  const appr = state.pendingApprovals[state.hitlCursor];
  if (!appr) return;
  try {
    await api.approve(state.port, appr.id);
  } catch {}
  const remaining = state.pendingApprovals.filter(a => a.id !== appr.id);
  setState({ pendingApprovals: remaining, hitlCursor: 0 });
  showToast('Approval sent', 'green');
  if (!remaining.length) switchView(state.prevView || 'live');
  scheduleRender();
}

async function sendDeny() {
  const appr = state.pendingApprovals[state.hitlCursor];
  if (!appr) { setState({ denyInputActive: false, denyInput: '' }); scheduleRender(); return; }
  try {
    await api.deny(state.port, appr.id, state.denyInput);
  } catch {}
  const remaining = state.pendingApprovals.filter(a => a.id !== appr.id);
  setState({ pendingApprovals: remaining, denyInputActive: false, denyInput: '', hitlCursor: 0 });
  showToast('Denial sent', 'yellow');
  if (!remaining.length) switchView(state.prevView || 'live');
  scheduleRender();
}

async function sendSteer() {
  const typed = state.steerInput.trim();
  const atts = state.attachments || [];
  if (!typed && !atts.length) { setState({ overlay: null, steerInput: '' }); scheduleRender(); return; }

  // F-3: fold any dropped files into the injected message so the agent sees their
  // contents mid-loop. Cap the total attachment payload so it can't blow the
  // context budget.
  let msg = typed || '(see attached files)';
  if (atts.length) {
    let budget = 128 * 1024;
    for (const a of atts) {
      if (budget <= 0) break;
      const body = String(a.content || '').slice(0, budget);
      budget -= body.length;
      msg += `\n\n[ATTACHED FILE: ${a.path} (${a.bytes} bytes${a.truncated ? ', truncated' : ''})]\n${body}`;
    }
  }

  try {
    await api.steer(state.port, msg);
    showToast(atts.length ? `Sent + ${atts.length} file(s)` : 'Steering message sent', 'green');
  } catch {
    showToast('Failed to send steering message', 'red');
  }
  setState({ overlay: null, steerInput: '', attachments: [] });
  scheduleRender();
}

// Convene the LLM council on a topic (runs in this process via OpenRouter).
function startCouncil(topic) {
  const t = (topic || '').trim();
  if (!t) return;
  const live = state.council && ['stage1', 'stage2', 'stage3'].includes(state.council.status);
  if (live) { showToast('AI Arena is already deliberating…', 'yellow'); return; }
  const members = state.councilModels.filter(m => m.on).map(m => ({ id: m.id, label: m.label }));
  if (!members.length) { showToast('No Arena models — press [m] to pick or [a] to add', 'red'); switchView('council'); setState({ councilCfgOpen: true }); scheduleRender(); return; }
  if (!state.openrouterKey) showToast('No OpenRouter key — set one in Settings (,) or /arena key …', 'yellow');

  switchView('council');
  setState({ councilScroll: 0, council: { topic: t, stage: 1, status: 'stage1', chairman: state.councilChairman, final: '', error: '',
    members: members.map(m => ({ ...m, status: 'pending', answer: '', error: '', rankText: '' })) } });
  const call = makeOpenRouterCall(() => state.openrouterKey);
  runCouncil({
    topic: t, members, chairman: state.councilChairman, call,
    onProgress: (snap) => { setState({ council: snap }); scheduleRender(); },
  }).catch((err) => {
    setState({ council: { ...(state.council || { members: [] }), status: 'error', error: err?.message || String(err) } });
    scheduleRender();
  });
  scheduleRender();
}

async function sendChatMessage(text) {
  const content = (text || '').trim();
  if (!content) return;
  if (state.chatPending) { showToast('Still waiting for a response…', 'yellow'); return; }

  const userMsg = { role: 'user', content, ts: Date.now() };
  const history = [...state.chatMessages, userMsg];
  setState({ chatMessages: history, chatPending: true, chatScroll: 0 });
  scheduleRender();

  const baseURL = (state.serverUrl || process.env.AGENT_BASE_URL || 'http://localhost:11434/v1').replace(/\/$/, '');
  const apiKey  = state.apiKey || process.env.AGENT_API_KEY || '';
  // `chat_template_kwargs` is a vLLM/SGLang extension that cloud providers
  // (OpenAI/OpenRouter/Anthropic) reject — only send it to a local server.
  const noThink = !!state.noThinking && state.modelSource === 'local';

  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    ...history.map(m => ({ role: m.role, content: m.content })),
  ];

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) { headers.Authorization = `Bearer ${apiKey}`; headers['X-API-KEY'] = apiKey; }

  // One request attempt against a given model id. Returns the parsed reply on 2xx,
  // or throws an Error tagged with `.status`/`.body` so the caller can react (e.g.
  // OpenRouter's 404 "use this slug instead" hint → swap + retry).
  async function attempt(modelId) {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId, messages, max_tokens: 4096, stream: false,
        temperature: state.temperature ?? 0.1,
        ...(noThink && { chat_template_kwargs: { enable_thinking: false } }),
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      e.status = res.status; e.body = body;
      throw e;
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    let reply = choice?.message?.content || '';
    if (Array.isArray(reply)) reply = reply.filter(b => b.type === 'text').map(b => b.text || '').join('');
    if (!reply && choice?.message?.reasoning_content) reply = choice.message.reasoning_content;
    return reply;
  }

  const startMs = Date.now();
  let model = state.model || process.env.AGENT_MODEL || '';
  try {
    let reply;
    try {
      reply = await attempt(model);
    } catch (err) {
      // OpenRouter retires/relocates :free slugs and names the replacement in the
      // 404 body. Honor it once: swap the model, remember it, and retry.
      const slug = err?.status === 404 ? openRouterSuggestedSlug(err.body) : '';
      if (slug && slug !== model) {
        showToast(`"${model}" moved → retrying with ${slug}`, 'yellow');
        reply = await attempt(slug);
        applyPicker('model', slug);   // persist + remember the working slug
        model = slug;
      } else {
        throw err;
      }
    }
    const assistantMsg = {
      role: 'assistant', content: reply || '(empty response)',
      ts: Date.now(), latencyMs: Date.now() - startMs,
    };
    setState({ chatMessages: [...state.chatMessages, assistantMsg], chatPending: false, chatScroll: 0 });
  } catch (err) {
    const errMsg = { role: 'assistant', content: `Error: ${friendlyChatError(err, model, baseURL)}`, ts: Date.now(), error: true };
    setState({ chatMessages: [...state.chatMessages, errMsg], chatPending: false });
  }
  scheduleRender();
}

// Parse OpenRouter's "...use this slug instead: vendor/model" hint from a 404 body.
export function openRouterSuggestedSlug(body) {
  const m = /use this slug instead:\s*([A-Za-z0-9._/:-]+)/i.exec(String(body || ''));
  return m ? m[1].replace(/[.,]$/, '') : '';
}

// Friendlier chat errors. OpenRouter's free tier 404s (model retired/unavailable)
// and 429s (rate-limited) are the common case — point the operator at the live
// model list (M → Tab) or their own key instead of dumping raw JSON.
export function friendlyChatError(err, model, baseURL) {
  const status = err?.status;
  const free = /:free\b/.test(model || '');
  if (status === 404) {
    return `"${model}" is unavailable${free ? " on OpenRouter's free tier" : ''} (404). Open the model picker (M) and press [Tab] to fetch the live list, then pick a current model.`;
  }
  if (status === 429) {
    return `"${model}" is rate-limited right now${free ? ' (free tier)' : ''} (429). Wait a moment and retry, add your own provider key in Settings, or pick a different model (M → Tab).`;
  }
  return describeFetchError(err, `${baseURL}/chat/completions`);
}

// Turn an opaque `fetch failed` into an actionable reason. Node's fetch hides the
// real cause (ECONNREFUSED, ENOTFOUND, timeout) in `err.cause`; surface it + the URL
// so the operator can see whether it's the Server URL, the network, or the server.
function describeFetchError(err, url) {
  if (err?.name === 'TimeoutError') return `timed out reaching ${url} — server slow/unreachable or wrong host:port`;
  if (/^HTTP \d/.test(err?.message || '')) return err.message; // server replied with an HTTP error + body
  const code = err?.cause?.code || err?.code || '';
  switch (code) {
    case 'ECONNREFUSED': return `connection refused at ${url} — is the server up and is the Server URL right? (Settings , → Server URL, e.g. http://HOST:8000/v1)`;
    case 'ENOTFOUND':    return `host not found for ${url} — check the Server URL`;
    case 'ECONNRESET':   return `connection reset by ${url}`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT': return `timed out connecting to ${url}`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':  return `network unreachable to ${url} — on WSL2 a LAN IP often needs mirrored networking or an SSH tunnel`;
    default: return `${err?.message || err}${code ? ` (${code})` : ''} — target ${url}`;
  }
}

async function exportMetrics() {
  try {
    const outPath = path.join(process.cwd(), '.agent', 'tui-export.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const data = {
      episodeId: state.episodeId, task: state.task, status: state.status,
      step: state.step, costUsd: state.costUsd, totalTokens: state.totalTokens,
      avgLatencyMs: avgLatency(), p95LatencyMs: latencyP(0.95),
      errors: state.errors, hallucinations: state.hallucinations,
      compactions: state.compactions, hitlTotal: state.hitlTotal,
      hitlApproved: state.hitlApproved, hitlDenied: state.hitlDenied,
      exportedAt: new Date().toISOString(),
    };
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  } catch {}
}

function spawnAgent(task) {
  const cliPath = path.join(_agentRoot, 'src', 'cli.js');
  const env = {
    ...process.env,
    AGENT_BASE_URL: state.serverUrl || process.env.AGENT_BASE_URL || '',
    AGENT_MODEL:    state.model     || process.env.AGENT_MODEL    || '',
    AGENT_API_KEY:  state.apiKey    || process.env.AGENT_API_KEY  || '',
    AGENT_PROVIDER: state.provider  || process.env.AGENT_PROVIDER || 'ollama',
    // Advanced config knobs from the TUI settings editor (only set when non-default).
    ...(state.maxSteps > 0         && { AGENT_MAX_STEPS:        String(state.maxSteps) }),
    ...(Number.isFinite(state.temperature) && { AGENT_TEMPERATURE: String(state.temperature) }),
    ...(state.contextWindow > 0    && { AGENT_CONTEXT_WINDOW:   String(state.contextWindow) }),
    ...(state.maxOutput > 0        && { AGENT_MAX_OUTPUT:       String(state.maxOutput) }),
    ...(state.memoryWindow > 0     && { AGENT_MEMORY_WINDOW:    String(state.memoryWindow) }),
    ...(state.compactThreshold > 0 && { AGENT_COMPACT_THRESHOLD: String(state.compactThreshold) }),
    ...(state.compactInterval > 0  && { AGENT_COMPACT_INTERVAL: String(state.compactInterval) }),
    AGENT_USE_PALACE:   state.usePalace ? '1' : '0',
    AGENT_NO_THINKING:  state.noThinking ? '1' : '0',
  };
  const child = spawn(process.execPath, [cliPath, task], {
    cwd: _agentRoot,
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  try { recordTask(_agentRoot, task); } catch {}
  setState({ task, status: 'connecting', launcherTasks: loadTasks(_agentRoot) });
  showToast('Agent started — connecting...', 'green');
  connectAgent(state.port);
}

function spawnAgentResume() {
  const cliPath = path.join(_agentRoot, 'src', 'cli.js');
  const env = {
    ...process.env,
    AGENT_BASE_URL: state.serverUrl || process.env.AGENT_BASE_URL || '',
    AGENT_MODEL:    state.model     || process.env.AGENT_MODEL    || '',
    AGENT_API_KEY:  state.apiKey    || process.env.AGENT_API_KEY  || '',
    AGENT_PROVIDER: state.provider  || process.env.AGENT_PROVIDER || 'ollama',
    AGENT_USE_PALACE:  state.usePalace ? '1' : '0',
    AGENT_NO_THINKING: state.noThinking ? '1' : '0',
  };
  const child = spawn(process.execPath, [cliPath, '--resume'], {
    cwd: _agentRoot, env, detached: true, stdio: 'ignore',
  });
  child.unref();
  setState({ status: 'connecting' });
  showToast('Resuming last session…', 'green');
  connectAgent(state.port);
}

function switchView(v) {
  const prev = state.view !== v ? state.view : state.prevView;
  setState({ view: v, prevView: prev });
  // The Voice view opens with a pipeline probe (mic/whisper/speaker/tts/model)
  // so its header states facts, not guesses. Re-probed after a minute — the
  // answers change when the user installs something, not per keystroke.
  // The Metrics view carries the persistent spend ledger — file-backed, so it
  // answers even DISCONNECTED. Re-probed after 30s, not per keystroke.
  if (v === 'metrics' && Date.now() - (state.spend.probedAt || 0) > 30_000) {
    state.spend.probedAt = Date.now();
    probeSpend()
      .then(p => { state.spend.data = p; if (state.view === 'metrics') scheduleRender(); })
      .catch(() => {});
  }
  if (v === 'voice' && Date.now() - (state.voice.pipelineAt || 0) > 60_000) {
    state.voice.pipelineAt = Date.now();
    probeVoicePipeline()
      .then(p => { state.voice.pipeline = p; if (state.view === 'voice') scheduleRender(); })
      .catch(() => {});
  }
  // The Ontology view reads the same store the CLI uses. probedAt is reset by
  // ingest events, so the table refreshes exactly when the store changed.
  if (v === 'ontology' && Date.now() - (state.ontology.probedAt || 0) > 30_000) {
    state.ontology.probedAt = Date.now();
    probeOntology()
      .then(p => {
        state.ontology.dropDir = p.dropDir;
        state.ontology.domains = p.domains;
        state.ontology.proposals = p.proposals;
        state.ontology.cursor = Math.min(state.ontology.cursor || 0, Math.max(0, p.proposals.length - 1));
        if (state.view === 'ontology') scheduleRender();
      })
      .catch(() => {});
  }
  scheduleRender();
}

// ── SSE connection + event handling ──────────────────────────────────────────

function connectAgent(port) {
  stopSSE?.();

  // Phase 3.6: prefer the daemon when one is running. Attaching to it means the
  // TUI is a client of a resident system rather than the cockpit of one loop —
  // closing this window stops nothing.
  const backend = resolveBackend({ port, root: _agentRoot, prefer: _backendPreference });
  const effectivePort = backend.port || port;

  setState({
    port: effectivePort,
    connecting: true,
    status: 'connecting',
    backendKind: backend.kind,
    connDiag: backend.kind === 'daemon-missing' ? backend.detail : state.connDiag,
  });

  // Token source follows the backend: the daemon's run-directory token, or the
  // project's .agent/web-ui-token for a single run. Read fresh per request —
  // either server may start after the TUI.
  const getToken = backend.kind === 'daemon'
    ? () => resolveBackend({ port, root: _agentRoot, prefer: _backendPreference }).token
    : () => readWebUiToken(_agentRoot);
  setTokenProvider(getToken);

  // Daemon events are D2 bus records; unwrap them into the 16 event types the
  // view layer already renders.
  const onEvent = backend.kind === 'daemon'
    ? daemonEventAdapter(handleSSEEvent, { missionId: _attachedMissionId })
    : handleSSEEvent;

  stopSSE = connectSSE(
    effectivePort,
    onEvent,
    (status, detail) => {
      if (status === 'connected')    {
        setState({
          connected: true, connecting: false, reconnectAttempts: 0, connDiag: '',
          // The stream is live; saying CONNECTING… past this point is a lie.
          // Attached to an idle daemon there is no mission to flip the status,
          // so it would have said CONNECTING forever — 'attached' is the
          // honest idle state, and session_start still promotes it to running.
          ...(state.status === 'connecting' ? { status: 'attached' } : {}),
        });
        loadPending(port);
      }
      if (status === 'disconnected') { setState({ connected: false, connecting: false, status: 'disconnected', connDiag: detail || state.connDiag }); probeLlmReachability(); }
      if (status === 'connecting')   { setState({ connected: false, connecting: true }); }
      scheduleRender();
    },
    getToken,
  );
}

// When disconnected, probe the configured LLM endpoint so we can distinguish
// "no agent running" from "agent up but LLM unreachable" — mirroring the kairos
// wrapper's connectivity check. Appends an actionable note to the diagnostic.
let _lastLlmProbe = 0;
async function probeLlmReachability() {
  const now = Date.now();
  if (now - _lastLlmProbe < 10000) return; // throttle
  _lastLlmProbe = now;
  const baseURL = (state.serverUrl || process.env.AGENT_BASE_URL || '').replace(/\/$/, '');
  if (!baseURL) return;
  try {
    const res = await fetch(`${baseURL}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const note = `LLM endpoint ${baseURL} unreachable (${err.message}). Start your model server or fix the URL in Settings (,).`;
    setState({ connDiag: state.connDiag ? `${state.connDiag}\n${note}` : note });
    scheduleRender();
  }
}

async function loadPending(port) {
  try {
    const payload = await api.pending(port);
    const list = Array.isArray(payload) ? payload : Array.isArray(payload?.pending) ? payload.pending : [];
    const clarify = Array.isArray(payload?.clarify) ? payload.clarify : [];
    setState({ pendingClarifications: clarify });
    if (list.length) {
      setState({ pendingApprovals: list });
      if (state.view !== 'live') switchView('live');  // approvals render inline in Live
    }
  } catch {}
}

// The speaking animation ticks only while the synthesiser is talking, and only
// re-renders when the Voice view is the one on screen. An always-on timer for a
// sometimes-visible animation is how a TUI ends up burning a core at idle.
let voiceAnimTimer = null;
function setSpeakingAnimation(on) {
  if (on && !voiceAnimTimer) {
    voiceAnimTimer = setInterval(() => {
      state.voice.animFrame = (state.voice.animFrame + 1) % 3600;
      if (state.view === 'voice') scheduleRender();
    }, 120);
    if (voiceAnimTimer.unref) voiceAnimTimer.unref();
  } else if (!on && voiceAnimTimer) {
    clearInterval(voiceAnimTimer);
    voiceAnimTimer = null;
  }
}

function handleSSEEvent(ev) {
  if (!ev || !ev.type) return;

  switch (ev.type) {
    case 'voice': {
      setState({ voice: foldVoiceEvent(state.voice, ev) });
      setSpeakingAnimation(state.voice.speaking);
      if (state.view === 'voice') scheduleRender();
      return;
    }

    case 'brain':
      state.voice.brain = { arousal: ev.arousal, load: ev.load, confidence: ev.confidence };
      if (state.view === 'voice') scheduleRender();
      return;

    case 'ontology': {
      setState({ ontology: foldOntologyEvent(state.ontology, ev) });
      // An ingest changed the store — refresh the domain table behind the feed.
      if (ev.action === 'ingested') {
        probeOntology()
          .then(p => {
            state.ontology.dropDir = p.dropDir;
            state.ontology.domains = p.domains;
            state.ontology.proposals = p.proposals;
            state.ontology.cursor = Math.min(state.ontology.cursor || 0, Math.max(0, p.proposals.length - 1));
            state.ontology.probedAt = Date.now();
            if (state.view === 'ontology') scheduleRender();
          })
          .catch(() => {});
      }
      if (state.view === 'ontology') scheduleRender();
      return;
    }

    case 'session_start':
      setState({
        showSplash: false,
        episodeId: ev.episodeId || ev.id || '',
        task: ev.task || state.task,
        status: 'running',
        model: ev.model || state.model,
        step: 0, costUsd: 0, totalTokens: 0,
        stepLatenciesMs: [], costHistory: [], steps: [],
        stepsScroll: 0, outputScroll: 0, pinnedIdx: null,
        errors: 0, hallucinations: 0, compactions: 0,
        skillsCreated: 0, hitlTotal: 0, hitlApproved: 0, hitlDenied: 0,
        stageMetrics: {}, controllerInfo: null, focusChain: [],
      });
      break;

    case 'step':
      state._lastStepMs = Date.now();
      setState({ showSplash: false, step: ev.step || state.step, stage: ev.stage || state.stage, model: ev.model || state.model, status: 'running',
        focusChain: Array.isArray(ev.focus) ? ev.focus : state.focusChain });
      addStep({
        step: ev.step,
        tool: ev.tool || ev.action || '?',
        arg: ev.arg || (ev.args ? JSON.stringify(ev.args).slice(0, 50) : ''),
        thought: ev.thought ? ev.thought.slice(0, 60) : '',
        result: '',
        error: false,
        startMs: Date.now(),
      });
      setState({ costHistory: [...state.costHistory, state.costUsd].slice(-200) });
      break;

    case 'tool_result': {
      const s = state.steps[0];
      if (s) {
        const latency = Date.now() - (s.startMs || Date.now());
        s.result = ev.result || '';
        s.error  = !!ev.error;
        s.latencyMs = latency;            // surfaced in the STEPS panel (Workstream A)
        const lats = [...state.stepLatenciesMs, latency].slice(-200);
        setState({ stepLatenciesMs: lats });
        if (ev.error) setState({ errors: state.errors + 1 });
      }
      break;
    }

    case 'approval_requested':
      setState({
        pendingApprovals: [...state.pendingApprovals.filter(a => a.id !== ev.id), {
          id: ev.id, tool: ev.tool, args: ev.args,
          reason: ev.reason || ev.thought || '',
          timestamp: ev.timestamp || Date.now(),
          timeoutMs: ev.timeoutMs || 600000,
          matchedRule: ev.matchedRule || '',
        }],
        hitlTotal: state.hitlTotal + 1,
      });
      // Surface it where the inline approval band lives. Far less disruptive than
      // the old jump to a separate HITL panel — this IS the main view.
      if (state.view !== 'live') switchView('live');
      break;

    case 'approval_response':
    case 'approval_timeout': {
      const remaining = state.pendingApprovals.filter(a => a.id !== ev.id);
      const approved  = ev.approved ?? false;
      setState({
        pendingApprovals: remaining,
        hitlApproved: approved ? state.hitlApproved + 1 : state.hitlApproved,
        hitlDenied:   !approved ? state.hitlDenied + 1 : state.hitlDenied,
      });
      break;
    }

    case 'paused':  setState({ status: 'paused' });  break;
    case 'resumed': setState({ status: 'running' }); break;

    case 'steering_injected':
      // Brief visual flash handled in commandBar — no state change needed
      break;

    case 'cost_update':
      setState({
        costUsd:     ev.costUsd     ?? state.costUsd,
        totalTokens: ev.totalTokens ?? state.totalTokens,
      });
      break;

    case 'stage_metrics':
      setState({
        stageMetrics:   ev.breakdown || state.stageMetrics,
        controllerInfo: ev.controller || state.controllerInfo,
      });
      break;

    case 'session_end': {
      const start = state.steps.length ? state.steps[state.steps.length - 1].startMs : Date.now();
      const durMs = Date.now() - start;
      const durStr = durMs > 60000 ? `${Math.floor(durMs / 60000)}m ${Math.floor((durMs % 60000) / 1000)}s` : `${Math.floor(durMs / 1000)}s`;
      setState({
        status: ev.exitReason === 'completed' ? 'completed' : 'error',
        overlay: 'session_end',
        sessionEndData: { exitReason: ev.exitReason, totalSteps: ev.totalSteps, p95: ev.p95StepLatencyMs, durationStr: durStr },
      });
      break;
    }

    case 'compaction': setState({ compactions: state.compactions + 1 }); break;

    default: break;
  }

  scheduleRender();
}
