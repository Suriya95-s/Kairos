// tests/kernel-daemon.test.js
// Phase 3.1 / 3.5 / 3.7 — the resident process, its client protocol, and the
// CLI control surface. Plus S2 (budgets, rotation) and S3 (degraded mode).
//
// The load-bearing claims: the daemon tells the truth about its own health,
// a budget breach pauses dispatch instead of killing work, the control plane
// is not open, and a reconnecting client gets exactly the events it missed.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { Daemon, DEFAULT_BUDGETS, HEALTH_STATES, autostartArtifact } from '../src/kernel/daemon.js';
import { DaemonServer } from '../src/kernel/server.js';
import { DaemonClient, discover, daemonPid } from '../src/kernel/client.js';
import { Bus } from '../src/kernel/bus.js';
import { SessionRegistry } from '../src/kernel/sessions.js';
import { MissionManager } from '../src/kernel/missions.js';
import { PID_FILE, TOKEN_FILE, PORT_FILE, DAEMON_STATE_FILE } from '../src/kernel/paths.js';

let tmpHome;
let workspaces;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-daemon-'));
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

class FakeChild extends EventEmitter {
  constructor() { super(); this.pid = 4242; this.sent = []; this.signals = []; }
  send(m) { this.sent.push(m); return true; }
  kill(s) { this.signals.push(s); if (s === 'SIGKILL') this.emit('exit', null, s); return true; }
  complete(result) { this.emit('message', { type: 'result', result }); this.emit('exit', 0, null); }
}

/** A daemon with no timers and an injectable LLM probe. */
function makeDaemon({ llmUp = true, budgets = {}, children = [] } = {}) {
  const bus = new Bus({ journal: false });
  const sessions = new SessionRegistry({ filePath: path.join(tmpHome, 'sessions', 'index.json'), bus });
  const missions = new MissionManager({
    filePath: path.join(tmpHome, 'missions', 'index.json'),
    bus,
    sessions,
    spawn: () => { const c = new FakeChild(); children.push(c); return c; },
  });
  const daemon = new Daemon({
    bus, sessions, missions, budgets, timers: false,
    llmProbe: async () => llmUp,
  });
  return daemon;
}

describe('daemon lifecycle', () => {
  test('start writes a pid file and reports itself running', async () => {
    const d = makeDaemon();
    const info = await d.start();
    assert.equal(info.pid, process.pid);
    assert.equal(fs.readFileSync(PID_FILE(), 'utf-8').trim(), String(process.pid));
    assert.equal(d.isRunning(), true);
    await d.stop();
  });

  test('a second daemon refuses to start over a live one', async () => {
    // Two daemons writing one registry is the corruption the whole kernel is
    // built to avoid; failing fast is the only safe answer.
    const first = makeDaemon();
    await first.start();

    // The pid file now holds OUR pid, which start() treats as "this is me".
    // Point it at a different, definitely-live process instead.
    const second = makeDaemon();
    second.readPid = () => (process.platform === 'win32' ? 4 : 1);

    await assert.rejects(() => second.start(), /already running/);
    await first.stop();
  });

  test('stop removes the pid file so the next start is clean', async () => {
    const d = makeDaemon();
    await d.start();
    await d.stop();
    assert.equal(fs.existsSync(PID_FILE()), false);
    assert.equal(d.health, 'stopped');
  });

  test('stop drains running missions so they checkpoint', async () => {
    const children = [];
    const d = makeDaemon({ children });
    await d.start();
    d.missions.submit({ task: 't', workspace: mkws() });

    const stopping = d.stop();
    assert.deepEqual(children[0].sent, [{ type: 'stop', reason: 'stop requested' }]);
    children[0].complete({ exitReason: 'interrupted' });
    await stopping;
    assert.equal(d.missions.activeCount(), 0);
  });

  test('state persists across a restart', async () => {
    const d = makeDaemon();
    await d.start();
    d.recordSpend(1.25);
    await d.stop();

    const raw = JSON.parse(fs.readFileSync(DAEMON_STATE_FILE(), 'utf-8'));
    assert.equal(raw.schemaVersion, 1);

    const reborn = makeDaemon();
    await reborn.start();
    assert.equal(reborn.spendToday(), 1.25, 'spend must survive a restart or the cap is meaningless');
    await reborn.stop();
  });

  test('boot re-adopts missions the previous daemon left running', async () => {
    // The P3 acceptance criterion, at the kernel level.
    const ws = mkws();
    const children = [];
    const d1 = makeDaemon({ children });
    await d1.start();
    const m = d1.missions.submit({ task: 't', workspace: ws });
    assert.equal(d1.missions.get(m.id).state, 'running');
    // No stop(): simulate kill -9 of the daemon itself.

    const d2 = makeDaemon();
    const info = await d2.start();
    assert.deepEqual(info.adoption.adopted, [m.id]);
    assert.equal(d2.missions.get(m.id).state, 'interrupted');
    await d2.stop();
  });
});

describe('health (S3)', () => {
  test('a reachable endpoint is healthy', async () => {
    const d = makeDaemon({ llmUp: true });
    await d.start();
    assert.equal(d.health, 'healthy');
    await d.stop();
  });

  test('an unreachable endpoint is degraded_llm, not silently healthy', async () => {
    // Jarvis at 3am with the endpoint down must say so.
    const d = makeDaemon({ llmUp: false });
    await d.start();
    assert.equal(d.health, 'degraded_llm');
    assert.match(d.healthReason, /unreachable/);
    await d.stop();
  });

  test('health recovers automatically when the endpoint returns', async () => {
    let up = false;
    const d = makeDaemon();
    d._llmProbe = async () => up;
    await d.start();
    assert.equal(d.health, 'degraded_llm');

    up = true;
    await d.tick();
    assert.equal(d.health, 'healthy');
    await d.stop();
  });

  test('a probe that throws is treated as down, not as a crash', async () => {
    const d = makeDaemon();
    d._llmProbe = async () => { throw new Error('ECONNREFUSED'); };
    await d.start();
    assert.equal(d.health, 'degraded_llm');
    await d.stop();
  });

  test('health transitions are published on the bus', async () => {
    const d = makeDaemon({ llmUp: false });
    const seen = [];
    d.bus.subscribe('health', e => seen.push(e.payload));
    await d.start();
    assert.ok(seen.some(h => h.state === 'degraded_llm'));
    assert.ok(seen.some(h => h.previous === 'starting'));
    await d.stop();
  });

  test('every health state is a declared one', async () => {
    const d = makeDaemon();
    assert.throws(() => d._setHealth('vibing', 'x'), /invalid health state/);
    assert.ok(HEALTH_STATES.includes('budget_hold'));
  });
});

describe('budgets and rotation (S2)', () => {
  test('spend accumulates per day', () => {
    const d = makeDaemon();
    d.recordSpend(0.5);
    d.recordSpend(0.25);
    assert.equal(d.spendToday(), 0.75);
  });

  test('nonsense spend values are ignored', () => {
    const d = makeDaemon();
    d.recordSpend(NaN);
    d.recordSpend(-5);
    d.recordSpend('abc');
    assert.equal(d.spendToday(), 0);
  });

  test('crossing the daily cap pauses dispatch rather than killing work', async () => {
    // A runaway loop must not be able to spend past the cap, but a mission
    // mid-write must not be decapitated either.
    const children = [];
    const d = makeDaemon({ budgets: { maxDollarsPerDay: 1 }, children });
    await d.start();
    d.missions.submit({ task: 'running', workspace: mkws('a') });

    d.recordSpend(1.5);
    assert.equal(d.health, 'budget_hold');
    assert.equal(d.missions.maxConcurrent, 0, 'no new missions start');
    assert.equal(d.missions.activeCount(), 1, 'the running one is left alone');

    const queued = d.missions.submit({ task: 'blocked', workspace: mkws('b') });
    assert.equal(d.missions.get(queued.id).state, 'queued');

    // Let the in-flight mission finish before shutdown drains it, otherwise the
    // fake child never exits and stop() waits forever.
    const stopping = d.stop();
    children[0].complete({ exitReason: 'interrupted' });
    await stopping;
  });

  test('budget_hold outranks a degraded endpoint in the reported health', async () => {
    // Reporting degraded_llm while actually paused for money sends the user to
    // debug the wrong system.
    const d = makeDaemon({ llmUp: false, budgets: { maxDollarsPerDay: 1 } });
    await d.start();
    d.recordSpend(2);
    await d.probeHealth();
    assert.equal(d.health, 'budget_hold');
    await d.stop();
  });

  test('raising the cap lifts the hold and restores dispatch', async () => {
    const d = makeDaemon({ budgets: { maxDollarsPerDay: 1 } });
    await d.start();
    d.recordSpend(2);
    assert.equal(d.health, 'budget_hold');

    d.budgets.maxDollarsPerDay = 100;
    assert.equal(await d.clearBudgetHold(), true);
    assert.equal(d.health, 'healthy');
    assert.equal(d.missions.maxConcurrent, DEFAULT_BUDGETS.maxConcurrentMissions);
    await d.stop();
  });

  test('an unbounded cap (0) never holds', () => {
    const d = makeDaemon({ budgets: { maxDollarsPerDay: 0 } });
    d.recordSpend(9999);
    assert.equal(d.isOverDailyBudget(), false);
  });

  test('the reflex rate limit is a sliding hour', () => {
    let clock = 1_000_000;
    const d = makeDaemon({ budgets: { maxReflexPerHour: 2 } });
    d._now = () => clock;
    assert.equal(d.allowReflexCall(), true);
    assert.equal(d.allowReflexCall(), true);
    assert.equal(d.allowReflexCall(), false, 'cap reached');

    clock += 3_600_001;
    assert.equal(d.allowReflexCall(), true, 'the window slid');
  });

  test('rotation prunes the journal past the retention window', async () => {
    const bus = new Bus({ journalDir: path.join(tmpHome, 'bus') });
    const d = makeDaemon();
    d.bus = bus;
    const day = 86_400_000;
    const now = Date.now();

    bus._now = () => now - 60 * day;
    bus.publish({ source: 'timer', kind: 'trigger', payload: { age: 'ancient' } });
    bus._now = () => now;
    bus.publish({ source: 'timer', kind: 'trigger', payload: { age: 'fresh' } });

    const { deleted } = d.rotate();
    assert.equal(deleted, 1);
    // Filter by kind: rotate() publishes its own `journal_pruned` daemon_state
    // event, which lands in the very journal being asserted on.
    assert.deepEqual(bus.replay({ kinds: ['trigger'] }).map(e => e.payload.age), ['fresh']);
  });

  test('crossing the disk warn ratio raises an event rather than failing silently', () => {
    const d = makeDaemon();
    d.budgets.diskQuotaBytes = 1;   // anything on disk exceeds 80% of 1 byte
    const warnings = [];
    d.bus.subscribe('daemon_state', e => { if (e.payload.action === 'disk_warning') warnings.push(e.payload); });
    fs.writeFileSync(path.join(tmpHome, 'ballast'), 'x'.repeat(500));

    const res = d.rotate();
    assert.equal(res.overQuota, true);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].bytes > 0);
  });
});

describe('autostart artifact', () => {
  test('the artifact matches this platform and names the daemon entry point', () => {
    const a = autostartArtifact({ script: '/opt/kairos/src/kernel/daemonMain.js' });
    assert.equal(a.platform, process.platform);
    assert.ok(a.content.includes('daemonMain.js'));
    assert.ok(a.command.length > 0);
    if (process.platform === 'win32') assert.equal(a.kind, 'schtasks');
  });

  test('generating never installs — enabling stays an explicit user action', () => {
    // Registering a login-time background process on someone's machine is not
    // a side effect an agent should have.
    const a = autostartArtifact();
    if (a.path) assert.equal(fs.existsSync(a.path), false, 'nothing written by generation alone');
  });
});

// ── Protocol ────────────────────────────────────────────────────────────────

describe('client protocol (3.5)', () => {
  let daemon, server, client, children;

  beforeEach(async () => {
    children = [];
    daemon = makeDaemon({ children });
    await daemon.start();
    server = new DaemonServer({ daemon, port: 0 });
    await server.listen();
    client = new DaemonClient();
  });

  afterEach(async () => {
    await server.close();
    await daemon.stop();
  });

  test('the port and token are discoverable from the run directory', () => {
    const conn = discover();
    assert.equal(conn.port, server.port);
    assert.equal(conn.token, server.token);
  });

  test('the token file is written 0600 where the OS honours it', () => {
    const mode = fs.statSync(TOKEN_FILE()).mode & 0o777;
    if (process.platform === 'win32') {
      // Windows reports 0666 regardless; the ACL is what actually protects it.
      assert.ok(mode > 0);
    } else {
      assert.equal(mode, 0o600, 'the control-plane token must not be world-readable');
    }
  });

  test('every route requires the token', async () => {
    // This control plane can start missions and (from P7) approve real-world
    // actions. There is no route that may be public.
    const base = `http://127.0.0.1:${server.port}`;
    for (const p of ['/api/status', '/api/missions', '/api/sessions', '/events', '/api/logs']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 401, `${p} must be authenticated`);
    }
  });

  test('a wrong token of the same length is rejected', async () => {
    const bogus = 'z'.repeat(server.token.length);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/status`, {
      headers: { Authorization: `Bearer ${bogus}` },
    });
    assert.equal(res.status, 401);
  });

  test('status round-trips through HTTP', async () => {
    const s = await client.status();
    assert.equal(s.health, 'healthy');
    assert.equal(s.pid, process.pid);
    assert.equal(s.missions.total, 0);
  });

  test('a mission can be submitted, listed, and stopped over HTTP', async () => {
    const ws = mkws();
    const { mission } = await client.submitMission({ task: 'do a thing', workspace: ws });
    assert.equal(mission.state, 'running');

    const { missions } = await client.missions();
    assert.equal(missions.length, 1);

    await client.stopMission(mission.id);
    assert.equal(daemon.missions.get(mission.id).state, 'stopping');
    children[0].complete({ exitReason: 'interrupted' });
  });

  test('submitting without a workspace is a 400, not a 500', async () => {
    await assert.rejects(
      () => client.submitMission({ task: 'no workspace' }),
      (err) => { assert.equal(err.status, 400); return true; },
    );
  });

  test('an unknown mission is a 404', async () => {
    await assert.rejects(
      () => client.mission('m-nope'),
      (err) => { assert.equal(err.status, 404); return true; },
    );
  });

  test('say records the utterance on the bus whatever the router concludes', async () => {
    // The publish is unconditional and happens first: the fact that the user
    // said something is history, and history must not depend on the router
    // having understood it.
    const utterances = [];
    daemon.bus.subscribe('utterance', e => utterances.push(e.payload.text));
    const res = await client.say({ text: 'build a REST API with Express', workspace: mkws() });

    assert.deepEqual(utterances, ['build a REST API with Express']);
    assert.ok(res.sessionId);
    assert.equal(res.action, 'started', 'a clearly mission-shaped ask starts one');
    assert.equal(res.intent, 'mission');

    // The mission is live; let it finish so the shared afterEach shutdown does
    // not wait on a fake child that will never exit.
    children[0].complete({ exitReason: 'completed' });
  });

  test('an unclear utterance is answered with a question, not a 400', async () => {
    // Changed deliberately in P4: before the router, anything without a
    // workspace was an HTTP error. Now it is a conversational turn — asking
    // "which project?" is an answer, not a protocol failure.
    const res = await client.say({ text: 'do something' });
    assert.equal(res.action, 'clarify');
    assert.match(res.text, /Which project/);
    assert.ok(res.sessionId, 'and the session still exists to continue in');
  });

  test('a question is answered without starting anything', async () => {
    const res = await client.say({
      text: 'what is a monad?',
      workspace: mkws(),
    });
    assert.equal(res.intent, 'reflex');
    assert.equal(res.mission, null, 'a question must never start a mission');
    assert.equal(children.length, 0);
  });

  test('sessions can be created, listed and closed', async () => {
    const { session } = await client.createSession({ workspace: mkws(), title: 'chat' });
    const { sessions } = await client.sessions();
    assert.ok(sessions.some(s => s.id === session.id));

    await client.closeSession(session.id);
    assert.equal(daemon.sessions.get(session.id).state, 'closed');
  });
});

// ── The graph plane over HTTP (G3) ──────────────────────────────────────────
// Degraded daemon on purpose: the graph ask must answer from the
// deterministic floor with the model down, and the whole path — router
// branch, real bus receipt, HTTP response — runs without a network.

describe('graph ask over HTTP (G3)', () => {
  let daemon, server, client, children;

  beforeEach(async () => {
    children = [];
    daemon = makeDaemon({ children, llmUp: false });
    await daemon.start();
    server = new DaemonServer({ daemon, port: 0 });
    await server.listen();
    client = new DaemonClient();
  });

  afterEach(async () => {
    await server.close();
    await daemon.stop();
  });

  test('"ask <domain>" answers from the graph — never a mission — with a bus receipt', async () => {
    // The regression this pins: the receipt used to publish with an invalid
    // bus source, the throw was swallowed, and the ask fell through to the
    // classifier — which started a mission to answer a lookup. A stubbed
    // dispatch test cannot catch that; only the real bus can.
    const csv = path.join(mkws('graph'), 'tickets.csv');
    fs.writeFileSync(csv, 'id,issue\nT1,gpu driver crash\nT2,late delivery\n');
    const { ingestFile } = await import('../src/ontology/engine.js');
    assert.equal(ingestFile('graphsay', csv).ok, true);

    const receipts = [];
    daemon.bus.subscribe('ontology', (e) => receipts.push(e.payload));

    const res = await client.say({ text: 'ask graphsay which ticket mentions gpu drivers', workspace: mkws() });
    assert.equal(res.action, 'answered', 'a graph ask must never start a mission');
    assert.equal(res.mission, null);
    assert.equal(children.length, 0, 'no mission child was ever spawned');
    assert.match(res.text, /\[cite:inst:Ticket:T1\]/, 'the floor answer cites the retrieved nodes');
    assert.ok(res.graph?.plan, 'the response carries the plan id for audit');

    const receipt = receipts.find((r) => r.action === 'graph_answer');
    assert.ok(receipt, 'the receipt survived real bus validation');
    assert.equal(receipt.domain, 'graphsay');
    assert.equal(receipt.grounded, true);
  });

  test('an ask about an unknown domain falls through to the normal router', async () => {
    const res = await client.say({ text: 'ask yourself why the build failed', workspace: mkws() });
    assert.equal(res.graph, null, 'no graph metadata — this was not a graph ask');
  });
});

describe('event streaming', () => {
  let daemon, server, client, children;

  beforeEach(async () => {
    children = [];
    daemon = makeDaemon({ children });
    daemon.bus = new Bus({ journalDir: path.join(tmpHome, 'bus') });
    daemon.sessions._bus = daemon.bus;
    daemon.missions._bus = daemon.bus;
    await daemon.start();
    server = new DaemonServer({ daemon, port: 0 });
    await server.listen();
    client = new DaemonClient();
  });

  afterEach(async () => {
    await server.close();
    await daemon.stop();
  });

  test('a live event reaches an attached client', async () => {
    const controller = new AbortController();
    const stream = client.stream({ signal: controller.signal });

    const first = (async () => { for await (const e of stream) return e; })();
    // Give the SSE handshake a moment before publishing.
    await new Promise(r => setTimeout(r, 150));
    daemon.bus.publish({ source: 'timer', kind: 'trigger', payload: { hello: 'world' } });

    const evt = await first;
    assert.equal(evt.kind, 'trigger');
    assert.equal(evt.payload.hello, 'world');
    controller.abort();
  });

  test('a reconnecting client gets exactly the events it missed', async () => {
    // Off-by-one here means either a duplicate or a silently dropped mission
    // completion — both worse than a visible error.
    const published = [1, 2, 3].map(n =>
      daemon.bus.publish({ source: 'timer', kind: 'trigger', payload: { n } }));
    // Resume from the FIRST of our events specifically. The journal also holds
    // the daemon's own boot events, so indexing into replay() would resume from
    // a health event and wrongly re-deliver n:1.
    const afterId = published[0].id;

    const res = await fetch(`http://127.0.0.1:${server.port}/events?after=${afterId}`, {
      headers: { Authorization: `Bearer ${server.token}` },
    });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    assert.ok(!text.includes('"n":1'), 'the already-seen event must not be replayed');
    assert.ok(text.includes('"n":2') && text.includes('"n":3'), 'the gap must be delivered');
    await reader.cancel();
  });

  test('logs replays the journal over HTTP', async () => {
    daemon.bus.publish({ source: 'timer', kind: 'trigger', payload: { n: 1 } });
    daemon.bus.publish({ source: 'user.cli', kind: 'utterance', payload: { text: 'hi' } });

    const { events } = await client.logs({ kinds: 'utterance' });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.text, 'hi');
  });

  test('N clients cost exactly one bus subscription, and disconnecting cleans up', async () => {
    // A per-client subscription would accumulate over a daemon's lifetime —
    // the classic always-on leak. The server fans out from a single '*' listener.
    const before = daemon.bus.listenerCount('*');
    assert.equal(before, 1, 'the server subscribes once, at listen()');

    const controllers = [];
    for (let i = 0; i < 3; i++) {
      const c = new AbortController();
      controllers.push(c);
      await fetch(`http://127.0.0.1:${server.port}/events`, {
        headers: { Authorization: `Bearer ${server.token}` },
        signal: c.signal,
      });
    }
    await new Promise(r => setTimeout(r, 100));
    assert.equal(daemon.bus.listenerCount('*'), before, 'still exactly one subscription');
    assert.equal(server.clientCount, 3);

    for (const c of controllers) c.abort();
    await new Promise(r => setTimeout(r, 200));
    assert.equal(server.clientCount, 0, 'disconnected clients are dropped');
  });
});

describe('client without a daemon', () => {
  test('every call fails with an actionable message, not ECONNREFUSED', () => {
    const client = new DaemonClient(null);
    assert.equal(client.available, false);
    return assert.rejects(() => client.status(), /is not running/);
  });

  test('daemonPid reports nothing when no pid file exists', () => {
    assert.equal(daemonPid(), null);
    assert.equal(discover(), null);
  });

  test('a stale pid file for a dead process reads as not running', () => {
    fs.mkdirSync(path.dirname(PID_FILE()), { recursive: true });
    fs.writeFileSync(PID_FILE(), '999999');
    assert.equal(daemonPid(), null, 'a crashed daemon must not look alive');
  });
});

describe('CLI verbs (3.7)', () => {
  test('help lists every documented verb', async () => {
    const { main } = await import('../src/kernel/cli.js');
    const chunks = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { chunks.push(s); return true; };
    try {
      assert.equal(await main([]), 0);
    } finally {
      process.stdout.write = write;
    }
    const help = chunks.join('');
    for (const verb of ['start', 'stop', 'status', 'say', 'missions', 'logs', 'install']) {
      assert.ok(help.includes(verb), `help should document "${verb}"`);
    }
  });

  test('status against a stopped daemon exits non-zero and says so', async () => {
    const { main } = await import('../src/kernel/cli.js');
    const chunks = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { chunks.push(s); return true; };
    let code;
    try {
      code = await main(['status']);
    } finally {
      process.stdout.write = write;
    }
    assert.equal(code, 1, 'scripts need a non-zero exit to detect "not running"');
    assert.match(chunks.join(''), /not running/);
  });

  test('an unknown verb exits 2 rather than silently doing nothing', async () => {
    const { main } = await import('../src/kernel/cli.js');
    const write = process.stdout.write.bind(process.stdout);
    const werr = process.stderr.write.bind(process.stderr);
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    try {
      assert.equal(await main(['frobnicate']), 2);
    } finally {
      process.stdout.write = write;
      process.stderr.write = werr;
    }
  });
});
