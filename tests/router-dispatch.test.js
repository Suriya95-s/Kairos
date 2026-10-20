// tests/router-dispatch.test.js
// Phase 4.3 + 4.4 — the conversation transcript and interruption routing.
//
// The behaviour under test is the one that separates "a chatbot that can also
// run jobs" from something that feels like a colleague: what happens when you
// say something while it is already working.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dispatch, ACTIONS } from '../src/router/dispatch.js';
import { Conversation, resetConversation } from '../src/chat/conversation.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-disp-'));
  process.env.KAIROS_HOME = tmpHome;
  resetConversation();
});

afterEach(() => {
  resetConversation();
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

const convo = () => new Conversation({ dir: path.join(tmpHome, 'sessions') });

/** Recording stubs for everything the dispatcher can do. */
function harness(overrides = {}) {
  const calls = { started: [], controlled: [], steered: [] };
  return {
    calls,
    deps: {
      sessionId: 's-1',
      workspace: '/tmp/proj',
      logDir: path.join(tmpHome, 'router'),
      startMission: async (spec) => { calls.started.push(spec); return { id: 'm-new', ...spec }; },
      controlMission: async (action, id) => { calls.controlled.push({ action, id }); },
      steerMission: async (id, msg) => { calls.steered.push({ id, msg }); },
      runReflex: async () => ({ text: 'an answer', toolUsed: null, escalation: null, latencyMs: 12 }),
      ...overrides,
    },
  };
}

const RUNNING = [{ id: 'm-1', state: 'running', workspace: '/tmp/proj', title: 'refactor auth' }];

describe('routing when idle', () => {
  test('a question is answered', async () => {
    const { deps, calls } = harness();
    const r = await dispatch('what is a monad?', deps);
    assert.equal(r.action, 'answered');
    assert.equal(r.text, 'an answer');
    assert.deepEqual(calls.started, []);
  });

  test('a job starts a mission with the right profile', async () => {
    const { deps, calls } = harness();
    const r = await dispatch('build a REST API with Express', deps);
    assert.equal(r.action, 'started');
    assert.equal(calls.started[0].profile, 'build');
    assert.equal(calls.started[0].workspace, '/tmp/proj');
  });

  test('a research job carries the research profile through', async () => {
    const { deps, calls } = harness();
    await dispatch('summarize what changed in this repo this week', deps);
    assert.equal(calls.started[0].profile, 'research');
  });

  test('a vague utterance asks rather than guessing', async () => {
    const { deps, calls } = harness();
    const r = await dispatch('fix it', deps);
    assert.equal(r.action, 'clarify');
    assert.deepEqual(calls.started, [], 'guessing here would start the wrong twenty-minute job');
  });

  test('with no workspace, work is refused with the useful question', async () => {
    const { deps } = harness({ workspace: null });
    const r = await dispatch('build a REST API', deps);
    assert.equal(r.action, 'clarify');
    assert.match(r.text, /Which project/);
  });

  test('every action is one of the declared ones', async () => {
    const { deps } = harness();
    for (const text of ['what is x?', 'build a parser', 'fix it', 'stop', 'status']) {
      const r = await dispatch(text, { ...deps, runningMissions: RUNNING });
      assert.ok(ACTIONS.includes(r.action), `"${text}" produced unknown action ${r.action}`);
    }
  });
});

describe('interruption — the 4.4 rule', () => {
  test('an INSTRUCTION during a mission steers it instead of starting a rival', async () => {
    // A second mission on the same workspace would just queue behind the first
    // (S5), so the change would not land until the current job finished.
    const { deps, calls } = harness();
    const r = await dispatch('also add tests for the login flow', { ...deps, runningMissions: RUNNING });

    assert.equal(r.action, 'steered');
    assert.equal(calls.steered[0].id, 'm-1');
    assert.deepEqual(calls.started, [], 'must not start a competing mission');
  });

  test('a QUESTION during a mission is answered without disturbing it', async () => {
    // The one that matters. Pausing a twenty-minute job to answer "what's a
    // monad" would be broken behaviour.
    const { deps, calls } = harness();
    const r = await dispatch('what is a monad?', { ...deps, runningMissions: RUNNING });

    assert.equal(r.action, 'answered');
    assert.deepEqual(calls.steered, [], 'the mission must not be touched');
    assert.deepEqual(calls.controlled, [], 'and certainly not paused');
  });

  test('"fix it" during a mission is steering, not a clarify', async () => {
    // Same words, different meaning: mid-mission "it" has an obvious antecedent.
    const { deps, calls } = harness();
    const r = await dispatch('fix it', { ...deps, runningMissions: RUNNING });
    assert.equal(r.action, 'steered');
    assert.equal(calls.steered[0].msg, 'fix it');
  });

  test('work in a DIFFERENT workspace starts a parallel mission rather than steering', async () => {
    const { deps, calls } = harness({ workspace: '/tmp/other' });
    const r = await dispatch('build a CLI tool', { ...deps, runningMissions: RUNNING });
    assert.equal(r.action, 'started');
    assert.deepEqual(calls.steered, []);
  });

  test('"stop that mission" works mid-run (the 4.4 acceptance criterion)', async () => {
    const { deps, calls } = harness();
    const r = await dispatch('stop that mission', { ...deps, runningMissions: RUNNING });
    assert.equal(r.action, 'controlled');
    assert.deepEqual(calls.controlled, [{ action: 'stop', id: 'm-1' }]);
  });

  test('stop can name a specific mission', async () => {
    const two = [...RUNNING, { id: 'm-2', state: 'running', workspace: '/tmp/b' }];
    const { deps, calls } = harness();
    await dispatch('stop m-2', { ...deps, runningMissions: two });
    assert.deepEqual(calls.controlled, [{ action: 'stop', id: 'm-2' }]);
  });

  test('stopping a mission that is not running says so instead of failing silently', async () => {
    const { deps, calls } = harness();
    const r = await dispatch('stop m-999', { ...deps, runningMissions: RUNNING });
    assert.match(r.text, /don't see a mission m-999/);
    assert.deepEqual(calls.controlled, []);
  });

  test('pause and resume reach the mission', async () => {
    const { deps, calls } = harness();
    await dispatch('pause', { ...deps, runningMissions: RUNNING });
    await dispatch('resume', { ...deps, runningMissions: RUNNING });
    assert.deepEqual(calls.controlled.map(c => c.action), ['pause', 'resume']);
  });

  test('status lists what is running', async () => {
    const { deps } = harness();
    const r = await dispatch('what are you working on?', { ...deps, runningMissions: RUNNING });
    assert.equal(r.action, 'controlled');
    assert.match(r.text, /m-1/);
    assert.match(r.text, /refactor auth/);
  });

  test('status with nothing running says so plainly', async () => {
    const { deps } = harness();
    const r = await dispatch('status', deps);
    assert.match(r.text, /Nothing running/);
  });
});

describe('escalation from a reflex', () => {
  test('by default a proposed mission is offered, not started', async () => {
    const { deps, calls } = harness({
      runReflex: async () => ({
        text: '', escalation: { proposed: true, task: 'migrate the DB layer', profile: 'build' },
      }),
    });
    // An utterance that genuinely routes to the reflex — the escalation is the
    // model realising mid-answer that this is a job.
    const r = await dispatch('what would it take to migrate the database layer?', deps);

    assert.equal(r.action, 'proposed');
    assert.deepEqual(calls.started, [], 'nothing may start without confirmation');
    assert.match(r.text, /Start it\?/);
  });

  test('autoStart converts a proposal into a mission when explicitly enabled', async () => {
    const { deps, calls } = harness({
      autoStart: true,
      runReflex: async () => ({
        text: '', escalation: { proposed: true, task: 'migrate the DB layer', profile: 'build' },
      }),
    });
    const r = await dispatch('what would it take to migrate the database layer?', deps);
    assert.equal(r.action, 'started');
    assert.equal(calls.started[0].task, 'migrate the DB layer');
  });

  test('a degraded reflex reports the outage instead of inventing an answer', async () => {
    const { deps } = harness({
      runReflex: async () => ({ text: '', degraded: 'model unavailable: ECONNREFUSED' }),
    });
    const r = await dispatch('what is a monad?', deps);
    assert.match(r.text, /can't answer right now/);
    assert.match(r.text, /ECONNREFUSED/);
  });
});

describe('the conversation transcript (4.3)', () => {
  test('user turns and reflex answers interleave in one record', async () => {
    const c = convo();
    const { deps } = harness({ conversation: c });
    await dispatch('what is a monad?', deps);

    const turns = c.read('s-1');
    assert.deepEqual(turns.map(t => t.role), ['user', 'assistant']);
    assert.equal(turns[0].content, 'what is a monad?');
    assert.equal(turns[1].content, 'an answer');
  });

  test('mission milestones join the same transcript', async () => {
    const c = convo();
    const { deps } = harness({ conversation: c });
    await dispatch('build a REST API', deps);
    c.missionEvent('s-1', { action: 'ended', missionId: 'm-new', exitReason: 'completed' });

    const roles = c.read('s-1').map(t => t.role);
    assert.deepEqual(roles, ['user', 'mission', 'mission']);
  });

  test('per-step mission noise is NOT recorded', async () => {
    // A transcript that is 98% "step 47: read_file" is a log with some talking
    // in it, not a conversation. Steps stay on the bus.
    const c = convo();
    for (let i = 1; i <= 50; i++) {
      c.missionEvent('s-1', { action: 'step', missionId: 'm-1', step: i, tool: 'read_file' });
    }
    assert.deepEqual(c.read('s-1'), []);
  });

  test('turns keep their order within a single millisecond', async () => {
    // A reflex answer and the mission it proposed can land in the same
    // millisecond; sorting by timestamp alone would let them swap.
    const c = new Conversation({ dir: path.join(tmpHome, 'sessions'), now: () => 1_700_000_000_000 });
    for (let i = 0; i < 20; i++) c.userSaid('s-1', `msg ${i}`);
    assert.deepEqual(c.read('s-1').map(t => t.content), Array.from({ length: 20 }, (_, i) => `msg ${i}`));
    assert.deepEqual(c.read('s-1').map(t => t.seq), Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test('sequence continues correctly after a restart', async () => {
    const dir = path.join(tmpHome, 'sessions');
    new Conversation({ dir }).userSaid('s-1', 'before');
    const reborn = new Conversation({ dir });
    reborn.userSaid('s-1', 'after');
    assert.deepEqual(reborn.read('s-1').map(t => t.seq), [1, 2]);
  });

  test('history is fed back to the reflex on the next turn', async () => {
    const c = convo();
    let seenHistory = null;
    const { deps } = harness({
      conversation: c,
      runReflex: async (_t, o) => { seenHistory = o.history; return { text: 'second answer' }; },
    });
    c.userSaid('s-1', 'first question');
    c.assistantSaid('s-1', 'first answer');
    await dispatch('and what about that?', deps);

    assert.ok(seenHistory.some(h => h.content === 'first answer'),
      'the reflex must see what was already said');
  });

  test('mission milestones reach the reflex as system context, not as user speech', async () => {
    const c = convo();
    c.missionEvent('s-1', { action: 'ended', missionId: 'm-1', exitReason: 'completed' });
    const h = c.history('s-1');
    assert.equal(h[0].role, 'system');
    assert.match(h[0].content, /^\[mission\]/);
  });

  test('forMission filters one job out of a busy session', async () => {
    const c = convo();
    c.missionEvent('s-1', { action: 'running', missionId: 'm-1', title: 'a' });
    c.missionEvent('s-1', { action: 'running', missionId: 'm-2', title: 'b' });
    c.missionEvent('s-1', { action: 'ended', missionId: 'm-1', exitReason: 'completed' });
    assert.equal(c.forMission('s-1', 'm-1').length, 2);
  });

  test('a session id cannot escape the transcript directory', async () => {
    const c = convo();
    c.userSaid('../../etc/passwd', 'malicious');
    const base = path.resolve(tmpHome, 'sessions');
    assert.ok(c.transcriptPath('../../etc/passwd').startsWith(base));
    // `.` and `..` survive a charset filter intact and ARE path segments.
    assert.ok(c.transcriptPath('..').startsWith(base));
    assert.ok(c.transcriptPath('.').startsWith(base));
  });

  test('an unknown role is rejected', () => {
    assert.throws(() => convo().append('s-1', 'wizard', 'hi'), /unknown turn role/);
  });

  test('reading an absent transcript returns empty', () => {
    assert.deepEqual(convo().read('s-never'), []);
  });
});

describe('decision logging through the dispatcher', () => {
  test('every dispatched utterance lands in the router log', async () => {
    const { deps } = harness();
    await dispatch('what is a monad?', deps);
    await dispatch('build a parser', deps);

    const logged = fs.readFileSync(path.join(tmpHome, 'router', 'decisions.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(logged.length, 2);
    assert.deepEqual(logged.map(l => l.intent), ['reflex', 'mission']);
    assert.equal(logged[0].sessionId, 's-1');
  });
});

describe('memory in the reflex path (5.5)', () => {
  test('recalled memory reaches the reflex', async () => {
    let sawRecall = null;
    const memory = {
      recallText: (opts) => {
        assert.equal(opts.layer, 'reflex', 'the reflex must be scoped as a reflex');
        return '- style: tabs, not spaces';
      },
    };
    const { deps } = harness({
      memory,
      runReflex: async (_t, o) => { sawRecall = o.recall; return { text: 'ok' }; },
    });
    await dispatch('what indentation do I use?', deps);
    assert.equal(sawRecall, '- style: tabs, not spaces');
  });

  test('a broken memory service degrades to an answer without context', async () => {
    // Memory enhances a reply; it is not a precondition for one. A corrupt DB
    // must not turn every question into an error.
    const memory = { recallText: () => { throw new Error('database is locked'); } };
    const { deps } = harness({
      memory,
      runReflex: async (_t, o) => ({ text: `answered with recall=${JSON.stringify(o.recall)}` }),
    });
    const r = await dispatch('what is a monad?', deps);
    assert.match(r.text, /recall=""/);
    assert.equal(r.action, 'answered');
  });

  test('with no memory service nothing changes', async () => {
    const { deps } = harness({ runReflex: async (_t, o) => ({ text: String(o.recall) }) });
    const r = await dispatch('what is a monad?', deps);
    assert.equal(r.text, '', 'recall defaults to empty, not undefined');
  });
});
