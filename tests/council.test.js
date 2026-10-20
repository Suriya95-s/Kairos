// tests/council.test.js — C-1: the 3-stage council engine (network stubbed, offline).
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { runCouncil, anonymize, buildRankPrompt, buildChairPrompt, DEFAULT_COUNCIL_MODELS } from '../apps/tui/src/council.js';

const MEMBERS = [
  { id: 'a/model:free', label: 'Alpha' },
  { id: 'b/model:free', label: 'Bravo' },
  { id: 'c/model:free', label: 'Charlie' },
];
const noShuffle = (a) => a; // deterministic order for assertions

// A scripted `call` that records invocations and returns by stage.
function scriptedCall(overrides = {}) {
  const calls = [];
  const call = async (model, messages, opts) => {
    calls.push({ model, messages, opts });
    if (overrides[model]) return overrides[model](messages);
    const last = messages[messages.length - 1].content;
    if (/anonymized responses/.test(last)) return `1. Response #1 — best`;
    if (/Chairman/.test(messages[0].content)) return `FINAL: synthesized answer`;
    return `A thoughtful answer.`; // stage-1 answer (no model id in the text)
  };
  call.calls = calls;
  return call;
}

describe('anonymize', () => {
  test('relabels to Response #N and leaks no model ids', () => {
    const { labels, block } = anonymize(
      [{ id: 'secret/model', label: 'Secret', answer: 'hello' }, { id: 'other/model', label: 'Other', answer: 'world' }],
      noShuffle,
    );
    assert.equal(labels[0].tag, 'Response #1');
    assert.equal(labels[1].tag, 'Response #2');
    assert.doesNotMatch(block, /secret\/model|other\/model|Secret|Other/);
    assert.match(block, /hello/);
    assert.match(block, /world/);
  });
});

describe('runCouncil — 3-stage happy path', () => {
  test('answers → rankings → chairman synthesis, with live progress', async () => {
    const call = scriptedCall();
    const progress = [];
    const result = await runCouncil({
      topic: 'Is P=NP?', members: MEMBERS, chairman: 'a/model:free',
      call, shuffle: noShuffle, onProgress: (s) => progress.push(s.status),
    });

    assert.equal(result.status, 'done');
    assert.match(result.final, /synthesized answer/);
    assert.ok(result.members.every(m => m.status === 'done'));
    assert.ok(result.members.every(m => m.answer && m.rankText));
    // 3 answers + 3 rankings + 1 chairman = 7 calls
    assert.equal(call.calls.length, 7);
    // progress passed through every stage
    assert.ok(progress.includes('stage1') && progress.includes('stage2') && progress.includes('stage3') && progress.includes('done'));
  });

  test('the rank prompts never contain raw model ids (anonymity holds end-to-end)', async () => {
    const call = scriptedCall();
    await runCouncil({ topic: 'T', members: MEMBERS, chairman: 'a/model:free', call, shuffle: noShuffle });
    const rankPrompts = call.calls.filter(c => /anonymized responses/.test(c.messages.at(-1).content));
    for (const c of rankPrompts) {
      assert.doesNotMatch(c.messages.at(-1).content, /a\/model:free|b\/model:free|c\/model:free/);
    }
  });
});

describe('runCouncil — graceful degradation', () => {
  test('a failing member is marked failed and excluded from later stages', async () => {
    const call = scriptedCall({
      'b/model:free': () => { throw new Error('429 rate limited'); },
    });
    const result = await runCouncil({ topic: 'T', members: MEMBERS, chairman: 'a/model:free', call, shuffle: noShuffle });
    assert.equal(result.status, 'done');
    const bravo = result.members.find(m => m.id === 'b/model:free');
    assert.equal(bravo.status, 'failed');
    assert.match(bravo.error, /rate limited/);
    // Bravo did NOT participate in stage 2 (no rankText)
    assert.equal(bravo.rankText, '');
    // The other two still answered + ranked
    assert.equal(result.members.filter(m => m.status === 'done').length, 2);
  });

  test('zero successful answers aborts cleanly (no chairman call)', async () => {
    const call = scriptedCall();
    const allFail = async () => { throw new Error('down'); };
    allFail.calls = [];
    const result = await runCouncil({ topic: 'T', members: MEMBERS, chairman: 'a/model:free', call: allFail });
    assert.equal(result.status, 'error');
    assert.match(result.error, /No council member/);
    assert.equal(result.final, '');
  });
});

describe('runCouncil — input guards', () => {
  test('rejects an empty topic', async () => {
    await assert.rejects(() => runCouncil({ topic: '  ', members: MEMBERS, chairman: 'a', call: async () => 'x' }), /topic is required/);
  });
  test('rejects an empty lineup', async () => {
    await assert.rejects(() => runCouncil({ topic: 'T', members: [], chairman: 'a', call: async () => 'x' }), /at least one/);
  });
});

describe('defaults', () => {
  test('DEFAULT_COUNCIL_MODELS are OpenRouter :free ids with labels', () => {
    assert.ok(DEFAULT_COUNCIL_MODELS.length >= 3);
    assert.ok(DEFAULT_COUNCIL_MODELS.every(m => m.id.endsWith(':free') && m.label));
    assert.ok(DEFAULT_COUNCIL_MODELS.some(m => m.on), 'at least one is on by default');
  });
});
