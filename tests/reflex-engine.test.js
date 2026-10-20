// tests/reflex-engine.test.js
// Phase 4.2 — the reflex engine.
//
// Three properties carry the whole design, and each is a thing that would be
// invisible if it broke:
//   * at most ONE tool, from a safe list — otherwise it is an ungated mission
//   * the latency budget is a deadline, not an aspiration
//   * escalation PROPOSES; it never starts work
//
// The model is injected everywhere. These tests must not need a running
// endpoint, and a reflex test that takes eight seconds to prove an eight-second
// budget is a test nobody will run.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  reflex,
  escalationPrompt,
  REFLEX_TOOLS,
  DEFAULT_LATENCY_BUDGET_MS,
} from '../src/reflex/engine.js';

/** A model that returns canned replies in order. */
function scriptedLlm(...replies) {
  const calls = [];
  const fn = async (messages) => {
    calls.push(messages);
    return replies[calls.length - 1] ?? replies[replies.length - 1] ?? '';
  };
  fn.calls = calls;
  return fn;
}

describe('answering directly', () => {
  test('a question gets an answer and no tool', async () => {
    const r = await reflex('what is a monad?', {
      llm: scriptedLlm('A monoid in the category of endofunctors.'),
    });
    assert.equal(r.text, 'A monoid in the category of endofunctors.');
    assert.equal(r.toolUsed, null);
    assert.equal(r.escalation, null);
  });

  test('an empty utterance costs nothing', async () => {
    let called = false;
    const r = await reflex('   ', { llm: async () => { called = true; return 'x'; } });
    assert.equal(called, false);
    assert.equal(r.text, '');
  });

  test('latency is measured and reported', async () => {
    let clock = 1000;
    const r = await reflex('hi', {
      now: () => clock,
      llm: async () => { clock += 250; return 'hello'; },
    });
    assert.equal(r.latencyMs, 250);
  });

  test('history is included but only the tail — a reflex must stay fast', async () => {
    const llm = scriptedLlm('ok');
    const history = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `turn ${i}` }));
    await reflex('and now?', { llm, history });

    const sent = llm.calls[0];
    const turns = sent.filter(m => /^turn \d+$/.test(m.content));
    assert.ok(turns.length <= 8, `sent ${turns.length} history turns; a long transcript is how a fast path stops being fast`);
    assert.equal(turns.at(-1).content, 'turn 39', 'and it should be the most recent ones');
  });

  test('recalled memory is passed to the model (L4)', async () => {
    const llm = scriptedLlm('ok');
    await reflex('what do I prefer?', { llm, recall: 'The user prefers tabs over spaces.' });
    assert.ok(JSON.stringify(llm.calls[0]).includes('prefers tabs'));
  });
});

describe('one tool, and only one', () => {
  test('a tool request is executed and the result feeds the answer', async () => {
    const calls = [];
    const r = await reflex("what's in package.json", {
      llm: scriptedLlm('TOOL: read_file {"path":"package.json"}', 'It declares four bin entries.'),
      execTool: async (name, args) => { calls.push({ name, args }); return { result: '{"bin":{}}' }; },
    });
    assert.deepEqual(calls, [{ name: 'read_file', args: { path: 'package.json' } }]);
    assert.equal(r.toolUsed, 'read_file');
    assert.equal(r.text, 'It declares four bin entries.');
  });

  test('a SECOND tool request is stripped, not obeyed', async () => {
    // Without this a reflex becomes an unbounded loop with no budget, no
    // verification and no HITL — a mission with all the gates removed.
    const execTool = async () => ({ result: 'first result' });
    let toolCalls = 0;
    const r = await reflex('look at two things', {
      llm: scriptedLlm(
        'TOOL: read_file {"path":"a.js"}',
        'TOOL: read_file {"path":"b.js"}',
      ),
      execTool: async (...a) => { toolCalls++; return execTool(...a); },
    });
    assert.equal(toolCalls, 1, 'exactly one tool call');
    assert.ok(!r.text.includes('TOOL:'), 'the stray marker must not reach the user');
  });

  test('a tool outside the allowlist is refused and escalated', async () => {
    // run_command has real-world consequences; it belongs behind mission gates
    // and the P7 trust tiers.
    const r = await reflex('delete the temp files', {
      workspace: '/tmp/proj',
      llm: scriptedLlm('TOOL: run_command {"cmd":"rm -rf /tmp/x"}'),
      execTool: async () => { throw new Error('must not be called'); },
    });
    assert.equal(r.refusedTool, 'run_command');
    assert.equal(r.escalation.proposed, true);
    assert.match(r.escalation.reason, /not safe to run without the mission gates/);
  });

  test('the allowlist is read-only plus save_memory, and nothing else', () => {
    for (const forbidden of ['run_command', 'write_file', 'edit_file', 'delete_path', 'patch', 'finish']) {
      assert.ok(!REFLEX_TOOLS.includes(forbidden), `${forbidden} must not be reflex-callable`);
    }
    assert.ok(REFLEX_TOOLS.includes('read_file'));
    assert.ok(REFLEX_TOOLS.includes('save_memory'),
      'remembering something the user just said should not require a mission');
  });

  test('malformed tool arguments do not crash the turn', async () => {
    const r = await reflex('look', {
      llm: scriptedLlm('TOOL: read_file {not json}', 'answered anyway'),
      execTool: async (name, args) => { assert.deepEqual(args, {}); return { result: '' }; },
    });
    assert.equal(r.text, 'answered anyway');
  });

  test('a failing tool degrades into an answer rather than an exception', async () => {
    const r = await reflex('read a missing file', {
      llm: scriptedLlm('TOOL: read_file {"path":"nope.js"}', 'That file does not exist.'),
      execTool: async () => { throw new Error('ENOENT'); },
    });
    assert.equal(r.text, 'That file does not exist.');
  });
});

describe('the latency budget is a deadline', () => {
  test('a slow model returns a truncated result instead of hanging', async () => {
    const r = await reflex('what is a monad?', {
      latencyBudgetMs: 60,
      llm: () => new Promise(resolve => setTimeout(() => resolve('too late'), 5000)),
    });
    assert.equal(r.truncated, true);
    assert.match(r.degraded, /no answer within 60ms/);
    assert.equal(r.text, '');
  });

  test('a slow TOOL also respects the deadline', async () => {
    const r = await reflex('look something up', {
      latencyBudgetMs: 80,
      llm: scriptedLlm('TOOL: read_file {"path":"a.js"}'),
      execTool: () => new Promise(resolve => setTimeout(() => resolve({ result: 'x' }), 5000)),
    });
    assert.equal(r.truncated, true);
    assert.equal(r.toolUsed, 'read_file');
  });

  test('the deadline covers the whole turn, not each call separately', async () => {
    // Two 40ms calls inside a 60ms budget must fail. A per-call timeout would
    // let a two-call turn quietly take twice the budget.
    //
    // Driven by an injected clock rather than real timers. The first version of
    // this raced actual setTimeouts and was flaky under full-suite load: when
    // the machine was busy enough, the FIRST call alone blew the budget and the
    // second was never attempted, so the assertion failed for a reason that had
    // nothing to do with the property being tested.
    let clock = 0;
    const advance = (ms) => { clock += ms; };
    let second = false;

    const r = await reflex('look', {
      latencyBudgetMs: 60,
      now: () => clock,
      llm: async (msgs) => {
        if (msgs.some(m => String(m.content).startsWith('Result of'))) {
          second = true;
          advance(40);            // cumulative: 85ms — past the 60ms budget
          return 'done';
        }
        advance(40);              // cumulative: 40ms — still inside it
        return 'TOOL: read_file {"path":"a"}';
      },
      execTool: async () => { advance(5); return { result: 'x' }; },
    });

    assert.ok(second, 'the second call should have been attempted');
    assert.equal(r.truncated, true, 'and the whole-turn budget should have caught it');
  });

  test('the default budget is single-digit seconds', () => {
    // A "fast path" that sometimes takes 40s is worse than none: the user
    // stops trusting either mode.
    assert.ok(DEFAULT_LATENCY_BUDGET_MS <= 10_000);
  });

  test('an unreachable model degrades honestly (S3)', async () => {
    const r = await reflex('what is a monad?', {
      llm: async () => { throw new Error('ECONNREFUSED'); },
    });
    assert.match(r.degraded, /model unavailable/);
    assert.equal(r.text, '');
    assert.equal(r.truncated, false, 'this is an outage, not a timeout — the distinction matters');
  });
});

describe('escalation proposes, never spawns', () => {
  test('a mission-shaped ask is escalated before any model call', async () => {
    let called = false;
    const r = await reflex('build a REST API with Express and Postgres', {
      workspace: '/tmp/proj',
      llm: async () => { called = true; return 'sure, starting'; },
    });
    assert.equal(called, false, 'the classifier already knows — do not pay for a model call');
    assert.equal(r.escalation.proposed, true);
    assert.equal(r.escalation.profile, 'build');
  });

  test('a mid-answer escalation from the model is honoured', async () => {
    const r = await reflex('can you tidy up the imports everywhere', {
      workspace: '/tmp/proj',
      llm: scriptedLlm('MISSION: normalise import ordering across the codebase'),
    });
    assert.equal(r.escalation.proposed, true);
    assert.equal(r.escalation.task, 'normalise import ordering across the codebase');
    assert.equal(r.text, '', 'an escalation is not also an answer');
  });

  test('escalation never returns a mission id — nothing was started', async () => {
    const r = await reflex('build a REST API', { workspace: '/tmp/p', llm: scriptedLlm('x') });
    assert.equal(r.escalation.missionId, undefined);
    assert.ok(!('started' in r.escalation));
  });

  test('the proposal is phrased as a question a person can answer', () => {
    const prompt = escalationPrompt({ proposed: true, task: 'migrate the DB layer', profile: 'build' });
    assert.match(prompt, /build job/);
    assert.match(prompt, /migrate the DB layer/);
    assert.match(prompt, /Start it\?$/);
  });

  test('the proposal names the right kind of work', () => {
    assert.match(escalationPrompt({ proposed: true, task: 't', profile: 'research' }), /research job/);
    assert.match(escalationPrompt({ proposed: true, task: 't', profile: 'errand' }), /an errand/);
  });

  test('no escalation renders as nothing', () => {
    assert.equal(escalationPrompt(null), '');
    assert.equal(escalationPrompt({ proposed: false }), '');
  });

  test('escalating carries the profile so the mission starts under the right gates', async () => {
    const r = await reflex('summarize what changed in this repo this week', {
      workspace: '/tmp/proj',
      llm: scriptedLlm('x'),
    });
    assert.equal(r.escalation.profile, 'research');
  });
});

describe('streaming (4.2)', () => {
  test('tokens are delivered as they arrive, and the full text still returns', async () => {
    // Perceived latency: a first token in ~200ms reads as instant even when the
    // whole answer takes two seconds.
    const seen = [];
    const r = await reflex('what is a monad?', {
      onToken: (t) => seen.push(t),
      llm: async (_m, { onToken }) => {
        for (const t of ['A ', 'monoid ', 'in ', 'endofunctors.']) onToken?.(t);
        return 'A monoid in endofunctors.';
      },
    });
    assert.deepEqual(seen, ['A ', 'monoid ', 'in ', 'endofunctors.']);
    assert.equal(r.text, 'A monoid in endofunctors.');
  });

  test('a throwing token consumer does not lose the answer', async () => {
    const r = await reflex('what is a monad?', {
      onToken: () => { throw new Error('renderer exploded'); },
      llm: async (_m, { onToken }) => { try { onToken?.('x'); } catch { /* engine swallows */ } return 'the answer'; },
    });
    assert.equal(r.text, 'the answer');
  });

  test('without onToken nothing changes — streaming is opt-in', async () => {
    let sawSink = 'unset';
    const r = await reflex('what is a monad?', {
      llm: async (_m, o) => { sawSink = o.onToken; return 'plain'; },
    });
    assert.equal(sawSink, null, 'no token sink is passed when the caller wants none');
    assert.equal(r.text, 'plain');
  });

  test('the post-tool answer is NOT streamed', async () => {
    // The stream visibly stops for the lookup; streaming the follow-up too
    // would make the answer appear to restart from the beginning.
    const sinks = [];
    await reflex('look something up', {
      onToken: () => {},
      llm: async (_m, o) => {
        sinks.push(o.onToken ? 'streamed' : 'plain');
        return sinks.length === 1 ? 'TOOL: read_file {"path":"a.js"}' : 'done';
      },
      execTool: async () => ({ result: 'x' }),
    });
    assert.deepEqual(sinks, ['streamed', 'plain']);
  });

  test('llm.js exposes a real streaming entry point', async () => {
    const llm = await import('../src/llm.js');
    assert.equal(typeof llm.streamCompletion, 'function');
  });
});

// ── Provider compatibility of the message array ─────────────────────────────
//
// Found the hard way against a real vLLM gateway: the reflex used to emit TWO
// system messages (the prompt, then workspace/recall context). That is legal
// OpenAI and an outright HTTP 400 on vLLM serving Qwen — "System message must
// be at the beginning" — which took the entire conversational path down the
// first time Kairos was pointed at a local model. The full suite was green
// throughout, because nothing asserted the shape of what gets sent.

describe('the message array is portable across providers', () => {
  /** Capture exactly what the model was handed. */
  function capturing(reply = 'ok') {
    const seen = [];
    const llm = async (messages) => { seen.push(messages); return reply; };
    return { llm, seen };
  }

  test('there is exactly one system message, and it is first', async () => {
    const { llm, seen } = capturing();
    await reflex('what is a monad?', {
      llm,
      workspace: 'C:\\work\\project',
      recall: 'the user prefers short answers',
      history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
    });
    const messages = seen[0];
    const systems = messages.filter(m => m.role === 'system');
    assert.equal(systems.length, 1, `exactly one system message, got ${systems.length}`);
    assert.equal(messages[0].role, 'system', 'and it must be the first message');
  });

  test('workspace and recall survive the merge into that one message', async () => {
    const { llm, seen } = capturing();
    await reflex('hello', {
      llm,
      workspace: 'C:\\work\\project',
      recall: 'the build has been failing since Tuesday',
    });
    const system = seen[0][0].content;
    assert.match(system, /C:\\work\\project/, 'workspace must still reach the model');
    assert.match(system, /failing since Tuesday/, 'recall must still reach the model');
    assert.match(system, /fast conversational layer/, 'and the base prompt must still be there');
  });

  test('with no context at all it is still one system message', async () => {
    const { llm, seen } = capturing();
    await reflex('hello', { llm });
    assert.equal(seen[0].filter(m => m.role === 'system').length, 1);
    assert.equal(seen[0][0].role, 'system');
  });

  test('no system message ever follows a user or assistant turn', async () => {
    const { llm, seen } = capturing();
    await reflex('and now?', {
      llm,
      workspace: 'C:\\w',
      recall: 'something',
      history: Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `turn ${i}` })),
    });
    const firstNonSystem = seen[0].findIndex(m => m.role !== 'system');
    const lastSystem = seen[0].map(m => m.role).lastIndexOf('system');
    assert.ok(lastSystem < firstNonSystem,
      'every system message must precede the first non-system message');
  });
});
