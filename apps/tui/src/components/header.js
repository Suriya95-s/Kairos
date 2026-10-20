// src/components/header.js - one-line header bar

import { C, padEnd, visLen, clip, g, y, r, cy, gr, vi, bandLR, reducedMotion } from '../render.js';
import { state, latencyP } from '../state.js';

const SPIN = '|/-\\';

export function renderHeader(W) {
  const statusDot = statusIndicator();

  // Meta as mid-dot-joined spans in receding ink (redesign §5) — calm, scannable.
  const meta = [];
  if (state.episodeId)   meta.push(`${C.ink4}ep-${state.episodeId.replace(/^ep-/, '').slice(-9)}${C.reset}`);
  if (state.step > 0)    meta.push(`${C.ink3}step ${C.ink2}${state.step}${C.reset}`);
  if (state.stage)       meta.push(`${C.ink3}${state.stage}${C.reset}`);
  if (state.costUsd > 0) meta.push(`${C.jade}$${state.costUsd.toFixed(3)}${C.reset}`);
  const p95 = latencyP(0.95);
  if (p95 > 0)           meta.push(`${C.ink3}p95 ${(p95 / 1000).toFixed(1)}s${C.reset}`);

  let pipeStr = '';
  if (state.agentPipeline) {
    pipeStr = '  ' + state.agentPipeline.map((agent) => {
      if (agent.status === 'done')    return `${C.jade}${agent.role} ✓${C.reset}`;
      if (agent.status === 'running') return `${C.amber}${agent.role} ▶${C.reset}`;
      return `${C.ink4}${agent.role}${C.reset}`;
    }).join(`${C.ink4} · ${C.reset}`);
  }

  const hitlBadge = state.pendingApprovals.length > 0
    ? `  ${C.bold}${C.amber}⚠ ${state.pendingApprovals.length} APPROVAL${state.pendingApprovals.length > 1 ? 'S' : ''} [a]/[d]${C.reset}`
    : '';

  const metaStr = meta.length ? `  ${meta.join(`${C.ink4} · ${C.reset}`)}` : '';
  const left = ` ${C.iris}◆${C.reset} ${C.bold}${C.iris}KAIROS${C.reset}  ${statusDot}${metaStr}${pipeStr}${hitlBadge}`;
  const hints = `${C.ink3}[1–7]${C.reset}  ${C.ink3}[/] cmd${C.reset}  ${C.ink4}[?] help${C.reset}`;
  // Keep the instruments intact; shed the right-side hints when space is tight
  // (they're mirrored in the command-bar hint line, so nothing is truly lost).
  if (visLen(left) + visLen(hints) + 1 > W) return padEnd(clip(left, W), W);
  return bandLR(left, hints, W);
}

function statusIndicator() {
  // Reconnect honesty (Wave E-4): when the SSE stream is actively retrying, say so
  // — never present stale session state as if it were live. A prior episodeId means
  // we had a session and dropped (RECONNECTING) vs. an initial CONNECTING.
  if (state.connecting && !state.connected) {
    const mark = reducedMotion() ? '▷' : SPIN[state._spinFrame % SPIN.length];
    const verb = state.episodeId ? 'RECONNECTING' : 'CONNECTING';
    const attempts = state.reconnectAttempts > 0 ? ` (try ${state.reconnectAttempts})` : '…';
    return y(mark) + C.yellow + ` ${verb}${attempts}` + C.reset;
  }

  // Each state carries a DISTINCT glyph (not just a distinct color) so it is
  // legible in monochrome and to color-blind operators — color is redundant.
  switch (state.status) {
    case 'attached':
      // Connected to a live daemon with no mission running. Distinct from
      // RUNNING (something is happening) and from CONNECTING (nothing is).
      return g('●') + C.bold + C.green + ' ATTACHED' + C.reset;
    case 'running':
      return g('▶') + C.bold + C.green + ' RUNNING' + C.reset;
    case 'paused':
      return y('‖') + C.bold + C.yellow + ' PAUSED' + C.reset;
    case 'completed':
      return cy('✓') + C.bold + C.cyan + ' DONE' + C.reset;
    case 'error':
      return r('✗') + C.bold + C.red + ' ERROR' + C.reset;
    case 'connecting': {
      // Reduced-motion: a static marker instead of the animated spinner.
      const mark = reducedMotion() ? '▷' : SPIN[state._spinFrame % SPIN.length];
      return y(mark) + C.yellow + ' CONNECTING...' + C.reset;
    }
    default:
      return gr('· DISCONNECTED');
  }
}
