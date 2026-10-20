// tests/loop-verification-breaker.test.js
// The verification circuit breaker: blocked finish attempts are bounded.
//
// Nothing bounded them before, and it showed: a written study misrouted into
// the build profile was smoke-test-gate-blocked 52 consecutive finish attempts
// — each a full LLM round-trip — and burned a weekly token quota. The gates
// exist to force repair; repair has a bounded number of useful attempts. Past
// `config.verifyMaxFailures` the mission is misconfigured, not unfinished, and
// the loop must stop and say so instead of spending to maxSteps.
//
// Drives the REAL loop end-to-end with a scripted fetch(): a model that writes
// one file (to clear the completion guard) and then insists it is finished,
// forever, under a profile whose smoke-test gate its task can never satisfy.

// Env must be set before config.js is imported — it reads at module load.
process.env.AGENT_VERIFY_MAX_FAILURES = '2';
process.env.AGENT_MAX_STEPS = '10';           // backstop: a broken breaker fails fast, not at 100 steps

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The client meters every completion into ~/.kairos/usage — this test's
// scripted model must spend into a throwaway home, not the owner's ledger.
process.env.KAIROS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-breaker-'));

const { runLoop } = await import('../src/loop.js');
const { createContext } = await import('../src/runtime/context.js');

const realFetch = globalThis.fetch;
let llmCalls;

function action(tool, args) {
  return JSON.stringify({ thought: 'scripted', tool, args });
}

// One write_file (clears the no-file-modifications completion guard), then
// finish attempts forever. Summaries vary so the identical-args stall guard
// (a different, earlier backstop at 4 identical calls) cannot mask the breaker.
function scriptedModel() {
  llmCalls = 0;
  globalThis.fetch = async () => {
    llmCalls++;
    const content = llmCalls === 1
      ? action('write_file', { path: 'ontology-study.md', content: '# Ontology\n\nA study.\n' })
      : action('finish', { summary: `the study is complete (attempt ${llmCalls})` });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
      text: async () => '',
    };
  };
}

afterEach(() => { globalThis.fetch = realFetch; });

describe('verification circuit breaker', () => {
  test('a finish forever blocked by the smoke gate trips the breaker instead of burning to maxSteps', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-breaker-'));
    scriptedModel();
    try {
      // A bare `workspace` option is IGNORED without an explicit ctx — runLoop
      // falls back to the ambient context's workspace, i.e. the CWD. Learned
      // the hard way: this test's first run wrote its scripted "study" over
      // the repo's real ontology-study.md (recovered from the bus journal).
      const res = await runLoop({
        task: 'Study ontology and write it up.',
        workspace,
        ctx: createContext({ workspace }),
        profile: 'build',        // explicit misroute: gates demand "SMOKE OK" a study can never print
        _noConduct: true,
      });

      assert.equal(res.exitReason, 'error',
        `breaker must end the loop with an error, got ${res.exitReason}: ${res.summary}`);
      assert.match(res.summary, /circuit breaker/i,
        'the summary must name the breaker so the operator knows this is misconfiguration, not failure to work');
      assert.match(res.summary, /profile/i,
        'the summary must point at the profile as the likely misconfiguration');

      // Cap 2 → blocked finish, blocked finish, breaker on the 3rd attempt.
      // 1 write + 3 finishes = 4 LLM round-trips, not dozens.
      assert.ok(llmCalls <= 6,
        `the breaker exists to bound spend — expected ≤6 LLM calls, saw ${llmCalls}`);

      // The work already on disk must survive the abort.
      const artifact = path.join(workspace, 'ontology-study.md');
      assert.ok(fs.existsSync(artifact), 'artifacts written before the breaker tripped must be preserved');
    } finally {
      try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* Windows file locks */ }
    }
  });
});
