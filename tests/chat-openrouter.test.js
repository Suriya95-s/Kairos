// tests/chat-openrouter.test.js — chat resilience against OpenRouter's flaky free
// tier: parse the "use this slug instead" 404 hint (drives an auto-retry) and turn
// 404/429 bodies into actionable guidance instead of raw JSON.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { openRouterSuggestedSlug, friendlyChatError } from '../apps/tui/src/app.js';

describe('openRouterSuggestedSlug', () => {
  test('extracts the replacement slug from a real 404 body', () => {
    const body = '{"error":{"message":"This model is unavailable for free. The paid version is available now - use this slug instead: qwen/qwen-2.5-72b-instruct","code":404}}';
    assert.equal(openRouterSuggestedSlug(body), 'qwen/qwen-2.5-72b-instruct');
  });
  test('handles a trailing period and :free suffix', () => {
    assert.equal(openRouterSuggestedSlug('use this slug instead: deepseek/deepseek-chat:free.'), 'deepseek/deepseek-chat:free');
  });
  test('returns empty when there is no hint', () => {
    assert.equal(openRouterSuggestedSlug('{"error":{"message":"No endpoints found","code":404}}'), '');
    assert.equal(openRouterSuggestedSlug(''), '');
  });
});

describe('friendlyChatError', () => {
  const err = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
  test('404 on a :free model points at M → Tab for the live list', () => {
    const msg = friendlyChatError(err(404), 'google/gemini-2.0-flash-exp:free', 'http://x/v1');
    assert.match(msg, /unavailable/);
    assert.match(msg, /free tier/);
    assert.match(msg, /\[Tab\]/);
  });
  test('429 explains rate-limiting and the remedies', () => {
    const msg = friendlyChatError(err(429), 'qwen/qwen-2.5-72b-instruct:free', 'http://x/v1');
    assert.match(msg, /rate-limited/);
    assert.match(msg, /key|different model/);
  });
  test('non-HTTP errors fall back to the network diagnostic', () => {
    const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const msg = friendlyChatError(e, 'gpt-4o', 'http://localhost:8000/v1');
    assert.match(msg, /connection refused/);
  });
});
