// tests/llm-retry.test.js
// Retry classification in the LLM client.
//
// Nothing guarded this before, and it showed: a gateway's per-key limit
// answered 413 and the client retried the identical prompt three times —
// the same bytes are exactly as long on every retry. A permanent client
// error must fail once, loudly, with the actionable hint.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The client meters every successful completion into ~/.kairos/usage — tests
// must spend into a throwaway home, not the owner's real ledger.
process.env.KAIROS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-llmretry-'));

import { chatCompletion } from '../src/llm.js';

const realFetch = globalThis.fetch;
let calls;

function respond(status, body = {}) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

const MESSAGES = [{ role: 'user', content: 'hello' }];
const OPTS = { baseURL: 'http://fake-endpoint.test/v1', apiKey: 'k', model: 'm' };

describe('LLM retry classification', () => {
  test('413 (request too large) fails immediately — the prompt will not shrink on retry', async () => {
    respond(413, { detail: 'Input too long: ~7810 tokens exceeds your limit of 4096' });
    await assert.rejects(
      chatCompletion(MESSAGES, OPTS),
      /request too large.*token limit/,
      'the error must carry the actionable hint',
    );
    assert.equal(calls.length, 1, `a permanent 413 must not be retried, saw ${calls.length} calls`);
  });

  test('429 with a quota-exhausted body fails immediately — backoff cannot refill a spent key', async () => {
    // The exact body a live gateway sent while a mission walked the full
    // 8-attempt / 4-minute ladder against it, step after step.
    respond(429, { detail: 'Weekly token quota exceeded (1,061,968/1,000,000)' });
    await assert.rejects(
      chatCompletion(MESSAGES, OPTS),
      /quota exhausted.*retrying cannot help/,
      'the error must say retrying is pointless and what to do instead',
    );
    assert.equal(calls.length, 1, `a quota-exhausted 429 must not be retried, saw ${calls.length} calls`);
  });

  test('a plain 429 (no quota language) IS still retried', async () => {
    // Negative control for the quota regex: an ordinary saturation 429 must
    // keep its long-backoff retry behaviour. One 429, then success.
    let first = true;
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (first) {
        first = false;
        return { ok: false, status: 429, json: async () => ({}), text: async () => '{"detail":"Too many requests, slow down"}' };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
        text: async () => '',
      };
    };
    const res = await chatCompletion(MESSAGES, OPTS);
    assert.equal(res.content, 'ok');
    assert.equal(calls.length, 2, `a saturation 429 must be retried once and succeed, saw ${calls.length} call(s)`);
  });

  test('401 fails immediately with the key hint', async () => {
    respond(401, {});
    await assert.rejects(chatCompletion(MESSAGES, OPTS), /unauthorized/);
    assert.equal(calls.length, 1);
  });

  test('500 is transient and IS retried', async () => {
    respond(500, {});
    await assert.rejects(chatCompletion(MESSAGES, OPTS));
    assert.ok(calls.length > 1, `a 5xx must be retried, saw ${calls.length} call(s)`);
  });

  test('a success needs exactly one call', async () => {
    respond(200, { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: {} });
    const res = await chatCompletion(MESSAGES, OPTS);
    assert.equal(res.content, 'hi');
    assert.equal(calls.length, 1);
  });
});

describe('AGENT_NO_THINKING is scoped to the models that understand it', () => {
  // chat_template_kwargs is a vLLM extension. OpenAI cloud models reject ANY
  // unknown parameter with a 400 — so the env flag (auto-set for Qwen default
  // profiles) must never leak into a call that targets a different model.
  // Found live: the first `ontology verify --model gpt-5.4-mini` fell to the
  // deterministic floor on exactly that 400.
  afterEach(() => { delete process.env.AGENT_NO_THINKING; });

  const ok = { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: {} };

  function sentBody() {
    return JSON.parse(calls[0].opts.body);
  }

  test('a gpt-* call under AGENT_NO_THINKING=1 sends NO chat_template_kwargs', async () => {
    process.env.AGENT_NO_THINKING = '1';
    respond(200, ok);
    await chatCompletion(MESSAGES, { ...OPTS, model: 'gpt-5.4-mini' });
    assert.equal('chat_template_kwargs' in sentBody(), false,
      'the vLLM-only knob must not reach an OpenAI model — it 400s on unknown parameters');
  });

  test('a Qwen call under AGENT_NO_THINKING=1 still disables thinking', async () => {
    // Negative control for the model gate: the knob must keep working where it
    // is needed, or thinking tokens eat the output budget again.
    process.env.AGENT_NO_THINKING = '1';
    respond(200, ok);
    await chatCompletion(MESSAGES, { ...OPTS, model: 'Qwen/Qwen3.6-35B-A3B-FP8' });
    assert.deepEqual(sentBody().chat_template_kwargs, { enable_thinking: false });
  });

  test('without the env flag no model gets the knob', async () => {
    respond(200, ok);
    await chatCompletion(MESSAGES, { ...OPTS, model: 'Qwen/Qwen3.6-35B-A3B-FP8' });
    assert.equal('chat_template_kwargs' in sentBody(), false);
  });
});
