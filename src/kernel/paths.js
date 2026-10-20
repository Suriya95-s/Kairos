// src/kernel/paths.js
// The daemon's home on disk, and the one place the product name is written.
//
// Everything above this file — the bus, registries, vault, CLI verbs, autostart
// unit files — asks here for its paths. Renaming the system is therefore a
// one-line change (BRAND below, or the KAIROS_BRAND env var), not a sweep.
//
// Two hard rules learned in Phase 1:
//   1. Paths resolve on every call, never at module load. A cached root is a
//      global by another name, and tests (which point KAIROS_HOME at a temp
//      dir) would silently share one home.
//   2. Registry writes are atomic (temp + rename). A daemon killed mid-write
//      must not leave a truncated daemon.json that bricks the next boot.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Product name. Drives the home directory (`~/.<brand>/`), the CLI verb, and
 * every user-facing string. Override with KAIROS_BRAND to rename the system.
 */
export const BRAND = (process.env.KAIROS_BRAND || 'kairos').trim().toLowerCase();

/** Current on-disk schema version for kernel registries. Bump when a shape changes. */
export const SCHEMA_VERSION = 1;

/**
 * Root of the daemon's persistent state: `~/.<brand>/`, or KAIROS_HOME.
 * Resolved per call — see rule 1 above.
 */
export function home() {
  const override = process.env.KAIROS_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), `.${BRAND}`);
}

/** Subdirectories of the daemon home. Keys are stable; layout can move. */
export const SUBDIRS = {
  bus:      'bus',        // JSONL event journal, daily segments
  missions: 'missions',   // per-mission records + exit results
  sessions: 'sessions',   // conversation registry
  vault:    'vault',      // encrypted credentials (S1)
  memory:   'memory',     // daemon-owned Palace DB (P5)
  logs:     'logs',       // daemon stdout/stderr, rotated
  run:      'run',        // pid file, socket/port file — ephemeral
  snapshots:'snapshots',  // pre-migration state snapshots (S4 rollback)
  ontology: 'ontology',   // per-domain ontology stores (O-series)
  drop:     'drop',       // drag-and-drop inbox; subfolder = domain
};

/** Absolute path to a named subdirectory of the daemon home. */
export function dir(key) {
  const sub = SUBDIRS[key];
  if (!sub) throw new Error(`unknown kernel dir "${key}" (known: ${Object.keys(SUBDIRS).join(', ')})`);
  return path.join(home(), sub);
}

/** Absolute path to a file inside the daemon home, e.g. file('daemon.json'). */
export function file(...parts) {
  return path.join(home(), ...parts);
}

/** Well-known registry files. */
export const DAEMON_STATE_FILE   = () => file('daemon.json');
export const SESSIONS_FILE       = () => file(SUBDIRS.sessions, 'index.json');
export const MISSIONS_FILE       = () => file(SUBDIRS.missions, 'index.json');
export const PORT_FILE           = () => file(SUBDIRS.run, 'daemon.port');
export const TOKEN_FILE          = () => file(SUBDIRS.run, 'daemon.token');
export const PID_FILE            = () => file(SUBDIRS.run, 'daemon.pid');

/** Create the home directory tree. Idempotent. */
export function ensureHome() {
  const root = home();
  fs.mkdirSync(root, { recursive: true });
  for (const sub of Object.values(SUBDIRS)) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  // Best-effort private mode. Windows ignores POSIX bits — the vault (S1) does
  // not rely on this for confidentiality, it encrypts. See vault.js.
  try { fs.chmodSync(root, 0o700); } catch { /* non-POSIX */ }
  return root;
}

// ── Registry I/O ────────────────────────────────────────────────────────────

/**
 * Read a JSON registry. Returns `fallback` when the file is absent, and also
 * when it is present but unparseable — a corrupt registry must not prevent the
 * daemon from booting. The corrupt file is preserved as `<name>.corrupt-<n>`
 * so the failure is inspectable rather than silently discarded.
 */
export function readRegistry(absPath, fallback = null) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    quarantine(absPath, raw);
    return fallback;
  }
}

/** Move a corrupt registry aside so a boot can proceed without losing evidence. */
function quarantine(absPath, raw) {
  for (let n = 1; n <= 20; n++) {
    const target = `${absPath}.corrupt-${n}`;
    if (fs.existsSync(target)) continue;
    try { fs.writeFileSync(target, raw, 'utf-8'); } catch { /* best effort */ }
    return;
  }
}

/**
 * Write a JSON registry atomically: temp file in the same directory, fsync,
 * then rename over the target. Rename-within-a-directory is atomic on both
 * NTFS and POSIX filesystems, so a reader never observes a partial file.
 */
export function writeRegistry(absPath, data) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  // Same directory as the target: rename across devices is not atomic (and
  // fails outright on Windows), so the temp file cannot live in os.tmpdir().
  const tmp = `${absPath}.tmp-${process.pid}`;
  const body = JSON.stringify(data, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, body, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, absPath);
  return absPath;
}

// ── Schema migration (S4) ───────────────────────────────────────────────────

/**
 * Run ordered, idempotent migration steps over a registry object.
 *
 * `migrations` maps a target version to a pure transform:
 *   { 2: data => ({ ...data, newField: [] }) }
 * A record at version 1 with migrations for 2 and 3 runs both, in order.
 *
 * Records with no `schemaVersion` are treated as version 0 — that is the
 * pre-versioning case, and it must migrate forward rather than be rejected.
 *
 * Returns `{ data, migrated, from, to }`. The caller decides whether to persist;
 * migrating in memory without writing is a valid read path.
 */
export function migrateRegistry(data, migrations = {}, target = SCHEMA_VERSION) {
  if (data == null || typeof data !== 'object') {
    return { data, migrated: false, from: null, to: target };
  }
  const from = Number.isInteger(data.schemaVersion) ? data.schemaVersion : 0;
  if (from > target) {
    // Written by a newer build. Refusing is safer than guessing: a downgrade
    // that drops fields it does not understand is silent data loss.
    throw new Error(
      `registry schemaVersion ${from} is newer than this build understands (${target}). ` +
      `Upgrade ${BRAND}, or remove the file to start fresh.`
    );
  }
  if (from === target) return { data, migrated: false, from, to: target };

  let cur = data;
  for (let v = from + 1; v <= target; v++) {
    const step = migrations[v];
    if (typeof step === 'function') cur = step(cur);
  }
  cur = { ...cur, schemaVersion: target };
  return { data: cur, migrated: true, from, to: target };
}

/**
 * Snapshot a registry before migrating it, so a failed migration can be rolled
 * back to exactly one prior version (S4). Returns the snapshot path, or null
 * when there was nothing to snapshot.
 */
export function snapshotRegistry(absPath, label = 'pre-migration') {
  if (!fs.existsSync(absPath)) return null;
  const snapDir = dir('snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  const target = path.join(snapDir, `${path.basename(absPath)}.${label}`);
  fs.copyFileSync(absPath, target);
  return target;
}

/** Restore a snapshot taken by snapshotRegistry(). Returns true when restored. */
export function restoreSnapshot(absPath, label = 'pre-migration') {
  const target = path.join(dir('snapshots'), `${path.basename(absPath)}.${label}`);
  if (!fs.existsSync(target)) return false;
  fs.copyFileSync(target, absPath);
  return true;
}
