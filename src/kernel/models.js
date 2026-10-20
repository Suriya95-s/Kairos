// src/kernel/models.js
// Named LLM endpoints — the roster the multi-model brain will draw from.
//
// One registry file (`~/.<brand>/models.json`) maps a short name to an
// OpenAI-compatible endpoint: base URL, model id, and (optionally) a
// `vault:scope.key` reference for its API key. The file itself never holds a
// credential — that is the vault's job — so it stays readable and committable.
//
// `active` names the entry that config.js falls back to when AGENT_BASE_URL /
// AGENT_MODEL are not set. Env vars always win: an explicit override must beat
// a stored default, or debugging "why is it talking to the wrong model" becomes
// archaeology.

import { BRAND, file, readRegistry, writeRegistry } from './paths.js';
import { getVault } from './vault.js';
import { recordUsage } from './usage.js';

export function modelsFile() {
  return file('models.json');
}

const EMPTY = () => ({ schemaVersion: 1, active: null, models: {} });

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function loadModels() {
  const data = readRegistry(modelsFile(), null) || EMPTY();
  if (typeof data.models !== 'object' || data.models === null) data.models = {};
  return data;
}

export function saveModels(data) {
  return writeRegistry(modelsFile(), data);
}

/**
 * Register (or replace) a named endpoint.
 * @param {string} name    short slug, e.g. "qwen36" or "gpt-mini"
 * @param {object} spec    { baseURL, model, apiKey?, notes? }
 */
export function addModel(name, { baseURL, model, apiKey = '', notes = '' } = {}) {
  if (!NAME_RE.test(String(name || ''))) {
    throw new Error(`"${name}" is not a valid model name — use letters, digits, dots, dashes (max 64)`);
  }
  let url;
  try {
    url = new URL(String(baseURL || ''));
  } catch {
    throw new Error(`"${baseURL}" is not a URL — expected something like http://localhost:8000/v1`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`"${baseURL}" must be an http(s) endpoint`);
  }
  if (!model || typeof model !== 'string') {
    throw new Error('a model id is required (--model) — the value the endpoint expects in the "model" field');
  }
  // The invariant lives here, not in the CLI: nothing that reaches this file
  // may be a literal credential. The CLI vaults plaintext keys first.
  if (apiKey && !String(apiKey).startsWith('vault:')) {
    throw new Error(`api keys are never stored in models.json — store it first (${BRAND} secret set llm ${name} <key>) and pass "vault:llm.${name}"`);
  }

  const data = loadModels();
  const existing = data.models[name];
  data.models[name] = {
    baseURL: String(baseURL).replace(/\/+$/, ''),
    model,
    apiKey: apiKey || '',
    notes: notes || '',
    addedAt: existing?.addedAt || new Date().toISOString(),
    lastCheck: existing?.lastCheck || null,
  };
  if (!data.active) data.active = name;
  saveModels(data);
  return data.models[name];
}

export function removeModel(name) {
  const data = loadModels();
  if (!data.models[name]) return false;
  delete data.models[name];
  if (data.active === name) data.active = null;
  saveModels(data);
  return true;
}

export function setActive(name) {
  const data = loadModels();
  if (!data.models[name]) {
    throw new Error(`no model named "${name}" — see: ${BRAND} llm list`);
  }
  data.active = name;
  saveModels(data);
  return data.models[name];
}

/**
 * Fetch one entry with its vault reference resolved to the real key.
 * Throws (via the vault) when the reference exists but the secret was never set.
 */
export function resolveModel(name, { vault } = {}) {
  const data = loadModels();
  const entry = data.models[name];
  if (!entry) throw new Error(`no model named "${name}" — see: ${BRAND} llm list`);
  const v = vault || getVault();
  return { name, ...entry, apiKey: entry.apiKey ? v.resolve(entry.apiKey) : '' };
}

/** Persist the outcome of a probe so `llm list` can show staleness at a glance. */
export function recordCheck(name, { ok, latencyMs = null, reply = null, error = null } = {}) {
  const data = loadModels();
  const entry = data.models[name];
  if (!entry) return false;
  entry.lastCheck = { ts: new Date().toISOString(), ok: !!ok, latencyMs, reply, error };
  saveModels(data);
  return true;
}

/** The probe prompt. One word, so any answer at all proves the round trip. */
const PROBE_MESSAGES = Object.freeze([
  { role: 'user', content: 'Reply with exactly one word: ready' },
]);

/**
 * Ask one endpoint for one completion, and report what came back.
 * Internal — `checkModel` calls this once or twice. See the note there.
 */
async function probeCompletion(entry, { fetchFn, headers, base, timeoutMs, maxTokens, noThinking }) {
  // No `temperature`. A one-word health check does not need determinism, and
  // asking for it breaks real models: gpt-5.6-sol rejects temperature 0
  // outright ("only the default (1) value is supported"). Sending nothing at
  // all is the portable choice.
  const body = {
    model: entry.model,
    messages: PROBE_MESSAGES,
    max_tokens: maxTokens,
    stream: false,
    ...(noThinking && { chat_template_kwargs: { enable_thinking: false } }),
  };

  const t0 = Date.now();
  const res = await fetchFn(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { httpError: `completion failed (HTTP ${res.status}): ${text.slice(0, 200)}`, latencyMs };
  }

  const data = await res.json();
  // Even the health probe is real spend — it goes in the ledger like any call.
  recordUsage({ model: entry.model, baseURL: base, purpose: 'llm.check', usage: data.usage || {}, latencyMs });
  const message = data.choices?.[0]?.message ?? {};
  let content = message.content ?? '';
  if (Array.isArray(content)) {
    // Some reasoning models return blocks; keep only the text ones.
    content = content.filter(b => b.type === 'text').map(b => b.text || '').join('');
  }
  // vLLM builds that split reasoning out sometimes put everything in here.
  if (!String(content).trim() && message.reasoning_content) content = message.reasoning_content;

  return {
    latencyMs,
    reply: String(content).trim(),
    reasoningTokens: data.usage?.reasoning_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

/**
 * Probe one endpoint the same way the daemon's health check does, then go one
 * step further: a real completion. Reachability alone lies — a vLLM server with
 * the wrong model id answers GET /models cheerfully and then 404s every
 * completion.
 *
 * ## Why this retries
 *
 * Reasoning models spend their output budget thinking *before* emitting a
 * token of answer, so a probe with a small `max_tokens` gets `content: ""` and
 * `finish_reason: "stop"` — a response that looks like a healthy model with
 * nothing to say. Measured against Qwen3.6-35B on the real gateway: 173
 * reasoning tokens and 2557ms to produce the single word "ready", versus 2
 * tokens and 199ms with thinking disabled.
 *
 * So an empty reply *with* reasoning tokens is not a failure, it is a
 * diagnosis: this model needs `enable_thinking: false` (what `AGENT_NO_THINKING`
 * sends). The retry confirms it and the result says so, because finding this
 * out here is much cheaper than finding it out from a voice loop that has
 * mysteriously blown its latency budget.
 *
 * @param {object} entry  resolved entry ({ baseURL, model, apiKey })
 * @param {object} [opts] { fetchFn, modelsTimeoutMs, completionTimeoutMs, maxTokens }
 * @returns {Promise<object>} { ok, reachable, latencyMs, reply, error, thinking }
 */
export async function checkModel(entry, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const modelsTimeoutMs = opts.modelsTimeoutMs ?? 5_000;
  const completionTimeoutMs = opts.completionTimeoutMs ?? 60_000;
  // Generous on purpose: a reasoning model given 64 tokens returns nothing at
  // all, and "nothing" is indistinguishable from a broken endpoint.
  const maxTokens = opts.maxTokens ?? 512;
  const base = String(entry.baseURL || '').replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    // A pooled keep-alive socket outlives the check, and exiting while it is
    // still closing trips a libuv assertion on Windows
    // (`!(handle->flags & UV_HANDLE_CLOSING)`), which corrupts the exit code
    // of an otherwise successful run. This is a short-lived CLI probe; there
    // is nothing to gain from reusing the connection.
    Connection: 'close',
  };
  if (entry.apiKey) {
    headers.Authorization = `Bearer ${entry.apiKey}`;
    headers['X-API-KEY'] = entry.apiKey;
  }

  const result = {
    ok: false, reachable: false, latencyMs: null, reply: null, error: null,
    thinking: null,
  };

  try {
    const res = await fetchFn(`${base}/models`, {
      headers: entry.apiKey ? { Authorization: headers.Authorization } : {},
      signal: AbortSignal.timeout(modelsTimeoutMs),
    });
    result.reachable = res.ok;
  } catch {
    result.reachable = false;
  }

  // Not every server implements /models, so an unreachable listing is a note,
  // not a verdict — the completion below is the test that counts.
  const probe = { fetchFn, headers, base, timeoutMs: completionTimeoutMs, maxTokens };
  try {
    const first = await probeCompletion(entry, { ...probe, noThinking: false });
    if (first.httpError) {
      result.error = first.httpError;
      return result;
    }

    result.latencyMs = first.latencyMs;
    result.reply = first.reply.slice(0, 80);

    if (first.reasoningTokens > 0) {
      result.thinking = {
        detected: true,
        reasoningTokens: first.reasoningTokens,
        thinkingLatencyMs: first.latencyMs,
        needsDisable: false,
      };
      // Worth measuring even when it did answer: the gap is the latency this
      // model costs on every call unless thinking is turned off.
      const retry = await probeCompletion(entry, { ...probe, noThinking: true }).catch(() => null);
      if (retry && !retry.httpError && retry.reply) {
        result.thinking.withoutThinkingMs = retry.latencyMs;
        if (!first.reply) {
          // The first attempt produced nothing at all — thinking is not merely
          // slow here, it is swallowing the entire answer.
          result.thinking.needsDisable = true;
          result.latencyMs = retry.latencyMs;
          result.reply = retry.reply.slice(0, 80);
        }
      }
    }

    if (!result.reply) {
      result.error = first.reasoningTokens > 0
        ? `answered with ${first.reasoningTokens} reasoning tokens but no content — needs thinking disabled (AGENT_NO_THINKING=1), and the retry did not help either`
        : 'the endpoint answered but the reply was empty';
      return result;
    }
    result.ok = true;
  } catch (err) {
    result.error = err?.name === 'TimeoutError'
      ? `no answer within ${Math.round(completionTimeoutMs / 1000)}s`
      : (err?.message || String(err));
  }
  return result;
}
