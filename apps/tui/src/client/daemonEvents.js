// apps/tui/src/client/daemonEvents.js
// Translate daemon bus events (D2) into the events the TUI already renders.
//
// The view layer understands 16 event types — session_start, step, tool_result,
// approval_requested, and so on. Those are exactly what a mission still emits;
// the kernel just wraps them. A mission child forwards its gateway events to the
// daemon, which republishes them as `mission_update` with the original event
// intact under `payload.event`.
//
// So the adapter is mostly an unwrap, not a rewrite. That is the point: the TUI
// gets multi-mission awareness without its rendering code learning what a
// daemon is.

/**
 * Convert one bus event into a TUI event, or null when it should be ignored.
 *
 * @param {object} evt              a D2 bus event
 * @param {object} [opts]
 * @param {string|null} [opts.missionId]  attach to one mission; other missions
 *                                        are dropped so two concurrent missions
 *                                        cannot interleave into one step list
 * @returns {object|null}
 */
export function adaptDaemonEvent(evt, { missionId = null } = {}) {
  if (!evt || typeof evt !== 'object') return null;
  const p = evt.payload || {};

  switch (evt.kind) {
    case 'mission_update': {
      if (missionId && p.missionId !== missionId) return null;

      // Gateway events pass straight through — they are already the shape the
      // view layer was written against.
      if (p.event && typeof p.event === 'object' && p.event.type) {
        return { ...p.event, missionId: p.missionId };
      }

      switch (p.action) {
        case 'running':
          return {
            type: 'session_start',
            id: p.missionId,
            episodeId: p.missionId,
            task: p.title || '',
            missionId: p.missionId,
          };

        case 'step':
          // Only synthesized when the mission did not already emit a native
          // `step` event; harmless if both arrive, since the view keys on step
          // number.
          return {
            type: 'step',
            step: p.step,
            tool: p.tool || '?',
            args: p.args || null,
            missionId: p.missionId,
          };

        case 'ended':
          return {
            type: 'session_end',
            exitReason: p.exitReason || p.state,
            totalSteps: p.lastStep || 0,
            summary: p.error || '',
            missionId: p.missionId,
          };

        case 'blocked':
          return {
            type: 'notice',
            level: 'warn',
            text: `mission ${p.missionId} is waiting: ${p.blockedReason}`,
            missionId: p.missionId,
          };

        default:
          return null;
      }
    }

    case 'health':
      // The daemon's own health is a first-class thing to show. A TUI that says
      // "connected" while the LLM endpoint is down is lying by omission.
      return {
        type: 'notice',
        level: p.state === 'healthy' ? 'info' : 'warn',
        text: `daemon: ${p.state}${p.reason ? ` — ${p.reason}` : ''}`,
      };

    case 'daemon_state':
      if (p.action === 'stopped') {
        return { type: 'notice', level: 'warn', text: `daemon stopped${p.reason ? `: ${p.reason}` : ''}` };
      }
      if (p.action === 'adopted') {
        return {
          type: 'notice',
          level: 'info',
          text: `daemon re-adopted ${p.missionIds?.length || 0} interrupted mission(s)`,
        };
      }
      if (p.action === 'disk_warning') {
        return {
          type: 'notice',
          level: 'warn',
          text: `daemon disk use at ${Math.round((p.ratio || 0) * 100)}% of quota`,
        };
      }
      return null;

    case 'utterance':
      // Echoed so a message sent from the CLI shows up in an attached TUI —
      // one conversation, several surfaces.
      return { type: 'user_message', text: p.text || '', sessionId: evt.sessionId };

    case 'voice':
      // The voice loop's telemetry — scores, rejections, answers, speaking —
      // rendered by the Voice view. Passed through whole; the view decides
      // what each phase looks like.
      return { type: 'voice', ...p };

    case 'brain':
      // B1's internal state, shown in the Voice view header (arousal is what
      // a verified wake word raises, so this is where it belongs on screen).
      return { type: 'brain', arousal: p.arousal, load: p.load, confidence: p.confidence };

    case 'ontology':
      // Drop-folder ingests and candidate promotions — rendered by the
      // Ontology view. Passed through whole; the view decides the icons.
      return { type: 'ontology', ...p };

    default:
      return null;
  }
}

/**
 * Wrap a TUI event handler so it accepts raw bus events.
 * @param {function} handler
 * @param {object}   [opts] forwarded to adaptDaemonEvent
 */
export function daemonEventAdapter(handler, opts = {}) {
  return (evt) => {
    const adapted = adaptDaemonEvent(evt, opts);
    if (adapted) handler(adapted);
  };
}
