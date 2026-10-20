// advanced-agent-loop/src/llm.js
// Minimal LLM client for vLLM / OpenAI-compatible endpoints.
// Zero dependencies — uses Node's native fetch.

import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import logger from './logger.js';
import { traced } from './tracer.js';
import { resolveContext } from './runtime/context.js';
import { pickTier } from './brain/neuromodulator.js';
import { recordUsage as recordLedgerUsage } from './kernel/usage.js';

// ── LLM Output Logger ──────────────────────────────────────────
// Logs every LLM request/response to .agent/llm-log.jsonl for analysis.
// Phase 1.4: the log path was module-level, so the last run to call
// setLLMLogDir() captured every concurrent run's LLM traffic into its own file.
// Now per-context; omitting `ctx` uses the ambient one, so callers are unchanged.
const LOG_SLOT = 'llm:logFile';

function logSlot(ctx) {
  return resolveContext(ctx).slot(LOG_SLOT, () => ({ path: null }), { workspaceScoped: true });
}

export function setLLMLogDir(workspace, ctx) {
  const c = resolveContext(ctx);
  const agentDir = path.join(workspace, c.config.agentDir || '.agent');
  if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
  logSlot(c).path = path.join(agentDir, 'llm-log.jsonl');
}

function logLLMCall(entry, ctx) {
  const target = logSlot(ctx).path;
  if (!target) return;
  try {
    fs.appendFileSync(target, JSON.stringify(entry) + '\n');
  } catch { /* non-critical */ }
}

// ── API-key resolution ─────────────────────────────────────────
// A key may arrive as a `vault:scope.key` reference (model registry / env).
// Resolved lazily and cached: the vault backend can shell out to the OS
// credential store, which must not happen at import time — and must happen at
// most once per process, not once per request.
const _resolvedKeys = new Map();
export async function resolveApiKey(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('vault:')) return raw;
  if (_resolvedKeys.has(raw)) return _resolvedKeys.get(raw);
  const { getVault } = await import('./kernel/vault.js');
  const value = getVault().resolve(raw);
  _resolvedKeys.set(raw, value);
  return value;
}

// Status codes that are safe to retry (transient server-side issues)
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// Status codes that are permanent client-side errors — never retry, surface actionable message
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 413, 422]);
const NON_RETRYABLE_HINTS = {
  400: 'bad request — check model parameters or message format',
  401: 'unauthorized — check AGENT_API_KEY',
  403: 'forbidden — check API key permissions',
  404: 'endpoint not found — check AGENT_BASE_URL',
  // Seen live from a gateway enforcing per-key token limits: the same prompt
  // will be exactly as long on the retry, so retrying is pure waste.
  413: 'request too large — the prompt exceeds a per-request token limit (gateway key limits, or lower AGENT_CONTEXT_WINDOW)',
  422: 'unprocessable request — invalid parameters',
};
const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 3;
// 429 rate-limits need much longer backoff — server may be saturated for minutes
const RATE_LIMIT_MAX_RETRIES = 8;
const RATE_LIMIT_BASE_DELAY_MS = 5000;
// Not every 429 is a rate limit. A gateway answering "Weekly token quota
// exceeded" will answer it identically after any backoff — the quota resets on
// a schedule measured in days, not seconds. Seen live: a mission spent 4+
// minutes per step walking the full 8-attempt ladder against an exhausted key.
const QUOTA_EXHAUSTED_RE = /quota|billing|insufficient[_ ]credit|out of credit/i;

/**
 * fetch() wrapper with exponential backoff.
 * Retries on network errors (fetch failed / ECONNRESET / ETIMEDOUT) and
 * on retryable HTTP status codes (429, 5xx).
 * 429 gets extra-long retries (up to 8 attempts with 5s/10s/20s/40s... backoff).
 */
async function fetchWithRetry(url, opts) {
  let lastErr;
  let maxAttempts = MAX_RETRIES;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = lastErr?.is429
        ? Math.min(RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt - 1), 60000)
        : RETRY_DELAY_MS * attempt;
      const tag = lastErr?.is429 ? '429 rate-limit' : 'retry';
      logger.warn(`[${tag}] waiting ${(delay / 1000).toFixed(0)}s before attempt ${attempt + 1}/${maxAttempts}...`);
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      const timeoutMs = parseInt(process.env.AGENT_LLM_TIMEOUT_MS || '120000', 10);
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      // 429 rate-limit — use extended retry budget
      if (res.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES - 1) {
        // ...unless the body says the KEY is spent, not the moment. Waiting
        // cannot fix an exhausted quota — fail once, loudly, with the hint.
        const body429 = await res.text().catch(() => '');
        if (QUOTA_EXHAUSTED_RE.test(body429)) {
          throw Object.assign(
            new Error(`LLM request failed (429): token quota exhausted — retrying cannot help; raise the key's quota or wait for its reset: ${body429.slice(0, 200)}`),
            { nonRetryable: true, status: 429, quotaExhausted: true }
          );
        }
        lastErr = Object.assign(new Error('HTTP 429'), { is429: true });
        maxAttempts = RATE_LIMIT_MAX_RETRIES;
        continue;
      }
      // Non-retryable client errors — fail immediately with an actionable message
      if (NON_RETRYABLE_STATUS.has(res.status)) {
        const hint = NON_RETRYABLE_HINTS[res.status] || '';
        const text = await res.text().catch(() => '');
        throw Object.assign(
          new Error(`LLM request failed (${res.status})${hint ? ': ' + hint : ''}: ${text.slice(0, 200)}`),
          { nonRetryable: true, status: res.status }
        );
      }
      // Other retryable HTTP errors — standard retry budget
      if (!res.ok && RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES - 1) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      // The non-retryable throw above lands in this very catch — it must pass
      // through, or the classification is decoration. It was decoration: every
      // 401/404/413 was retried with full backoff since this file was written,
      // found the day a real gateway answered 413 and a test finally looked.
      if (err?.nonRetryable) throw err;
      // Network error (fetch failed, ECONNRESET, etc.) — retry
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Send a chat completion request.
 * Retries once on transient HTTP errors (429, 5xx) before throwing.
 * @param {Array<{role:string, content:string}>} messages
 * @param {Object} opts - Override config for this call
 * @returns {Promise<{content:string, usage:{prompt_tokens:number, completion_tokens:number, total_tokens:number}}>}
 */
export async function chatCompletion(messages, opts = {}) {
  // Record/replay boundary: in replay mode the recorded completion is returned
  // without touching the network, making the run deterministic. Key on the
  // inputs that determine the output (messages + sampling params).
  return traced(
    'llm',
    {
      messages,
      model: opts.model || config.model,
      temperature: opts.temperature ?? config.temperature,
      max_tokens: opts.maxOutputTokens || config.maxOutputTokens,
    },
    () => _chatCompletionLive(messages, opts),
  );
}

async function _chatCompletionLive(messages, opts = {}) {
  const url = `${opts.baseURL || config.baseURL}/chat/completions`;
  const body = {
    model: opts.model || config.model,
    messages,
    temperature: opts.temperature ?? config.temperature,
    max_tokens: opts.maxOutputTokens || config.maxOutputTokens,
    stream: false,
    // Disable extended thinking for Qwen/QwQ/DeepSeek/MiniMax when requested.
    // Without this, thinking tokens can consume the entire output budget before JSON is emitted.
    // Gated on the TARGET model, not just the env flag: chat_template_kwargs is
    // a vLLM extension, and OpenAI cloud models 400 on any unknown parameter.
    // AGENT_NO_THINKING is auto-set for Qwen default profiles, and that one env
    // flag must not poison a call that explicitly targets a different model —
    // it did: the first live `ontology verify --model gpt-5.4-mini` fell to the
    // deterministic floor on exactly this 400.
    ...(process.env.AGENT_NO_THINKING === '1'
      && /qwen|qwq|deepseek|minimax|glm/i.test(String(opts.model || config.model))
      && { chat_template_kwargs: { enable_thinking: false } }),
  };

  const requestOpts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };

  const apiKey = await resolveApiKey(opts.apiKey ?? config.apiKey);
  if (apiKey) {
    requestOpts.headers.Authorization = `Bearer ${apiKey}`;
    requestOpts.headers['X-API-KEY'] = apiKey;
  }

  const fetchStartMs = Date.now();
  const res = await fetchWithRetry(url, requestOpts);
  const fetchDoneMs = Date.now();

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('LLM returned no choices');

  // Some thinking/reasoning models return content as an array of blocks
  // (e.g. {type:"thinking", thinking:"..."} + {type:"text", text:"..."})
  // Others separate reasoning into a `reasoning_content` field.
  let content = choice.message?.content;
  if (Array.isArray(content)) {
    // Keep only text blocks; skip thinking/reasoning blocks
    content = content
      .filter(block => block.type === 'text')
      .map(block => block.text || '')
      .join('');
  } else if (!content && choice.message?.reasoning_content) {
    // Fallback: some vLLM builds put the full output (thinking + action) in reasoning_content
    content = choice.message.reasoning_content;
  }

  const result = {
    content: content || '',
    usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    finishReason: choice.finish_reason || 'stop',
    latencyMs: fetchDoneMs - fetchStartMs,
  };

  // Log full request/response for vLLM optimization
  logLLMCall({
    ts: new Date().toISOString(),
    model: body.model,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    prompt_tokens: result.usage.prompt_tokens,
    completion_tokens: result.usage.completion_tokens,
    total_tokens: result.usage.total_tokens,
    finish_reason: result.finishReason,
    latency_ms: result.latencyMs,
    input_messages: messages.map(m => ({ role: m.role, content_length: (m.content || '').length })),
    output_length: result.content.length,
    output_raw: result.content,
  });

  // The spend meter lives on this exact line because this is the one path
  // every completion in the system takes — a meter at any call site instead
  // would under-count the moment a new caller appeared. Token counts are the
  // API's own (`data.usage`), never estimates. In traced replay mode this
  // function is not entered, so replayed calls are not double-billed.
  recordLedgerUsage({
    model: body.model,
    baseURL: opts.baseURL || config.baseURL,
    purpose: opts.purpose || process.env.KAIROS_USAGE_PURPOSE || 'other',
    usage: result.usage,
    latencyMs: result.latencyMs,
  });

  return result;
}

/**
 * Streaming completion, for the reflex layer (P4.2).
 *
 * Separate from `chatCompletion` rather than a flag on it, for two reasons.
 * First, the loop's every decision goes through the record/replay tracer, and a
 * token stream is not a recordable value — mixing them would make replay lie.
 * Second, the loop needs the *complete* JSON action before it can do anything,
 * so streaming buys it nothing; only a human reading words as they arrive
 * benefits, and that is exactly the reflex.
 *
 * @param {object[]} messages
 * @param {object} [opts]
 * @param {function} [opts.onToken]  called with each text delta
 * @param {AbortSignal} [opts.signal] cancels mid-stream (P8 barge-in)
 * @returns {Promise<{content: string, finishReason: string, latencyMs: number}>}
 */
export async function streamCompletion(messages, opts = {}) {
  const url = `${opts.baseURL || config.baseURL}/chat/completions`;
  const body = {
    model: opts.model || config.model,
    messages,
    temperature: opts.temperature ?? config.temperature,
    max_tokens: opts.maxOutputTokens || config.maxOutputTokens,
    stream: true,
    ...(process.env.AGENT_NO_THINKING === '1' && { chat_template_kwargs: { enable_thinking: false } }),
  };

  const headers = { 'Content-Type': 'application/json' };
  const apiKey = await resolveApiKey(opts.apiKey ?? config.apiKey);
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['X-API-KEY'] = apiKey;
  }

  const startMs = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM stream failed (${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.body) throw new Error('LLM stream returned no body');

  const decoder = new TextDecoder();
  const onToken = typeof opts.onToken === 'function' ? opts.onToken : null;
  let buffer = '';
  let content = '';
  let finishReason = 'stop';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    // SSE frames are separated by a blank line, and a network chunk can split
    // one down the middle — only complete frames are parsed, the tail is kept.
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta?.content;
        if (typeof delta === 'string' && delta) {
          content += delta;
          if (onToken) {
            // A throwing consumer must not abort the stream — the answer is
            // still worth completing even if one renderer is broken.
            try { onToken(delta); } catch { /* renderer's problem */ }
          }
        }
      }
    }
  }

  return { content, finishReason, latencyMs: Date.now() - startMs };
}

/**
 * Get embedding vectors for texts via the OpenAI-compatible /embeddings endpoint.
 * Returns number[][] (one vector per input), or null when the endpoint is
 * unavailable/unsupported — callers should fall back to lexical search.
 * Kept deliberately fast-failing (short timeout, no long retries).
 * @param {string|string[]} texts
 * @param {Object} [opts]
 */
export async function embed(texts, opts = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (list.length === 0) return [];
  const url = `${opts.baseURL || config.baseURL}/embeddings`;
  const model = opts.model || process.env.AGENT_EMBED_MODEL || 'text-embedding-3-small';
  const headers = { 'Content-Type': 'application/json' };
  try {
    const apiKey = await resolveApiKey(opts.apiKey ?? config.apiKey);
    if (apiKey) { headers.Authorization = `Bearer ${apiKey}`; headers['X-API-KEY'] = apiKey; }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: list }),
      signal: AbortSignal.timeout(parseInt(process.env.AGENT_EMBED_TIMEOUT_MS || '15000', 10)),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data?.data)) return null;
    const sorted = data.data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vecs = sorted.map((d) => d.embedding).filter(Array.isArray);
    return vecs.length === list.length ? vecs : null;
  } catch {
    return null;
  }
}

// Stages where the stronger model pays off (planning-quality decisions)
const STRONG_STAGES = new Set(['planning', 'verification', 'finalization']);

/**
 * Return the model ID to use for a given stage name.
 * Falls back to config.model when AGENT_CHEAP_MODEL / AGENT_STRONG_MODEL are not set.
 *
 * The stage is the primary signal — it reflects what the call is *for*, which
 * does not change. B1's neuromodulator state is the secondary one, reflecting
 * what the system can *afford* right now, and it may only override the stage
 * choice in the two directions that are always defensible: downgrade under
 * contention (a queued strong call helps nobody), upgrade when work is going
 * badly and there is room to think.
 *
 * @param {string} [stage]
 * @param {object} [brain]  neuromodulator state; omit for stage-only behaviour
 * @returns {string}
 */
export function selectModelForStage(stage, brain = null) {
  const strong = config.strongModel;
  const cheap  = config.cheapModel;
  if (!strong && !cheap) return config.model;

  const stageTier = STRONG_STAGES.has(stage) ? 'strong' : 'cheap';
  const tier = brain ? pickTier(brain, stageTier) : stageTier;

  if (tier === 'strong' && strong) return strong;
  if (tier === 'cheap' && cheap) return cheap;
  return config.model;
}

/**
 * Count characters across messages array (cheap token proxy).
 */
export function countMessageChars(messages) {
  return messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
}

/**
 * Estimate token count from a string using the configured chars-per-token ratio.
 * Single source of truth for all estimators in the codebase.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / config.charsPerToken);
}

/**
 * Estimate total token count across a messages array.
 * @param {Array} messages
 * @returns {number}
 */
export function estimateMessagesTokens(messages) {
  return estimateTokens(messages.reduce((s, m) => s + (m.content || ''), ''));
}
