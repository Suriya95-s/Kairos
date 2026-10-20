// src/hitl/steeringChannel.js
// Human → agent mid-run steering injection.
// Messages written to .agent/hitl/steer/<id>.json by the CLI.
// Consumed by loop.js at the start of each step and injected into context.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import config from '../config.js';
import { workspaceResolve } from '../runtime/workspacePath.js';
import { appendAudit, emitEvent } from './gateway.js';

// Resolves through the AgentContext when one is active (the daemon runs each
// mission inside its own), falling back to the config singleton for direct CLI
// calls. See src/runtime/workspacePath.js for why this indirection exists.
function resolve(rel) {
  return workspaceResolve(rel);
}

function ensureDir() {
  fs.mkdirSync(resolve(config.hitlSteerDir), { recursive: true });
}

/**
 * Human calls this (via CLI / web UI) to inject a steering message.
 * @param {string} message
 * @returns {string} messageId
 */
export function addSteeringMessage(message) {
  ensureDir();
  const id = randomUUID();
  const entry = { id, message, timestamp: Date.now() };
  fs.writeFileSync(
    resolve(path.join(config.hitlSteerDir, `${id}.json`)),
    JSON.stringify(entry, null, 2)
  );
  appendAudit({ type: 'steering_injected', id, message: message.slice(0, 200) });
  emitEvent({ type: 'steering_injected', id, message: message.slice(0, 200), timestamp: Date.now() });
  return id;
}

/**
 * Consume all pending steering messages — returns them and removes from disk.
 * Called by loop.js at the start of each step.
 * @returns {string[]}  array of message strings, oldest first
 */
export function consumeSteering() {
  ensureDir();
  const dir = resolve(config.hitlSteerDir);
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const fp = path.join(dir, f);
      try { return { file: fp, data: JSON.parse(fs.readFileSync(fp, 'utf-8')) }; }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.data.timestamp - b.data.timestamp);

  const messages = [];
  for (const { file, data } of files) {
    messages.push(data.message);
    fs.unlinkSync(file);
  }
  return messages;
}

/**
 * List all pending steering messages without consuming them.
 * @returns {Array<{id, message, timestamp}>}
 */
export function listSteering() {
  ensureDir();
  const dir = resolve(config.hitlSteerDir);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);
}
