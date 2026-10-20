// src/triggers/watchers.js
// Observers (6.2): "tell me if the test suite on main breaks".
//
// A watcher samples something and reports when the answer *changes*. The change
// part is the whole design. A watcher that reported the current state every
// poll would produce a notification every thirty seconds, and the budget in the
// intent ledger would spend itself in two minutes. What the user asked to hear
// about is the transition — the moment it broke — not the ongoing fact of it
// being broken.
//
// Three probe kinds, all pluggable:
//   file     a path's existence / mtime / content hash
//   command  a shell command's exit code and output
//   http     a URL's status and body hash
//
// Every observation carries its intent id, so the notification can be traced
// back to the wish that asked for it and charged against that wish's budget.
//
// Probes are sampled, never streamed. `fs.watch` would be lower latency and
// is a well-known source of duplicate and missed events across platforms; a
// 30-second poll that is *correct* beats a filesystem event that fires twice
// on Windows and not at all over a network mount.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const PROBE_KINDS = Object.freeze(['file', 'command', 'http']);

/** How long a probe may take before it is treated as a failure. */
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

// ── Probes ──────────────────────────────────────────────────────────────────
// Each returns { state, detail } where `state` is a short comparable string.
// Comparability is the contract: the watcher only ever diffs `state`.

export const PROBES = {
  /** A path: does it exist, and has its content changed? */
  async file({ path: target, mode = 'content' }) {
    const abs = path.resolve(target);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return { state: 'absent', detail: { path: abs } };
    }
    if (mode === 'exists') return { state: 'present', detail: { path: abs } };
    if (mode === 'mtime') return { state: `mtime:${Math.floor(stat.mtimeMs)}`, detail: { path: abs } };

    if (stat.isDirectory()) {
      // A directory's "content" is its listing plus each entry's mtime — enough
      // to notice an added, removed or edited file without reading them all.
      const entries = fs.readdirSync(abs).sort();
      const sig = entries.map(e => {
        try { return `${e}:${Math.floor(fs.statSync(path.join(abs, e)).mtimeMs)}`; } catch { return `${e}:gone`; }
      }).join('|');
      return { state: `dir:${hash(sig)}`, detail: { path: abs, entries: entries.length } };
    }
    try {
      return { state: `file:${hash(fs.readFileSync(abs))}`, detail: { path: abs, bytes: stat.size } };
    } catch {
      return { state: 'unreadable', detail: { path: abs } };
    }
  },

  /** A command: its exit code, and optionally whether its output changed. */
  async command({ command, args = [], cwd = null, includeOutput = false, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS }) {
    return new Promise((resolve) => {
      execFile(command, args, { cwd: cwd || process.cwd(), timeout: timeoutMs, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          const out = String(stdout || '');
          // Exit code alone by default. Hashing output as well means any
          // timestamp or duration in the output reads as a change, which is
          // how a watcher turns into a metronome.
          const state = includeOutput ? `exit:${code}:${hash(out)}` : `exit:${code}`;
          resolve({
            state,
            detail: {
              code,
              stdout: out.slice(-2000),
              stderr: String(stderr || '').slice(-2000),
              timedOut: err?.killed === true,
            },
          });
        });
    });
  },

  /** A URL: its status class, and optionally a body hash. */
  async http({ url, includeBody = false, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const body = includeBody ? await res.text() : '';
      return {
        state: includeBody ? `http:${res.status}:${hash(body)}` : `http:${res.status}`,
        detail: { status: res.status, ok: res.ok },
      };
    } catch (err) {
      // Unreachable is a state, and a meaningful one — going from 200 to
      // unreachable is exactly the transition someone wants to hear about.
      return { state: 'unreachable', detail: { error: err?.message || String(err) } };
    } finally {
      clearTimeout(timer);
    }
  },
};

function hash(data) {
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

// ── Watcher runner ──────────────────────────────────────────────────────────

export class WatcherRunner {
  /**
   * @param {object} opts
   * @param {object} opts.ledger      IntentLedger — watchers are `watch` intents
   * @param {function} [opts.onObserve] async (intent, observation) => void
   * @param {object} [opts.probes]    override probe implementations (tests)
   * @param {number} [opts.intervalMs]
   * @param {function} [opts.now]
   */
  constructor({ ledger, onObserve = null, probes = PROBES, intervalMs = 60_000, now = Date.now } = {}) {
    if (!ledger) throw new Error('WatcherRunner needs an intent ledger');
    this.ledger = ledger;
    this._onObserve = onObserve;
    this._probes = probes;
    this._intervalMs = intervalMs;
    this._now = now;
    this._timer = null;
    this.observationCount = 0;
  }

  /**
   * Register a watcher.
   *
   * `notifyOn` decides which transitions are worth a message:
   *   'change'  any transition (default)
   *   'failure' only when a command starts failing / a URL stops being ok
   *   'recovery' only when it starts working again
   */
  watch({ probe, config, description, sessionId = null, workspace = null, urgency = 'soon', budget = null, expiresAt = null, notifyOn = 'change' }) {
    if (!PROBE_KINDS.includes(probe)) {
      throw new Error(`unknown probe "${probe}" (expected: ${PROBE_KINDS.join(', ')})`);
    }
    return this.ledger.create({
      kind: 'watch',
      description,
      sessionId, workspace, urgency, budget, expiresAt,
      // `lastState: null` means "not yet sampled". The first poll therefore
      // establishes a baseline and does NOT notify — otherwise registering a
      // watcher on an already-broken build would fire immediately, which reads
      // as noise rather than news.
      condition: { probe, config: config || {}, notifyOn, lastState: null, lastSeenAt: null },
    });
  }

  /**
   * Poll every active watcher once.
   * @returns {Promise<object[]>} observations that were notified
   */
  async tick() {
    this.ledger.sweepExpired();
    const notified = [];

    for (const intent of this.ledger.list({ kind: 'watch' })) {
      const { probe, config, notifyOn, lastState } = intent.condition || {};
      const impl = this._probes[probe];
      if (!impl) continue;

      let result;
      try {
        result = await impl(config || {});
      } catch (err) {
        result = { state: 'probe_error', detail: { error: err?.message || String(err) } };
      }
      this.observationCount++;

      const first = lastState == null;
      const changed = !first && result.state !== lastState;

      this.ledger.update(intent.id, {
        condition: { ...intent.condition, lastState: result.state, lastSeenAt: this._now() },
      });

      // Baseline sample: record it, say nothing.
      if (first || !changed) continue;
      if (!this._shouldNotify(notifyOn, lastState, result.state)) continue;

      const claim = this.ledger.claimNotification(intent.id);
      if (!claim.ok) continue;

      const observation = {
        intentId: intent.id,
        description: intent.description,
        probe,
        from: lastState,
        to: result.state,
        detail: result.detail,
        at: this._now(),
        remainingBudget: claim.remaining,
      };
      notified.push(observation);

      if (this._onObserve) {
        try { await this._onObserve(intent, observation); } catch { /* one bad sink must not stop the rest */ }
      }
    }
    return notified;
  }

  /** Is this particular transition the one the user asked about? */
  _shouldNotify(notifyOn, from, to) {
    if (notifyOn === 'change' || !notifyOn) return true;
    const wasOk = isHealthy(from);
    const isOk = isHealthy(to);
    if (notifyOn === 'failure') return wasOk && !isOk;
    if (notifyOn === 'recovery') return !wasOk && isOk;
    return true;
  }

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => { this.tick().catch(() => {}); }, this._intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    return this;
  }

  status() {
    return {
      running: !!this._timer,
      watching: this.ledger.list({ kind: 'watch' }).length,
      observations: this.observationCount,
    };
  }
}

/** Does this probe state represent a working thing? */
export function isHealthy(state) {
  const s = String(state || '');
  if (s === 'exit:0') return true;
  if (s.startsWith('exit:0:')) return true;
  if (/^http:2\d\d/.test(s)) return true;
  if (/^http:3\d\d/.test(s)) return true;
  if (s === 'present' || s.startsWith('file:') || s.startsWith('dir:') || s.startsWith('mtime:')) return true;
  // absent / unreachable / probe_error / non-zero exit / 4xx / 5xx
  return false;
}
