// apps/tui/src/client/backend.js
// Which backend does the TUI talk to? (3.6)
//
// Before the presence kernel there was exactly one answer: the per-run web-ui
// server on port 5180, owned by a single `agent` process, dying with it. The
// TUI was the cockpit of one loop.
//
// Now there can be a daemon, which outlives every run and every client. When it
// is up the TUI attaches to it and becomes one of its clients — closing the TUI
// stops nothing, and reopening it re-attaches to whatever is still going.
//
// Resolution is deliberately automatic with a manual override. A user who runs
// `agent "task"` in one terminal and opens the TUI in another must still get the
// legacy behaviour, or this upgrade breaks the existing workflow.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { readWebUiToken } from './token.js';

/** Daemon home — mirrors src/kernel/paths.js without importing across the app boundary. */
function daemonHome() {
  const override = process.env.KAIROS_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  const brand = (process.env.KAIROS_BRAND || 'kairos').trim().toLowerCase();
  return path.join(os.homedir(), `.${brand}`);
}

function readRunFile(name) {
  try {
    const v = fs.readFileSync(path.join(daemonHome(), 'run', name), 'utf-8').trim();
    return v || null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * Is a daemon actually running? Both the pid AND the run files must check out:
 * a crashed daemon leaves its port file behind, and connecting to a port nobody
 * is listening on would show "connecting…" forever instead of an honest
 * "not running".
 */
export function daemonAvailable() {
  const pidRaw = readRunFile('daemon.pid');
  if (!pidRaw || !pidAlive(parseInt(pidRaw, 10))) return false;
  return !!(readRunFile('daemon.port') && readRunFile('daemon.token'));
}

/**
 * Pick a backend.
 *
 * @param {object} opts
 * @param {number} opts.port          the legacy/live-view port (from --port)
 * @param {string} opts.root          project root, for the legacy token file
 * @param {'auto'|'daemon'|'legacy'} [opts.prefer]
 * @returns {{kind: string, port: number, token: string, label: string, detail: string}}
 */
export function resolveBackend({ port, root, prefer = 'auto' } = {}) {
  const wantDaemon = prefer === 'daemon' || (prefer === 'auto' && daemonAvailable());

  if (wantDaemon) {
    const dPort = parseInt(readRunFile('daemon.port') || '', 10);
    const token = readRunFile('daemon.token');
    if (Number.isInteger(dPort) && token) {
      return {
        kind: 'daemon',
        port: dPort,
        token,
        label: 'daemon',
        detail: `attached to the daemon on port ${dPort} — closing the TUI leaves missions running`,
      };
    }
    if (prefer === 'daemon') {
      // Explicitly asked for the daemon and it is not there. Say so rather than
      // silently falling back to a port that will also be empty.
      return {
        kind: 'daemon-missing',
        port: dPort || port,
        token: '',
        label: 'daemon (not running)',
        detail: 'no daemon found — start one with "kairosd start", or drop --daemon to use a single run',
      };
    }
  }

  return {
    kind: 'legacy',
    port,
    token: readWebUiToken(root),
    label: 'single run',
    detail: `watching one agent run on port ${port}`,
  };
}
