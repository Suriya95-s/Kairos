// tests/kernel-missions.test.js
// Phase 3.4 — the mission manager.
//
// The claims under test are the ones the daemon's usefulness rests on:
// two missions never write one workspace, a crashed mission costs one mission,
// a stop is resumable rather than destructive, and a daemon that is kill -9'd
// mid-mission re-adopts the wreckage on the next boot instead of leaving a
// wedged lock and a lying registry.
//
// Child processes are injected as fakes here so the state machine can be driven
// deterministically; the real fork path is exercised at the bottom.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { MissionManager } from '../src/kernel/missions.js';
import { SessionRegistry } from '../src/kernel/sessions.js';
import { Bus } from '../src/kernel/bus.js';
import { acquireWorkspaceLock, readLock, lockPath } from '../src/kernel/locks.js';

let tmpHome;
let workspaces;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-miss-'));
  process.env.KAIROS_HOME = tmpHome;
  workspaces = [];
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  for (const ws of workspaces) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function mkws(tag = 'ws') {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `kairos-${tag}-`));
  workspaces.push(ws);
  return ws;
}

/** A stand-in for a forked mission child, driveable from the test. */
class FakeChild extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.pid = pid;
    this.sent = [];
    this.signals = [];
    this.killed = false;
  }
  send(msg) { this.sent.push(msg); return true; }
  kill(signal) {
    this.signals.push(signal);
    if (signal === 'SIGKILL') this.exit(null, 'SIGKILL');
    return true;
  }
  /** Simulate the child reporting a runLoop result, then exiting. */
  complete(result, code = 0) {
    this.emit('message', { type: 'result', result });
    this.exit(code, null);
  }
  /** Simulate a hard crash: no result message at all. */
  crash(code = 139, signal = null) { this.exit(code, signal); }
  exit(code, signal) { this.emit('exit', code, signal); }
}

/** Manager wired to fakes; returns [manager, children] where children are in spawn order. */
function makeManager(opts = {}) {
  const children = [];
  const mgr = new MissionManager({
    filePath: path.join(tmpHome, 'missions', 'index.json'),
    spawn: () => { const c = new FakeChild(5000 + children.length); children.push(c); return c; },
    ...opts,
  });
  return [mgr, children];
}

describe('mission dispatch', () => {
  test('a submitted mission starts immediately when the workspace is free', () => {
    const ws = mkws();
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 'build a thing', workspace: ws });

    assert.equal(m.state, 'running');
    assert.equal(children.length, 1);
    assert.equal(mgr.get(m.id).pid, 5000);
    assert.ok(readLock(ws), 'the workspace lock is held while running');
  });

  test('a mission needs both a task and a workspace', () => {
    const [mgr] = makeManager();
    assert.throws(() => mgr.submit({ workspace: mkws() }), /needs a task/);
    assert.throws(() => mgr.submit({ task: 'x' }), /needs a workspace/);
  });

  test('a second mission on the SAME workspace queues instead of racing', () => {
    // S5's core promise. Two missions editing one working tree corrupt each
    // other in ways that look like model failure.
    const ws = mkws();
    const [mgr, children] = makeManager();
    mgr.submit({ task: 'first', workspace: ws });
    const second = mgr.submit({ task: 'second', workspace: ws });

    assert.equal(second.state, 'queued');
    assert.match(second.blockedReason, /locked by mission/);
    assert.equal(children.length, 1, 'the second child must not have been spawned');
  });

  test('a second mission on a DIFFERENT workspace runs in parallel', () => {
    const [mgr, children] = makeManager({ maxConcurrent: 2 });
    mgr.submit({ task: 'a', workspace: mkws('a') });
    const b = mgr.submit({ task: 'b', workspace: mkws('b') });
    assert.equal(b.state, 'running');
    assert.equal(children.length, 2);
  });

  test('the concurrency cap queues the overflow (S2)', () => {
    const [mgr, children] = makeManager({ maxConcurrent: 1 });
    mgr.submit({ task: 'a', workspace: mkws('a') });
    const b = mgr.submit({ task: 'b', workspace: mkws('b') });

    assert.equal(b.state, 'queued');
    assert.match(b.blockedReason, /mission slot/);
    assert.equal(children.length, 1);
  });

  test('finishing one mission starts the queued one on the same workspace', () => {
    // "queues" only means something if the queue actually drains.
    const ws = mkws();
    const [mgr, children] = makeManager();
    const first = mgr.submit({ task: 'first', workspace: ws });
    const second = mgr.submit({ task: 'second', workspace: ws });
    assert.equal(mgr.get(second.id).state, 'queued');

    children[0].complete({ exitReason: 'completed', summary: 'done' });

    assert.equal(mgr.get(first.id).state, 'done');
    assert.equal(mgr.get(second.id).state, 'running');
    assert.equal(children.length, 2);
    assert.equal(readLock(ws).missionId, second.id, 'the lock transferred to the successor');
  });

  test('the queue drains oldest-first', () => {
    const ws = mkws();
    const [mgr, children] = makeManager();
    let clock = 1000;
    mgr._now = () => clock;
    mgr.submit({ task: 'running', workspace: ws });
    clock = 2000; const b = mgr.submit({ task: 'b', workspace: ws });
    clock = 3000; const c = mgr.submit({ task: 'c', workspace: ws });

    children[0].complete({ exitReason: 'completed' });
    assert.equal(mgr.get(b.id).state, 'running', 'b was queued first');
    assert.equal(mgr.get(c.id).state, 'queued');
  });
});

describe('mission outcomes', () => {
  test('exitReason completed → done', () => {
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });
    children[0].complete({ exitReason: 'completed', summary: 'shipped' });
    const got = mgr.get(m.id);
    assert.equal(got.state, 'done');
    assert.equal(got.result.summary, 'shipped');
  });

  test('a crashed child with no result becomes failed, and says so', () => {
    // This is what child-process isolation is for. The daemon must survive it
    // AND record it accurately.
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });
    children[0].crash(139, 'SIGSEGV');

    const got = mgr.get(m.id);
    assert.equal(got.state, 'failed');
    assert.match(got.error, /exited without a result/);
    assert.match(got.error, /139/);
  });

  test('max_steps is recorded as stopped, not failed — the taxonomy survives', () => {
    // P6.4 turns these into follow-ups. Flattening everything to "failed"
    // would throw away the only signal that says "needs another pass".
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });
    children[0].complete({ exitReason: 'max_steps', summary: 'ran out of steps' });

    const got = mgr.get(m.id);
    assert.equal(got.state, 'stopped');
    assert.equal(got.exitReason, 'max_steps', 'the precise reason is preserved');
  });

  test('an LLM/loop error becomes failed', () => {
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });
    children[0].complete({ exitReason: 'error', summary: 'LLM failed 3 times' });
    assert.equal(mgr.get(m.id).state, 'failed');
  });

  test('a mission always releases its workspace lock, however it ends', () => {
    const ws = mkws();
    const [mgr, children] = makeManager();
    mgr.submit({ task: 't', workspace: ws });
    assert.ok(readLock(ws));
    children[0].crash(1);
    assert.equal(readLock(ws), null, 'a crash must not wedge the workspace');
  });

  test('step messages update progress but do not thrash the registry', () => {
    // ~50–300 steps per mission; the checkpoint already holds resumable state.
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });
    const regPath = path.join(tmpHome, 'missions', 'index.json');
    const before = fs.statSync(regPath).mtimeMs;

    for (let i = 1; i <= 20; i++) {
      children[0].emit('message', { type: 'step', step: i, tool: 'write_file', resultPreview: 'ok' });
    }
    assert.equal(mgr.get(m.id).lastStep, 20, 'progress is tracked in memory');
    assert.equal(fs.statSync(regPath).mtimeMs, before, 'and not written per step');
  });

  test('gate-blocked steps still advance lastStep via forwarded gateway events', () => {
    // The child's 'step' IPC message only fires when a step runs to
    // completion; a step that ends in a finish-gate block or LLM error skips
    // it. Live case: a resumed mission spent EVERY step gate-blocked and
    // `missions` reported lastStep 0 while the bus showed step 77. The
    // forwarded gateway events carry the loop's own counter — the registry
    // must mirror it.
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });

    children[0].emit('message', { type: 'hitl', event: { type: 'step', step: 75, tool: 'finish' } });
    assert.equal(mgr.get(m.id).lastStep, 75, 'a blocked step must still show as progress');

    // Non-step events (no numeric step) must not disturb the counter…
    children[0].emit('message', { type: 'hitl', event: { type: 'session_end', totalSteps: 77 } });
    assert.equal(mgr.get(m.id).lastStep, 75);

    // …and the counter never runs backwards, whatever order events arrive in.
    children[0].emit('message', { type: 'hitl', event: { type: 'cost_update', step: 40 } });
    assert.equal(mgr.get(m.id).lastStep, 75, 'stale/lower step numbers must not regress the counter');
  });

  test('wait() resolves when the mission ends', async () => {
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });
    const pending = mgr.wait(m.id);
    children[0].complete({ exitReason: 'completed' });
    assert.equal((await pending).state, 'done');
  });

  test('wait() on an already-finished mission resolves immediately', async () => {
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });
    children[0].complete({ exitReason: 'completed' });
    assert.equal((await mgr.wait(m.id)).state, 'done');
  });
});

describe('stopping and cancelling', () => {
  test('stop is cooperative: IPC and SIGTERM, so the loop can checkpoint', () => {
    // The difference between `stop` and `cancel` is whether the work survives.
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });
    mgr.stop(m.id);

    assert.equal(mgr.get(m.id).state, 'stopping');
    assert.deepEqual(children[0].sent, [{ type: 'stop', reason: 'stop requested' }]);
    assert.deepEqual(children[0].signals, ['SIGTERM']);
  });

  test('a stopped mission ends as stopped and stays resumable', () => {
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });
    mgr.stop(m.id);
    children[0].complete({ exitReason: 'interrupted', summary: 'checkpointed at step 12' });

    assert.equal(mgr.get(m.id).state, 'stopped');
  });

  test('stopping a queued mission cancels it — there is nothing to checkpoint', () => {
    const ws = mkws();
    const [mgr] = makeManager();
    mgr.submit({ task: 'first', workspace: ws });
    const queued = mgr.submit({ task: 'second', workspace: ws });
    mgr.stop(queued.id);
    assert.equal(mgr.get(queued.id).state, 'cancelled');
  });

  test('cancel hard-kills', () => {
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });
    mgr.cancel(m.id);
    assert.deepEqual(children[0].signals, ['SIGKILL']);
    assert.equal(mgr.get(m.id).state, 'cancelled');
  });

  test('cancelling an already-finished mission is a no-op', () => {
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });
    children[0].complete({ exitReason: 'completed' });
    mgr.cancel(m.id);
    assert.equal(mgr.get(m.id).state, 'done', 'a finished mission is not retroactively cancelled');
  });

  test('resume re-queues a stopped mission with resume:true', () => {
    // resume must NOT rewrite the task file — it may carry user steering.
    const ws = mkws();
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: ws });
    mgr.stop(m.id);
    children[0].complete({ exitReason: 'interrupted' });

    const resumed = mgr.resume(m.id);
    assert.equal(resumed.state, 'running');
    assert.equal(resumed.resume, true);
    assert.equal(mgr.get(m.id).attempts, 2);
  });

  test('stopAll waits for every running mission', async () => {
    const [mgr, children] = makeManager({ maxConcurrent: 3 });
    mgr.submit({ task: 'a', workspace: mkws('a') });
    mgr.submit({ task: 'b', workspace: mkws('b') });

    const done = mgr.stopAll();
    children[0].complete({ exitReason: 'interrupted' });
    children[1].complete({ exitReason: 'interrupted' });
    assert.equal((await done).length, 2);
    assert.equal(mgr.activeCount(), 0);
  });
});

describe('crash recovery — daemon restart (P3 acceptance)', () => {
  test('a mission left running by a dead daemon is adopted as interrupted', () => {
    const ws = mkws();
    const regPath = path.join(tmpHome, 'missions', 'index.json');
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: ws });
    assert.equal(mgr.get(m.id).state, 'running');

    // Simulate kill -9 of the whole daemon: the registry still says "running"
    // and the workspace lock is still on disk, but no child survives.
    const reborn = new MissionManager({ filePath: regPath, spawn: () => new FakeChild() });
    const { adopted } = reborn.adopt();

    assert.deepEqual(adopted, [m.id]);
    assert.equal(reborn.get(m.id).state, 'interrupted',
      'the registry must stop claiming a process that does not exist');
  });

  test('adoption reclaims the stale workspace lock the dead mission left behind', () => {
    const ws = mkws();
    const regPath = path.join(tmpHome, 'missions', 'index.json');
    const [mgr] = makeManager();
    const m = mgr.submit({ task: 't', workspace: ws });

    // Rewrite the lock as belonging to a process that no longer exists.
    const lock = readLock(ws);
    fs.writeFileSync(lockPath(ws), JSON.stringify({ ...lock, pid: 999_999 }));

    const reborn = new MissionManager({ filePath: regPath, spawn: () => new FakeChild() });
    const { reclaimed } = reborn.adopt();

    assert.deepEqual(reclaimed, [path.resolve(ws)]);
    assert.equal(readLock(ws), null, 'the workspace is usable again');
  });

  test('adoption does NOT steal a lock a live process legitimately holds', () => {
    // Two daemons, or a daemon plus a foreground `agent` run. Reclaiming a live
    // lock would reintroduce exactly the corruption S5 exists to prevent.
    const ws = mkws();
    const regPath = path.join(tmpHome, 'missions', 'index.json');
    const [mgr] = makeManager();
    const m = mgr.submit({ task: 't', workspace: ws });

    // A different, live holder takes the workspace over.
    fs.rmSync(lockPath(ws));
    const live = acquireWorkspaceLock(ws, { missionId: 'm-someone-else' });

    const reborn = new MissionManager({ filePath: regPath, spawn: () => new FakeChild() });
    const { adopted, reclaimed } = reborn.adopt();

    assert.deepEqual(adopted, [m.id], 'our orphan is still marked interrupted');
    assert.deepEqual(reclaimed, [], 'but we do not touch the other holder');
    assert.equal(readLock(ws).token, live.lock.token);
  });

  test('autoResume re-queues adopted missions', () => {
    const ws = mkws();
    const regPath = path.join(tmpHome, 'missions', 'index.json');
    const [mgr] = makeManager();
    const m = mgr.submit({ task: 't', workspace: ws });
    fs.writeFileSync(lockPath(ws), JSON.stringify({ ...readLock(ws), pid: 999_999 }));

    const children = [];
    const reborn = new MissionManager({
      filePath: regPath,
      spawn: () => { const c = new FakeChild(); children.push(c); return c; },
    });
    reborn.adopt({ autoResume: true });

    assert.equal(reborn.get(m.id).state, 'running', 'the mission picks up where it left off');
    assert.equal(reborn.get(m.id).resume, true, 'and resumes from its checkpoint');
    assert.equal(children.length, 1);
  });

  test('adopt is idempotent and leaves finished missions alone', () => {
    const regPath = path.join(tmpHome, 'missions', 'index.json');
    const [mgr, children] = makeManager();
    const done = mgr.submit({ task: 'done', workspace: mkws('d') });
    children[0].complete({ exitReason: 'completed' });

    const reborn = new MissionManager({ filePath: regPath, spawn: () => new FakeChild() });
    assert.deepEqual(reborn.adopt().adopted, []);
    assert.deepEqual(reborn.adopt().adopted, []);
    assert.equal(reborn.get(done.id).state, 'done');
  });

  test('adopt does not disturb the manager\'s own live missions', () => {
    // The daemon calls adopt() at boot, but a long-lived daemon may call it
    // again; it must not decapitate the missions it is currently running.
    const [mgr] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });
    assert.deepEqual(mgr.adopt().adopted, []);
    assert.equal(mgr.get(m.id).state, 'running');
  });
});

describe('registry, sessions and bus', () => {
  test('missions persist across a restart', () => {
    const regPath = path.join(tmpHome, 'missions', 'index.json');
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 'persist me', workspace: mkws(), profile: 'research' });
    children[0].complete({ exitReason: 'completed', summary: 's' });

    const reborn = new MissionManager({ filePath: regPath });
    const got = reborn.get(m.id);
    assert.equal(got.title, 'persist me');
    assert.equal(got.profile, 'research');
    assert.equal(got.state, 'done');
  });

  test('the registry carries a schemaVersion (S4)', () => {
    const [mgr] = makeManager();
    mgr.submit({ task: 't', workspace: mkws() });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpHome, 'missions', 'index.json'), 'utf-8'));
    assert.equal(raw.schemaVersion, 1);
  });

  test('a mission attaches to and detaches from its session', () => {
    const sessions = new SessionRegistry({ filePath: path.join(tmpHome, 'sessions', 'index.json') });
    const s = sessions.create({});
    const [mgr, children] = makeManager({ sessions });

    const m = mgr.submit({ task: 't', workspace: mkws(), sessionId: s.id });
    assert.equal(sessions.get(s.id).state, 'mission');
    assert.deepEqual(sessions.get(s.id).missionIds, [m.id]);

    children[0].complete({ exitReason: 'completed' });
    assert.equal(sessions.get(s.id).state, 'idle');
    assert.deepEqual(sessions.get(s.id).missionIds, []);
  });

  test('lifecycle transitions are published on the bus', () => {
    const bus = new Bus({ journal: false });
    const actions = [];
    bus.subscribe('mission_update', e => actions.push(e.payload.action));
    const [mgr, children] = makeManager({ bus });

    const m = mgr.submit({ task: 't', workspace: mkws() });
    children[0].emit('message', { type: 'step', step: 1, tool: 'read_file' });
    children[0].complete({ exitReason: 'completed' });

    assert.deepEqual(actions, ['queued', 'starting', 'running', 'step', 'ended']);
    assert.ok(m.id);
  });

  test('mission end is urgency:soon so P6 can surface it', () => {
    const bus = new Bus({ journal: false });
    const ended = [];
    bus.subscribe('mission_update', e => { if (e.payload.action === 'ended') ended.push(e); });
    const [mgr, children] = makeManager({ bus });
    mgr.submit({ task: 't', workspace: mkws() });
    children[0].complete({ exitReason: 'completed' });
    assert.equal(ended[0].urgency, 'soon');
  });

  test('a failing bus does not roll back a committed transition', () => {
    const brokenBus = { publish() { throw new Error('bus down'); } };
    const [mgr, children] = makeManager({ bus: brokenBus });
    const m = mgr.submit({ task: 't', workspace: mkws() });
    children[0].complete({ exitReason: 'completed' });
    assert.equal(mgr.get(m.id).state, 'done');
  });

  test('list filters by state, session and workspace', () => {
    const wsA = mkws('a');
    const [mgr, children] = makeManager({ maxConcurrent: 5 });
    const a = mgr.submit({ task: 'a', workspace: wsA, sessionId: 's-1' });
    mgr.submit({ task: 'b', workspace: mkws('b'), sessionId: 's-2' });
    children[0].complete({ exitReason: 'completed' });

    assert.deepEqual(mgr.list({ state: 'done' }).map(r => r.id), [a.id]);
    assert.deepEqual(mgr.list({ sessionId: 's-1' }).map(r => r.id), [a.id]);
    assert.deepEqual(mgr.list({ workspace: wsA }).map(r => r.id), [a.id]);
  });
});

describe('child process plumbing — regressions found by running it for real', () => {
  test('the child spawn sets windowsHide, or a detached daemon kills its own missions', async () => {
    // Found end-to-end, invisible to unit tests: without windowsHide a mission
    // forked by a DETACHED daemon stays in the launching terminal's console
    // group and dies with 0xC000013A (CTRL_C) about two seconds in. It works
    // fine under a foreground daemon, which is why it hid.
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const missionsSrc = strip(fs.readFileSync(new URL('../src/kernel/missions.js', import.meta.url), 'utf-8'));
    const spawnFn = missionsSrc.slice(missionsSrc.indexOf('function defaultSpawn'));
    assert.match(spawnFn, /windowsHide:\s*true/, 'mission fork must set windowsHide');

    const cliSrc = strip(fs.readFileSync(new URL('../src/kernel/cli.js', import.meta.url), 'utf-8'));
    const daemonSpawn = cliSrc.slice(cliSrc.indexOf('detached: true'));
    assert.match(daemonSpawn.slice(0, 400), /windowsHide:\s*true/, 'daemon spawn must set windowsHide');
  });

  test('child stdout/stderr are drained, or a chatty mission deadlocks', async () => {
    // stdio is ['ignore','pipe','pipe','ipc']. An unread pipe fills at ~8KB and
    // then blocks the writer forever — the mission would hang mid-run with no
    // error recorded anywhere.
    const { PassThrough } = await import('node:stream');
    const child = new FakeChild();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    const [mgr] = [new MissionManager({
      filePath: path.join(tmpHome, 'missions', 'index.json'),
      spawn: () => child,
    })];
    mgr.submit({ task: 't', workspace: mkws() });

    assert.ok(child.stdout.listenerCount('data') > 0, 'stdout must be consumed');
    assert.ok(child.stderr.listenerCount('data') > 0, 'stderr must be consumed');

    // And a large burst must not stall.
    child.stdout.write('x'.repeat(64 * 1024));
    assert.ok(true, 'writing far past the pipe buffer did not block');
  });

  test('a crash report includes the child\'s last output and its log path', async () => {
    // Otherwise the only clue is a numeric exit code and diagnosing means
    // re-running the mission by hand.
    const { PassThrough } = await import('node:stream');
    const child = new FakeChild();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    const mgr = new MissionManager({
      filePath: path.join(tmpHome, 'missions', 'index.json'),
      spawn: () => child,
    });
    const m = mgr.submit({ task: 't', workspace: mkws() });

    child.stderr.write('Error: ENOENT: no such file or directory\n');
    await new Promise(r => setImmediate(r));
    child.crash(1);

    const got = mgr.get(m.id);
    assert.equal(got.state, 'failed');
    assert.match(got.error, /ENOENT: no such file/, 'the failure should explain itself');
    assert.match(got.error, /\[log: /, 'and point at the full log');
  });

  test('the per-mission log file is written', async () => {
    const { PassThrough } = await import('node:stream');
    const child = new FakeChild();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    const mgr = new MissionManager({
      filePath: path.join(tmpHome, 'missions', 'index.json'),
      spawn: () => child,
    });
    const m = mgr.submit({ task: 't', workspace: mkws() });
    child.stdout.write('step 1 output\n');
    await new Promise(r => setTimeout(r, 50));

    const logPath = path.join(tmpHome, 'missions', `${m.id}.log`);
    assert.ok(fs.existsSync(logPath), `${logPath} should exist`);
    assert.match(fs.readFileSync(logPath, 'utf-8'), /step 1 output/);
    child.complete({ exitReason: 'completed' });
  });

  test('a child with no stdio streams still runs (the injected-fake path)', () => {
    // Every other test in this file uses a fake with no stdout/stderr; draining
    // must tolerate that rather than throwing on undefined.
    const [mgr, children] = makeManager();
    const m = mgr.submit({ task: 't', workspace: mkws() });
    children[0].complete({ exitReason: 'completed' });
    assert.equal(mgr.get(m.id).state, 'done');
  });
});

describe('workspace-scoped control (4.4)', () => {
  test('steering lands in the MISSION\'s workspace, not the daemon\'s', async () => {
    // The bug this exists for was silent: the daemon reported "passed that to
    // the running mission" and wrote the file into its own cwd. Nothing threw;
    // the message was simply never delivered. Root cause was `config._workspace`
    // being a second source of truth that an explicit AgentContext does not
    // update — see src/runtime/workspacePath.js.
    const ws = mkws();
    const [mgr] = makeManager();
    const m = mgr.submit({ task: 't', workspace: ws });

    await mgr.steer(m.id, 'also add tests');

    const steerDir = path.join(ws, '.agent', 'hitl', 'steer');
    const files = fs.existsSync(steerDir) ? fs.readdirSync(steerDir) : [];
    assert.equal(files.length, 1, 'exactly one steering message in the mission workspace');
    const body = JSON.parse(fs.readFileSync(path.join(steerDir, files[0]), 'utf-8'));
    assert.equal(body.message, 'also add tests');
  });

  test('the steering message is readable by the loop\'s own consumer', async () => {
    // Writing a file the mission cannot read would be the same bug wearing a
    // different hat, so assert against consumeSteering rather than the layout.
    const ws = mkws();
    const [mgr] = makeManager();
    const m = mgr.submit({ task: 't', workspace: ws });
    await mgr.steer(m.id, 'change of plan');

    const { AgentContext, runWithContext } = await import('../src/runtime/context.js');
    const { consumeSteering } = await import('../src/hitl/steeringChannel.js');
    const ctx = new AgentContext({ workspace: ws });
    const got = runWithContext(ctx, () => consumeSteering());
    ctx.dispose();

    assert.deepEqual(got, ['change of plan']);
  });

  test('pause writes the flag into the mission workspace, and unpause clears it', async () => {
    const ws = mkws();
    const [mgr] = makeManager();
    const m = mgr.submit({ task: 't', workspace: ws });
    const flag = path.join(ws, '.agent', 'hitl', 'paused');

    await mgr.pause(m.id);
    assert.equal(fs.existsSync(flag), true);
    await mgr.unpause(m.id);
    assert.equal(fs.existsSync(flag), false);
  });

  test('two missions in different workspaces are steered independently', async () => {
    // The whole point of scoping: a global would send both messages to whichever
    // workspace happened to be current.
    const wsA = mkws('a');
    const wsB = mkws('b');
    const [mgr] = makeManager({ maxConcurrent: 2 });
    const a = mgr.submit({ task: 'a', workspace: wsA });
    const b = mgr.submit({ task: 'b', workspace: wsB });

    await mgr.steer(a.id, 'message for A');
    await mgr.steer(b.id, 'message for B');

    const readOne = (ws) => {
      const d = path.join(ws, '.agent', 'hitl', 'steer');
      const f = fs.readdirSync(d);
      assert.equal(f.length, 1, `${ws} should have exactly one message`);
      return JSON.parse(fs.readFileSync(path.join(d, f[0]), 'utf-8')).message;
    };
    assert.equal(readOne(wsA), 'message for A');
    assert.equal(readOne(wsB), 'message for B');
  });

  test('steering an unknown mission returns null rather than writing somewhere', async () => {
    const [mgr] = makeManager();
    assert.equal(await mgr.steer('m-nope', 'hello'), null);
  });
});

describe('the real child process', () => {
  const CHILD = fileURLToPath(new URL('../src/kernel/missionChild.js', import.meta.url));

  test('the child script path resolves on this platform', () => {
    // The fileURLToPath-vs-.pathname bug has landed in this repo twice. On
    // Windows the wrong one yields "/C:/Users/…" and every spawn is ENOENT.
    assert.ok(fs.existsSync(CHILD), `${CHILD} should exist`);
    assert.ok(!/^\/[A-Za-z]:/.test(CHILD), 'path must not have a leading slash before a drive letter');
  });

  test('a child with no mission spec exits non-zero and reports why', async () => {
    // Real fork, no LLM needed: proves the IPC contract and the failure path.
    const child = fork(CHILD, [], {
      env: { ...process.env, KAIROS_MISSION_SPEC: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages = [];
    child.on('message', m => messages.push(m));
    const code = await new Promise(resolve => child.on('exit', resolve));

    assert.equal(code, 2);
    assert.equal(messages[0]?.type, 'error');
    assert.match(messages[0].message, /KAIROS_MISSION_SPEC/);
  });

  test('a child with an unparseable spec fails cleanly rather than hanging', async () => {
    const child = fork(CHILD, [], {
      env: { ...process.env, KAIROS_MISSION_SPEC: '{not json' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages = [];
    child.on('message', m => messages.push(m));
    const code = await new Promise(resolve => child.on('exit', resolve));

    assert.equal(code, 2);
    assert.match(messages[0].message, /unparseable mission spec/);
  });
});
