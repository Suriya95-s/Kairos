// tests/kernel-sessions.test.js
// Phase 3.3 — the session registry, and Phase 3 / S5 — workspace locks.
//
// The claim these tests defend is "presence": a conversation survives the
// client closing, and survives the daemon dying. Plus the S5 claim: two
// missions never write the same workspace, and a hard-killed holder does not
// wedge that workspace forever.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionRegistry, SESSION_STATES, SYSTEM_SESSION_ID } from '../src/kernel/sessions.js';
import {
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  heartbeatLock,
  readLock,
  isStale,
  lockPath,
  withWorkspaceLock,
  DEFAULT_TTL_MS,
} from '../src/kernel/locks.js';
import { Bus } from '../src/kernel/bus.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-sess-'));
  process.env.KAIROS_HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* windows lock */ }
});

const regFile = () => path.join(tmpHome, 'sessions', 'index.json');

describe('session registry — basics', () => {
  test('a new registry always has the system session', () => {
    // Self-initiated work (timers, watchers) needs an owner from the first
    // boot, before any human has said anything.
    const reg = new SessionRegistry({ filePath: regFile() }).load();
    const sys = reg.get(SYSTEM_SESSION_ID);
    assert.ok(sys, 'system session must exist');
    assert.equal(sys.state, 'idle');
  });

  test('create returns a session with an id and idle state', () => {
    const reg = new SessionRegistry({ filePath: regFile() });
    const s = reg.create({ workspace: '/tmp/proj', clientKind: 'tui' });
    assert.match(s.id, /^s-/);
    assert.equal(s.state, 'idle');
    assert.deepEqual(s.missionIds, []);
    assert.equal(s.workspace, '/tmp/proj');
  });

  test('get returns a copy — mutating it cannot corrupt the registry', () => {
    const reg = new SessionRegistry({ filePath: regFile() });
    const s = reg.create({});
    const copy = reg.get(s.id);
    copy.state = 'mission';
    copy.missionIds.push('m-hack');
    assert.equal(reg.get(s.id).state, 'idle');
    assert.deepEqual(reg.get(s.id).missionIds, []);
  });

  test('updating an unknown session throws instead of silently doing nothing', () => {
    // A no-op here turns a routing bug into a mysterious delivery bug later.
    const reg = new SessionRegistry({ filePath: regFile() });
    assert.throws(() => reg.update('s-nope', { state: 'idle' }), /unknown session/);
  });

  test('an invalid state is rejected', () => {
    const reg = new SessionRegistry({ filePath: regFile() });
    const s = reg.create({});
    assert.throws(() => reg.update(s.id, { state: 'thinking' }), /invalid session state/);
    for (const st of SESSION_STATES) assert.doesNotThrow(() => reg.update(s.id, { state: st }));
  });

  test('id and createdAt cannot be patched', () => {
    const reg = new SessionRegistry({ filePath: regFile() });
    const s = reg.create({});
    reg.update(s.id, { id: 's-evil', createdAt: 0, title: 'ok' });
    const got = reg.get(s.id);
    assert.equal(got.id, s.id);
    assert.equal(got.createdAt, s.createdAt);
    assert.equal(got.title, 'ok');
  });

  test('list is newest-first and filterable by state', () => {
    let clock = 1000;
    const reg = new SessionRegistry({ filePath: regFile(), now: () => clock });
    const a = reg.create({ title: 'a' }); clock += 10;
    const b = reg.create({ title: 'b' }); clock += 10;
    reg.update(b.id, { state: 'reflex' });

    const ids = reg.list().map(s => s.id);
    assert.equal(ids[0], b.id, 'most recently updated first');
    assert.deepEqual(reg.list({ state: 'reflex' }).map(s => s.id), [b.id]);
    assert.ok(reg.list({ state: 'idle' }).some(s => s.id === a.id));
  });
});

describe('session registry — missions', () => {
  test('attaching a mission moves the session into the mission state', () => {
    const reg = new SessionRegistry({ filePath: regFile() });
    const s = reg.create({});
    const after = reg.attachMission(s.id, 'm-1');
    assert.equal(after.state, 'mission');
    assert.deepEqual(after.missionIds, ['m-1']);
  });

  test('attaching the same mission twice is idempotent', () => {
    const reg = new SessionRegistry({ filePath: regFile() });
    const s = reg.create({});
    reg.attachMission(s.id, 'm-1');
    reg.attachMission(s.id, 'm-1');
    assert.deepEqual(reg.get(s.id).missionIds, ['m-1']);
  });

  test('a session with two missions stays busy when one ends', () => {
    // The bug this prevents: the daemon reporting "idle" while a mission is
    // still writing files.
    const reg = new SessionRegistry({ filePath: regFile() });
    const s = reg.create({});
    reg.attachMission(s.id, 'm-1');
    reg.attachMission(s.id, 'm-2');

    assert.equal(reg.detachMission(s.id, 'm-1').state, 'mission', 'still running m-2');
    assert.equal(reg.detachMission(s.id, 'm-2').state, 'idle', 'now genuinely idle');
  });

  test('detaching a mission the session never had is harmless', () => {
    const reg = new SessionRegistry({ filePath: regFile() });
    const s = reg.create({});
    assert.doesNotThrow(() => reg.detachMission(s.id, 'm-ghost'));
  });
});

describe('session registry — presence across restarts', () => {
  test('sessions survive a daemon restart', () => {
    // This is the entire point of a presence kernel.
    const reg = new SessionRegistry({ filePath: regFile() });
    const s = reg.create({ workspace: '/tmp/proj', title: 'ongoing work' });
    reg.attachMission(s.id, 'm-1');

    const reborn = new SessionRegistry({ filePath: regFile() }).load();
    const got = reborn.get(s.id);
    assert.ok(got, 'session must survive');
    assert.equal(got.title, 'ongoing work');
    assert.equal(got.workspace, '/tmp/proj');
    assert.deepEqual(got.missionIds, ['m-1']);
  });

  test('the live client handle is NOT persisted', () => {
    // A serialized socket is a lie: after a restart the registry would claim a
    // connection that does not exist.
    const reg = new SessionRegistry({ filePath: regFile() });
    const socket = { write: () => {}, secret: 'live-handle' };
    const s = reg.create({ clientKind: 'tui', client: socket });
    assert.equal(reg.client(s.id), socket, 'held in memory while running');

    const onDisk = fs.readFileSync(regFile(), 'utf-8');
    assert.ok(!onDisk.includes('live-handle'), 'the handle must not reach disk');

    const reborn = new SessionRegistry({ filePath: regFile() }).load();
    assert.equal(reborn.client(s.id), null, 'no phantom client after restart');
    assert.equal(reborn.get(s.id).clientKind, 'tui', 'but we remember what kind it was');
  });

  test('detaching a client keeps the session alive', () => {
    // Closing the TUI must not end the conversation.
    const reg = new SessionRegistry({ filePath: regFile() });
    const s = reg.create({ clientKind: 'tui', client: {} });
    reg.detachClient(s.id);
    assert.ok(reg.get(s.id), 'session outlives its client');
    assert.equal(reg.client(s.id), null);
  });

  test('the registry file carries a schemaVersion (S4)', () => {
    const reg = new SessionRegistry({ filePath: regFile() });
    reg.create({});
    assert.equal(JSON.parse(fs.readFileSync(regFile(), 'utf-8')).schemaVersion, 1);
  });

  test('an unversioned legacy registry loads rather than being rejected', () => {
    fs.mkdirSync(path.dirname(regFile()), { recursive: true });
    fs.writeFileSync(regFile(), JSON.stringify({
      sessions: { 's-legacy': { state: 'idle', missionIds: [], createdAt: 1, updatedAt: 1 } },
    }));
    const reg = new SessionRegistry({ filePath: regFile() }).load();
    assert.ok(reg.get('s-legacy'), 'pre-versioning state must migrate forward');
  });

  test('a corrupt registry boots empty instead of bricking the daemon', () => {
    fs.mkdirSync(path.dirname(regFile()), { recursive: true });
    fs.writeFileSync(regFile(), '{"sessions": {');
    const reg = new SessionRegistry({ filePath: regFile() }).load();
    assert.ok(reg.get(SYSTEM_SESSION_ID), 'still boots');
    assert.ok(fs.existsSync(`${regFile()}.corrupt-1`), 'evidence preserved');
  });
});

describe('session registry — lifecycle and bus', () => {
  test('close marks the session rather than deleting its history', () => {
    const reg = new SessionRegistry({ filePath: regFile() });
    const s = reg.create({});
    reg.close(s.id);
    assert.equal(reg.get(s.id).state, 'closed', 'history stays resolvable');
  });

  test('the system session cannot be closed', () => {
    const reg = new SessionRegistry({ filePath: regFile() });
    assert.throws(() => reg.close(SYSTEM_SESSION_ID), /cannot be closed/);
  });

  test('purge removes only old closed sessions', () => {
    let clock = 1_000_000;
    const reg = new SessionRegistry({ filePath: regFile(), now: () => clock });
    const old = reg.create({ title: 'old' });
    const recent = reg.create({ title: 'recent' });
    const open = reg.create({ title: 'open' });
    reg.close(old.id);
    clock += 40 * 86_400_000;
    reg.close(recent.id);

    const removed = reg.purge({ olderThanMs: 30 * 86_400_000 });
    assert.deepEqual(removed, [old.id]);
    assert.ok(reg.get(recent.id), 'recently closed is kept');
    assert.ok(reg.get(open.id), 'open sessions are never purged');
  });

  test('mutations publish session_update events', () => {
    const bus = new Bus({ journal: false });
    const seen = [];
    bus.subscribe('session_update', e => seen.push(e.payload.action));
    const reg = new SessionRegistry({ filePath: regFile(), bus });
    const s = reg.create({});
    reg.attachMission(s.id, 'm-1');
    assert.deepEqual(seen, ['created', 'updated']);
  });

  test('a failing bus does not roll back a committed state change', () => {
    // The registry is the source of truth. Losing a notification is survivable;
    // losing the state change it described is not.
    const brokenBus = { publish() { throw new Error('bus down'); } };
    const reg = new SessionRegistry({ filePath: regFile(), bus: brokenBus });
    const s = reg.create({});
    assert.equal(reg.get(s.id).state, 'idle', 'the session was still created');
  });
});

// ── S5 ──────────────────────────────────────────────────────────────────────

describe('workspace locks (S5)', () => {
  let ws;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-ws-')); });
  afterEach(() => { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} });

  test('the first mission gets the lock', () => {
    const got = acquireWorkspaceLock(ws, { missionId: 'm-1' });
    assert.equal(got.ok, true);
    assert.equal(got.lock.missionId, 'm-1');
    assert.ok(fs.existsSync(lockPath(ws)));
  });

  test('a second mission is refused, with a reason naming the holder', () => {
    // "queues or fails fast with a clear reason" — the reason has to be
    // actionable, not "EEXIST".
    acquireWorkspaceLock(ws, { missionId: 'm-1' });
    const second = acquireWorkspaceLock(ws, { missionId: 'm-2' });
    assert.equal(second.ok, false);
    assert.match(second.reason, /locked by mission m-1/);
    assert.equal(second.heldBy.missionId, 'm-1');
  });

  test('releasing lets the next mission in', () => {
    const first = acquireWorkspaceLock(ws, { missionId: 'm-1' });
    assert.equal(releaseWorkspaceLock(ws, first.lock.token), true);
    assert.equal(acquireWorkspaceLock(ws, { missionId: 'm-2' }).ok, true);
  });

  test('only the holder may release', () => {
    // A mission that lost its lock to a reaper must not delete its successor's.
    const first = acquireWorkspaceLock(ws, { missionId: 'm-1' });
    assert.equal(releaseWorkspaceLock(ws, 'not-my-token'), false);
    assert.ok(readLock(ws), 'lock survives the impostor');
    assert.equal(releaseWorkspaceLock(ws, first.lock.token), true);
  });

  test('a lock held by a dead process is stolen immediately, not after the TTL', () => {
    // kill -9 is the failure this exists for. Waiting out a 15s TTL when the
    // holder is provably gone is pure dead time.
    const dead = { ...acquireWorkspaceLock(ws, { missionId: 'm-1' }).lock, pid: 999_999 };
    fs.writeFileSync(lockPath(ws), JSON.stringify(dead));

    const { stale, reason } = isStale(dead);
    assert.equal(stale, true);
    assert.match(reason, /pid 999999 is gone/);

    const second = acquireWorkspaceLock(ws, { missionId: 'm-2' });
    assert.equal(second.ok, true);
    assert.equal(second.lock.stoleFrom, 'm-1', 'the steal is recorded, not silent');
  });

  test('a live but hung holder keeps the lock until its heartbeat expires', () => {
    const first = acquireWorkspaceLock(ws, { missionId: 'm-1' });

    const justBefore = first.lock.heartbeatAt + DEFAULT_TTL_MS - 1;
    assert.equal(isStale(first.lock, { now: justBefore }).stale, false, 'still held');

    const justAfter = first.lock.heartbeatAt + DEFAULT_TTL_MS + 1;
    assert.equal(isStale(first.lock, { now: justAfter }).stale, true, 'now abandoned');
  });

  test('a heartbeat keeps the lock alive', () => {
    const first = acquireWorkspaceLock(ws, { missionId: 'm-1', now: 1000 });
    assert.equal(heartbeatLock(ws, first.lock.token, { now: 9000 }), true);
    assert.equal(readLock(ws).heartbeatAt, 9000);
    assert.equal(isStale(readLock(ws), { now: 9000 + DEFAULT_TTL_MS - 1 }).stale, false);
  });

  test('heartbeating a lock you no longer hold reports the loss', () => {
    // The caller must learn it lost the workspace, not retry into a conflict.
    const first = acquireWorkspaceLock(ws, { missionId: 'm-1' });
    fs.writeFileSync(lockPath(ws), JSON.stringify({ ...first.lock, token: 'someone-else' }));
    assert.equal(heartbeatLock(ws, first.lock.token), false);
  });

  test('a corrupt lock file is treated as free rather than wedging the workspace', () => {
    fs.mkdirSync(path.join(ws, '.agent'), { recursive: true });
    fs.writeFileSync(lockPath(ws), '{"token":');
    assert.equal(readLock(ws), null);
    assert.equal(acquireWorkspaceLock(ws, { missionId: 'm-1' }).ok, true);
  });

  test('withWorkspaceLock releases even when the body throws', () => {
    const ran = withWorkspaceLock(ws, { missionId: 'm-1' }, async () => { throw new Error('mission crashed'); });
    return ran.then(
      () => assert.fail('should have rejected'),
      () => { assert.equal(readLock(ws), null, 'lock released despite the crash'); },
    );
  });

  test('withWorkspaceLock refuses rather than running the body when held', () => {
    acquireWorkspaceLock(ws, { missionId: 'm-1' });
    let bodyRan = false;
    return withWorkspaceLock(ws, { missionId: 'm-2' }, async () => { bodyRan = true; })
      .then(res => {
        assert.equal(res.ok, false);
        assert.equal(bodyRan, false, 'the body must not run without the lock');
      });
  });

  test('acquire requires a missionId — an anonymous lock is unattributable', () => {
    assert.throws(() => acquireWorkspaceLock(ws, {}), /requires a missionId/);
  });
});
