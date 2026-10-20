// tests/tui-daemon-attach.test.js
// Phase 3.6 — the TUI becomes a client of the daemon.
//
// Two things must hold at once: attaching to a daemon works, and the pre-daemon
// single-run workflow keeps working exactly as before. The second is the one
// that breaks silently, so it gets as many tests as the first.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveBackend, daemonAvailable } from '../apps/tui/src/client/backend.js';
import { adaptDaemonEvent, daemonEventAdapter } from '../apps/tui/src/client/daemonEvents.js';

let tmpHome;
let projectRoot;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-tui-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-proj-'));
  process.env.KAIROS_HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  for (const d of [tmpHome, projectRoot]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

/** Write the run files a live daemon would publish. */
function fakeDaemonRunFiles({ pid = process.pid, port = 5181, token = 'tok-abc' } = {}) {
  const runDir = path.join(tmpHome, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'daemon.pid'), String(pid));
  fs.writeFileSync(path.join(runDir, 'daemon.port'), String(port));
  fs.writeFileSync(path.join(runDir, 'daemon.token'), token);
}

function fakeLegacyToken(value = 'legacy-token') {
  fs.mkdirSync(path.join(projectRoot, '.agent'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.agent', 'web-ui-token'), value);
}

describe('backend resolution', () => {
  test('with no daemon, auto resolves to the legacy single-run backend', () => {
    // The pre-daemon workflow must survive this upgrade untouched.
    fakeLegacyToken();
    const b = resolveBackend({ port: 5180, root: projectRoot });
    assert.equal(b.kind, 'legacy');
    assert.equal(b.port, 5180);
    assert.equal(b.token, 'legacy-token');
  });

  test('with a daemon running, auto attaches to it', () => {
    fakeDaemonRunFiles({ port: 5199, token: 'daemon-token' });
    const b = resolveBackend({ port: 5180, root: projectRoot });
    assert.equal(b.kind, 'daemon');
    assert.equal(b.port, 5199, 'the daemon port wins over the legacy default');
    assert.equal(b.token, 'daemon-token');
    assert.match(b.detail, /leaves missions running/);
  });

  test('--no-daemon forces the single-run backend even when a daemon is up', () => {
    // `agent "task"` in one terminal + TUI in another is still a valid workflow.
    fakeDaemonRunFiles();
    fakeLegacyToken();
    const b = resolveBackend({ port: 5180, root: projectRoot, prefer: 'legacy' });
    assert.equal(b.kind, 'legacy');
    assert.equal(b.port, 5180);
  });

  test('--daemon with no daemon says so instead of silently falling back', () => {
    // Falling back would connect to an equally empty port and show
    // "connecting…" forever — the user would debug the wrong thing.
    const b = resolveBackend({ port: 5180, root: projectRoot, prefer: 'daemon' });
    assert.equal(b.kind, 'daemon-missing');
    assert.match(b.detail, /kairosd start/);
  });

  test('a crashed daemon that left its port file behind is not treated as running', () => {
    // The stale-run-file trap: the port file exists, nobody is listening.
    fakeDaemonRunFiles({ pid: 999_999 });
    assert.equal(daemonAvailable(), false);
    assert.equal(resolveBackend({ port: 5180, root: projectRoot }).kind, 'legacy');
  });

  test('a partially-written run directory is not treated as running', () => {
    const runDir = path.join(tmpHome, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'daemon.pid'), String(process.pid));
    // No port, no token yet — mid-boot.
    assert.equal(daemonAvailable(), false);
  });

  test('the token is re-read rather than cached, so a daemon restart is survivable', () => {
    fakeDaemonRunFiles({ token: 'first-token' });
    assert.equal(resolveBackend({ port: 5180, root: projectRoot }).token, 'first-token');
    fakeDaemonRunFiles({ token: 'second-token' });
    assert.equal(resolveBackend({ port: 5180, root: projectRoot }).token, 'second-token');
  });
});

describe('event adaptation', () => {
  test('a forwarded gateway event passes through unchanged', () => {
    // The whole design: missions still emit the 16 native event types, the
    // kernel only wraps them, so the view layer needs no rewrite.
    const native = { type: 'tool_result', result: 'ok', error: false };
    const adapted = adaptDaemonEvent({
      kind: 'mission_update',
      payload: { action: 'hitl', missionId: 'm-1', event: native },
    });
    assert.equal(adapted.type, 'tool_result');
    assert.equal(adapted.result, 'ok');
    assert.equal(adapted.missionId, 'm-1', 'tagged so the view can attribute it');
  });

  test('a mission going running becomes session_start', () => {
    const a = adaptDaemonEvent({
      kind: 'mission_update',
      payload: { action: 'running', missionId: 'm-1', title: 'build a thing' },
    });
    assert.equal(a.type, 'session_start');
    assert.equal(a.task, 'build a thing');
    assert.equal(a.episodeId, 'm-1');
  });

  test('a mission ending becomes session_end carrying its exit reason', () => {
    const a = adaptDaemonEvent({
      kind: 'mission_update',
      payload: { action: 'ended', missionId: 'm-1', state: 'stopped', exitReason: 'max_steps', lastStep: 47 },
    });
    assert.equal(a.type, 'session_end');
    assert.equal(a.exitReason, 'max_steps', 'the taxonomy reaches the UI, not just "finished"');
    assert.equal(a.totalSteps, 47);
  });

  test('a blocked mission surfaces as a warning, not silence', () => {
    const a = adaptDaemonEvent({
      kind: 'mission_update',
      payload: { action: 'blocked', missionId: 'm-2', blockedReason: 'workspace is locked by mission m-1' },
    });
    assert.equal(a.type, 'notice');
    assert.equal(a.level, 'warn');
    assert.match(a.text, /locked by mission m-1/);
  });

  test('daemon health reaches the UI', () => {
    // A TUI that shows "connected" while the LLM endpoint is down is lying by
    // omission.
    const a = adaptDaemonEvent({ kind: 'health', payload: { state: 'degraded_llm', reason: 'unreachable' } });
    assert.equal(a.level, 'warn');
    assert.match(a.text, /degraded_llm/);

    const ok = adaptDaemonEvent({ kind: 'health', payload: { state: 'healthy' } });
    assert.equal(ok.level, 'info');
  });

  test('the daemon stopping is announced', () => {
    const a = adaptDaemonEvent({ kind: 'daemon_state', payload: { action: 'stopped', reason: 'SIGTERM received' } });
    assert.match(a.text, /daemon stopped: SIGTERM received/);
  });

  test('an utterance from another surface is echoed — one conversation, many clients', () => {
    const a = adaptDaemonEvent({ kind: 'utterance', sessionId: 's-1', payload: { text: 'hello' } });
    assert.equal(a.type, 'user_message');
    assert.equal(a.text, 'hello');
    assert.equal(a.sessionId, 's-1');
  });

  test('unknown kinds and malformed input are dropped, not crashed on', () => {
    assert.equal(adaptDaemonEvent(null), null);
    assert.equal(adaptDaemonEvent({}), null);
    assert.equal(adaptDaemonEvent({ kind: 'schedule_due', payload: {} }), null);
    assert.equal(adaptDaemonEvent({ kind: 'mission_update', payload: { action: 'starting' } }), null);
  });
});

describe('attaching to one mission', () => {
  test('with a missionId set, other missions are filtered out', () => {
    // Two concurrent missions interleaving into one step list would render as
    // nonsense — steps jumping between unrelated pieces of work.
    const seen = [];
    const handler = daemonEventAdapter(e => seen.push(e), { missionId: 'm-1' });

    handler({ kind: 'mission_update', payload: { action: 'step', missionId: 'm-1', step: 1, tool: 'read_file' } });
    handler({ kind: 'mission_update', payload: { action: 'step', missionId: 'm-2', step: 1, tool: 'write_file' } });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].tool, 'read_file');
  });

  test('with no missionId, every mission is followed', () => {
    const seen = [];
    const handler = daemonEventAdapter(e => seen.push(e));
    handler({ kind: 'mission_update', payload: { action: 'step', missionId: 'm-1', step: 1 } });
    handler({ kind: 'mission_update', payload: { action: 'step', missionId: 'm-2', step: 1 } });
    assert.equal(seen.length, 2);
  });

  test('non-mission events reach the UI regardless of attachment', () => {
    // Daemon health is not "another mission's" event; filtering it out would
    // hide an outage from an attached user.
    const seen = [];
    const handler = daemonEventAdapter(e => seen.push(e), { missionId: 'm-1' });
    handler({ kind: 'health', payload: { state: 'degraded_llm', reason: 'down' } });
    assert.equal(seen.length, 1);
  });

  test('the adapter never forwards a null to the view layer', () => {
    let calls = 0;
    const handler = daemonEventAdapter(() => calls++);
    handler({ kind: 'schedule_due', payload: {} });
    handler(null);
    assert.equal(calls, 0);
  });
});

describe('end-to-end shape against real bus events', () => {
  test('events published by the real mission manager adapt correctly', async () => {
    // Guards against the adapter drifting from what the kernel actually emits —
    // the failure mode a hand-written fixture would miss.
    const { Bus } = await import('../src/kernel/bus.js');
    const { MissionManager } = await import('../src/kernel/missions.js');
    const { EventEmitter } = await import('node:events');

    const bus = new Bus({ journal: false });
    const adapted = [];
    bus.subscribe('mission_update', daemonEventAdapter(e => adapted.push(e)));

    const children = [];
    const mgr = new MissionManager({
      filePath: path.join(tmpHome, 'missions', 'index.json'),
      bus,
      spawn: () => {
        const c = new EventEmitter();
        c.pid = 1; c.send = () => true; c.kill = () => true;
        children.push(c);
        return c;
      },
    });

    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-ws-'));
    try {
      mgr.submit({ task: 'real task', workspace: ws });
      children[0].emit('message', { type: 'step', step: 1, tool: 'read_file', resultPreview: 'ok' });
      children[0].emit('message', { type: 'result', result: { exitReason: 'completed' } });
      children[0].emit('exit', 0, null);

      const types = adapted.map(e => e.type);
      assert.ok(types.includes('session_start'), `expected session_start in ${types}`);
      assert.ok(types.includes('step'), `expected step in ${types}`);
      assert.ok(types.includes('session_end'), `expected session_end in ${types}`);

      const end = adapted.find(e => e.type === 'session_end');
      assert.equal(end.exitReason, 'completed');
    } finally {
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });
});
