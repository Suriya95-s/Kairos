// src/observability/telemetry.js
// Opt-in telemetry stub. Default OFF — set KAIROS_TELEMETRY=1 to enable.
// Writes structured events to .agent/telemetry/events.jsonl (local only).
// No data leaves the machine without an explicit KAIROS_TELEMETRY_ENDPOINT.
// Task 6.10 / N9

import fs from 'node:fs';
import path from 'node:path';
import { resolveContext } from '../runtime/context.js';

const ENDPOINT = process.env.KAIROS_TELEMETRY_ENDPOINT || '';

// Phase 1.4: workspace + sessionId were module-level, so a second run's
// initTelemetry() silently redirected the first run's events. Now per-context.
const SLOT = 'observability:telemetry';

function tel(ctx) {
  const c = resolveContext(ctx);
  return c.slot(SLOT, () => ({ workspace: c.workspace, sessionId: null }));
}

export function initTelemetry(workspace, sessionId, ctx) {
  const t = tel(ctx);
  t.workspace = workspace || resolveContext(ctx).workspace || process.cwd();
  t.sessionId = sessionId || null;
}

function eventsFile(c) {
  return path.join(tel(c).workspace, c.config.telemetryDir || '.agent/telemetry', 'events.jsonl');
}

/**
 * Record a telemetry event. No-op when disabled.
 * @param {string} name - Event name (e.g. 'session.start', 'step.complete')
 * @param {object} [payload]
 * @param {import('../runtime/context.js').AgentContext} [ctx]
 */
export function track(name, payload = {}, ctx) {
  const c = resolveContext(ctx);
  // Read the flag at call time, not module-load time: cli.js mutates config
  // during startup, so a module-scope `const ENABLED` captured a stale value.
  if (!c.config.telemetryEnabled) return;
  const event = {
    ts:        new Date().toISOString(),
    name,
    sessionId: tel(c).sessionId,
    ...payload,
  };
  _writeLocal(event, c);
  if (ENDPOINT) _sendRemote(event);
}

function _writeLocal(event, c) {
  try {
    const file = eventsFile(c);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf-8');
  } catch { /* non-critical */ }
}

function _sendRemote(event) {
  // Fire-and-forget — never block the agent loop
  Promise.resolve().then(async () => {
    try {
      await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* non-critical */ }
  });
}
