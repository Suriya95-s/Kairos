// tests/usage.test.js
// The spend meter (kernel/usage.js) and its choke-point wiring.
//
// The claim under test: every model call in the system lands in the monthly
// ledger with the token counts the API ITSELF returned, priced at the rates
// in force at that moment — and metering can never fail a completion.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Home must be a throwaway per run — the meter writes real files.
let HOME;
function freshHome(tag) {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), `kairos-usage-${tag}-`));
  process.env.KAIROS_HOME = HOME;
  return HOME;
}
freshHome('boot');

const usage = await import('../src/kernel/usage.js');
const { chatCompletion } = await import('../src/llm.js');
const models = await import('../src/kernel/models.js');
const { writeRegistry, file } = await import('../src/kernel/paths.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function completionResponse(usageObj, content = 'hi') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: usageObj,
    }),
    text: async () => '',
  };
}

const OPTS = { baseURL: 'http://fake-endpoint.test/v1', apiKey: 'k' };

describe('pricing resolution', () => {
  beforeEach(() => freshHome('price'));

  test('a registry price set on a models.json entry beats the builtin table', () => {
    writeRegistry(file('models.json'), {
      schemaVersion: 1, active: 'myapi',
      models: { myapi: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', price: { in: 1, out: 2 } } },
    });
    const p = usage.priceFor('gpt-4o-mini');
    assert.deepEqual({ in: p.in, out: p.out, source: p.source }, { in: 1, out: 2, source: 'registry' });
  });

  test('builtin matching is longest-substring — a dated mini id must not bill at gpt-4o rates', () => {
    // 'gpt-4o-mini-2024-07-18' contains BOTH 'gpt-4o-mini' and 'gpt-4o'.
    // Shortest-first matching over-billed mini ~16× once already.
    const p = usage.priceFor('gpt-4o-mini-2024-07-18');
    assert.equal(p.in, 0.15);
    assert.equal(p.out, 0.60);
    assert.equal(p.source, 'builtin');
  });

  test('an unknown model is UNPRICED (null), never silently $0-priced', () => {
    assert.equal(usage.priceFor('totally-novel-model-x1'), null);
  });
});

describe('recordUsage — the ledger line', () => {
  beforeEach(() => freshHome('record'));

  test('writes one JSONL line with the cost computed from the rates in force', () => {
    const r = usage.recordUsage({
      model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', purpose: 'ontology.verify',
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      at: '2026-08-19T10:00:00.000Z',
    });
    // 1M in at $0.15 + 1M out at $0.60 = exactly $0.75.
    assert.equal(r.cost, 0.75);
    assert.equal(r.priced, true);
    const lines = fs.readFileSync(usage.usageFile('2026-08'), 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.promptTokens, 1_000_000);
    assert.equal(parsed.completionTokens, 1_000_000);
    assert.equal(parsed.purpose, 'ontology.verify');
    // The rates ride on the record: a later price change must not rewrite history.
    assert.equal(parsed.priceIn, 0.15);
    assert.equal(parsed.priceOut, 0.60);
  });

  test('an unknown model still records REAL token counts, flagged unpriced at $0', () => {
    const r = usage.recordUsage({
      model: 'mystery-9000', purpose: 'other',
      usage: { prompt_tokens: 500, completion_tokens: 50 }, at: '2026-08-19T10:00:00.000Z',
    });
    assert.equal(r.priced, false);
    assert.equal(r.cost, 0);
    assert.equal(r.totalTokens, 550);
  });

  test('records split into monthly files by their own timestamp', () => {
    usage.recordUsage({ model: 'gpt-4o-mini', usage: { prompt_tokens: 1, completion_tokens: 1 }, at: '2026-07-31T23:59:59.000Z' });
    usage.recordUsage({ model: 'gpt-4o-mini', usage: { prompt_tokens: 2, completion_tokens: 2 }, at: '2026-08-01T00:00:01.000Z' });
    assert.equal(usage.readMonth('2026-07').length, 1);
    assert.equal(usage.readMonth('2026-08').length, 1);
    assert.deepEqual(usage.listMonths(), ['2026-07', '2026-08']);
  });

  test('a home where the usage dir cannot be created loses the line, NOT the call', () => {
    // Make `usage` a FILE so mkdir fails — the worst realistic ledger failure.
    fs.writeFileSync(path.join(HOME, 'usage'), 'not a directory', 'utf-8');
    const r = usage.recordUsage({ model: 'gpt-4o-mini', usage: { prompt_tokens: 1, completion_tokens: 1 } });
    assert.equal(r, null); // swallowed, reported as unwritten — never thrown
  });
});

describe('summarizeUsage — aggregation', () => {
  beforeEach(() => freshHome('sum'));

  test('totals, by-model, by-purpose and by-day all fold every record', () => {
    usage.recordUsage({ model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', purpose: 'ontology.verify', usage: { prompt_tokens: 100, completion_tokens: 10 }, at: '2026-08-18T09:00:00.000Z' });
    usage.recordUsage({ model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1', purpose: 'ontology.ask', usage: { prompt_tokens: 200, completion_tokens: 20 }, at: '2026-08-19T09:00:00.000Z' });
    usage.recordUsage({ model: 'mystery-9000', purpose: 'mission', usage: { prompt_tokens: 50, completion_tokens: 5 }, at: '2026-08-19T10:00:00.000Z' });
    const s = usage.summarizeUsage({ month: '2026-08' });
    assert.equal(s.records, 3);
    assert.equal(s.totals.promptTokens, 350);
    assert.equal(s.totals.completionTokens, 35);
    assert.equal(s.totals.unpricedTokens, 55); // only the mystery model's tokens
    assert.equal(Object.keys(s.byPurpose).length, 3);
    assert.equal(s.byDay['2026-08-19'].calls, 2);
    assert.equal(s.byModel['gpt-4o-mini @ https://api.openai.com/v1'].promptTokens, 300);
  });

  test('one corrupt ledger line is skipped, not fatal, and hides nothing else', () => {
    usage.recordUsage({ model: 'gpt-4o-mini', usage: { prompt_tokens: 10, completion_tokens: 1 }, at: '2026-08-19T09:00:00.000Z' });
    fs.appendFileSync(usage.usageFile('2026-08'), '{corrupt not json\n', 'utf-8');
    usage.recordUsage({ model: 'gpt-4o-mini', usage: { prompt_tokens: 20, completion_tokens: 2 }, at: '2026-08-19T09:01:00.000Z' });
    const s = usage.summarizeUsage({ month: '2026-08' });
    assert.equal(s.records, 2);
    assert.equal(s.totals.promptTokens, 30);
  });

  test('--all spans months; a single month stays scoped to itself', () => {
    usage.recordUsage({ model: 'gpt-4o-mini', usage: { prompt_tokens: 1, completion_tokens: 0 }, at: '2026-07-01T00:00:00.000Z' });
    usage.recordUsage({ model: 'gpt-4o-mini', usage: { prompt_tokens: 2, completion_tokens: 0 }, at: '2026-08-01T00:00:00.000Z' });
    assert.equal(usage.summarizeUsage({ month: '2026-08' }).totals.promptTokens, 2);
    assert.equal(usage.summarizeUsage({ all: true }).totals.promptTokens, 3);
  });
});

describe('choke-point wiring — chatCompletion meters itself', () => {
  beforeEach(() => freshHome('wire'));

  test('a completion records the API\'s exact usage object, purpose-tagged', async () => {
    globalThis.fetch = async () => completionResponse({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    const res = await chatCompletion([{ role: 'user', content: 'q' }], { ...OPTS, model: 'gpt-4o-mini', purpose: 'ontology.verify' });
    assert.equal(res.content, 'hi');
    const month = new Date().toISOString().slice(0, 7);
    const recs = usage.readMonth(month);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].promptTokens, 100);       // the API's number, not an estimate
    assert.equal(recs[0].completionTokens, 20);
    assert.equal(recs[0].purpose, 'ontology.verify');
    assert.equal(recs[0].model, 'gpt-4o-mini');
    // 100/1M×0.15 + 20/1M×0.60
    assert.equal(recs[0].cost, 0.000027);
  });

  test('KAIROS_USAGE_PURPOSE attributes untagged calls (how mission children bill as "mission")', async () => {
    globalThis.fetch = async () => completionResponse({ prompt_tokens: 5, completion_tokens: 1 });
    process.env.KAIROS_USAGE_PURPOSE = 'mission';
    try {
      await chatCompletion([{ role: 'user', content: 'q' }], { ...OPTS, model: 'gpt-4o-mini' });
    } finally {
      delete process.env.KAIROS_USAGE_PURPOSE;
    }
    const recs = usage.readMonth(new Date().toISOString().slice(0, 7));
    assert.equal(recs[0].purpose, 'mission');
  });

  test('an unwritable ledger never fails the completion itself', async () => {
    fs.writeFileSync(path.join(HOME, 'usage'), 'not a directory', 'utf-8');
    globalThis.fetch = async () => completionResponse({ prompt_tokens: 5, completion_tokens: 1 });
    const res = await chatCompletion([{ role: 'user', content: 'q' }], { ...OPTS, model: 'gpt-4o-mini' });
    assert.equal(res.content, 'hi'); // the answer survives; only the ledger line is lost
  });

  test('the llm-check probe is metered too — even health checks are real spend', async () => {
    const fetchFn = async (url) => {
      if (String(url).endsWith('/models')) return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      return completionResponse({ prompt_tokens: 10, completion_tokens: 2 }, 'ready');
    };
    const r = await models.checkModel({ baseURL: 'http://fake.test/v1', model: 'gpt-4o-mini', apiKey: '' }, { fetchFn });
    assert.equal(r.ok, true);
    const recs = usage.readMonth(new Date().toISOString().slice(0, 7));
    assert.equal(recs.length, 1);
    assert.equal(recs[0].purpose, 'llm.check');
    assert.equal(recs[0].totalTokens, 12);
  });
});
