// src/kernel/usage.js
// The spend meter — token and dollar accounting for every model call.
//
// One JSONL ledger per calendar month (`~/.<brand>/usage/usage-YYYY-MM.jsonl`),
// one line per completion, written at the single choke point every call takes
// (src/llm.js _chatCompletionLive, plus the `llm check` probe). The token
// counts are the ones the API RETURNED — `data.usage` from the response body —
// never estimates, so the ledger is as true as the provider's own billing.
//
// Dollars are computed at write time and stored on the record, so a later
// price change never rewrites history: each line carries the rates it was
// billed at. Price resolution order:
//   1. a `price: { in, out }` set on a models.json entry whose `model` id
//      matches (set via: <brand> llm price <name> --in USD --out USD)
//   2. the builtin table below (USD per 1M tokens; known public models,
//      local/gateway models at 0)
//   3. no match → the record is written UNPRICED (cost 0, priced:false) and
//      the CLI surfaces the gap instead of hiding it — a silent $0 for an
//      unknown paid model would be a lie in the ledger.
//
// Recording must never break a completion: every write path here swallows its
// own failures and returns null. A full disk costs you a ledger line, not an
// answer.

import fs from 'node:fs';
import path from 'node:path';
import { file, readRegistry } from './paths.js';

// ── Pricing (USD per 1M tokens) ─────────────────────────────────────────────
// Matched by longest substring of the model id, so 'gpt-4o-mini' can never be
// caught by 'gpt-4o' (that substring bug over-billed mini ~16× once already —
// see observability/costTracker.js). Prices drift; the registry override
// (`llm price`) always wins over this table.
export const BUILTIN_PRICES = Object.freeze({
  // OpenAI
  'gpt-4o-mini':   { in: 0.15, out: 0.60 },
  'gpt-4o':        { in: 2.50, out: 10.00 },
  'gpt-4.1-mini':  { in: 0.40, out: 1.60 },
  'gpt-4.1-nano':  { in: 0.10, out: 0.40 },
  'gpt-4.1':       { in: 2.00, out: 8.00 },
  'o4-mini':       { in: 1.10, out: 4.40 },
  'o3-mini':       { in: 1.10, out: 4.40 },
  'o3':            { in: 2.00, out: 8.00 },
  // Anthropic
  'claude-opus':   { in: 15.00, out: 75.00 },
  'claude-sonnet': { in: 3.00, out: 15.00 },
  'claude-haiku':  { in: 0.80, out: 4.00 },
  // Local / self-hosted gateways — known-free, priced at zero on purpose so
  // they show as $0 rather than "unpriced".
  'qwen':          { in: 0, out: 0 },
  'gpt-oss':       { in: 0, out: 0 },
  'nemotron':      { in: 0, out: 0 },
  'minimax':       { in: 0, out: 0 },
  'llama':         { in: 0, out: 0 },
  'mistral':       { in: 0, out: 0 },
  'gpt-5.6-sol':   { in: 0, out: 0 },
});

export function usageDir() {
  return file('usage');
}

export function usageFile(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) throw new Error(`"${month}" is not a month — expected YYYY-MM`);
  return path.join(usageDir(), `usage-${month}.jsonl`);
}

export function monthOf(ts) {
  return String(ts).slice(0, 7);
}

/**
 * Resolve the price for a model id.
 * @returns {{ in:number, out:number, source:'registry'|'builtin' } | null} null = unpriced
 */
export function priceFor(modelId) {
  const id = String(modelId || '');
  // Registry first: an explicit human-set price beats any builtin guess.
  const reg = readRegistry(file('models.json'), null);
  if (reg && typeof reg.models === 'object' && reg.models !== null) {
    for (const entry of Object.values(reg.models)) {
      if (!entry || entry.model !== id) continue;
      const p = entry.price;
      if (p && Number.isFinite(p.in) && Number.isFinite(p.out)) {
        return { in: p.in, out: p.out, source: 'registry' };
      }
    }
  }
  const lower = id.toLowerCase();
  const keys = Object.keys(BUILTIN_PRICES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key)) return { ...BUILTIN_PRICES[key], source: 'builtin' };
  }
  return null;
}

/**
 * Append one completion to the ledger. Never throws — metering a call must
 * never fail the call.
 * @param {object} o
 * @param {string} o.model      model id sent in the request body
 * @param {string} [o.baseURL]  endpoint the call went to
 * @param {string} [o.purpose]  what spent it ('mission', 'ontology.verify', …)
 * @param {object} [o.usage]    the API's own usage object (prompt/completion_tokens)
 * @param {number} [o.latencyMs]
 * @param {string} [o.at]       ISO timestamp override (tests / backfill)
 * @returns {object|null} the record written, or null when writing failed
 */
export function recordUsage({ model, baseURL = '', purpose = 'other', usage = {}, latencyMs = null, at = null } = {}) {
  try {
    const ts = at || new Date().toISOString();
    const promptTokens = Number(usage?.prompt_tokens) || 0;
    const completionTokens = Number(usage?.completion_tokens) || 0;
    const price = priceFor(model);
    const cost = price
      ? (promptTokens / 1_000_000) * price.in + (completionTokens / 1_000_000) * price.out
      : 0;
    const record = {
      ts,
      model: String(model || 'unknown'),
      baseURL: String(baseURL || ''),
      purpose: String(purpose || 'other'),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      ...(latencyMs != null ? { latencyMs } : {}),
      priced: !!price,
      ...(price ? { priceIn: price.in, priceOut: price.out, priceSource: price.source } : {}),
      cost: Math.round(cost * 1e8) / 1e8,
    };
    const dest = usageFile(monthOf(ts));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.appendFileSync(dest, JSON.stringify(record) + '\n', 'utf-8');
    return record;
  } catch {
    return null;
  }
}

/** Months that have a ledger file, oldest first. */
export function listMonths() {
  let names;
  try {
    names = fs.readdirSync(usageDir());
  } catch {
    return [];
  }
  return names
    .map((n) => n.match(/^usage-(\d{4}-\d{2})\.jsonl$/)?.[1])
    .filter(Boolean)
    .sort();
}

/** All parseable records for one month. Corrupt lines are skipped, not fatal. */
export function readMonth(month) {
  let raw;
  try {
    raw = fs.readFileSync(usageFile(month), 'utf-8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object') records.push(r);
    } catch { /* one bad line must not hide a month of spend */ }
  }
  return records;
}

function bucket() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, unpricedTokens: 0 };
}

function fold(b, r) {
  b.calls++;
  b.promptTokens += r.promptTokens || 0;
  b.completionTokens += r.completionTokens || 0;
  b.totalTokens += r.totalTokens || 0;
  b.cost += r.cost || 0;
  if (!r.priced) b.unpricedTokens += r.totalTokens || 0;
}

/**
 * Aggregate the ledger.
 * @param {object} [opts] { month: 'YYYY-MM' (default: current), all: true }
 * @returns {{ months, records, totals, byModel, byPurpose, byDay }}
 */
export function summarizeUsage({ month = null, all = false } = {}) {
  const months = all ? listMonths() : [month || monthOf(new Date().toISOString())];
  const totals = bucket();
  const byModel = {};
  const byPurpose = {};
  const byDay = {};
  let count = 0;
  for (const m of months) {
    for (const r of readMonth(m)) {
      count++;
      fold(totals, r);
      const modelKey = `${r.model}${r.baseURL ? ` @ ${r.baseURL}` : ''}`;
      fold(byModel[modelKey] ??= bucket(), r);
      fold(byPurpose[r.purpose || 'other'] ??= bucket(), r);
      fold(byDay[String(r.ts || '').slice(0, 10)] ??= bucket(), r);
    }
  }
  totals.cost = Math.round(totals.cost * 1e8) / 1e8;
  return { months, records: count, totals, byModel, byPurpose, byDay };
}
