// tests/kernel-bus.test.js
// Phase 3.2 — the event bus.
//
// The bus is the daemon's nervous system, so its guarantees have to be facts,
// not intentions: schema validation rejects typos, redaction happens before
// anything is written or delivered, ordering survives same-millisecond bursts,
// and one bad subscriber cannot take down the others.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  Bus,
  createEvent,
  getBus,
  resetBus,
  setBus,
  EVENT_KINDS,
  EVENT_SOURCES,
  URGENCIES,
} from '../src/kernel/bus.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-bus-'));
  process.env.KAIROS_HOME = tmpHome;
});

afterEach(() => {
  resetBus();
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* windows lock */ }
});

/** A bus writing into an isolated journal dir under the temp home. */
function makeBus(opts = {}) {
  return new Bus({ journalDir: path.join(tmpHome, 'bus'), ...opts });
}

describe('event schema (D2)', () => {
  test('a well-formed event gets id, ts, seq and defaults', () => {
    const evt = createEvent({ source: 'user.cli', kind: 'utterance', payload: { text: 'hi' } });
    assert.match(evt.id, /^evt-/);
    assert.equal(typeof evt.ts, 'number');
    assert.equal(evt.identity, 'default', 'identity defaults for the single-user case');
    assert.equal(evt.urgency, 'whenever');
    assert.equal(evt.sessionId, null, 'ambient events have no session');
  });

  test('an unknown kind is rejected rather than coerced', () => {
    // A typo'd kind that quietly becomes a valid one is a bug that surfaces
    // weeks later as "why did my trigger never fire".
    assert.throws(() => createEvent({ source: 'timer', kind: 'mission_updat' }), /invalid event kind/);
    assert.throws(() => createEvent({ source: 'user.clii', kind: 'utterance' }), /invalid event source/);
    assert.throws(
      () => createEvent({ source: 'timer', kind: 'trigger', urgency: 'urgent' }),
      /invalid event urgency/,
    );
  });

  test('the error names the valid values, so the fix is obvious', () => {
    assert.throws(() => createEvent({ source: 'timer', kind: 'nope' }), (err) => {
      for (const k of EVENT_KINDS) assert.ok(err.message.includes(k), `should list ${k}`);
      return true;
    });
  });

  test('payload must be a plain object', () => {
    assert.throws(() => createEvent({ source: 'timer', kind: 'trigger', payload: 'text' }), /plain object/);
    assert.throws(() => createEvent({ source: 'timer', kind: 'trigger', payload: [1] }), /plain object/);
    assert.throws(() => createEvent({ source: 'timer', kind: 'trigger', payload: null }), /plain object/);
  });

  test('the D2 canonical kinds are all present', () => {
    for (const k of ['utterance', 'trigger', 'mission_update', 'approval', 'schedule_due', 'observation']) {
      assert.ok(EVENT_KINDS.includes(k), `D2 kind ${k} must exist`);
    }
    assert.deepEqual([...URGENCIES], ['now', 'soon', 'whenever']);
    assert.ok(EVENT_SOURCES.includes('user.voice'), 'P8 voice source reserved up front');
  });
});

describe('publish and subscribe', () => {
  test('subscribers receive events for their kind', () => {
    const bus = makeBus();
    const got = [];
    bus.subscribe('utterance', e => got.push(e));
    bus.publish({ source: 'user.cli', kind: 'utterance', payload: { text: 'a' } });
    bus.publish({ source: 'timer', kind: 'trigger', payload: {} });
    assert.equal(got.length, 1);
    assert.equal(got[0].payload.text, 'a');
  });

  test("'*' receives everything", () => {
    const bus = makeBus();
    const got = [];
    bus.subscribe('*', e => got.push(e.kind));
    bus.publish({ source: 'user.cli', kind: 'utterance', payload: {} });
    bus.publish({ source: 'timer', kind: 'trigger', payload: {} });
    assert.deepEqual(got, ['utterance', 'trigger']);
  });

  test('a session channel receives only that session', () => {
    const bus = makeBus();
    const got = [];
    bus.subscribe('session:s-1', e => got.push(e.sessionId));
    bus.publish({ source: 'mission', kind: 'mission_update', sessionId: 's-1', payload: {} });
    bus.publish({ source: 'mission', kind: 'mission_update', sessionId: 's-2', payload: {} });
    assert.deepEqual(got, ['s-1']);
  });

  test('a predicate filter works', () => {
    const bus = makeBus();
    const got = [];
    bus.subscribe(e => e.urgency === 'now', e => got.push(e.id));
    bus.publish({ source: 'watcher', kind: 'observation', urgency: 'now', payload: {} });
    bus.publish({ source: 'watcher', kind: 'observation', urgency: 'whenever', payload: {} });
    assert.equal(got.length, 1);
  });

  test('unsubscribe stops delivery', () => {
    const bus = makeBus();
    const got = [];
    const off = bus.subscribe('trigger', e => got.push(e));
    bus.publish({ source: 'timer', kind: 'trigger', payload: {} });
    off();
    bus.publish({ source: 'timer', kind: 'trigger', payload: {} });
    assert.equal(got.length, 1);
  });

  test('one throwing subscriber does not stop the others', () => {
    // An always-on process cannot let a buggy client surface silence the rest
    // of the system.
    const errors = [];
    const bus = makeBus({ onError: (err, evt, where) => errors.push({ err, where }) });
    const seen = [];
    bus.subscribe('trigger', () => { throw new Error('boom'); });
    bus.subscribe('trigger', e => seen.push(e.id));
    bus.publish({ source: 'timer', kind: 'trigger', payload: {} });
    assert.equal(seen.length, 1, 'the healthy subscriber still ran');
    assert.equal(errors.length, 1);
    assert.match(errors[0].where, /^subscriber:/);
  });

  test('publishing on a closed bus throws', () => {
    const bus = makeBus();
    bus.close();
    assert.throws(() => bus.publish({ source: 'timer', kind: 'trigger', payload: {} }), /closed/);
  });
});

describe('redaction (S1) — secrets never transit the bus', () => {
  test('a credential in a payload is redacted before delivery AND before journaling', () => {
    // This is the S1 guarantee. Redacting only on write would still leak the
    // secret to every SSE client and into LLM context via a subscriber.
    const bus = makeBus();
    let delivered = null;
    bus.subscribe('*', e => { delivered = e; });

    bus.publish({
      source: 'mission',
      kind: 'mission_update',
      payload: { cmd: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456"' },
    });

    assert.ok(!delivered.payload.cmd.includes('sk-abcdefghijklmnopqrstuvwxyz123456'),
      'subscriber must not see the raw key');
    const journal = fs.readFileSync(bus.segments()[0], 'utf-8');
    assert.ok(!journal.includes('sk-abcdefghijklmnopqrstuvwxyz123456'),
      'journal must not contain the raw key');
    assert.ok(journal.includes('REDACTED'), 'and it should say so, not just drop it');
  });

  test('redaction reaches nested payload fields', () => {
    const bus = makeBus();
    let got;
    bus.subscribe('*', e => { got = e; });
    bus.publish({
      source: 'system',
      kind: 'error',
      payload: { detail: { env: { token: 'ghp_012345678901234567890123456789012345' } } },
    });
    assert.ok(!JSON.stringify(got.payload).includes('ghp_0123456789'),
      'nested secrets must be redacted too');
  });

  test('ordinary payloads survive redaction unchanged', () => {
    // A redactor aggressive enough to mangle normal text would make the
    // journal useless. Guard the false-positive direction too.
    const bus = makeBus();
    let got;
    bus.subscribe('*', e => { got = e; });
    const payload = { missionId: 'm-1', step: 12, stage: 'execution', note: 'wrote src/app.js' };
    bus.publish({ source: 'mission', kind: 'mission_update', payload });
    assert.deepEqual(got.payload, payload);
  });
});

describe('journal — durability and ordering', () => {
  test('events are appended as JSONL and replay reads them back', () => {
    const bus = makeBus();
    bus.publish({ source: 'user.cli', kind: 'utterance', payload: { text: 'one' } });
    bus.publish({ source: 'user.cli', kind: 'utterance', payload: { text: 'two' } });

    const replayed = makeBus().replay();
    assert.equal(replayed.length, 2);
    assert.deepEqual(replayed.map(e => e.payload.text), ['one', 'two']);
  });

  test('a same-millisecond burst keeps its publication order', () => {
    // The exact failure that made the multi-agent handoff test flaky: a frozen
    // clock means ts cannot break ties, so append order and seq must.
    const bus = makeBus({ now: () => 1_700_000_000_000 });
    for (let i = 0; i < 50; i++) {
      bus.publish({ source: 'mission', kind: 'mission_update', payload: { i } });
    }
    const replayed = makeBus().replay();
    assert.deepEqual(replayed.map(e => e.payload.i), Array.from({ length: 50 }, (_, i) => i));
    assert.deepEqual(replayed.map(e => e.seq), Array.from({ length: 50 }, (_, i) => i));
    assert.equal(new Set(replayed.map(e => e.id)).size, 50, 'ids stay unique within a millisecond');
  });

  test('the event is durable before subscribers run', () => {
    // Journal-before-deliver: a subscriber that kills the process must not
    // take the event with it.
    const bus = makeBus();
    let onDiskAtDeliveryTime = null;
    bus.subscribe('*', () => {
      onDiskAtDeliveryTime = fs.readFileSync(bus.segments()[0], 'utf-8');
    });
    bus.publish({ source: 'timer', kind: 'trigger', payload: { tag: 'durable' } });
    assert.ok(onDiskAtDeliveryTime?.includes('durable'),
      'the event must already be on disk when the first subscriber sees it');
  });

  test('a torn final line is skipped, not fatal', () => {
    // A daemon killed mid-append leaves a partial line. Replay must survive it.
    const bus = makeBus();
    bus.publish({ source: 'timer', kind: 'trigger', payload: { n: 1 } });
    fs.appendFileSync(bus.segments()[0], '{"id":"evt-trunc","ts":1,"kin');

    const replayed = makeBus().replay();
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].payload.n, 1);
  });

  test('journal:false keeps the bus entirely in memory', () => {
    const bus = new Bus({ journalDir: path.join(tmpHome, 'bus'), journal: false });
    const got = [];
    bus.subscribe('*', e => got.push(e));
    bus.publish({ source: 'timer', kind: 'trigger', payload: {} });
    assert.equal(got.length, 1);
    assert.deepEqual(bus.segments(), [], 'nothing should have been written');
  });

  test('a journal write failure does not stop in-process delivery', () => {
    // Disk full at 3am must degrade, not decapitate.
    const errors = [];
    const bus = new Bus({
      journalDir: path.join(tmpHome, 'bus'),
      onError: (err, evt, where) => errors.push(where),
    });
    const got = [];
    bus.subscribe('*', e => got.push(e));
    // Point the journal at a path that cannot be a directory.
    const blocker = path.join(tmpHome, 'blocked');
    fs.writeFileSync(blocker, 'not a directory');
    bus._journalDir = path.join(blocker, 'bus');

    bus.publish({ source: 'timer', kind: 'trigger', payload: {} });
    assert.equal(got.length, 1, 'delivery continues');
    assert.deepEqual(errors, ['journal'], 'and the failure is reported, not swallowed');
  });
});

describe('replay filters', () => {
  function seed() {
    const bus = makeBus({ now: () => 1_700_000_000_000 });
    bus.publish({ source: 'user.cli', kind: 'utterance', sessionId: 's-1', payload: { n: 1 } });
    bus.publish({ source: 'mission', kind: 'mission_update', sessionId: 's-1', payload: { n: 2 } });
    bus.publish({ source: 'mission', kind: 'mission_update', sessionId: 's-2', payload: { n: 3 } });
    bus.publish({ source: 'timer', kind: 'trigger', payload: { n: 4 } });
    return bus;
  }

  test('filter by kind', () => {
    seed();
    const got = makeBus().replay({ kinds: ['mission_update'] });
    assert.deepEqual(got.map(e => e.payload.n), [2, 3]);
  });

  test('filter by session', () => {
    seed();
    const got = makeBus().replay({ sessionId: 's-1' });
    assert.deepEqual(got.map(e => e.payload.n), [1, 2]);
  });

  test('afterId resumes a stream exactly once — no duplicate, no gap', () => {
    // This is how a reconnecting TUI catches up. Off-by-one here means either
    // a replayed duplicate or a silently dropped event.
    const bus = seed();
    const all = makeBus().replay();
    const got = makeBus().replay({ afterId: all[1].id });
    assert.deepEqual(got.map(e => e.payload.n), [3, 4]);
  });

  test('an unknown afterId yields nothing rather than everything', () => {
    // Failing open here would re-deliver the entire history to a client that
    // asked for "just what I missed".
    seed();
    assert.deepEqual(makeBus().replay({ afterId: 'evt-nonexistent' }), []);
  });

  test('limit returns the most recent N', () => {
    seed();
    const got = makeBus().replay({ limit: 2 });
    assert.deepEqual(got.map(e => e.payload.n), [3, 4]);
  });

  test('sinceTs filters by wall clock', () => {
    const bus = makeBus();
    let clock = 1000;
    bus._now = () => clock;
    bus.publish({ source: 'timer', kind: 'trigger', payload: { n: 1 } });
    clock = 5000;
    bus.publish({ source: 'timer', kind: 'trigger', payload: { n: 2 } });
    assert.deepEqual(makeBus().replay({ sinceTs: 2000 }).map(e => e.payload.n), [2]);
  });
});

describe('rotation and retention (S2)', () => {
  test('segments roll over at the size cap', () => {
    const bus = makeBus({ maxSegmentBytes: 400, now: () => 1_700_000_000_000 });
    for (let i = 0; i < 20; i++) {
      bus.publish({ source: 'mission', kind: 'mission_update', payload: { pad: 'x'.repeat(50), i } });
    }
    const segs = bus.segments();
    assert.ok(segs.length > 1, `expected rotation, got ${segs.length} segment(s)`);
    for (const s of segs) {
      assert.ok(fs.statSync(s).size <= 400 + 512, `segment ${path.basename(s)} respects the cap`);
    }
  });

  test('rotation preserves order across segments', () => {
    const bus = makeBus({ maxSegmentBytes: 400, now: () => 1_700_000_000_000 });
    for (let i = 0; i < 20; i++) {
      bus.publish({ source: 'mission', kind: 'mission_update', payload: { pad: 'x'.repeat(50), i } });
    }
    const replayed = makeBus().replay();
    assert.deepEqual(replayed.map(e => e.payload.i), Array.from({ length: 20 }, (_, i) => i));
  });

  test('segments beyond the retention window are pruned; recent ones are kept', () => {
    const bus = makeBus();
    const day = 86_400_000;
    const now = 1_700_000_000_000;

    bus._now = () => now - 40 * day;
    bus.publish({ source: 'timer', kind: 'trigger', payload: { age: 'old' } });
    bus._now = () => now;
    bus.publish({ source: 'timer', kind: 'trigger', payload: { age: 'new' } });

    assert.equal(bus.segments().length, 2);
    const deleted = bus.prune({ retentionDays: 30, now });
    assert.equal(deleted.length, 1);
    assert.deepEqual(makeBus().replay().map(e => e.payload.age), ['new']);
  });

  test('journalBytes reports total size for the disk-quota watcher', () => {
    const bus = makeBus();
    assert.equal(bus.journalBytes(), 0);
    bus.publish({ source: 'timer', kind: 'trigger', payload: {} });
    assert.ok(bus.journalBytes() > 0);
  });
});

describe('process-wide bus accessor', () => {
  test('getBus returns one instance; resetBus clears it', () => {
    const a = getBus({ journal: false });
    assert.equal(getBus(), a, 'same instance within a process');
    resetBus();
    assert.notEqual(getBus({ journal: false }), a, 'reset mints a fresh one');
  });

  test('setBus injects a test double', () => {
    const fake = new Bus({ journal: false });
    setBus(fake);
    assert.equal(getBus(), fake);
  });

  test('resetBus closes the old bus so its subscribers stop firing', () => {
    // Leaked subscribers across tests are how "works alone, fails in the suite"
    // starts.
    const bus = getBus({ journal: false });
    let hits = 0;
    bus.subscribe('*', () => hits++);
    resetBus();
    assert.throws(() => bus.publish({ source: 'timer', kind: 'trigger', payload: {} }));
    assert.equal(hits, 0);
  });
});
