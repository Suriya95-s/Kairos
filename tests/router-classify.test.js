// tests/router-classify.test.js
// Phase 4.1 — the cognition router.
//
// The plan's acceptance criterion is "classification accuracy ≥90% on a written
// 100-case fixture set". That number is only meaningful with the fixture set
// held fixed, so the accuracy test reads tests/fixtures/router-cases.js and
// never inlines its own cases.
//
// Honest caveat, recorded here rather than buried: the fixture set was written
// alongside the classifier, so a high score is a regression guard, not an
// estimate of how it will do on utterances nobody anticipated. The real
// accuracy signal is the decision log (C9), once there is one.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classify,
  classifyWithLlm,
  logDecision,
  readDecisions,
  INTENTS,
  LLM_THRESHOLD,
} from '../src/router/classify.js';
import { ROUTER_CASES, CONTEXTUAL_CASES } from './fixtures/router-cases.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-router-'));
  process.env.KAIROS_HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('the fixture set itself', () => {
  test('has at least 100 cases', () => {
    assert.ok(ROUTER_CASES.length >= 100, `expected ≥100 cases, found ${ROUTER_CASES.length}`);
  });

  test('covers every intent, with enough of each to mean anything', () => {
    // A 100-case set that is 95 missions would score well and prove nothing.
    const counts = {};
    for (const c of ROUTER_CASES) counts[c.intent] = (counts[c.intent] || 0) + 1;
    for (const intent of INTENTS) {
      assert.ok((counts[intent] || 0) >= 8, `intent "${intent}" has only ${counts[intent] || 0} cases`);
    }
  });

  test('covers every mission profile', () => {
    const profiles = new Set(ROUTER_CASES.filter(c => c.profile).map(c => c.profile));
    for (const p of ['build', 'research', 'errand']) {
      assert.ok(profiles.has(p), `no fixture exercises the ${p} profile`);
    }
  });

  test('has no duplicate utterances', () => {
    // A duplicate silently double-weights one case in the accuracy figure.
    const seen = new Set();
    const dupes = [];
    for (const c of ROUTER_CASES) {
      const key = c.text.toLowerCase().trim();
      if (seen.has(key)) dupes.push(c.text);
      seen.add(key);
    }
    assert.deepEqual(dupes, []);
  });

  test('every case declares a known intent', () => {
    for (const c of ROUTER_CASES) {
      assert.ok(INTENTS.includes(c.intent), `unknown intent "${c.intent}" for "${c.text}"`);
    }
  });
});

describe('accuracy (the 4.1 acceptance criterion)', () => {
  test('intent accuracy is at least 90%', () => {
    const failures = [];
    for (const c of ROUTER_CASES) {
      const got = classify(c.text);
      if (got.intent !== c.intent) {
        failures.push(`want=${c.intent} got=${got.intent} :: "${c.text}"${c.note ? ` (${c.note})` : ''} [${got.reason}]`);
      }
    }
    const accuracy = (ROUTER_CASES.length - failures.length) / ROUTER_CASES.length;
    assert.ok(
      accuracy >= 0.90,
      `accuracy ${(accuracy * 100).toFixed(1)}% is below the 90% bar:\n  ${failures.join('\n  ')}`,
    );
  });

  test('no case currently regresses', () => {
    // Stricter than the AC on purpose. When a deliberately hard case is added
    // that the classifier cannot yet get right, relax THIS test — never the
    // 90% one, and never by relabelling the case.
    const failures = ROUTER_CASES
      .filter(c => classify(c.text).intent !== c.intent)
      .map(c => `${c.intent} :: "${c.text}"`);
    assert.deepEqual(failures, []);
  });

  test('mission profile selection is correct for every labelled case', () => {
    const failures = [];
    for (const c of ROUTER_CASES) {
      if (!c.profile) continue;
      const got = classify(c.text);
      if (got.profile !== c.profile) failures.push(`want=${c.profile} got=${got.profile} :: "${c.text}"`);
    }
    assert.deepEqual(failures, []);
  });

  test('context changes the answer where it should', () => {
    const failures = [];
    for (const c of CONTEXTUAL_CASES) {
      const got = classify(c.text, c.context);
      if (got.intent !== c.intent) {
        failures.push(`want=${c.intent} got=${got.intent} :: "${c.text}" ${JSON.stringify(c.context)}`);
      }
    }
    assert.deepEqual(failures, []);
  });
});

describe('coverage, which is not the same thing as accuracy', () => {
  // The distinction this suite learned the hard way. The fixture set was at
  // 100% while the verb "check" matched no signal at all, so an ordinary spoken
  // instruction fell through to clarify. Accuracy is the percentage right *out
  // of the cases that exist*; a word nobody thought to write down is not a
  // wrong answer, it is an absent question. Only coverage sees it.

  test('the "nothing matched" confidence is a distinct, recognisable value', () => {
    // eval/router-coverage.js keys off this exactly. If it ever becomes an
    // ordinary score, the coverage gate silently stops detecting anything.
    const nonsense = classify('zorblax the quimbly frobnicator');
    assert.equal(nonsense.intent, 'clarify');
    assert.equal(nonsense.confidence, 0.15,
      'the sentinel confidence changed — eval/router-coverage.js keys off it');
  });

  test('ordinary instructions do not fall through to clarify', () => {
    // A representative slice of what the audit found: 30 of 65 realistic
    // utterances used to score zero on every intent.
    const shouldRoute = [
      'check the build status', 'verify the tests pass', 'look at the error log',
      'inspect the database schema', 'see if the server is up', 'restart the daemon',
      'commit these changes', 'push to main', 'is the build passing',
      'are the tests green', 'rename this variable', 'optimize this query',
      'fix the failing test', 'update the readme', 'that worked',
    ];
    const dead = shouldRoute.filter(t => classify(t).confidence === 0.15);
    assert.deepEqual(dead, [], `these matched no signal at all: ${dead.join(', ')}`);
  });

  test('a prefix written as a bare signal matches nothing — the optimi bug', () => {
    // `['optimi', 3]` sat in MISSION_SIGNALS unable to fire, because compile()
    // wraps alphanumeric patterns in \b and it was searching for the literal
    // word "optimi". Guarded by behaviour rather than by reading the table.
    for (const text of ['optimize this query', 'optimise this query']) {
      assert.notEqual(classify(text).confidence, 0.15, `${text} matched nothing`);
    }
  });

  test('genuinely ambiguous input still asks rather than guessing', () => {
    // The gate must not be satisfiable by making everything match something.
    for (const vague of ['build status', 'test results', 'the error log']) {
      assert.equal(classify(vague).intent, 'clarify', `"${vague}" should ask`);
    }
  });
});

describe('regressions found while building this', () => {
  test('signals match on word boundaries, not substrings', () => {
    // "ok" matched inside "broken", which made "the build is broken" a
    // conversational reflex. Substring matching fails silently and constantly.
    assert.notEqual(classify('the build is broken').intent, 'reflex');
    assert.notEqual(classify('the token is invalid').intent, 'reflex');
    // And the real word still matches.
    assert.equal(classify('ok').intent, 'reflex');
  });

  test('an utterance matching NOTHING becomes clarify, not a default intent', () => {
    // The short-utterance penalty moved the score off zero, so the
    // "nothing matched" branch never fired and unrecognised input silently
    // became reflex — burning a model call on something we did not understand.
    for (const text of ['test', 'zxcvbn', 'foo bar']) {
      assert.equal(classify(text).intent, 'clarify', `"${text}" should be clarify`);
    }
  });

  test('a question containing build vocabulary stays a question', () => {
    assert.equal(classify('how do I build a REST API in Express?').intent, 'reflex');
    assert.equal(classify('build a REST API in Express').intent, 'mission');
  });

  test('"stop" alone is control; "stop X from Y" is work', () => {
    assert.equal(classify('stop').intent, 'control');
    assert.equal(classify('stop the server from crashing on startup').intent, 'mission');
  });

  test('"remind me to X" is an errand; "remind me what X" is recall', () => {
    assert.equal(classify('remind me to check the deploy on Friday').profile, 'errand');
    assert.equal(classify('remind me what the mission profiles are').intent, 'reflex');
  });

  test('a leading auxiliary is only a question when a subject follows it', () => {
    // "do something" was read as a question because of the leading "do", sent
    // to the reflex, and spent six seconds finding out the model was down — to
    // answer something the user had asked it to DO.
    assert.notEqual(classify('do something').intent, 'reflex');
    assert.notEqual(classify('do the migration').intent, 'reflex');
    // …and real auxiliary questions still work.
    assert.equal(classify('do you know if Node supports top-level await?').intent, 'reflex');
    assert.equal(classify('does the build pass?').intent, 'reflex');
    assert.equal(classify('is the deploy done?').intent, 'reflex');
  });

  test('a wh-word leads a question with or without a question mark', () => {
    assert.equal(classify('what is a monad').intent, 'reflex');
    assert.equal(classify('why does this fail').intent, 'reflex');
  });

  test('the LLM classifier calls a function that actually exists', async () => {
    // The first version imported `callLLM`, which llm.js has never exported.
    // It threw a TypeError, the catch swallowed it, and the fallback silently
    // never consulted a model while appearing to work.
    const src = fs.readFileSync(new URL('../src/router/classify.js', import.meta.url), 'utf-8');
    const llmSrc = await import('../src/llm.js');
    const imported = [...src.matchAll(/const \{ (\w+) \} = await import\('\.\.\/llm\.js'\)/g)].map(m => m[1]);
    assert.ok(imported.length > 0, 'the classifier should import something from llm.js');
    for (const name of imported) {
      assert.ok(typeof llmSrc[name] === 'function', `llm.js does not export "${name}"`);
    }
  });

  test('classification has a hard timeout — it sits in every utterance path', async () => {
    const t0 = Date.now();
    const d = await classifyWithLlm('the widget situation', {
      llm: () => new Promise(resolve => setTimeout(() => resolve('mission'), 30_000)),
    });
    // The injected llm has no timeout of its own, so this proves the caller
    // does not hang; the built-in path has LLM_CLASSIFY_TIMEOUT_MS on top.
    assert.ok(d.intent, 'a decision was still returned');
    assert.ok(Date.now() - t0 < 30_000);
  });

  test('the router and profiles.js agree on errand vocabulary', () => {
    // They are separate tables and drifting apart is a real failure mode: the
    // router says errand, the profile selector then runs it under `build` and
    // demands a smoke test for setting a timer.
    const d = classify('set a timer for 25 minutes');
    assert.equal(d.intent, 'mission');
    assert.equal(d.profile, 'errand');
  });
});

describe('decision shape', () => {
  test('an empty utterance is clarify, not a crash', () => {
    for (const input of ['', '   ', null, undefined]) {
      assert.equal(classify(input).intent, 'clarify');
    }
  });

  test('control decisions name the action', () => {
    assert.equal(classify('pause').control.action, 'pause');
    assert.equal(classify('resume').control.action, 'resume');
    assert.equal(classify('status').control.action, 'status');
    assert.equal(classify('stop').control.action, 'stop');
  });

  test('a control phrase naming a mission id captures it', () => {
    const d = classify('stop m-abc123');
    assert.equal(d.intent, 'control');
    assert.equal(d.control.target, 'm-abc123');
  });

  test('urgency reflects the words used', () => {
    assert.equal(classify('build a parser right away').urgency, 'now');
    assert.equal(classify('build a parser whenever you get a chance').urgency, 'whenever');
    assert.equal(classify('build a parser').urgency, 'soon', 'missions are background work by default');
    assert.equal(classify('what is a monad?').urgency, 'now', 'someone is waiting for an answer');
  });

  test('confidence is a margin, so a tie reads as unsure', () => {
    const clear = classify('build a REST API with Express');
    const murky = classify('maybe the widget thing');
    assert.ok(clear.confidence > murky.confidence,
      `expected clear(${clear.confidence}) > murky(${murky.confidence})`);
  });

  test('only mission decisions carry a profile', () => {
    assert.equal(classify('what is a monad?').profile, null);
    assert.equal(classify('stop').profile, null);
    assert.ok(classify('build a REST API').profile);
  });

  test('politeness prefixes do not hide the verb', () => {
    for (const prefix of ['please ', 'could you ', 'hey, can you ', 'ok so ']) {
      const d = classify(`${prefix}refactor the auth module`);
      assert.equal(d.intent, 'mission', `"${prefix}" broke it`);
    }
  });
});

describe('LLM fallback', () => {
  test('a confident keyword decision never calls the model', async () => {
    let called = false;
    const d = await classifyWithLlm('build a REST API with Express', {
      llm: async () => { called = true; return 'reflex'; },
    });
    assert.equal(called, false, 'paying for a model call on an obvious case is wasted latency');
    assert.equal(d.intent, 'mission');
  });

  test('an unsure decision escalates and takes the model\'s answer', async () => {
    let prompt = null;
    const d = await classifyWithLlm('the widget situation', {
      llm: async (p) => { prompt = p; return 'mission'; },
    });
    assert.ok(prompt, 'the model should have been consulted');
    assert.equal(d.intent, 'mission');
    assert.equal(d.method, 'llm');
  });

  test('a model that answers with garbage is ignored, not obeyed', async () => {
    const d = await classifyWithLlm('the widget situation', {
      llm: async () => 'I think this is probably about widgets, hard to say',
    });
    assert.ok(INTENTS.includes(d.intent));
  });

  test('an unreachable model degrades to the keyword answer (S3)', async () => {
    // A router that stops working when the endpoint is down is worse than one
    // that is occasionally unsure.
    const keyword = classify('the widget situation');
    const d = await classifyWithLlm('the widget situation', {
      llm: async () => { throw new Error('ECONNREFUSED'); },
    });
    assert.equal(d.intent, keyword.intent);
    assert.match(d.reason, /llm unavailable/);
  });

  test('the escalation threshold is what decides, not the intent', async () => {
    const murky = classify('the widget situation');
    assert.ok(murky.confidence < LLM_THRESHOLD, 'this fixture must actually be below threshold');
  });
});

describe('decision log (C9)', () => {
  test('a decision is appended and reads back', () => {
    const d = classify('build a REST API');
    logDecision(d, { text: 'build a REST API', sessionId: 's-1' });

    const all = readDecisions();
    assert.equal(all.length, 1);
    assert.equal(all[0].intent, 'mission');
    assert.equal(all[0].sessionId, 's-1');
    assert.equal(all[0].profile, 'build');
  });

  test('EVERY decision is logged, not only the uncertain ones', () => {
    // An accuracy claim needs the denominator.
    for (const t of ['stop', 'what is a monad?', 'build a REST API', 'fix it']) {
      logDecision(classify(t), { text: t });
    }
    assert.equal(readDecisions().length, 4);
  });

  test('a correction can be recorded — this is what makes it training data', () => {
    logDecision(classify('the widget thing'), { text: 'the widget thing', corrected: 'mission' });
    assert.equal(readDecisions()[0].corrected, 'mission');
  });

  test('logged text is truncated so the log is not a second transcript', () => {
    const long = 'build '.repeat(400);
    logDecision(classify(long), { text: long });
    assert.ok(readDecisions()[0].text.length <= 500);
  });

  test('an unwritable log never breaks routing', () => {
    // The observer must not be able to break the thing it observes.
    const blocker = path.join(tmpHome, 'blocked');
    fs.writeFileSync(blocker, 'not a directory');
    assert.doesNotThrow(() => logDecision(classify('hi'), { text: 'hi', dir: path.join(blocker, 'router') }));
  });

  test('reading an absent log returns empty rather than throwing', () => {
    assert.deepEqual(readDecisions({ dir: path.join(tmpHome, 'nope') }), []);
  });
});
