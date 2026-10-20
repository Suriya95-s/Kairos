// src/hitl/approvalQueue.js
// File-based approval/denial queue for Human-in-the-Loop gate.
// Pending requests: .agent/hitl/pending/<id>.json
// Responses:        .agent/hitl/responses/<id>.json

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import config from '../config.js';
import { workspaceResolve } from '../runtime/workspacePath.js';

// Resolves through the AgentContext when one is active (the daemon runs each
// mission inside its own), falling back to the config singleton for direct CLI
// calls. See src/runtime/workspacePath.js for why this indirection exists.
function resolve(rel) {
  return workspaceResolve(rel);
}

function ensureDirs() {
  fs.mkdirSync(resolve(config.hitlPendingDir), { recursive: true });
  fs.mkdirSync(resolve(config.hitlResponsesDir), { recursive: true });
}

/**
 * Write a pending approval request.
 * @param {string} tool
 * @param {object} args
 * @param {string} reason  — why approval is needed
 * @param {number} timeoutMs
 * @returns {string} requestId
 */
export function enqueue(tool, args, reason, timeoutMs) {
  ensureDirs();
  const id = randomUUID();
  const req = {
    id,
    tool,
    args,
    reason,
    timeoutMs,
    timestamp: Date.now(),
    status: 'pending',
  };
  const file = resolve(path.join(config.hitlPendingDir, `${id}.json`));
  fs.writeFileSync(file, JSON.stringify(req, null, 2));
  return id;
}

/**
 * List all pending (unanswered) requests.
 * @returns {Array<object>}
 */
export function listPending() {
  ensureDirs();
  const dir = resolve(config.hitlPendingDir);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .filter(r => r.status === 'pending');
}

/**
 * Get a pending request by id (or null).
 * @param {string} id
 */
export function getRequest(id) {
  const file = resolve(path.join(config.hitlPendingDir, `${id}.json`));
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return null; }
}

/**
 * Write a response (approve or deny) for a given request id.
 * @param {string} id
 * @param {boolean} approved
 * @param {string} [reason]
 */
export function writeResponse(id, approved, reason = '') {
  ensureDirs();
  const resp = { id, approved, reason, timestamp: Date.now() };
  fs.writeFileSync(
    resolve(path.join(config.hitlResponsesDir, `${id}.json`)),
    JSON.stringify(resp, null, 2)
  );
  // Mark request as resolved
  const reqFile = resolve(path.join(config.hitlPendingDir, `${id}.json`));
  if (fs.existsSync(reqFile)) {
    try {
      const req = JSON.parse(fs.readFileSync(reqFile, 'utf-8'));
      req.status = approved ? 'approved' : 'denied';
      fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));
    } catch { /* best-effort */ }
  }
}

/**
 * Poll for a response to a request (non-blocking — returns null if not ready).
 * @param {string} id
 * @returns {{approved: boolean, reason: string}|null}
 */
export function getResponse(id) {
  const file = resolve(path.join(config.hitlResponsesDir, `${id}.json`));
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return null; }
}

/**
 * Remove a pending request (cleanup after response consumed).
 * @param {string} id
 */
export function removeRequest(id) {
  const f = resolve(path.join(config.hitlPendingDir, `${id}.json`));
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
