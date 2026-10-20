// src/observability/costTracker.js
// Per-run token + dollar cost accounting. Zero external deps.
// Writes to .agent/telemetry/cost.jsonl (one record per session/agent).
// Task 6.9

import fs from 'node:fs';
import path from 'node:path';
import { resolveContext } from '../runtime/context.js';

// ── Pricing table (dollars per 1M tokens) ────────────────────────────────────
// Defaults used when model is not in the table. Override via KAIROS_COST_PER_1M_IN / OUT.
const PRICE_TABLE = {
  // Anthropic
  'claude-opus-4':         { in: 15.00, out: 75.00 },
  'claude-sonnet-4':       { in:  3.00, out: 15.00 },
  'claude-haiku-4':        { in:  0.80, out:  4.00 },
  // OpenAI
  'gpt-4o':                { in:  2.50, out: 10.00 },
  'gpt-4o-mini':           { in:  0.15, out:  0.60 },
  // Local / vLLM — effectively zero but non-zero to enable cost tracking
  'qwen':                  { in:  0.00, out:  0.00 },
  'gpt-oss':               { in:  0.00, out:  0.00 },
  'nemotron':              { in:  0.00, out:  0.00 },
  'minimax':               { in:  0.00, out:  0.00 },
};

function priceFor(modelId) {
  if (process.env.KAIROS_COST_PER_1M_IN || process.env.KAIROS_COST_PER_1M_OUT) {
    return {
      in:  parseFloat(process.env.KAIROS_COST_PER_1M_IN  || '0'),
      out: parseFloat(process.env.KAIROS_COST_PER_1M_OUT || '0'),
    };
  }
  const id = String(modelId || '').toLowerCase();
  // Longest key first so the most specific model wins: 'gpt-4o-mini' must not be
  // matched by the substring 'gpt-4o' (which over-billed mini ~16×).
  const keys = Object.keys(PRICE_TABLE).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (id.includes(key)) return PRICE_TABLE[key];
  }
  return { in: 0.00, out: 0.00 };
}

// ── Per-session accumulator ───────────────────────────────────────────────────
//
// Phase 1.4 (de-globalization): these counters were seven module-level `let`s,
// so every concurrent run in a process shared one accumulator — two missions
// would sum into a single bill and `startSession()` from one would zero the
// other. They now live in a per-context slot. All functions take an optional
// trailing `ctx`; omitting it uses the ambient context, so existing callers are
// unchanged.

const SLOT = 'observability:cost';

function acc(ctx) {
  return resolveContext(ctx).slot(SLOT, () => ({
    sessionId:   null,
    agentId:     'default',
    promptTok:   0,
    completeTok: 0,
    calls:       0,
    startMs:     Date.now(),
    stageStats:  {},   // stage → { promptTokens, completionTokens, calls }
  }));
}

/** Initialize (or reset) cost tracking for a new session. */
export function startSession(sessionId, agentId = 'default', ctx) {
  const a = acc(ctx);
  a.sessionId   = sessionId || `sess-${Date.now()}`;
  a.agentId     = agentId;
  a.promptTok   = 0;
  a.completeTok = 0;
  a.calls       = 0;
  a.startMs     = Date.now();
  a.stageStats  = {};
}

/**
 * Record token usage from one LLM call.
 * @param {{ prompt_tokens: number, completion_tokens: number }} usage
 * @param {string} [stage] - the stage this call was made in (for per-stage breakdown)
 * @param {import('../runtime/context.js').AgentContext} [ctx]
 */
export function recordUsage(usage, stage = '', ctx) {
  const a  = acc(ctx);
  const pt = Number(usage?.prompt_tokens   || 0);
  const ct = Number(usage?.completion_tokens || 0);
  a.promptTok   += pt;
  a.completeTok += ct;
  a.calls++;
  if (stage) {
    const s = a.stageStats[stage] || { promptTokens: 0, completionTokens: 0, calls: 0 };
    s.promptTokens += pt;
    s.completionTokens += ct;
    s.calls++;
    a.stageStats[stage] = s;
  }
}

/**
 * Compute cost summary for the current session.
 * @param {import('../runtime/context.js').AgentContext} [ctx]
 * @returns {{ promptTokens, completionTokens, totalTokens, estimatedDollars, calls, model }}
 */
export function sessionCost(ctx) {
  const c = resolveContext(ctx);
  const a = acc(c);
  // Price against THIS context's model, not the process-wide singleton. A
  // conductor dispatching specialists on different models previously billed
  // every one of them at config.model's rate.
  const model  = c.config.model || 'unknown';
  const price  = priceFor(model);
  const dollars = (a.promptTok / 1_000_000) * price.in + (a.completeTok / 1_000_000) * price.out;
  // Per-stage breakdown of tokens + dollars (same pricing as the session total).
  const stages = {};
  for (const [stage, s] of Object.entries(a.stageStats)) {
    const d = (s.promptTokens / 1_000_000) * price.in + (s.completionTokens / 1_000_000) * price.out;
    stages[stage] = {
      promptTokens:     s.promptTokens,
      completionTokens: s.completionTokens,
      totalTokens:      s.promptTokens + s.completionTokens,
      calls:            s.calls,
      dollars:          Math.round(d * 1_000_000) / 1_000_000,
    };
  }
  return {
    sessionId:        a.sessionId,
    agentId:          a.agentId,
    model,
    calls:            a.calls,
    promptTokens:     a.promptTok,
    completionTokens: a.completeTok,
    totalTokens:      a.promptTok + a.completeTok,
    estimatedDollars: Math.round(dollars * 1_000_000) / 1_000_000,
    durationMs:       Date.now() - a.startMs,
    stages,
  };
}

/**
 * Flush the current session cost record to disk.
 * @param {string} workspace
 * @param {import('../runtime/context.js').AgentContext} [ctx]
 */
export function flushCost(workspace, ctx) {
  const c = resolveContext(ctx);
  const dir = path.join(workspace || c.workspace || process.cwd(), c.config.telemetryDir || '.agent/telemetry');
  const file = path.join(dir, 'cost.jsonl');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...sessionCost(c), ts: new Date().toISOString() }) + '\n', 'utf-8');
  } catch { /* non-critical */ }
}
