// src/kernel/missions.js
// Mission lifecycle (3.4): the daemon's dispatcher.
//
// A mission is a job. runLoop stays exactly what D1 says it is — a terminating,
// task-scoped function — and this module is what turns N of those into fleet
// behaviour: queueing behind workspace locks, streaming progress onto the bus,
// persisting outcomes, and re-adopting whatever was in flight when the daemon
// died.
//
// Each mission runs in a forked child process. The trade is deliberate: an
// in-process mission is cheaper and Phase 1 made it safe, but a mission runs
// arbitrary model-chosen commands and a segfault or OOM in one must not take
// down the presence layer with it.
//
// State machine:
//
//   queued ──▶ starting ──▶ running ──┬─▶ done        (exitReason completed)
//      │                              ├─▶ failed      (error / crash)
//      │                              ├─▶ stopped     (cooperative stop, resumable)
//      │                              └─▶ interrupted (daemon died under it)
//      └─▶ cancelled                        │
//                                           └─▶ (re-adopted) queued
//
// `interrupted` is the one that matters for presence: it means a checkpoint
// exists and the mission can pick up where it left off.

import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  MISSIONS_FILE,
  SCHEMA_VERSION,
  readRegistry,
  writeRegistry,
  migrateRegistry,
} from './paths.js';
import {
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  startHeartbeat,
  readLock,
  isStale,
} from './locks.js';

/** Terminal and non-terminal mission states. */
export const MISSION_STATES = Object.freeze([
  'queued', 'starting', 'running', 'stopping',
  'done', 'failed', 'stopped', 'interrupted', 'cancelled',
]);

/** States from which a mission will never move on its own. */
export const TERMINAL_STATES = Object.freeze(['done', 'failed', 'cancelled']);

/** Resolved once: the child entry point, via fileURLToPath. */
// NOT `new URL(...).pathname` — on Windows that yields "/C:/Users/..." and every
// spawn fails with ENOENT. This bug has been fixed twice in this repo already.
const CHILD_SCRIPT = fileURLToPath(new URL('./missionChild.js', import.meta.url));

const MIGRATIONS = {
  1: (data) => ({ missions: data.missions || {}, ...data }),
};

export class MissionManager {
  /**
   * @param {object}   [opts]
   * @param {string}   [opts.filePath]      default ~/.<brand>/missions/index.json
   * @param {object}   [opts.bus]           mission_update events are published here
   * @param {object}   [opts.sessions]      SessionRegistry, kept in sync
   * @param {number}   [opts.maxConcurrent] global cap (S2 resource governance)
   * @param {function} [opts.now]
   * @param {function} [opts.newId]
   * @param {function} [opts.spawn]         injectable child spawner (tests)
   * @param {boolean}  [opts.persist]
   */
  constructor({
    filePath = null,
    bus = null,
    sessions = null,
    maxConcurrent = 2,
    now = Date.now,
    newId = null,
    spawn = null,
    persist = true,
    memory = null,
  } = {}) {
    this._memory = memory;
    this._filePath = filePath;
    this._bus = bus;
    this._sessions = sessions;
    this._maxConcurrent = maxConcurrent;
    this._now = now;
    this._newId = newId || (() => `m-${randomUUID().slice(0, 8)}`);
    this._spawn = spawn || defaultSpawn;
    this._persist = persist;

    /** @type {Map<string, object>} missionId → record */
    this._missions = new Map();
    /** @type {Map<string, {child: object, stopHeartbeat: function, token: string}>} live handles */
    this._running = new Map();
    /** @type {Map<string, function[]>} missionId → completion waiters */
    this._waiters = new Map();
    /** @type {Map<string, string>} missionId → tail of a crashed child's output */
    this._lastOutput = new Map();
    this._loaded = false;
  }

  get filePath() { return this._filePath || MISSIONS_FILE(); }

  get maxConcurrent() { return this._maxConcurrent; }
  set maxConcurrent(n) { this._maxConcurrent = Math.max(0, n | 0); }

  // ── Persistence ───────────────────────────────────────────────────────────

  load() {
    if (this._loaded) return this;
    this._loaded = true;
    if (!this._persist) return this;

    const raw = readRegistry(this.filePath, null);
    if (raw) {
      const { data } = migrateRegistry(raw, MIGRATIONS, SCHEMA_VERSION);
      for (const [id, rec] of Object.entries(data.missions || {})) {
        this._missions.set(id, { ...rec, id });
      }
    }
    return this;
  }

  save() {
    if (!this._persist) return this;
    const missions = {};
    for (const [id, rec] of this._missions) missions[id] = rec;
    writeRegistry(this.filePath, { schemaVersion: SCHEMA_VERSION, missions });
    return this;
  }

  _snapshot(rec) {
    return JSON.parse(JSON.stringify(rec));
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  get(id) {
    this.load();
    const rec = this._missions.get(id);
    return rec ? this._snapshot(rec) : null;
  }

  /** All missions, newest first, optionally filtered. */
  list({ state = null, sessionId = null, workspace = null } = {}) {
    this.load();
    let all = [...this._missions.values()].map(r => this._snapshot(r));
    if (state)     all = all.filter(r => r.state === state);
    if (sessionId) all = all.filter(r => r.sessionId === sessionId);
    if (workspace) all = all.filter(r => r.workspace === path.resolve(workspace));
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Missions currently occupying a concurrency slot. */
  activeCount() {
    this.load();
    let n = 0;
    for (const rec of this._missions.values()) {
      if (rec.state === 'starting' || rec.state === 'running' || rec.state === 'stopping') n++;
    }
    return n;
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  /**
   * Register a mission and start it if a slot and the workspace are free;
   * otherwise leave it queued. Returns the mission record either way — the
   * caller finds out which happened from `state`, not from a thrown error.
   */
  submit({ task, workspace, sessionId = 'system', profile = null, model = null, maxSteps = null, resume = false, title = null } = {}) {
    this.load();
    if (!task && !resume) throw new Error('a mission needs a task');
    if (!workspace) throw new Error('a mission needs a workspace');

    const ts = this._now();
    const id = this._newId();
    const rec = {
      id,
      sessionId,
      title: title || String(task || '').slice(0, 80),
      task: task || null,
      workspace: path.resolve(workspace),
      profile,
      model,
      maxSteps,
      resume,
      state: 'queued',
      pid: null,
      lockToken: null,
      createdAt: ts,
      startedAt: null,
      endedAt: null,
      lastStep: 0,
      exitReason: null,
      result: null,
      error: null,
      blockedReason: null,
      attempts: 0,
    };
    this._missions.set(id, rec);
    this.save();
    this._emit(rec, 'queued');

    // First mission in a workspace brings its existing .agent/ memory across
    // (5.2). Sentinel-guarded, so this is a no-op on every later mission, and
    // deliberately non-fatal: a failed import must not stop the job.
    this._importWorkspaceMemory(rec.workspace);

    if (this._sessions && sessionId) {
      try { this._sessions.attachMission(sessionId, id); } catch { /* system session may be absent in unit tests */ }
    }

    this._pump();
    return this.get(id);
  }

  /** Import a workspace's legacy memory once, on first sight. Never throws. */
  _importWorkspaceMemory(workspace) {
    if (!this._memory) return;
    try {
      // Synchronous import of an async module would block; fire and forget,
      // because nothing downstream waits on it and a mission that started
      // before the import lands simply recalls less on its first run.
      import('../memoryd/import.js')
        .then(({ importWorkspace, isImported }) => {
          if (isImported(workspace)) return;
          const res = importWorkspace(this._memory, { workspace });
          if (res.imported > 0) {
            this._bus?.publish({
              source: 'system', kind: 'daemon_state', sessionId: null,
              payload: { action: 'memory_imported', workspace, ...res },
              urgency: 'whenever',
            });
          }
        })
        .catch(() => { /* memory import is best-effort */ });
    } catch { /* best-effort */ }
  }

  /**
   * Try to start any queued missions that can run right now.
   * Called after every submit and every completion — this is the whole
   * scheduler, deliberately small and deterministic (oldest first).
   */
  _pump() {
    this.load();
    const queued = [...this._missions.values()]
      .filter(r => r.state === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const rec of queued) {
      if (this.activeCount() >= this._maxConcurrent) {
        this._setBlocked(rec, `waiting for a mission slot (${this._maxConcurrent} in use)`);
        continue;
      }
      const got = acquireWorkspaceLock(rec.workspace, { missionId: rec.id });
      if (!got.ok) {
        this._setBlocked(rec, got.reason);
        continue;
      }
      this._start(rec, got.lock);
    }
  }

  /** Record why a queued mission is not running, without state churn. */
  _setBlocked(rec, reason) {
    if (rec.blockedReason === reason) return;
    rec.blockedReason = reason;
    this.save();
    this._emit(rec, 'blocked');
  }

  _start(rec, lock) {
    rec.state = 'starting';
    rec.attempts += 1;
    rec.lockToken = lock.token;
    rec.blockedReason = null;
    rec.startedAt = this._now();
    this.save();
    this._emit(rec, 'starting');

    const spec = {
      missionId: rec.id,
      task: rec.task,
      workspace: rec.workspace,
      profile: rec.profile,
      model: rec.model,
      maxSteps: rec.maxSteps,
      resume: rec.resume,
    };

    let child;
    try {
      child = this._spawn(CHILD_SCRIPT, spec, { cwd: rec.workspace });
    } catch (err) {
      this._finish(rec, { state: 'failed', error: `could not spawn mission: ${err.message}` });
      return;
    }

    const stopHeartbeat = startHeartbeat(rec.workspace, lock.token, {
      onLost: () => {
        // Losing the lock means another process reclaimed this workspace. Stop
        // rather than let two writers race — the mission is checkpointed and
        // can be resumed once the workspace is free.
        this._emit(rec, 'lock_lost');
        this.stop(rec.id, { reason: 'workspace lock lost' });
      },
    });

    this._running.set(rec.id, { child, stopHeartbeat, token: lock.token });

    // Drain the child's stdio. These are pipes, and nothing else reads them —
    // an unread pipe fills at ~8KB and then blocks the writer forever, so a
    // chatty mission would hang mid-run with no error anywhere. Draining also
    // means a crash leaves its stack trace somewhere findable.
    this._attachOutput(rec, child);

    child.on('message', (msg) => this._onChildMessage(rec.id, msg));
    child.on('error', (err) => {
      this._finish(this._missions.get(rec.id) || rec, { state: 'failed', error: `child error: ${err.message}` });
    });
    child.on('exit', (code, signal) => this._onChildExit(rec.id, code, signal));

    rec.pid = child.pid ?? null;
    rec.state = 'running';
    this.save();
    this._emit(rec, 'running');
  }

  /**
   * Consume the child's stdout/stderr into a per-mission log file, keeping the
   * last slice in memory for crash reporting.
   *
   * Kept out of the bus deliberately: a mission emits thousands of log lines
   * and every one would be journalled, broadcast to every SSE client, and
   * retained for 30 days. The structured `step` events are the live view; this
   * is the debugging trail.
   */
  _attachOutput(rec, child) {
    let logStream = null;
    try {
      const logPath = path.join(path.dirname(this.filePath), `${rec.id}.log`);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      logStream = fs.createWriteStream(logPath, { flags: 'a' });
      // createWriteStream opens lazily, so failures (disk full, directory
      // removed under us) surface as an async 'error' event. Unhandled, that
      // is an uncaughtException — which for a daemon means the whole presence
      // layer dies because one mission could not write a log line.
      logStream.on('error', () => { logStream = null; });
      rec.logPath = logPath;
    } catch {
      // No log file is survivable; an undrained pipe is not. Fall through and
      // still consume the streams below.
    }

    const tail = [];
    const consume = (stream) => {
      if (!stream) return;
      stream.setEncoding('utf-8');
      stream.on('data', (chunk) => {
        try { logStream?.write(chunk); } catch { /* disk full */ }
        tail.push(chunk);
        if (tail.length > 40) tail.shift();
      });
      stream.on('error', () => { /* the child is going away; nothing to do */ });
    };
    consume(child.stdout);
    consume(child.stderr);

    child.once('exit', () => {
      try { logStream?.end(); } catch { /* already closed */ }
      // Only kept when the mission died without reporting — otherwise the
      // result message is the better explanation.
      this._lastOutput.set(rec.id, tail.join('').slice(-2000));
    });
  }

  _onChildMessage(missionId, msg) {
    const rec = this._missions.get(missionId);
    if (!rec || !msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'ready':
        rec.pid = msg.pid ?? rec.pid;
        this.save();
        break;

      case 'step':
        rec.lastStep = msg.step ?? rec.lastStep;
        // Deliberately not saved to disk per step: a mission does ~50–300 steps
        // and the checkpoint already holds resumable progress. Step counters are
        // for the live view, and the bus is the live view.
        this._emit(rec, 'step', {
          step: msg.step, tool: msg.tool, args: msg.args, resultPreview: msg.resultPreview,
        });
        break;

      case 'hitl': {
        // The child's dedicated 'step' IPC message only fires when a step runs
        // to COMPLETION — every `continue` path in the loop (finish-gate block,
        // LLM error, loop guard) skips the bottom-of-body onStep callback.
        // Live case: a resumed mission spent every step gate-blocked, so
        // lastStep sat at 0 while the bus streamed gateway events showing step
        // 77. Those forwarded events carry the loop's own counter (emitted
        // BEFORE the gates) — mirror it so the registry matches reality.
        const s = Number(msg.event?.step);
        if (Number.isFinite(s) && s > rec.lastStep) rec.lastStep = s;
        this._emit(rec, 'hitl', { event: msg.event });
        break;
      }

      case 'result':
        // Captured here rather than at exit: the exit event carries only a
        // numeric code, and 'max_steps' vs 'completed' is the difference
        // between "done" and "needs a follow-up" (P6.4 consumes this).
        rec.result = msg.result || null;
        rec.exitReason = msg.result?.exitReason ?? null;
        this.save();
        break;

      case 'error':
        rec.error = msg.message || 'unknown mission error';
        this.save();
        break;

      default:
        break;
    }
  }

  _onChildExit(missionId, code, signal) {
    const rec = this._missions.get(missionId);
    if (!rec) return;

    const handle = this._running.get(missionId);
    if (handle) {
      handle.stopHeartbeat();
      releaseWorkspaceLock(rec.workspace, handle.token);
      this._running.delete(missionId);
    }

    let state;
    if (rec.state === 'cancelled') {
      state = 'cancelled';
    } else if (rec.exitReason === 'completed') {
      state = 'done';
    } else if (rec.exitReason === 'interrupted' || rec.state === 'stopping') {
      // Checkpointed and resumable — not a failure.
      state = 'stopped';
    } else if (rec.exitReason) {
      // max_steps / budget_exceeded / repair_stalled / error: the loop finished
      // on its own terms. Keep the taxonomy rather than flattening to "failed";
      // P6.4 turns these into follow-ups.
      state = rec.exitReason === 'error' ? 'failed' : 'stopped';
    } else {
      // No result message at all → the child died without reporting. That is
      // the crash case the child-process isolation exists for.
      state = 'failed';
      // Include the child's own last words. Without this the only clue is a
      // numeric exit code, and diagnosing a crash means re-running it by hand.
      const tail = (this._lastOutput.get(rec.id) || '').trim();
      const lastLine = tail ? (tail.split(/\r?\n/).filter(Boolean).slice(-1)[0] || '') : '';
      rec.error = rec.error
        || `mission child exited without a result (code ${code}${signal ? `, signal ${signal}` : ''})`
           + (lastLine ? ` — last output: ${lastLine.slice(0, 300)}` : '')
           + (rec.logPath ? ` [log: ${rec.logPath}]` : '');
    }

    this._finish(rec, { state, exitCode: code, signal });
  }

  _finish(rec, { state, error = null, exitCode = null, signal = null }) {
    rec.state = state;
    rec.endedAt = this._now();
    rec.pid = null;
    rec.lockToken = null;
    if (error) rec.error = error;
    rec.exitCode = exitCode;
    rec.signal = signal ?? null;
    this.save();
    this._emit(rec, 'ended');

    if (this._sessions && rec.sessionId) {
      try { this._sessions.detachMission(rec.sessionId, rec.id); } catch { /* session gone */ }
    }

    const waiters = this._waiters.get(rec.id) || [];
    this._waiters.delete(rec.id);
    this._lastOutput.delete(rec.id);
    for (const resolve of waiters) resolve(this._snapshot(rec));

    // A freed slot and a freed workspace may unblock something.
    this._pump();
  }

  // ── Control ───────────────────────────────────────────────────────────────

  /**
   * Ask a mission to stop cooperatively: it finishes the current step, saves a
   * checkpoint, and exits 'interrupted'. This is what makes stopping resumable
   * rather than destructive.
   */
  stop(id, { reason = 'stop requested' } = {}) {
    this.load();
    const rec = this._missions.get(id);
    if (!rec) return null;

    if (rec.state === 'queued') {
      // Never started — nothing to checkpoint.
      this._finish(rec, { state: 'cancelled', error: reason });
      return this.get(id);
    }
    const handle = this._running.get(id);
    if (!handle) return this.get(id);

    rec.state = 'stopping';
    rec.blockedReason = reason;
    this.save();
    this._emit(rec, 'stopping', { reason });

    // IPC first: signals are unreliable on Windows, and the child understands
    // both. Whichever arrives first wins; the second is a no-op.
    try { handle.child.send?.({ type: 'stop', reason }); } catch { /* channel closed */ }
    try { handle.child.kill?.('SIGTERM'); } catch { /* already gone */ }
    return this.get(id);
  }

  /** Hard-kill a mission. Loses in-flight work that was not checkpointed. */
  cancel(id, { reason = 'cancelled' } = {}) {
    this.load();
    const rec = this._missions.get(id);
    if (!rec) return null;
    if (TERMINAL_STATES.includes(rec.state)) return this.get(id);

    rec.state = 'cancelled';
    rec.error = reason;
    this.save();

    const handle = this._running.get(id);
    if (!handle) {
      this._finish(rec, { state: 'cancelled', error: reason });
      return this.get(id);
    }
    try { handle.child.kill?.('SIGKILL'); } catch { /* already gone */ }
    return this.get(id);
  }

  /**
   * Inject a steering message into a running mission (4.4).
   *
   * The steering channel and the pause flag are both files under the mission's
   * OWN workspace, and the daemon's ambient context points somewhere else
   * entirely — so these run inside a context scoped to that workspace. Writing
   * from the daemon's context would drop the message into the wrong `.agent/`
   * and it would never be read, silently.
   */
  async steer(id, message) {
    return this._inMissionWorkspace(id, async () => {
      const { addSteeringMessage } = await import('../hitl/steeringChannel.js');
      return addSteeringMessage(String(message));
    });
  }

  /** Pause a mission at its next step boundary (the existing HITL pause flag). */
  async pause(id) {
    return this._inMissionWorkspace(id, async () => {
      const { pause } = await import('../hitl/gateway.js');
      pause();
      return true;
    });
  }

  /** Lift a pause. */
  async unpause(id) {
    return this._inMissionWorkspace(id, async () => {
      const { resume } = await import('../hitl/gateway.js');
      resume();
      return true;
    });
  }

  async _inMissionWorkspace(id, fn) {
    this.load();
    const rec = this._missions.get(id);
    if (!rec) return null;
    const { AgentContext, runWithContext } = await import('../runtime/context.js');
    const ctx = new AgentContext({ workspace: rec.workspace, missionId: id });
    try {
      return await runWithContext(ctx, fn);
    } finally {
      try { ctx.dispose(); } catch { /* nothing held */ }
    }
  }

  /** Resolve when a mission reaches a terminal state. */
  wait(id) {
    this.load();
    const rec = this._missions.get(id);
    if (!rec) return Promise.resolve(null);
    if (rec.endedAt) return Promise.resolve(this._snapshot(rec));
    return new Promise((resolve) => {
      const list = this._waiters.get(id) || [];
      list.push(resolve);
      this._waiters.set(id, list);
    });
  }

  /**
   * Re-queue a stopped/interrupted mission from its checkpoint.
   * The distinction from submit() is `resume: true` — the child must not
   * overwrite the task file, which may carry steering the user added.
   */
  resume(id) {
    this.load();
    const rec = this._missions.get(id);
    if (!rec) return null;
    if (rec.state === 'running' || rec.state === 'queued') return this.get(id);

    rec.state = 'queued';
    rec.resume = true;
    rec.endedAt = null;
    rec.error = null;
    rec.exitReason = null;
    rec.blockedReason = null;
    this.save();
    this._emit(rec, 'queued');

    if (this._sessions && rec.sessionId) {
      try { this._sessions.attachMission(rec.sessionId, rec.id); } catch { /* no session */ }
    }
    this._pump();
    return this.get(id);
  }

  // ── Crash recovery ────────────────────────────────────────────────────────

  /**
   * Reconcile the registry with reality at daemon boot (the P3 acceptance
   * criterion: kill -9 the daemon mid-mission, restart, and it re-adopts).
   *
   * A mission recorded as running whose process is gone did not finish — it was
   * orphaned. Mark it `interrupted`, drop the stale workspace lock it left
   * behind, and optionally re-queue it.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.autoResume] re-queue interrupted missions immediately
   * @returns {{adopted: string[], reclaimed: string[]}}
   */
  adopt({ autoResume = false } = {}) {
    this.load();
    const adopted = [];
    const reclaimed = [];

    for (const rec of this._missions.values()) {
      if (!['starting', 'running', 'stopping'].includes(rec.state)) continue;
      if (this._running.has(rec.id)) continue; // ours, still live

      // The daemon restarted, so no child of ours survives. Anything still
      // marked running is by definition orphaned.
      rec.state = 'interrupted';
      rec.endedAt = this._now();
      rec.pid = null;
      adopted.push(rec.id);
      this._emit(rec, 'interrupted');

      // Release the lock it left behind, but only if it is genuinely stale —
      // another live daemon may legitimately hold this workspace now.
      const lock = readLock(rec.workspace);
      if (lock && lock.missionId === rec.id && isStale(lock, { now: this._now() }).stale) {
        if (releaseWorkspaceLock(rec.workspace, lock.token)) reclaimed.push(rec.workspace);
      }
      rec.lockToken = null;
    }

    if (adopted.length) this.save();
    if (autoResume) for (const id of adopted) this.resume(id);
    return { adopted, reclaimed };
  }

  /** Stop every running mission cooperatively; resolves when all have ended. */
  async stopAll({ reason = 'daemon shutting down' } = {}) {
    const ids = [...this._running.keys()];
    const waits = ids.map(id => this.wait(id));
    for (const id of ids) this.stop(id, { reason });
    await Promise.all(waits);
    return ids;
  }

  _emit(rec, action, extra = {}) {
    if (!this._bus) return;
    try {
      this._bus.publish({
        source: 'mission',
        kind: 'mission_update',
        sessionId: rec.sessionId || null,
        urgency: action === 'ended' ? 'soon' : 'whenever',
        payload: {
          action,
          missionId: rec.id,
          state: rec.state,
          workspace: rec.workspace,
          profile: rec.profile,
          lastStep: rec.lastStep,
          exitReason: rec.exitReason,
          blockedReason: rec.blockedReason,
          error: rec.error,
          ...extra,
        },
      });
    } catch {
      // The registry is the source of truth; a bus failure must not roll back a
      // committed lifecycle transition.
    }
  }
}

/**
 * Fork a mission child, passing its spec through the environment.
 *
 * `windowsHide` is load-bearing, not cosmetic. Without it a mission forked by a
 * *detached* daemon stays attached to the launching terminal's console, and
 * when that terminal's foreground process exits Windows delivers CTRL_C to the
 * console group — the mission dies with 0xC000013A two seconds in. It only
 * reproduces when the daemon is detached, which is the normal way to run it.
 */
function defaultSpawn(script, spec, { cwd } = {}) {
  return fork(script, [], {
    cwd: fs.existsSync(cwd) ? cwd : process.cwd(),
    // KAIROS_USAGE_PURPOSE: every completion the child makes lands in the
    // spend ledger attributed to missions unless a call site tags tighter.
    env: { ...process.env, KAIROS_MISSION_SPEC: JSON.stringify(spec), KAIROS_USAGE_PURPOSE: 'mission' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
}
