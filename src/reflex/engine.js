// src/reflex/engine.js
// The reflex layer (4.2): answer now, or say honestly that this is a job.
//
// A mission is the right shape for "build me a REST API" and completely the
// wrong shape for "what time is it" — six stages, a smoke-test gate and a
// sandbox verifier to answer a question is not thoroughness, it is a system
// that is exhausting to talk to. The reflex is the other mode: one model call,
// at most one cheap tool, and a hard ceiling on how long the user waits.
//
// Three rules make this safe rather than just fast:
//
//   1. **At most one tool, T0/T1 only.** A reflex that can loop is a mission
//      with no gates — no budget, no verification, no HITL. The single-tool cap
//      is what keeps it a reflex.
//   2. **The latency budget is a real deadline, not a hint.** Exceeding it
//      returns what exists so far and says it was cut short. A "fast path" that
//      occasionally takes forty seconds is worse than no fast path, because the
//      user stops trusting either mode.
//   3. **Escalation proposes; it never spawns.** When the ask turns out to be
//      bigger than a sentence, the reflex says "that's a twenty-minute job —
//      start it?" and stops. Silently converting a question into twenty minutes
//      of autonomous file editing is precisely the behaviour that makes an
//      agent untrustworthy.

import { classify } from '../router/classify.js';
import { modulate } from '../brain/neuromodulator.js';

/**
 * Tools a reflex may call. T0 (read-only local) plus save_memory, which is T1
 * (reversible local write) and is the one write worth having: remembering
 * something the user just said should not require a mission.
 *
 * Everything absent from this list is absent on purpose — no run_command, no
 * write_file, no MCP. Those have real-world consequences and belong behind the
 * mission gates and the P7 trust tiers.
 */
export const REFLEX_TOOLS = Object.freeze([
  'read_file', 'list_dir', 'glob', 'search_files',
  'search_memory', 'recall_by_domain', 'recall_by_entity', 'recall_temporal',
  'recall_chat_session', 'recall_room',
  'save_memory', 'think',
]);

/** Default ceiling on a reflex turn, end to end. */
export const DEFAULT_LATENCY_BUDGET_MS = 8_000;

/** How much conversation history a reflex sees. */
const HISTORY_TURNS = 8;

const ESCALATE_MARKER = /^\s*MISSION:\s*(.+)$/im;
const TOOL_MARKER = /^\s*TOOL:\s*([a-z_]+)\s*(\{[\s\S]*?\})\s*$/im;

const SYSTEM_PROMPT = `You are the fast conversational layer of an autonomous agent system.

Answer directly and briefly — a sentence or two unless more is genuinely needed.
You are talking, not writing a document. No preamble, no restating the question.

You have TWO special replies available:

1. If you need to look at exactly one thing before answering, reply with only:
   TOOL: <tool_name> {"arg": "value"}
   You get one look. Use it, then answer.

2. If the request is real work — building, refactoring, multi-file changes,
   research that needs many steps, anything taking more than a couple of
   minutes — do NOT attempt it. Reply with only:
   MISSION: <one-line restatement of the job>
   The user will be asked whether to start it. Never start work yourself.

Otherwise just answer.`;

/**
 * Run one reflex turn.
 *
 * @param {string} utterance
 * @param {object} [opts]
 * @param {string}   [opts.sessionId]
 * @param {string}   [opts.workspace]
 * @param {object[]} [opts.history]          prior turns: {role, content}
 * @param {string}   [opts.recall]           memory context to include (L4)
 * @param {number}   [opts.latencyBudgetMs]
 * @param {object}   [opts.brain]            B1 neuromodulator state; tightens the
 *                                           deadline when someone is waiting and
 *                                           relaxes it when the room is empty
 * @param {function} [opts.llm]              async (messages, opts) => text
 * @param {function} [opts.execTool]         async (name, args) => {result, error}
 * @param {function} [opts.now]
 * @returns {Promise<object>} the reflex result
 */
export async function reflex(utterance, {
  sessionId = null,
  workspace = null,
  history = [],
  recall = '',
  latencyBudgetMs = DEFAULT_LATENCY_BUDGET_MS,
  brain = null,
  llm = null,
  execTool = null,
  onToken = null,
  now = Date.now,
} = {}) {
  const started = now();
  const text = String(utterance || '').trim();
  // The budget is still a hard deadline — the brain only decides how long it
  // is. With no brain state this is exactly the caller's number.
  const budgetMs = modulate({ latencyBudgetMs }, brain).latencyBudgetMs;
  const deadline = started + budgetMs;

  if (!text) {
    return result({ text: '', started, now, degraded: 'empty utterance' });
  }

  // Only the FIRST call streams. The follow-up after a tool is short and the
  // user has already seen the stream stop for the lookup; streaming it too
  // would make the answer appear to restart.
  const callLlm = llm || defaultLlm;
  const runTool = execTool || defaultExecTool;

  // A mission-shaped ask is refused before spending a model call on it. The
  // classifier already knows; asking the LLM to rediscover it is latency the
  // user pays for nothing.
  const routed = classify(text, { hasWorkspace: !!workspace });
  if (routed.intent === 'mission') {
    return result({
      started, now,
      text: '',
      escalation: {
        proposed: true,
        task: text,
        profile: routed.profile,
        reason: 'the router classified this as a job, not a question',
      },
    });
  }

  const messages = buildMessages({ text, history, recall, workspace });

  let reply;
  try {
    reply = await withDeadline(callLlm(messages, { deadline, onToken }), deadline, now);
  } catch (err) {
    if (err?.code === 'DEADLINE') {
      return result({ started, now, text: '', truncated: true, degraded: `no answer within ${budgetMs}ms` });
    }
    // S3: the endpoint is down. Say so rather than hanging or inventing.
    return result({ started, now, text: '', degraded: `model unavailable: ${err?.message || err}` });
  }

  // ── Escalation ────────────────────────────────────────────────────
  const escalated = ESCALATE_MARKER.exec(reply || '');
  if (escalated) {
    const task = escalated[1].trim();
    return result({
      started, now,
      text: '',
      escalation: {
        proposed: true,
        task,
        profile: classify(task, { hasWorkspace: !!workspace }).profile || 'build',
        reason: 'the model judged this to be more than a quick answer',
      },
    });
  }

  // ── One tool, then answer ─────────────────────────────────────────
  const wantsTool = TOOL_MARKER.exec(reply || '');
  if (!wantsTool) {
    return result({ started, now, text: (reply || '').trim() });
  }

  const toolName = wantsTool[1];
  if (!REFLEX_TOOLS.includes(toolName)) {
    // Refused, not silently dropped: the model asked for something the reflex
    // is not allowed to do, and the honest move is to offer the mission path.
    return result({
      started, now,
      text: '',
      escalation: {
        proposed: true,
        task: text,
        profile: classify(text, { hasWorkspace: !!workspace }).profile || 'build',
        reason: `answering needs "${toolName}", which is not safe to run without the mission gates`,
      },
      refusedTool: toolName,
    });
  }

  let args = {};
  try { args = JSON.parse(wantsTool[2]); } catch { args = {}; }

  let toolResult;
  try {
    toolResult = await withDeadline(runTool(toolName, args), deadline, now);
  } catch (err) {
    if (err?.code === 'DEADLINE') {
      return result({ started, now, text: '', toolUsed: toolName, truncated: true,
        degraded: `the lookup did not finish within ${budgetMs}ms` });
    }
    toolResult = { result: `tool failed: ${err?.message || err}`, error: true };
  }

  // Second and final model call. There is no loop here by construction — this
  // path cannot ask for another tool, which is what keeps a reflex bounded.
  const followUp = [
    ...messages,
    { role: 'assistant', content: `TOOL: ${toolName} ${JSON.stringify(args)}` },
    {
      role: 'user',
      content: `Result of ${toolName}:\n${String(toolResult?.result ?? '').slice(0, 4000)}\n\n` +
               `Now answer the original question directly. Do not request another tool.`,
    },
  ];

  let finalReply;
  try {
    finalReply = await withDeadline(callLlm(followUp, { deadline }), deadline, now);
  } catch (err) {
    return result({
      started, now, toolUsed: toolName, truncated: err?.code === 'DEADLINE',
      text: '',
      degraded: err?.code === 'DEADLINE'
        ? `looked it up but ran out of time to answer (${budgetMs}ms)`
        : `model unavailable: ${err?.message || err}`,
    });
  }

  // A model that ignores "do not request another tool" gets its marker stripped
  // rather than obeyed — one tool means one.
  const cleaned = String(finalReply || '').replace(TOOL_MARKER, '').trim();
  return result({ started, now, text: cleaned, toolUsed: toolName });
}

function buildMessages({ text, history, recall, workspace }) {
  const context = [];
  if (workspace) context.push(`Working directory: ${workspace}`);
  if (recall) context.push(`What you remember that may be relevant:\n${recall}`);

  // ONE system message, always first. Two of them is valid OpenAI and is
  // rejected outright by vLLM serving Qwen ("System message must be at the
  // beginning", HTTP 400) — which took the whole reflex path down the first
  // time a real local endpoint was pointed at it. Concatenating costs nothing
  // and works everywhere.
  const system = context.length
    ? `${SYSTEM_PROMPT}\n\n${context.join('\n\n')}`
    : SYSTEM_PROMPT;
  const msgs = [{ role: 'system', content: system }];

  // Only the tail: a reflex is a fast path, and a long transcript is both slow
  // to send and the main way a "quick" answer stops being quick.
  for (const turn of history.slice(-HISTORY_TURNS)) {
    if (!turn?.content) continue;
    msgs.push({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: String(turn.content) });
  }

  msgs.push({ role: 'user', content: text });
  return msgs;
}

/**
 * Race a promise against the turn's deadline.
 *
 * The timer is cleared on both paths — an uncleared timer per reflex turn keeps
 * the event loop alive and, in a daemon answering all day, is a slow leak.
 */
function withDeadline(promise, deadline, now) {
  const remaining = deadline - now();
  if (remaining <= 0) return Promise.reject(deadlineError());
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(deadlineError()), remaining);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

function deadlineError() {
  const err = new Error('reflex latency budget exceeded');
  err.code = 'DEADLINE';
  return err;
}

function result({ started, now, text = '', toolUsed = null, escalation = null, truncated = false, degraded = null, refusedTool = null }) {
  return {
    text,
    toolUsed,
    escalation,
    truncated,
    degraded,
    refusedTool,
    latencyMs: now() - started,
  };
}

/**
 * Render an escalation as something a person can answer.
 * Kept separate from the engine so voice (P8) and the TUI can phrase it
 * differently without the decision logic knowing about either.
 */
export function escalationPrompt(escalation) {
  if (!escalation?.proposed) return '';
  const kind = escalation.profile === 'research' ? 'a research job'
    : escalation.profile === 'errand' ? 'an errand'
    : 'a build job';
  return `That's ${kind}, not a quick answer — ${escalation.task}\nStart it?`;
}

async function defaultLlm(messages, { deadline, onToken } = {}) {
  const { chatCompletion, streamCompletion } = await import('../llm.js');
  const { default: config } = await import('../config.js');

  // Streaming exists for perceived latency: first token in ~200ms reads as
  // instant even when the full answer takes two seconds. It is also the hook
  // P8 needs for barge-in — you cannot interrupt a reply you cannot hear yet.
  if (typeof onToken === 'function') {
    const streamed = await streamCompletion(messages, {
      model: config.cheapModel || config.model,
      temperature: 0.3,
      maxOutputTokens: 512,
      onToken,
    });
    return streamed.content;
  }

  const res = await chatCompletion(messages, {
    // The cheap model by design (D7): the reflex is the latency-sensitive path,
    // and a 30B local model answering in 1s beats a strong model answering in 12.
    model: config.cheapModel || config.model,
    temperature: 0.3,
    maxOutputTokens: 512,
    timeoutMs: deadline ? Math.max(500, deadline - Date.now()) : undefined,
  });
  return typeof res === 'string' ? res : (res?.content ?? '');
}

async function defaultExecTool(name, args) {
  const { executeTool } = await import('../tools.js');
  return executeTool(name, args);
}
