// src/agents/manifest.js
// Wave D-2 — Durable conductor manifest.
// Persists the multi-agent orchestration state to .agent/conductor-state.json so a
// run can resume after a crash/restart. Reuses the single-agent checkpoint philosophy
// (review point 6): a thin manifest, NOT a divergent per-agent persistence layer.
// The actual work products are the handoff files (handoff.js); this just tracks
// per-role status + results so completed roles are skipped on resume.

import fs   from 'node:fs';
import path from 'node:path';
import { getWorkspace } from '../state.js';

const MANIFEST_FILE = '.agent/conductor-state.json';

function manifestPath(workspace) {
  return path.join(workspace || getWorkspace(), MANIFEST_FILE);
}

/**
 * Read the conductor manifest for a session. Returns null when none exists or it
 * belongs to a different session (a stale manifest from an unrelated run).
 * @param {string} workspace
 * @param {string} sessionId
 * @returns {object|null}
 */
export function readManifest(workspace, sessionId) {
  const abs = manifestPath(workspace);
  if (!fs.existsSync(abs)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    if (sessionId && obj.sessionId !== sessionId) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * Atomically write the conductor manifest (tmp-file + rename, mirroring state.js).
 * @param {string} workspace
 * @param {object} manifest
 */
export function writeManifest(workspace, manifest) {
  const abs = manifestPath(workspace);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const payload = JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }, null, 2);
  const tmp = `${abs}.tmp`;
  fs.writeFileSync(tmp, payload, 'utf-8');
  fs.renameSync(tmp, abs);
}

/**
 * Build a fresh manifest with every role marked 'pending'.
 * @param {string} sessionId
 * @param {string} task
 * @param {{role: string}[]} assignments
 * @returns {object}
 */
export function initManifest(sessionId, task, assignments) {
  const status = {};
  for (const a of assignments) status[a.role] = 'pending';
  return {
    sessionId,
    task: String(task || '').slice(0, 2000),
    assignments,
    status,
    results: [],
    budget: null,
  };
}

/**
 * Delete the manifest (fresh-start cleanup).
 * @param {string} workspace
 */
export function clearManifest(workspace) {
  const abs = manifestPath(workspace);
  if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
}
