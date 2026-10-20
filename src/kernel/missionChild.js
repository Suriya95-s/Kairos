#!/usr/bin/env node
// src/kernel/missionChild.js
// The thin wrapper that runs one mission inside its own OS process.
//
// Why a child process rather than an in-process ctx (Phase 1 made both
// possible): crash containment. A mission is arbitrary model-driven work that
// runs `run_command`, loads MCP servers, and can exhaust memory. An always-on
// daemon must survive all of that. A segfault in a mission should cost one
// mission, not the user's whole presence layer.
//
// The child speaks to the daemon over Node's IPC channel only. It writes no
// registry files — the daemon owns all shared state, so there is exactly one
// writer and no lock needed between them.
//
// Protocol (child → parent):
//   { type: 'ready' }
//   { type: 'step',  step, tool, args, resultPreview }
//   { type: 'hitl',  event }          — forwarded gateway events (approvals, …)
//   { type: 'result', result }        — the runLoop return value
//   { type: 'error',  message, stack }

import { runLoop } from '../loop.js';
import { setWorkspace, initAgentDir, writeTask } from '../state.js';
import { addSseListener } from '../hitl/gateway.js';
import { getAmbientContext } from '../runtime/context.js';

/** Send to the parent, tolerating a channel that has already closed. */
function send(msg) {
  if (typeof process.send !== 'function') return;
  try { process.send(msg); } catch { /* parent gone; the exit code still tells the story */ }
}

async function main() {
  const specRaw = process.env.KAIROS_MISSION_SPEC;
  if (!specRaw) {
    send({ type: 'error', message: 'KAIROS_MISSION_SPEC is not set' });
    process.exit(2);
  }

  let spec;
  try {
    spec = JSON.parse(specRaw);
  } catch (err) {
    send({ type: 'error', message: `unparseable mission spec: ${err.message}` });
    process.exit(2);
  }

  const { missionId, task, workspace, profile = null, model = null, maxSteps = null, resume = false } = spec;

  setWorkspace(workspace);
  initAgentDir();
  // On a fresh mission the task file is the source of truth the loop reads back;
  // on resume it already exists and overwriting it would discard any steering
  // the user applied to the paused mission.
  if (!resume && task) writeTask(task);

  // Forward HITL/step events (the existing 16 SSE event types) to the daemon so
  // they can be republished on the bus. This is how approvals reach a phone in
  // P7 without the mission knowing anything about transports.
  addSseListener((payload) => {
    let event = payload;
    if (typeof payload === 'string') {
      try { event = JSON.parse(payload); } catch { event = { raw: payload }; }
    }
    send({ type: 'hitl', event });
  });

  send({ type: 'ready', missionId, pid: process.pid });

  try {
    const result = await runLoop({
      task,
      workspace,
      resume,
      profile: profile || undefined,
      model: model || null,
      maxSteps: maxSteps || null,
      missionId,
      // The daemon owns SIGINT/SIGTERM semantics for the fleet; this flag is the
      // Phase 1.6 hook that stops runLoop from installing its own handlers.
      daemonMode: true,
      onStep: (step, action, toolResult) => {
        send({
          type: 'step',
          step,
          tool: action?.tool ?? null,
          args: action?.args ?? null,
          resultPreview: String(toolResult ?? '').slice(0, 300),
        });
      },
    });
    send({ type: 'result', result });
    process.exit(0);
  } catch (err) {
    send({ type: 'error', message: err?.message || String(err), stack: err?.stack || null });
    process.exit(1);
  }
}

// A mission child runs in daemon mode, so runLoop deliberately does NOT install
// its own signal handlers (Phase 1.6). Translate SIGTERM into the cooperative
// stop instead: the loop finishes its current step, saves a checkpoint, and
// returns 'interrupted' — which is what makes `<brand> stop` resumable rather
// than destructive.
function requestGracefulStop(signal) {
  send({ type: 'hitl', event: { type: 'shutdown_requested', source: 'daemon', signal } });
  const stop = getAmbientContext().requestShutdown;
  if (typeof stop === 'function') stop();
  // If the loop is wedged inside a long tool call it may never reach the next
  // step boundary. Insist after a grace period rather than hanging the daemon's
  // own shutdown behind it.
  const grace = parseInt(process.env.KAIROS_MISSION_STOP_GRACE_MS || '20000', 10);
  const timer = setTimeout(() => process.exit(143), grace);
  if (typeof timer.unref === 'function') timer.unref();
}

process.on('SIGTERM', () => requestGracefulStop('SIGTERM'));
// The parent also asks politely over IPC, which works on Windows where signals
// are largely a fiction.
process.on('message', (msg) => {
  if (msg && msg.type === 'stop') requestGracefulStop('ipc');
});

main();
