// src/kernel/locks.js
// One writer per workspace (S5).
//
// Two missions editing the same working tree at once corrupt each other in ways
// that look like model failure — half-applied edits, a smoke test running
// against another mission's half-written file, a checkpoint describing a state
// that no longer exists. The conductor already handles parallelism *inside* a
// mission; this is the guard *between* missions.
//
// The lock must be crash-safe, because the failure it most needs to survive is
// `kill -9`. Two independent staleness signals, deliberately:
//
//   * heartbeat age — covers a hung-but-alive process, and remote holders
//   * process liveness — covers a hard kill, immediately, without waiting out
//     the whole TTL (only trusted when the lock was taken on this host, since
//     PID numbers mean nothing across machines)
//
// Acquisition is optimistic: create-exclusive first, and when stealing a stale
// lock, write-then-read-back to see who actually won the race. `wx` gives a
// real atomic primitive; rename-over does not (it is last-write-wins), so the
// read-back is what makes a contested steal safe.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** How often a holder is expected to refresh its heartbeat. */
export const HEARTBEAT_MS = 5_000;

/** Missed beats before a lock is considered abandoned. */
export const MISSED_BEATS = 3;

/** Default lifetime of a heartbeat before the lock goes stale. */
export const DEFAULT_TTL_MS = HEARTBEAT_MS * MISSED_BEATS;

/** Path of the lock file for a workspace. */
export function lockPath(workspace) {
  return path.join(path.resolve(workspace), '.agent', 'lock.json');
}

/** Read the current lock record, or null when the workspace is free. */
export function readLock(workspace) {
  try {
    const raw = fs.readFileSync(lockPath(workspace), 'utf-8');
    return JSON.parse(raw);
  } catch {
    // ENOENT = free. A corrupt lock file is treated as free too: refusing to
    // ever run again because one JSON file got truncated is the worse failure.
    return null;
  }
}

/** Is a process alive? Only meaningful for locks taken on this host. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — alive for our purposes.
    return err.code === 'EPERM';
  }
}

/**
 * Is this lock abandoned?
 * @returns {{stale: boolean, reason: string}}
 */
export function isStale(lock, { now = Date.now(), ttlMs = null } = {}) {
  if (!lock || typeof lock !== 'object') return { stale: true, reason: 'no lock' };

  const ttl = ttlMs ?? (Number.isFinite(lock.ttlMs) ? lock.ttlMs : DEFAULT_TTL_MS);
  const sameHost = lock.host === os.hostname();

  if (sameHost && !pidAlive(lock.pid)) {
    return { stale: true, reason: `holder pid ${lock.pid} is gone` };
  }
  const age = now - (lock.heartbeatAt ?? lock.acquiredAt ?? 0);
  if (age > ttl) {
    return { stale: true, reason: `heartbeat ${Math.round(age / 1000)}s old (ttl ${Math.round(ttl / 1000)}s)` };
  }
  return { stale: false, reason: 'held' };
}

function writeLockFileExclusive(p, record) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(p, 'wx'); // atomic create-or-fail
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(record, null, 2), 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function overwriteLockFile(p, record) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(record, null, 2), 'utf-8');
}

/**
 * Try to take the workspace lock.
 *
 * @param {string} workspace
 * @param {object} opts
 * @param {string} opts.missionId    who wants it — surfaced in the refusal message
 * @param {number} [opts.pid]
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.now]
 * @returns {{ok: true, lock: object} | {ok: false, heldBy: object, reason: string}}
 */
export function acquireWorkspaceLock(workspace, { missionId, pid = process.pid, ttlMs = DEFAULT_TTL_MS, now = null } = {}) {
  if (!missionId) throw new Error('acquireWorkspaceLock requires a missionId');
  const p = lockPath(workspace);
  const ts = now ?? Date.now();
  const record = {
    schemaVersion: 1,
    token: randomUUID(),
    missionId,
    pid,
    host: os.hostname(),
    workspace: path.resolve(workspace),
    acquiredAt: ts,
    heartbeatAt: ts,
    ttlMs,
  };

  if (writeLockFileExclusive(p, record)) return { ok: true, lock: record };

  // Someone holds it — or held it and died.
  const existing = readLock(workspace);
  const { stale, reason } = isStale(existing, { now: ts, ttlMs });
  if (!stale) {
    return {
      ok: false,
      heldBy: existing,
      reason: `workspace is locked by mission ${existing.missionId} (pid ${existing.pid})`,
    };
  }

  // Steal it, then confirm we actually won. Two daemons reaping the same stale
  // lock in the same millisecond both succeed at writing; only one can read its
  // own token back.
  overwriteLockFile(p, { ...record, stoleFrom: existing?.missionId ?? null, staleReason: reason });
  const after = readLock(workspace);
  if (after?.token !== record.token) {
    return {
      ok: false,
      heldBy: after,
      reason: `lost a race to reclaim a stale lock (now held by mission ${after?.missionId ?? 'unknown'})`,
    };
  }
  return { ok: true, lock: after };
}

/**
 * Refresh the heartbeat. Returns false when the token no longer matches, which
 * means the lock was reclaimed while we were working — the caller should treat
 * that as loss of the workspace, not as a transient error.
 */
export function heartbeatLock(workspace, token, { now = null } = {}) {
  const existing = readLock(workspace);
  if (!existing || existing.token !== token) return false;
  overwriteLockFile(lockPath(workspace), { ...existing, heartbeatAt: now ?? Date.now() });
  return true;
}

/**
 * Release the lock. Only the holder may release it: a mission that lost its
 * lock to a reaper must not delete its successor's lock on the way out.
 */
export function releaseWorkspaceLock(workspace, token) {
  const existing = readLock(workspace);
  if (!existing) return false;
  if (existing.token !== token) return false;
  try {
    fs.rmSync(lockPath(workspace));
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a heartbeat timer for a held lock. Returns a stop function.
 * The timer is unref'd so it can never keep the process alive by itself.
 */
export function startHeartbeat(workspace, token, { intervalMs = HEARTBEAT_MS, onLost = null } = {}) {
  const timer = setInterval(() => {
    if (!heartbeatLock(workspace, token)) {
      clearInterval(timer);
      if (typeof onLost === 'function') onLost();
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/**
 * Run `fn` while holding the workspace lock, releasing it however `fn` ends.
 * @returns {Promise<{ok: true, result: *} | {ok: false, reason: string, heldBy: object}>}
 */
export async function withWorkspaceLock(workspace, { missionId, ttlMs = DEFAULT_TTL_MS }, fn) {
  const got = acquireWorkspaceLock(workspace, { missionId, ttlMs });
  if (!got.ok) return got;
  const stop = startHeartbeat(workspace, got.lock.token);
  try {
    return { ok: true, result: await fn(got.lock) };
  } finally {
    stop();
    releaseWorkspaceLock(workspace, got.lock.token);
  }
}
