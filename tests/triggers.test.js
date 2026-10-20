// tests/triggers.test.js
// Phase 6 — proactivity: intents (6.3), scheduler (6.1), watchers (6.2),
// follow-ups (6.4), interruption etiquette (6.5).
//
// The acceptance criteria are two sentences, and both are about restraint as
// much as capability:
//
//   "watch the test suite on main and tell me if it breaks" works end-to-end
//   with zero human polling; nothing ever notifies more than its budget.
//
// The second is the one that keeps this system usable. An agent that can
// initiate contact and does so freely gets switched off, and then the genuinely
// urgent message never arrives either — so the budget tests are not edge cases,
// they are the point.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IntentLedger, DEFAULT_BUDGET, INTENT_KINDS } from '../src/triggers/intents.js';
import {
  TriggerScheduler, parseCron, cronMatches, nextCronTime, parseWhen,
} from '../src/triggers/scheduler.js';
import { WatcherRunner, PROBES, isHealthy } from '../src/triggers/watchers.js';
import { FollowUpLedger, FOLLOWUP_REASONS } from '../src/triggers/followups.js';
import {
  decideDelivery, inQuietHours, inferUserState, Outbox, DELIVERY,
} from '../src/triggers/etiquette.js';
import { Bus } from '../src/kernel/bus.js';
import { MemoryService } from '../src/memoryd/service.js';

let clock;
let ledger;
let tmp;

beforeEach(() => {
  clock = new Date('2026-07-01T09:00:00Z').getTime();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-trig-'));
  ledger = new IntentLedger({ filePath: path.join(tmp, 'intents.json'), now: () => clock });
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const minutes = (n) => n * 60_000;
const hours = (n) => n * 3_600_000;

// ── 6.3 ─────────────────────────────────────────────────────────────────────

describe('standing intents (6.3)', () => {
  test('an intent records what the user actually asked for', () => {
    const i = ledger.create({ kind: 'watch', description: 'tell me if the build breaks' });
    assert.equal(i.description, 'tell me if the build breaks');
    assert.equal(i.state, 'active');
    assert.deepEqual(i.budget, DEFAULT_BUDGET);
  });

  test('an intent without a description is rejected', () => {
    // The description IS the notification. An intent that fires with nothing to
    // say is a bug that only shows up at the worst moment.
    assert.throws(() => ledger.create({ kind: 'watch' }), /needs a description/);
  });

  test('an unknown kind is rejected', () => {
    assert.throws(() => ledger.create({ kind: 'telepathy', description: 'x' }), /unknown intent kind/);
    for (const k of INTENT_KINDS) {
      assert.doesNotThrow(() => ledger.create({ kind: k, description: `a ${k} intent` }));
    }
  });

  test('intents survive a restart', () => {
    const i = ledger.create({ kind: 'schedule', description: 'check the deploy' });
    const reborn = new IntentLedger({ filePath: path.join(tmp, 'intents.json'), now: () => clock });
    assert.equal(reborn.get(i.id).description, 'check the deploy');
  });

  test('the budget is a hard ceiling, not advice', () => {
    // The acceptance criterion: "nothing ever notifies more than its budget".
    const i = ledger.create({ kind: 'watch', description: 'noisy thing', budget: { max: 3, windowMs: hours(1) } });
    const results = [];
    for (let n = 0; n < 10; n++) results.push(ledger.claimNotification(i.id).ok);

    assert.deepEqual(results, [true, true, true, false, false, false, false, false, false, false]);
    assert.equal(ledger.get(i.id).notifyCount, 3);
    assert.equal(ledger.get(i.id).suppressedCount, 7, 'and the suppressions are counted, not hidden');
  });

  test('the budget window slides', () => {
    const i = ledger.create({ kind: 'watch', description: 'x', budget: { max: 2, windowMs: hours(1) } });
    assert.equal(ledger.claimNotification(i.id).ok, true);
    assert.equal(ledger.claimNotification(i.id).ok, true);
    assert.equal(ledger.claimNotification(i.id).ok, false);

    clock += hours(1) + 1;
    assert.equal(ledger.claimNotification(i.id).ok, true, 'the window moved on');
  });

  test('max: 0 means never notify, and there is no way to say unlimited', () => {
    const i = ledger.create({ kind: 'watch', description: 'silent', budget: { max: 0, windowMs: hours(1) } });
    assert.equal(ledger.claimNotification(i.id).ok, false);
  });

  test('the refusal explains itself in the user\'s terms', () => {
    const i = ledger.create({ kind: 'watch', description: 'x', budget: { max: 1, windowMs: minutes(30) } });
    ledger.claimNotification(i.id);
    const denied = ledger.claimNotification(i.id);
    assert.match(denied.reason, /budget reached \(1 per 30m\)/);
  });

  test('timestamps do not accumulate forever in the persisted file', () => {
    // An intent alive for months would otherwise grow an unbounded array in a
    // file that is rewritten on every save.
    const i = ledger.create({ kind: 'watch', description: 'x', budget: { max: 1, windowMs: minutes(1) } });
    for (let n = 0; n < 200; n++) {
      clock += minutes(2);
      ledger.claimNotification(i.id);
    }
    assert.ok(ledger.get(i.id).notifications.length <= 2,
      `expected the window to prune, found ${ledger.get(i.id).notifications.length}`);
  });

  test('a paused or cancelled intent cannot notify', () => {
    const i = ledger.create({ kind: 'watch', description: 'x' });
    ledger.pause(i.id);
    assert.equal(ledger.claimNotification(i.id).ok, false);
    ledger.resume(i.id);
    assert.equal(ledger.claimNotification(i.id).ok, true);
    ledger.cancel(i.id);
    assert.equal(ledger.claimNotification(i.id).ok, false);
  });

  test('an expired intent stops firing and says so', () => {
    const i = ledger.create({ kind: 'watch', description: 'x', expiresAt: clock + hours(1) });
    clock += hours(2);
    const claim = ledger.claimNotification(i.id);
    assert.equal(claim.ok, false);
    assert.match(claim.reason, /expired/);
    assert.equal(ledger.get(i.id).state, 'expired');
  });

  test('firing publishes on the bus', () => {
    const bus = new Bus({ journal: false });
    const seen = [];
    bus.subscribe('trigger', e => seen.push(e.payload.action));
    const l = new IntentLedger({ filePath: path.join(tmp, 'b.json'), bus, now: () => clock });
    const i = l.create({ kind: 'watch', description: 'x', budget: { max: 1, windowMs: hours(1) } });
    l.claimNotification(i.id);
    l.claimNotification(i.id);
    assert.deepEqual(seen, ['created', 'fired', 'suppressed']);
  });

  test('a failing bus does not roll back a committed budget claim', () => {
    // If it did, the budget would stop being a ceiling.
    const broken = { publish() { throw new Error('bus down'); } };
    const l = new IntentLedger({ filePath: path.join(tmp, 'c.json'), bus: broken, now: () => clock });
    const i = l.create({ kind: 'watch', description: 'x', budget: { max: 1, windowMs: hours(1) } });
    assert.equal(l.claimNotification(i.id).ok, true);
    assert.equal(l.claimNotification(i.id).ok, false);
  });
});

// ── 6.1 ─────────────────────────────────────────────────────────────────────

describe('cron parsing (6.1)', () => {
  test('the basic shapes parse', () => {
    assert.doesNotThrow(() => parseCron('0 9 * * 1-5'));
    assert.doesNotThrow(() => parseCron('*/15 * * * *'));
    assert.doesNotThrow(() => parseCron('0 9,17 * * *'));
  });

  test('a malformed expression throws rather than silently never firing', () => {
    // The worst outcome for a typo'd schedule is silence: nothing looks broken.
    assert.throws(() => parseCron('0 9 * *'), /needs 5 fields/);
    assert.throws(() => parseCron('99 9 * * *'), /outside 0-59/);
    assert.throws(() => parseCron('0 25 * * *'), /outside 0-23/);
    assert.throws(() => parseCron('a 9 * * *'), /invalid minute/);
  });

  test('weekday-at-nine matches only weekdays at nine', () => {
    const f = parseCron('0 9 * * 1-5');
    assert.equal(cronMatches(f, new Date(2026, 6, 1, 9, 0)), true);   // Wednesday
    assert.equal(cronMatches(f, new Date(2026, 6, 1, 10, 0)), false);
    assert.equal(cronMatches(f, new Date(2026, 6, 4, 9, 0)), false);  // Saturday
  });

  test('when both day fields are restricted, EITHER matching fires', () => {
    // Standard cron semantics. Requiring both would make "the 1st, and Mondays"
    // mean "Mondays that fall on the 1st", which nobody means.
    const f = parseCron('0 9 1 * 1');
    assert.equal(cronMatches(f, new Date(2026, 6, 1, 9, 0)), true, 'the 1st');
    assert.equal(cronMatches(f, new Date(2026, 6, 6, 9, 0)), true, 'a Monday');
    assert.equal(cronMatches(f, new Date(2026, 6, 7, 9, 0)), false, 'neither');
  });

  test('nextCronTime finds the next slot', () => {
    const from = new Date(2026, 6, 1, 8, 0).getTime();
    assert.equal(nextCronTime('0 9 * * *', from), new Date(2026, 6, 1, 9, 0).getTime());
  });

  test('an impossible expression returns null instead of spinning', () => {
    assert.equal(nextCronTime('0 9 30 2 *', Date.now()), null, '30 February never comes');
  });
});

describe('the scheduler (6.1)', () => {
  function makeScheduler(onFire) {
    return new TriggerScheduler({ ledger, onFire, now: () => clock });
  }

  test('a one-shot fires once and retires', async () => {
    const fired = [];
    const s = makeScheduler(async (i) => fired.push(i.description));
    s.scheduleAt({ at: clock + minutes(10), description: 'check the deploy' });

    assert.deepEqual(await s.tick(), [], 'not yet');
    clock += minutes(11);
    assert.equal((await s.tick()).length, 1);
    assert.deepEqual(fired, ['check the deploy']);

    clock += hours(1);
    assert.deepEqual(await s.tick(), [], 'a one-shot does not fire twice');
  });

  test('a cron fires repeatedly', async () => {
    const s = makeScheduler();
    s.scheduleCron({ cron: '0 * * * *', description: 'hourly check' });
    let fires = 0;
    for (let h = 0; h < 5; h++) {
      clock += hours(1);
      fires += (await s.tick()).length;
    }
    assert.ok(fires >= 4, `expected roughly hourly fires, got ${fires}`);
  });

  test('a missed fire is delivered late, not skipped', async () => {
    // "Remind me at 9" means "make sure I know", not "make a sound at 09:00:00".
    // A laptop asleep at 9 must still say it at 10.
    const fired = [];
    const s = makeScheduler(async (i, meta) => fired.push(meta));
    s.scheduleAt({ at: clock + minutes(5), description: 'take the thing out of the oven' });

    clock += hours(3);   // the machine was asleep
    await s.tick();

    assert.equal(fired.length, 1);
    assert.equal(fired[0].late, true);
    assert.ok(fired[0].missedBy > hours(2));
  });

  test('a week of downtime collapses to ONE delivery, not 168', async () => {
    // The catch-up must not replay every missed slot.
    const s = makeScheduler();
    s.scheduleCron({ cron: '0 * * * *', description: 'hourly' });
    clock += 7 * 24 * hours(1);
    assert.equal((await s.tick()).length, 1);
  });

  test('a budget-blocked schedule still advances, or it re-fires forever', async () => {
    // Claiming before delivering is what prevents a suppressed cron from
    // hammering the tick loop every 30 seconds until the window rolls over.
    const s = makeScheduler();
    s.scheduleCron({ cron: '* * * * *', description: 'every minute', budget: { max: 1, windowMs: hours(1) } });

    let delivered = 0;
    for (let n = 0; n < 10; n++) {
      clock += minutes(1);
      delivered += (await s.tick()).length;
    }
    assert.equal(delivered, 1, 'the budget held');
    const intent = ledger.list({ kind: 'schedule' })[0];
    assert.ok(intent.condition.nextAt > clock, 'and the schedule kept moving');
  });

  test('a failing delivery does not stop the other due triggers', async () => {
    const seen = [];
    const s = new TriggerScheduler({
      ledger, now: () => clock,
      onFire: async (i) => { seen.push(i.description); if (i.description === 'boom') throw new Error('sink failed'); },
    });
    s.scheduleAt({ at: clock + 1, description: 'boom' });
    s.scheduleAt({ at: clock + 1, description: 'fine' });
    clock += minutes(1);
    await s.tick();
    assert.deepEqual(seen.sort(), ['boom', 'fine']);
  });

  test('an invalid cron is rejected at scheduling time', () => {
    const s = makeScheduler();
    assert.throws(() => s.scheduleCron({ cron: 'nonsense', description: 'x' }), /5 fields/);
    assert.throws(() => s.scheduleCron({ cron: '0 9 30 2 *', description: 'x' }), /never match/);
  });
});

describe('natural-language times (6.1)', () => {
  const base = new Date(2026, 6, 1, 9, 0).getTime();   // Wednesday 09:00

  test('relative offsets', () => {
    assert.equal(parseWhen('in 20 minutes', base).at, base + minutes(20));
    assert.equal(parseWhen('remind me in 2 hours', base).at, base + hours(2));
  });

  test('a named weekday means the NEXT one', () => {
    const r = parseWhen('remind me to check the deploy on friday', base);
    assert.equal(new Date(r.at).getDay(), 5);
    assert.ok(r.at > base);
  });

  test('the same weekday, later that day, means next week', () => {
    // Said on Wednesday afternoon, "Wednesday" is not four hours ago.
    const wedAfternoon = new Date(2026, 6, 1, 15, 0).getTime();
    const r = parseWhen('on wednesday at 9', wedAfternoon);
    assert.ok(r.at - wedAfternoon > 6 * 24 * hours(1));
  });

  test('repeating phrases become cron', () => {
    assert.equal(parseWhen('every weekday at 9', base).cron, '0 9 * * 1-5');
    assert.equal(parseWhen('every day at 6pm', base).cron, '0 18 * * *');
    assert.equal(parseWhen('every monday at 10:30', base).cron, '30 10 * * 1');
    assert.equal(parseWhen('hourly', base).cron, '0 * * * *');
  });

  test('a bare time is today if ahead, tomorrow if past', () => {
    assert.equal(new Date(parseWhen('at 5pm', base).at).getHours(), 17);
    const evening = new Date(2026, 6, 1, 20, 0).getTime();
    assert.ok(parseWhen('at 9am', evening).at > evening);
  });

  test('an unrecognised phrase returns null rather than guessing', () => {
    // Guessing at a time and being silently wrong is worse than asking.
    assert.equal(parseWhen('sometime soonish', base), null);
    assert.equal(parseWhen('', base), null);
  });
});

// ── 6.2 ─────────────────────────────────────────────────────────────────────

describe('watchers (6.2)', () => {
  /** A probe whose answer the test controls. */
  function scriptedProbes(states) {
    let i = 0;
    return { command: async () => ({ state: states[Math.min(i++, states.length - 1)], detail: {} }) };
  }

  test('the first poll establishes a baseline and says nothing', async () => {
    // Registering a watcher on an already-broken build must not fire
    // immediately — that reads as noise, not news.
    const observed = [];
    const r = new WatcherRunner({
      ledger, now: () => clock, probes: scriptedProbes(['exit:1']),
      onObserve: async (_i, o) => observed.push(o),
    });
    r.watch({ probe: 'command', config: {}, description: 'the suite' });
    assert.deepEqual(await r.tick(), []);
    assert.deepEqual(observed, []);
  });

  test('a transition fires exactly once, not every poll', async () => {
    // The core of the design: report the change, not the ongoing state.
    const r = new WatcherRunner({ ledger, now: () => clock, probes: scriptedProbes(['exit:0', 'exit:1', 'exit:1', 'exit:1']) });
    r.watch({ probe: 'command', config: {}, description: 'the suite' });

    assert.equal((await r.tick()).length, 0, 'baseline');
    assert.equal((await r.tick()).length, 1, 'it broke');
    assert.equal((await r.tick()).length, 0, 'still broken is not news');
    assert.equal((await r.tick()).length, 0);
  });

  test('notifyOn:failure ignores the recovery', async () => {
    const r = new WatcherRunner({ ledger, now: () => clock, probes: scriptedProbes(['exit:0', 'exit:1', 'exit:0']) });
    r.watch({ probe: 'command', config: {}, description: 'the suite', notifyOn: 'failure' });
    await r.tick();
    assert.equal((await r.tick()).length, 1, 'the break');
    assert.equal((await r.tick()).length, 0, 'the fix is not what was asked about');
  });

  test('notifyOn:recovery is the mirror image', async () => {
    const r = new WatcherRunner({ ledger, now: () => clock, probes: scriptedProbes(['exit:1', 'exit:0']) });
    r.watch({ probe: 'command', config: {}, description: 'the suite', notifyOn: 'recovery' });
    await r.tick();
    assert.equal((await r.tick()).length, 1);
  });

  test('observations are charged against the intent\'s budget', async () => {
    const r = new WatcherRunner({
      ledger, now: () => clock,
      probes: { command: async () => ({ state: `exit:${Math.floor(clock / 1000) % 2}`, detail: {} }) },
    });
    r.watch({ probe: 'command', config: {}, description: 'flapping', budget: { max: 2, windowMs: hours(1) } });

    let fired = 0;
    for (let n = 0; n < 10; n++) { clock += 1000; fired += (await r.tick()).length; }
    assert.equal(fired, 2, 'a flapping check cannot exceed its budget');
  });

  test('a throwing probe becomes a state, not a crash', async () => {
    const r = new WatcherRunner({
      ledger, now: () => clock,
      probes: { command: async () => { throw new Error('spawn failed'); } },
    });
    r.watch({ probe: 'command', config: {}, description: 'x' });
    await r.tick();
    assert.equal(ledger.list({ kind: 'watch' })[0].condition.lastState, 'probe_error');
  });

  test('an unknown probe kind is rejected at registration', () => {
    const r = new WatcherRunner({ ledger, now: () => clock });
    assert.throws(() => r.watch({ probe: 'telepathy', description: 'x' }), /unknown probe/);
  });

  test('the file probe notices content changes and deletion', async () => {
    const target = path.join(tmp, 'watched.txt');
    fs.writeFileSync(target, 'one');
    const a = await PROBES.file({ path: target });
    fs.writeFileSync(target, 'two');
    const b = await PROBES.file({ path: target });
    fs.rmSync(target);
    const c = await PROBES.file({ path: target });

    assert.notEqual(a.state, b.state);
    assert.equal(c.state, 'absent');
  });

  test('the directory probe notices an added file', async () => {
    const before = await PROBES.file({ path: tmp });
    fs.writeFileSync(path.join(tmp, 'new-file.txt'), 'x');
    const after = await PROBES.file({ path: tmp });
    assert.notEqual(before.state, after.state);
  });

  test('the command probe reports exit codes', async () => {
    const ok = await PROBES.command({ command: process.execPath, args: ['-e', 'process.exit(0)'] });
    const bad = await PROBES.command({ command: process.execPath, args: ['-e', 'process.exit(3)'] });
    assert.equal(ok.state, 'exit:0');
    assert.equal(bad.state, 'exit:3');
  });

  test('command output is NOT hashed by default', async () => {
    // Any timestamp or duration in the output would otherwise read as a change,
    // and the watcher becomes a metronome.
    const a = await PROBES.command({ command: process.execPath, args: ['-e', 'console.log(Date.now())'] });
    const b = await PROBES.command({ command: process.execPath, args: ['-e', 'console.log(Date.now())'] });
    assert.equal(a.state, b.state);
  });

  test('isHealthy classifies the states a user would call "working"', () => {
    for (const s of ['exit:0', 'http:200', 'http:301', 'present']) assert.equal(isHealthy(s), true, s);
    for (const s of ['exit:1', 'http:500', 'http:404', 'absent', 'unreachable', 'probe_error']) {
      assert.equal(isHealthy(s), false, s);
    }
  });
});

// ── 6.4 ─────────────────────────────────────────────────────────────────────

describe('follow-ups (6.4)', () => {
  let followups;
  beforeEach(() => { followups = new FollowUpLedger({ intents: ledger, now: () => clock }); });

  test('a completed mission needs no follow-up', () => {
    assert.equal(followups.onMissionEnded({ id: 'm-1', state: 'done', exitReason: 'completed', title: 't' }), null);
  });

  test('a mission the USER cancelled needs no follow-up', () => {
    // They stopped it on purpose. Resurfacing it would be nagging.
    assert.equal(followups.onMissionEnded({ id: 'm-1', state: 'cancelled', exitReason: 'interrupted', title: 't' }), null);
  });

  test('max_steps creates a resumable follow-up', () => {
    const i = followups.onMissionEnded({
      id: 'm-1', state: 'stopped', exitReason: 'max_steps', title: 'refactor the auth module', lastStep: 200,
    });
    assert.ok(i);
    assert.match(i.description, /ran out of steps/);
    assert.equal(i.condition.resumable, true);
    assert.equal(i.missionId, 'm-1');
  });

  test('every warranting exit reason is covered', () => {
    for (const reason of Object.keys(FOLLOWUP_REASONS)) {
      const i = followups.onMissionEnded({ id: `m-${reason}`, state: 'stopped', exitReason: reason, title: 'x' });
      assert.ok(i, `${reason} should create a follow-up`);
    }
  });

  test('the wording invites continuing, not giving up', () => {
    // "Ran out of steps" and "failed" describe the same event and produce very
    // different reactions.
    const i = followups.onMissionEnded({ id: 'm-1', state: 'stopped', exitReason: 'max_steps', title: 'x' });
    assert.ok(!/fail/i.test(i.description));
    assert.match(i.condition.suggestion, /resume/i);
  });

  test('a follow-up is mentioned exactly once', () => {
    const i = followups.onMissionEnded({ id: 'm-1', state: 'stopped', exitReason: 'max_steps', title: 'x' });
    assert.ok(followups.claim(i.id));
    assert.equal(followups.claim(i.id), null, 'a follow-up that repeats is nagging');
  });

  test('resuming a mission resolves its follow-up', () => {
    const i = followups.onMissionEnded({ id: 'm-1', state: 'stopped', exitReason: 'max_steps', title: 'x' });
    assert.deepEqual(followups.resolveForMission('m-1'), [i.id]);
    assert.deepEqual(followups.pending(), []);
  });

  test('follow-ups expire — after two weeks it is a decision, not a loose end', () => {
    followups.onMissionEnded({ id: 'm-1', state: 'stopped', exitReason: 'max_steps', title: 'x' });
    clock += 15 * 24 * hours(1);
    ledger.sweepExpired();
    assert.deepEqual(followups.pending(), []);
  });

  test('the stall is recorded in project memory, not global', () => {
    const mem = new MemoryService({ dbPath: ':memory:', now: () => clock });
    const f = new FollowUpLedger({ intents: ledger, memory: mem, now: () => clock });
    f.onMissionEnded({ id: 'm-1', state: 'stopped', exitReason: 'repair_stalled', title: 'the migration', workspace: '/tmp/proj', lastStep: 40 });

    assert.deepEqual(mem.list({ scope: 'global' }), [], 'a project\'s stall is not a fact about the user');
    assert.ok(mem.list({ limit: 10 }).some(r => /repair_stalled/.test(r.body)));
    mem.close();
  });

  test('rendering reads like a person wrote it', () => {
    assert.equal(followups.render(), '');
    followups.onMissionEnded({ id: 'm-1', state: 'stopped', exitReason: 'max_steps', title: 'refactor auth' });
    assert.match(followups.render(), /refactor auth.*ran out of steps.*You could resume/s);

    followups.onMissionEnded({ id: 'm-2', state: 'stopped', exitReason: 'interrupted', title: 'build the API' });
    assert.match(followups.render(), /^2 unfinished things:/);
  });
});

// ── 6.5 ─────────────────────────────────────────────────────────────────────

describe('interruption etiquette (6.5)', () => {
  test('urgent and present speaks immediately', () => {
    assert.equal(decideDelivery({ urgency: 'now', userState: 'active', hour: 14 }).delivery, 'speak');
  });

  test('quiet hours override everything short of an explicit override', () => {
    // The cost of a delayed "the build broke" is minutes. The cost of a 3am
    // interruption for it is that nobody trusts the system again.
    assert.equal(decideDelivery({ urgency: 'now', userState: 'active', hour: 3 }).delivery, 'queue');
    assert.equal(
      decideDelivery({ urgency: 'now', userState: 'active', hour: 3, policy: { urgentPiercesQuiet: true } }).delivery,
      'speak',
    );
  });

  test('being awake at 3am is not consent to be interrupted', () => {
    const d = decideDelivery({ urgency: 'soon', userState: 'active', hour: 2 });
    assert.equal(d.delivery, 'queue');
    assert.match(d.reason, /quiet hours/);
  });

  test('do-not-disturb defers everything except the urgent', () => {
    assert.equal(decideDelivery({ urgency: 'soon', userState: 'busy', hour: 14 }).delivery, 'queue');
    assert.equal(decideDelivery({ urgency: 'now', userState: 'busy', hour: 14 }).delivery, 'speak');
    assert.equal(
      decideDelivery({ urgency: 'now', userState: 'busy', hour: 14, policy: { urgentPiercesBusy: false } }).delivery,
      'queue',
    );
  });

  test('speaking to an empty room is not delivery', () => {
    // Even urgent items queue when nobody is attached. P8's phone channel is
    // what changes this answer, not a louder message to an unwatched terminal.
    assert.equal(decideDelivery({ urgency: 'now', userState: 'away', hour: 14 }).delivery, 'queue');
    assert.equal(decideDelivery({ urgency: 'whenever', userState: 'away', hour: 14 }).delivery, 'digest');
  });

  test('a "soon" item interrupts a conversation but not a train of thought', () => {
    assert.equal(decideDelivery({ urgency: 'soon', userState: 'active', hour: 14 }).delivery, 'speak');
    assert.equal(decideDelivery({ urgency: 'soon', userState: 'idle', hour: 14 }).delivery, 'queue');
  });

  test('"whenever" never interrupts, by definition', () => {
    for (const userState of ['active', 'idle', 'away']) {
      assert.notEqual(decideDelivery({ urgency: 'whenever', userState, hour: 14 }).delivery, 'speak');
    }
  });

  test('every decision is one of the declared deliveries, and has a reason', () => {
    for (const urgency of ['now', 'soon', 'whenever']) {
      for (const userState of ['active', 'idle', 'away', 'busy']) {
        for (const hour of [3, 9, 14, 23]) {
          const d = decideDelivery({ urgency, userState, hour });
          assert.ok(DELIVERY.includes(d.delivery), `${urgency}/${userState}/${hour} → ${d.delivery}`);
          assert.ok(d.reason.length > 0);
        }
      }
    }
  });

  test('quiet hours wrap midnight correctly', () => {
    assert.equal(inQuietHours(23, { start: 22, end: 8 }), true);
    assert.equal(inQuietHours(2, { start: 22, end: 8 }), true);
    assert.equal(inQuietHours(9, { start: 22, end: 8 }), false);
    assert.equal(inQuietHours(12, { start: 12, end: 12 }), false, 'an empty window is no quiet hours');
  });

  test('user state is inferred conservatively', () => {
    // Guessing someone is present and being wrong means interrupting a meeting.
    const now = clock;
    assert.equal(inferUserState({ clientAttached: false, now }), 'away');
    assert.equal(inferUserState({ clientAttached: true, lastSeenAt: now - 1000, now }), 'active');
    assert.equal(inferUserState({ clientAttached: true, lastSeenAt: now - hours(1), now }), 'idle');
    assert.equal(inferUserState({ clientAttached: true, doNotDisturb: true, now }), 'busy');
  });
});

describe('the outbox (6.5)', () => {
  function makeOutbox() { return new Outbox({ now: () => clock }); }

  test('queued items surface at the next interaction', () => {
    const o = makeOutbox();
    o.route({ text: 'the build broke', urgency: 'soon', createdAt: clock }, { userState: 'idle', hour: 14 });
    assert.equal(o.queuedCount, 1);
    assert.equal(o.drainQueued().length, 1);
    assert.equal(o.queuedCount, 0, 'draining empties it');
  });

  test('a digest groups repeats into one line with a count', () => {
    // Five "the build broke" lines is the failure mode a digest exists to fix.
    const o = makeOutbox();
    for (let n = 0; n < 5; n++) {
      o.route({ text: 'the build broke', urgency: 'whenever', intentId: 'i-1', createdAt: clock }, { userState: 'away', hour: 14 });
    }
    const text = o.drainDigest();
    assert.match(text, /×5/);
    assert.equal(text.split('\n').length, 2, 'one header, one line');
  });

  test('a single digest item is just the message', () => {
    const o = makeOutbox();
    o.route({ text: 'the docs were regenerated', urgency: 'whenever', createdAt: clock }, { userState: 'away', hour: 14 });
    assert.equal(o.drainDigest(), 'the docs were regenerated');
  });

  test('an empty digest renders nothing', () => {
    assert.equal(makeOutbox().drainDigest(), '');
  });

  test('the queue is bounded — a lifted do-not-disturb is not a wall of text', () => {
    const o = new Outbox({ now: () => clock, maxQueued: 5 });
    for (let n = 0; n < 50; n++) {
      o.route({ text: `item ${n}`, urgency: 'soon', createdAt: clock }, { userState: 'idle', hour: 14 });
    }
    assert.equal(o.queuedCount, 5);
    assert.equal(o.drainQueued().at(-1).text, 'item 49', 'and it keeps the most recent');
  });

  test('speak items are returned, not held', () => {
    const o = makeOutbox();
    const r = o.route({ text: 'urgent thing', urgency: 'now', createdAt: clock }, { userState: 'active', hour: 14 });
    assert.equal(r.delivery, 'speak');
    assert.equal(o.queuedCount, 0);
    assert.equal(o.digestCount, 0);
  });
});

// ── The acceptance criterion ────────────────────────────────────────────────

describe('"watch the test suite and tell me if it breaks" (the P6 criterion)', () => {
  test('end to end, with zero human polling and within budget', async () => {
    const outbox = new Outbox({ now: () => clock });
    const spoken = [];

    // A stand-in for the suite: passing, then broken, then still broken.
    let suiteState = 'exit:0';
    const runner = new WatcherRunner({
      ledger,
      now: () => clock,
      probes: { command: async () => ({ state: suiteState, detail: { code: suiteState === 'exit:0' ? 0 : 1 } }) },
      onObserve: async (intent, obs) => {
        const decision = outbox.route(
          { text: `${intent.description} — now ${obs.to}`, urgency: intent.urgency, intentId: intent.id, createdAt: clock },
          { userState: 'active', hour: 14 },
        );
        if (decision.delivery === 'speak') spoken.push(decision.item.text);
      },
    });

    runner.watch({
      probe: 'command',
      config: {},
      description: 'the test suite on main',
      notifyOn: 'failure',
      urgency: 'now',
    });

    await runner.tick();                       // baseline: silence
    assert.deepEqual(spoken, []);

    suiteState = 'exit:1';                     // it breaks
    clock += minutes(1);
    await runner.tick();
    assert.equal(spoken.length, 1);
    assert.match(spoken[0], /the test suite on main/);

    // …and stays broken for an hour of polling.
    for (let n = 0; n < 60; n++) { clock += minutes(1); await runner.tick(); }
    assert.equal(spoken.length, 1, 'still-broken is not news; it must not repeat');

    suiteState = 'exit:0';                     // it recovers
    clock += minutes(1);
    await runner.tick();
    assert.equal(spoken.length, 1, 'the user asked about breaks, not fixes');

    const intent = ledger.list({ kind: 'watch' })[0];
    assert.ok(intent.notifyCount <= intent.budget.max, 'nothing ever notifies more than its budget');
  });

  test('a flapping check cannot exceed its budget however hard it flaps', async () => {
    // The property that keeps the whole system usable.
    let flip = false;
    const runner = new WatcherRunner({
      ledger, now: () => clock,
      probes: { command: async () => { flip = !flip; return { state: flip ? 'exit:1' : 'exit:0', detail: {} }; } },
    });
    runner.watch({ probe: 'command', config: {}, description: 'a flapping check', budget: { max: 3, windowMs: hours(1) } });

    let fired = 0;
    for (let n = 0; n < 100; n++) { clock += 1000; fired += (await runner.tick()).length; }

    assert.equal(fired, 3);
    assert.ok(ledger.list({ kind: 'watch' })[0].suppressedCount > 50, 'and the suppressions are visible');
  });
});
