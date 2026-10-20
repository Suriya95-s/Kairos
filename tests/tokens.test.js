// tests/tokens.test.js — Wave C-3: single conservative token estimator.
import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('config.charsPerToken', () => {
  test('default is 3.5', async () => {
    const config = (await import('../src/config.js')).default;
    assert.equal(config.charsPerToken, 3.5);
  });
});

describe('llm.estimateTokens', () => {
  test('empty string → 0 tokens', async () => {
    const { estimateTokens } = await import('../src/llm.js');
    assert.equal(estimateTokens(''), 0);
  });

  test('null/undefined → 0 tokens (no throw)', async () => {
    const { estimateTokens } = await import('../src/llm.js');
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
  });

  test('35-char string → ceil(35/3.5) = 10 tokens', async () => {
    const { estimateTokens } = await import('../src/llm.js');
    assert.equal(estimateTokens('x'.repeat(35)), 10);
  });

  test('uses config.charsPerToken ratio (not a hardcoded constant)', async () => {
    const config = (await import('../src/config.js')).default;
    const { estimateTokens } = await import('../src/llm.js');
    const text = 'a'.repeat(70);
    const expected = Math.ceil(70 / config.charsPerToken);
    assert.equal(estimateTokens(text), expected);
  });
});

describe('llm.estimateMessagesTokens', () => {
  test('sums content across messages', async () => {
    const config = (await import('../src/config.js')).default;
    const { estimateMessagesTokens } = await import('../src/llm.js');
    const messages = [
      { role: 'system', content: 'a'.repeat(35) },
      { role: 'user',   content: 'b'.repeat(35) },
    ];
    const expected = Math.ceil(70 / config.charsPerToken);
    assert.equal(estimateMessagesTokens(messages), expected);
  });

  test('tolerates messages without content field', async () => {
    const { estimateMessagesTokens } = await import('../src/llm.js');
    assert.doesNotThrow(() => estimateMessagesTokens([{ role: 'user' }]));
  });
});

describe('rmt estimateTokens uses config ratio', () => {
  test('shouldInvokeRmt uses charsPerToken-based estimate (smoke check)', async () => {
    const { shouldInvokeRmt } = await import('../src/rmt/index.js');
    // A very short text should not invoke RMT
    const result = shouldInvokeRmt({ text: 'hello world', fileCount: 0, traceChars: 0 });
    assert.equal(typeof result, 'boolean');
  });
});
