// src/palace/session.js
// Palace session — holds the live EpisodicStore + RoomGraph for a run.
// Initialized by loop.js when AGENT_USE_PALACE=1.
//
// Phase 1.3 (de-globalization): this was a module-level `_session` singleton.
// Two concurrent missions in one process would share the FIRST one's episodic
// database — the second `initPalace()` returned early and silently wrote its
// memories into the other workspace's store. The session now lives in a
// per-context slot, and the SQLite handle is released via ctx.dispose().
//
// The `_instances` cache in episodic-store.js is keyed by absolute dbPath, so
// distinct workspaces already map to distinct handles; the leak was here.

import path from 'node:path';
import { getEpisodicStore, closeEpisodicStore } from './episodic-store.js';
import { buildRoomGraph } from './rooms.js';
import { resolveContext } from '../runtime/context.js';

const DB_RELPATH = '.agent/palace/episodic.db';
const SLOT = 'palace:session';

/**
 * Per-context holder. Created empty so the disposer is registered exactly once,
 * up front — otherwise a context disposed before initPalace() would leak, and a
 * disposer registered later could run out of order relative to other handles.
 */
function holder(ctx) {
  const c = resolveContext(ctx);
  return c.slot(
    SLOT,
    () => ({ session: null }),
    {
      workspaceScoped: true,
      dispose: (h) => {
        if (h.session) {
          closeEpisodicStore(h.session.dbPath);
          h.session = null;
        }
      },
    }
  );
}

/**
 * Initialize the palace session.
 * Builds the room graph, opens the episodic store, runs migration if needed.
 * @param {{ noMigrate?: boolean }} [opts]
 * @param {import('../runtime/context.js').AgentContext} [ctx]
 * @returns {Promise<{ store, graph, dbPath }>}
 */
export async function initPalace(opts = {}, ctx) {
  const c = resolveContext(ctx);
  const h = holder(c);
  if (h.session) return h.session;

  const workspace = c.workspace;
  const dbPath    = path.join(workspace, DB_RELPATH);

  const store = getEpisodicStore(dbPath);
  const graph = buildRoomGraph(workspace);

  // Run LMMA → palace migration on first boot
  const { migrateLmmaBanks } = await import('./migrate.js');
  migrateLmmaBanks(store, opts);

  h.session = { store, graph, dbPath };
  return h.session;
}

/** Return the current session, or null if palace not initialized. */
export function getPalaceSession(ctx) {
  return holder(ctx).session;
}

/** Close the palace session (called on shutdown). */
export function closePalace(ctx) {
  const h = holder(ctx);
  if (h.session) {
    closeEpisodicStore(h.session.dbPath);
    h.session = null;
  }
}

/** Refresh the room graph (call after file-writes to keep graph current). */
export function refreshRoomGraph(ctx) {
  const c = resolveContext(ctx);
  const h = holder(c);
  if (!h.session) return;
  h.session.graph = buildRoomGraph(c.workspace);
}
