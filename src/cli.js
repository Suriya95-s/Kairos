#!/usr/bin/env node
// advanced-agent-loop/src/cli.js
// CLI entry point — parse args, set workspace, bootstrap identity, run the loop.

import { runLoop } from './loop.js';
import { setWorkspace, loadCheckpoint, readTask } from './state.js';
import { setLLMLogDir } from './llm.js';
import config from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeResponse, listPending, getRequest } from './hitl/approvalQueue.js';
import { pause, resume, isPaused } from './hitl/gateway.js';
import { addSteeringMessage } from './hitl/steeringChannel.js';
import { answerClarification, getPendingClarifications } from './hitl/clarificationQueue.js';
import { listSessions, summarizeSession, searchTurns, recentTurns } from './chat/session.js';
import { isProfile, profileNames, selectProfile } from './missions/profiles.js';

/**
 * Query the vLLM /v1/models endpoint to discover the model's real max_model_len,
 * then scale all context-dependent config parameters proportionally.
 * Only runs if the user has NOT set AGENT_CONTEXT_WINDOW explicitly.
 */
async function autoDetectAndScale() {
  // If user didn't pin the context window, try to detect it from the server
  if (!process.env.AGENT_CONTEXT_WINDOW) {
    let detected = null;

    // Strategy 1: Read max_model_len from /v1/models (works with native vLLM)
    try {
      const res = await fetch(`${config.baseURL}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        // Prefer exact match; fall back to first model the server reports.
        // If we fall back, also fix config.model so API requests use the real ID.
        const exactMatch = data.data?.find(m => m.id === config.model);
        const modelInfo  = exactMatch ?? data.data?.[0];
        if (!exactMatch && modelInfo?.id) {
          const oldId = config.model;
          config.model = modelInfo.id;
          console.error(`[auto-detect] model name corrected: "${oldId}" → "${config.model}"`);
        }
        detected = modelInfo?.max_model_len;
        if (typeof detected !== 'number' || detected <= 0) detected = null;
      }
    } catch {
      // Server not reachable — keep default
    }

    // Strategy 2: Probe with absurd max_tokens to extract limit from 400 error.
    // Many gateways (ollama-gateway, litellm) strip max_model_len from /v1/models
    // but the underlying vLLM still returns it in error messages.
    if (!detected) {
      try {
        const probeRes = await fetch(`${config.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 999999,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!probeRes.ok) {
          const errBody = await probeRes.text();
          // Parse patterns like "max_model_len=16384" or "max_total_tokens=16384"
          // or "context length is only 16384 tokens"
          const match = errBody.match(/max_model_len[=:]?\s*(\d+)/)
            || errBody.match(/max_total_tokens[=:]?\s*(\d+)/)
            || errBody.match(/context length is(?: only)?\s*(\d+)/);
          if (match) {
            detected = parseInt(match[1], 10);
            if (detected <= 0) detected = null;
          }
        }
      } catch {
        // Probe failed — keep default
      }
    }

    if (detected) {
      config.contextWindow = detected;
      scaleToContextWindow(detected);
      console.error(`[auto-detect] max_model_len=${detected}`);
    }
  }
}

/**
 * Scale memory/compaction/output parameters to fit within the given context window.
 * Formula rationale:
 *   - Reserve 70% of context for input (static prompt + working memory)
 *   - Static prompt ≈ 6500 tokens (identity, task, plan, learnings)
 *   - Each working memory entry ≈ 250 tokens
 *   - Output budget: 17–20% of context window, capped at 8192
 */
function scaleToContextWindow(ctxTokens) {
  const STATIC_TOKENS = 6500;       // approximate fixed overhead per step
  const TOKENS_PER_ENTRY = 250;     // average working memory entry cost
  const INPUT_FRACTION = 0.70;      // portion of context reserved for input
  const CHARS_PER_TOKEN = config.charsPerToken;

  // Only override if env vars not set (respect explicit user config)
  if (!process.env.AGENT_MAX_OUTPUT) {
    config.maxOutputTokens = Math.min(8192, Math.max(1024, Math.floor(ctxTokens * 0.18)));
  }
  if (!process.env.AGENT_MEMORY_WINDOW) {
    const inputBudgetTokens = ctxTokens * INPUT_FRACTION - STATIC_TOKENS;
    config.workingMemoryWindow = Math.min(50, Math.max(6, Math.floor(inputBudgetTokens / TOKENS_PER_ENTRY)));
  }
  if (!process.env.AGENT_COMPACT_THRESHOLD) {
    // Threshold in chars — trigger compaction when old working memory exceeds this
    const memBudgetChars = (ctxTokens * INPUT_FRACTION - STATIC_TOKENS) * CHARS_PER_TOKEN;
    config.compactionThresholdChars = Math.max(4000, Math.floor(memBudgetChars * 0.6));
  }
  if (!process.env.AGENT_COMPACT_INTERVAL) {
    // Compact more often on small contexts, less often on large ones
    config.compactionIntervalSteps = Math.min(30, Math.max(7, Math.floor(ctxTokens / 1600)));
  }
}

const HELP = `
Advanced Agent Loop — Autonomous agent. No framework. Pure loop + file-based state.

Usage:
  agent "Build a REST API with Express"          Run a new task in long-running mode
  agent --mode chat "What does this file do?"    Run in chat mode (direct, conversational)
  agent --resume                                 Resume from checkpoint
  agent --task-file task.txt                     Read task from file
  agent --workspace /path/to/project "task"      Specify workspace directory

Mission Profiles (--profile, -p):
  build (default)    Create/modify software. Six-stage lifecycle, smoke-test gated.
  research           Investigate and write an answer. No smoke test; evidence gated.
  errand             Take real-world actions. Gated on actuation receipts.
  converse           Answer/discuss directly. No stages, no gates.
  Omit --profile to infer the profile from the task text.

Modes:
  longrun (default)  Multi-step autonomous execution with checkpointing and memory.
  chat               Direct conversational answer, lighter tool use, session is persisted
                     in .agent/chats/. Use /run <task> inside chat to promote to longrun.

HITL Commands (Human-in-the-Loop):
  agent approve <id>             Approve a pending action
  agent deny <id> [reason]       Deny a pending action
  agent pause                    Pause the running agent
  agent resume                   Resume a paused agent
  agent steer "message"          Inject steering guidance mid-run
  agent hitl list                List pending approvals + clarifications
  agent clarify <id> "answer"    Answer a clarification request from the agent

Memory Inspection:
  agent memory status                   Overview of all memory layers
  agent memory recent [N]               Last N chat turns (default: 10)
  agent memory search <query>           Keyword search across chat sessions
  agent memory session <session-id>     Summary + turns for one session
  agent memory palace                   Memory Palace / CEI status
  agent memory lmma                     LMMA working-memory status

Options:
  --task, -t TASK        Set task description directly
  --profile, -p NAME     Mission profile: build | research | errand | converse
  --mode, -m MODE        Set execution mode: longrun (default) or chat
  --resume, -r           Resume from .agent/checkpoint.json
  --workspace, -w DIR    Set workspace directory (default: cwd)
  --task-file, -f FILE   Read task description from file
  --max-steps N          Override max steps (default: ${config.maxSteps > 0 ? config.maxSteps : 'disabled'})
  --no-tui, --line       Stream plain tagged lines (screen-reader / CI / pipe); no web-ui server
  --help, -h             Show this help
  --dry-run              Show what would happen without executing

Identity Layer:
  SOUL.md               Agent personality and identity (auto-created)
  AGENTS.md             Operating protocol and rules (auto-created)
  USER.md               User preferences learned over time
  MEMORY.md             Curated long-term knowledge

Persistence:
  .agent/memory/        Daily logs (YYYY-MM-DD.md), learnings, file tracking
  .agent/skills/        Agent-created reusable tools (.md files)
  .agent/checkpoint.json Crash recovery state
  .agent/plan.md        Task plan with progress tracking
  .agent/focus-chain.md Human-editable priority steering

Environment:
  AGENT_BASE_URL        LLM endpoint (default: ${config.baseURL})
  AGENT_MODEL           Model name (default: ${config.model})
  AGENT_MAX_STEPS       Max loop steps (default: ${config.maxSteps > 0 ? config.maxSteps : 'disabled'})
  AGENT_CONTEXT_WINDOW  Context window size (default: ${config.contextWindow})
`;

function formatMaxSteps(value) {
  return value > 0 ? String(value) : 'disabled';
}

function _findWorkspaceFromArgs(args) {
  const wi = args.findIndex(a => a === '--workspace' || a === '-w');
  if (wi !== -1 && args[wi + 1]) return path.resolve(args[wi + 1]);
  return null;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  // ── HITL sub-commands (Task 4.6) ────────────────────────────────────────────
  const subcmd = args[0];

  if (subcmd === 'approve') {
    const id = args[1];
    if (!id) { console.error('Usage: agent approve <id>'); process.exit(1); }
    // Set workspace so file paths resolve correctly
    const ws = _findWorkspaceFromArgs(args) || process.cwd();
    setWorkspace(ws);
    writeResponse(id, true, args[2] || 'approved by user');
    console.log(`Approved request ${id}`);
    process.exit(0);
  }

  if (subcmd === 'deny') {
    const id = args[1];
    if (!id) { console.error('Usage: agent deny <id> [reason]'); process.exit(1); }
    const ws = _findWorkspaceFromArgs(args) || process.cwd();
    setWorkspace(ws);
    writeResponse(id, false, args[2] || 'denied by user');
    console.log(`Denied request ${id}`);
    process.exit(0);
  }

  if (subcmd === 'pause') {
    const ws = _findWorkspaceFromArgs(args) || process.cwd();
    setWorkspace(ws);
    pause();
    console.log('Agent paused. Run `agent resume` to continue.');
    process.exit(0);
  }

  if (subcmd === 'resume') {
    const ws = _findWorkspaceFromArgs(args) || process.cwd();
    setWorkspace(ws);
    resume();
    console.log('Agent resumed.');
    process.exit(0);
  }

  if (subcmd === 'steer') {
    const message = args[1];
    if (!message) { console.error('Usage: agent steer "message"'); process.exit(1); }
    const ws = _findWorkspaceFromArgs(args) || process.cwd();
    setWorkspace(ws);
    const id = addSteeringMessage(message);
    console.log(`Steering message queued (id=${id})`);
    process.exit(0);
  }

  if (subcmd === 'hitl' && args[1] === 'list') {
    const ws = _findWorkspaceFromArgs(args) || process.cwd();
    setWorkspace(ws);
    const pending = listPending();
    const clarify = getPendingClarifications();
    if (pending.length === 0 && clarify.length === 0) {
      console.log('No pending HITL requests.');
    } else {
      if (pending.length > 0) {
        console.log(`\nPending approvals (${pending.length}):`);
        for (const r of pending) {
          console.log(`  [${r.id}] ${r.tool} — ${r.reason} (timeout: ${Math.round(r.timeoutMs / 1000)}s)`);
        }
      }
      if (clarify.length > 0) {
        console.log(`\nPending clarifications (${clarify.length}):`);
        for (const c of clarify) {
          console.log(`  [${c.id}] "${c.question}"`);
        }
      }
    }
    process.exit(0);
  }

  if (subcmd === 'clarify') {
    const id = args[1];
    const answer = args[2];
    if (!id || !answer) { console.error('Usage: agent clarify <id> "answer"'); process.exit(1); }
    const ws = _findWorkspaceFromArgs(args) || process.cwd();
    setWorkspace(ws);
    answerClarification(id, answer);
    console.log(`Answer recorded for clarification ${id}`);
    process.exit(0);
  }

  // ── Memory inspection sub-commands ──────────────────────────────────────────
  //
  //   agent memory status                       — overview of all memory layers
  //   agent memory recent [N]                   — last N chat turns (default 10)
  //   agent memory search <query>               — keyword search across sessions
  //   agent memory session <session-id>         — full summary for one session
  //   agent memory palace                       — palace / CEI status
  //   agent memory lmma                         — LMMA working-memory status
  //
  if (subcmd === 'memory') {
    const ws = _findWorkspaceFromArgs(args) || process.cwd();
    setWorkspace(ws);
    const sub2 = args[1] ?? 'status';

    // Collect positional arguments after sub2, skipping --flag/value pairs
    const memPositionals = [];
    for (let _i = 2; _i < args.length; _i++) {
      if (args[_i] === '--workspace' || args[_i] === '-w') { _i++; continue; }
      if (args[_i].startsWith('-')) continue;
      memPositionals.push(args[_i]);
    }

    if (sub2 === 'status') {
      const sessions = listSessions();
      const palaceDb = path.resolve(ws, config.palaceDbFile);
      const lmmaRoute = path.resolve(ws, config.lmmaActiveRouteFile);
      const memoryDir = path.resolve(ws, config.memoryDir);
      const chatsDir  = path.resolve(ws, config.chatsDir);

      console.log('=== Kairos Memory Status ===\n');
      console.log(`Workspace:         ${ws}`);
      console.log(`Chat sessions:     ${sessions.length}  (${fs.existsSync(chatsDir) ? chatsDir : 'not yet created'})`);
      console.log(`Memory Palace:     ${process.env.AGENT_USE_PALACE === '1' ? 'enabled' : 'disabled (set AGENT_USE_PALACE=1)'}`);
      console.log(`  episodic.db:     ${fs.existsSync(palaceDb) ? 'present' : 'absent'}`);
      console.log(`LMMA:              ${fs.existsSync(lmmaRoute) ? 'active-route exists' : 'no active route'}`);
      console.log(`Memory logs:       ${fs.existsSync(memoryDir) ? fs.readdirSync(memoryDir).length + ' files' : 'absent'}`);
      console.log(`MEMORY.md:         ${fs.existsSync(path.resolve(ws, config.memoryFile)) ? 'present' : 'absent'}`);
      console.log('');
      console.log('Memory layers:');
      console.log('  MEMORY.md          — curated durable facts');
      console.log('  .agent/memory/     — daily logs and summaries');
      console.log('  .agent/lmma/       — routing / intermediate memory structure');
      console.log('  .agent/palace/     — authoritative episodic memory (CEI)');
      console.log('  .agent/chats/      — conversational session history');
      process.exit(0);
    }

    if (sub2 === 'recent') {
      const n = parseInt(memPositionals[0] || '10', 10);
      const turns = recentTurns(n);
      if (turns.length === 0) { console.log('No chat turns recorded yet.'); process.exit(0); }
      for (const t of turns) {
        console.log(`[${t.sessionId}] [${(t.ts ?? '').slice(0, 16)}] ${t.role}: ${(t.content ?? '').slice(0, 200)}`);
      }
      process.exit(0);
    }

    if (sub2 === 'search') {
      const query = memPositionals[0];
      if (!query) { console.error('Usage: agent memory search <query>'); process.exit(1); }
      const results = searchTurns(query, 20);
      if (results.length === 0) { console.log(`No turns found matching "${query}".`); process.exit(0); }
      for (const t of results) {
        console.log(`[${t.sessionId}] [${(t.ts ?? '').slice(0, 16)}] ${t.role}: ${(t.content ?? '').slice(0, 200)}`);
      }
      process.exit(0);
    }

    if (sub2 === 'session') {
      const sessionId = memPositionals[0];
      if (!sessionId) { console.error('Usage: agent memory session <session-id>'); process.exit(1); }
      console.log(summarizeSession(sessionId));
      process.exit(0);
    }

    if (sub2 === 'palace') {
      const palaceDb  = path.resolve(ws, config.palaceDbFile);
      const palaceWal = palaceDb + '-wal';
      console.log('=== Memory Palace (CEI) Status ===\n');
      console.log(`Enabled:    ${process.env.AGENT_USE_PALACE === '1' ? 'yes' : 'no (AGENT_USE_PALACE not set to 1)'}`);
      console.log(`DB path:    ${palaceDb}`);
      console.log(`DB exists:  ${fs.existsSync(palaceDb) ? 'yes' : 'no'}`);
      console.log(`WAL exists: ${fs.existsSync(palaceWal) ? 'yes (active writes)' : 'no'}`);
      process.exit(0);
    }

    if (sub2 === 'lmma') {
      const lmmaDir   = path.resolve(ws, config.lmmaDir);
      const routeFile = path.resolve(ws, config.lmmaActiveRouteFile);
      const wmFile    = path.resolve(ws, config.lmmaWorkingMemoryFile);
      console.log('=== LMMA Memory Status ===\n');
      console.log(`LMMA dir:        ${lmmaDir}  (${fs.existsSync(lmmaDir) ? 'exists' : 'absent'})`);
      console.log(`Active route:    ${fs.existsSync(routeFile) ? fs.readFileSync(routeFile, 'utf-8').slice(0, 300) : 'absent'}`);
      console.log(`Working memory:  ${fs.existsSync(wmFile) ? fs.readFileSync(wmFile, 'utf-8').slice(0, 300) : 'absent'}`);
      process.exit(0);
    }

    console.error(`Unknown memory sub-command: ${sub2}`);
    console.error('Usage: agent memory <status|recent|search|session|palace|lmma>');
    process.exit(1);
  }

  // Parse arguments
  let resume = false;
  let workspace = process.cwd();
  let taskFile = null;
  let task = null;
  let dryRun = false;
  let agentMode = 'longrun';   // 'longrun' (default) | 'chat'
  let noTui = false;             // --no-tui / --line: in-process line renderer, no web-ui server
  let missionProfile = '';       // --profile: build | research | errand | converse ('' = infer)
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--resume': case '-r':
        resume = true;
        break;
      case '--workspace': case '-w':
        workspace = path.resolve(args[++i]);
        break;
      case '--task': case '-t':
        task = args[++i];
        break;
      case '--task-file': case '-f':
        taskFile = args[++i];
        break;
      case '--max-steps':
        config.maxSteps = parseInt(args[++i], 10);
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--profile': case '-p': {
        const requested = args[++i] ?? '';
        if (!isProfile(requested)) {
          console.error(`Unknown profile: ${requested}. Use one of: ${profileNames().join(', ')}`);
          process.exit(1);
        }
        missionProfile = requested;
        break;
      }
      case '--mode': case '-m':
        agentMode = args[++i] ?? 'longrun';
        if (!['longrun', 'chat'].includes(agentMode)) {
          console.error(`Unknown mode: ${agentMode}. Use: longrun, chat`);
          process.exit(1);
        }
        break;
      case '--no-tui': case '--line':
        noTui = true;
        break;
      default:
        positional.push(args[i]);
    }
  }

  // Set workspace
  setWorkspace(workspace);
  setLLMLogDir(workspace);
  console.error(`Workspace: ${workspace}`);

  // Determine task
  if (resume) {
    const cp = loadCheckpoint();
    if (cp && cp.step > 0) {
      task = readTask();
      console.error(`Resuming from step ${cp.step}`);
    } else {
      console.error('No checkpoint found. Start a new task instead.');
      process.exit(1);
    }
  } else if (taskFile) {
    const abs = path.resolve(workspace, taskFile);
    if (!fs.existsSync(abs)) {
      console.error(`Task file not found: ${abs}`);
      process.exit(1);
    }
    task = fs.readFileSync(abs, 'utf-8').trim();

    // If task file is markdown (.md), copy it into .agent/ as a reference file
    // so the agent can read the full content without it bloating the prompt.
    if (taskFile.endsWith('.md')) {
      const agentDir = path.resolve(workspace, config.agentDir);
      fs.mkdirSync(agentDir, { recursive: true });
      const refName = path.basename(taskFile);
      const refPath = path.resolve(agentDir, `task-reference-${refName}`);
      fs.copyFileSync(abs, refPath);
      // Store the reference path relative to workspace so context.js can use it
      const relRef = path.relative(workspace, refPath);
      task = `__MD_TASK_REF__:${relRef}\n${task}`;
    }
  } else if (positional.length > 0) {
    task = positional.join(' ');
  }

  if (!task) {
    console.error('No task provided. Use: agent "your task" or agent --resume');
    process.exit(1);
  }

  // Dry run: show what would happen
  if (dryRun) {
    console.log('=== DRY RUN ===');
    console.log(`Task: ${task}`);
    console.log(`Workspace: ${workspace}`);
    console.log(`Max steps: ${formatMaxSteps(config.maxSteps)}`);
    console.log(`Model: ${config.model}`);
    console.log(`Resume: ${resume}`);
    const _dryProfile = selectProfile(task, { explicit: missionProfile || config.missionProfile || '' });
    console.log(`Profile: ${_dryProfile.name} (${_dryProfile.reason})`);
    console.log('');
    console.log('Identity files: SOUL.md, AGENTS.md, USER.md, MEMORY.md');
    console.log('Memory dir: .agent/memory/');
    console.log('Skills dir: .agent/skills/');
    console.log('Features: pre-compaction flush, post-compaction recovery, dynamic skills');
    process.exit(0);
  }

  // Auto-detect model context window and scale config proportionally
  await autoDetectAndScale();

  // Live view: either the in-process line renderer (--no-tui, no server/port) or
  // the SSE server that the alt-screen TUI connects to. Both consume the same
  // gateway event bus; the line mode is a first-class screen-reader / CI / pipe path.
  if (noTui) {
    const gateway = await import('./hitl/gateway.js');
    const { attachLineRenderer } = await import('./observability/lineRenderer.js');
    attachLineRenderer(gateway);
  } else {
    // Start live-view SSE server in-process (shares gateway module → events flow to TUI)
    try {
      const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web-ui/server.js');
      const { startServer } = await import(serverPath);
      await startServer(workspace, config.hitlWebUiPort);
    } catch (err) {
      console.error(`[live-view] server failed to start: ${err.message} (TUI will show disconnected)`);
    }
  }

  // ── Chat session — persist the opening turn ──────────────────────────────────
  let chatSessionId = null;
  if (agentMode === 'chat' || agentMode === 'longrun') {
    try {
      const { newSessionId, appendTurn } = await import('./chat/session.js');
      chatSessionId = newSessionId();
      appendTurn(chatSessionId, 'user', task, { mode: agentMode });
    } catch {
      // session persistence is optional
    }
  }

  // In chat mode use a small default step budget so the response stays concise.
  // Users can still override with --max-steps.
  if (agentMode === 'chat' && config.maxSteps === 0) {
    config.maxSteps = parseInt(process.env.AGENT_CHAT_MAX_STEPS || '10', 10);
  }

  // Banner
  console.error('╔══════════════════════════════════════════════════╗');
  console.error('║            Advanced Agent Loop                   ║');
  console.error('║  Identity | Persistent Memory | Skills | Plans   ║');
  console.error('║  No framework. Pure loop. Maximum stability.     ║');
  console.error('╚══════════════════════════════════════════════════╝');
  console.error(`Mode: ${agentMode}${chatSessionId ? `  session=${chatSessionId}` : ''}`);
  console.error(`Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`);
  const profileNote = config.modelProfile?.notes ? ` (${config.modelProfile.notes.split('.')[0]})` : '';
  console.error(`Max steps: ${formatMaxSteps(config.maxSteps)} | Model: ${config.model}${profileNote}`);
  console.error(`Context: ${config.contextWindow} tokens | Output: ${config.maxOutputTokens} | Memory window: ${config.workingMemoryWindow} | Compact every: ${config.compactionIntervalSteps} steps`);
  console.error('Features: identity layer, memory flush, skill creation, focus chain');
  console.error('');

  // Run
  const startTime = Date.now();

  const result = await runLoop({
    task,
    workspace,
    resume,
    profile: missionProfile || undefined,
    onStep: (step, action, toolResult) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const truncResult = toolResult.slice(0, 80).replace(/\n/g, ' ');
      console.error(`  [${elapsed}s] Step ${step}: ${action.tool}(${JSON.stringify(action.args).slice(0, 60)}) → ${truncResult}`);
    },
  });

  // Persist the agent's final reply into the chat session
  if (chatSessionId && result.summary) {
    try {
      const { appendTurn } = await import('./chat/session.js');
      appendTurn(chatSessionId, 'assistant', result.summary, {
        mode: agentMode,
        promoted: agentMode === 'longrun',
      });
    } catch {
      // session persistence is optional
    }
  }

  // Final report
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error('');
  console.error('═══════════════════════════════════════════════════');
  console.error(`Exit: ${result.exitReason}`);
  console.error(`Steps: ${result.totalSteps}`);
  console.error(`Time: ${elapsed}s`);
  console.error(`Step latency avg/p95: ${result.avgStepLatencyMs}ms / ${result.p95StepLatencyMs}ms`);
  console.error(`Chars: ${result.totalCharsUsed.toLocaleString()}`);
  console.error(`Compactions: ${result.compactionCount}`);
  console.error(`Memories flushed: ${result.memoriesFlushed}`);
  console.error(`Skills created: ${result.skillsCreated}`);
  if (chatSessionId) console.error(`Session: ${chatSessionId}  (agent memory session <id> to review)`);
  console.error('═══════════════════════════════════════════════════');
  console.error(`Summary: ${result.summary}`);

  // Exit code
  process.exit(result.exitReason === 'completed' ? 0 : 1);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(2);
});
