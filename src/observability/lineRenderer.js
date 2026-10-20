// src/observability/lineRenderer.js
// Wave E-1 — In-process line renderer (the `--no-tui` / screen-reader / CI path).
// Consumes the same SSE event payloads the TUI does (src/hitl/gateway.js emitEvent),
// but renders each as a single plain, prefix-tagged line instead of an alt-screen UI.
// First-class peer of the TUI: one event bus, two renderers.
//
// `formatEvent` is PURE and deterministic (no timestamps, no I/O) so it can be unit
// tested exhaustively. The thin `lineFor` wrapper prepends a wall-clock stamp for the
// live writer; tests call `formatEvent` directly.

const MAX = 200; // clamp long fields so a line stays one screen-readable unit

function clip(s, n = MAX) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/**
 * Map one SSE event to a single tagged line, or null for events that carry no
 * standalone signal in line mode (per-step cost/metrics noise — their content is
 * folded into STEP and DONE lines).
 * @param {object} ev — a parsed SSE event payload
 * @returns {string|null}
 */
export function formatEvent(ev) {
  if (!ev || !ev.type) return null;
  switch (ev.type) {
    case 'session_start':
      return `SESSION ${ev.episodeId || ev.id || '?'} model=${ev.model || '?'}${ev.resume ? ' (resumed)' : ''} task="${clip(ev.task, 120)}"`;

    case 'step': {
      const stage = ev.stage ? `[${ev.stage}] ` : '';
      const arg = ev.arg || (ev.args ? clip(JSON.stringify(ev.args), 50) : '');
      const tool = ev.tool || ev.action || '?';
      const thought = ev.thought ? ` — ${clip(ev.thought, 80)}` : '';
      return `STEP ${ev.step ?? '?'} ${stage}${tool}${arg ? ` ${clip(arg, 60)}` : ''}${thought}`;
    }

    case 'tool_result':
      return `  ${ev.error ? '✗ ERR' : '✓ ok'} ${clip(ev.result, 160)}`;

    case 'approval_requested':
      return `APPROVAL NEEDED ${ev.tool || '?'} — ${clip(ev.reason || ev.thought, 120)} [id ${ev.id || '?'}]`;

    case 'approval_response':
      return `APPROVAL ${ev.approved ? 'approved' : 'denied'} [id ${ev.id || '?'}]`;

    case 'approval_timeout':
      return `APPROVAL TIMEOUT (auto-denied) [id ${ev.id || '?'}]`;

    case 'clarification_asked':
      return `CLARIFY? ${clip(ev.question, 160)} [id ${ev.id || '?'}]`;

    case 'clarification_answered':
      return `CLARIFY answered: ${clip(ev.answer, 120)} [id ${ev.id || '?'}]`;

    case 'steering_injected':
      return `STEER ${clip(ev.message, 160)}`;

    case 'paused':  return 'PAUSED';
    case 'resumed': return 'RESUMED';
    case 'compaction': return `COMPACTION (memory compacted at step ${ev.step ?? '?'})`;

    case 'session_end': {
      const cost = typeof ev.costUsd === 'number' ? ` $${ev.costUsd.toFixed(4)}` : '';
      return `DONE ${ev.exitReason || '?'} (${ev.totalSteps ?? '?'} steps${cost})`;
    }

    // Folded into STEP/DONE lines — no standalone line (avoids per-step spam).
    case 'cost_update':
    case 'stage_metrics':
      return null;

    default:
      return null;
  }
}

/**
 * Live-writer helper: a timestamped line, or null to suppress.
 * @param {object} ev
 * @param {string} [nowIso] — injectable for tests; defaults to wall clock.
 * @returns {string|null}
 */
export function lineFor(ev, nowIso) {
  const body = formatEvent(ev);
  if (body == null) return null;
  const ts = nowIso || new Date().toISOString().slice(11, 19); // HH:MM:SS
  return `${ts}  ${body}`;
}

/**
 * Attach an in-process line renderer to the gateway event bus. Returns an
 * unsubscribe function. Used by `src/cli.js` for `--no-tui`/`--line`.
 * @param {{ addSseListener: function, removeSseListener: function }} gateway
 * @param {function} [write] — sink (defaults to stdout)
 * @returns {function} unsubscribe
 */
export function attachLineRenderer(gateway, write = (s) => process.stdout.write(s + '\n')) {
  const listener = (payload) => {
    let ev;
    try { ev = typeof payload === 'string' ? JSON.parse(payload) : payload; }
    catch { return; }
    const line = lineFor(ev);
    if (line != null) write(line);
  };
  gateway.addSseListener(listener);
  return () => gateway.removeSseListener(listener);
}
