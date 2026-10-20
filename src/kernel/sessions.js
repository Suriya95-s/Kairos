// src/kernel/sessions.js
// The session registry (D3): a session is a *conversation*, a mission is a *job*.
// A session can own several missions; a mission always belongs to a session, or
// to the synthetic `system` session for self-initiated work (P6 triggers).
//
// Sessions outlive the daemon. That is the whole point of a presence kernel:
// closing the TUI must not end the conversation, and `kill -9` must not either.
// So the registry is file-backed and every mutation persists atomically.
//
// What is deliberately NOT persisted: the live client handle. A socket cannot
// be serialized, and writing one down means that after a restart the registry
// claims a connection that does not exist. Only the *shape* of the last client
// survives a restart; the handle itself is re-attached when a client reconnects.

import { randomUUID } from 'node:crypto';

import {
  SESSIONS_FILE,
  SCHEMA_VERSION,
  readRegistry,
  writeRegistry,
  migrateRegistry,
} from './paths.js';

/** Lifecycle states for a conversation. */
export const SESSION_STATES = Object.freeze(['idle', 'reflex', 'mission', 'closed']);

/** The always-present session that owns self-initiated work (timers, watchers). */
export const SYSTEM_SESSION_ID = 'system';

/** Ordered migrations for the sessions registry (S4). */
const MIGRATIONS = {
  // 1: initial versioned shape.
  1: (data) => ({ sessions: data.sessions || {}, ...data }),
};

export class SessionRegistry {
  /**
   * @param {object}   [opts]
   * @param {string}   [opts.filePath]  default ~/.<brand>/sessions/index.json
   * @param {object}   [opts.bus]       publishes session_update events when present
   * @param {function} [opts.now]       injectable clock
   * @param {function} [opts.newId]     injectable id generator
   * @param {boolean}  [opts.persist]   false → memory only (unit tests)
   */
  constructor({ filePath = null, bus = null, now = Date.now, newId = null, persist = true } = {}) {
    this._filePath = filePath;
    this._bus = bus;
    this._now = now;
    this._newId = newId || (() => `s-${randomUUID().slice(0, 8)}`);
    this._persist = persist;
    /** @type {Map<string, object>} sessionId → record (no client handle) */
    this._sessions = new Map();
    /** @type {Map<string, object>} sessionId → live client handle, memory only */
    this._clients = new Map();
    this._loaded = false;
  }

  get filePath() { return this._filePath || SESSIONS_FILE(); }

  // ── Persistence ───────────────────────────────────────────────────────────

  /**
   * Load from disk, migrating on the way in (S4). Idempotent; a second call is
   * a no-op so the daemon can call it defensively.
   */
  load() {
    if (this._loaded) return this;
    this._loaded = true;
    if (!this._persist) { this._ensureSystemSession(); return this; }

    const raw = readRegistry(this.filePath, null);
    if (raw) {
      const { data } = migrateRegistry(raw, MIGRATIONS, SCHEMA_VERSION);
      for (const [id, rec] of Object.entries(data.sessions || {})) {
        // A session recorded mid-mission while the daemon died is not still
        // running one — the mission manager re-adopts and corrects this. Until
        // then, reporting `idle` is honest; reporting `mission` is not.
        this._sessions.set(id, { ...rec, id, client: null });
      }
    }
    this._ensureSystemSession();
    return this;
  }

  /** Persist the whole registry atomically. */
  save() {
    if (!this._persist) return this;
    const sessions = {};
    for (const [id, rec] of this._sessions) {
      // Strip the live handle; keep only what is meaningful after a restart.
      const { client, ...persistable } = rec;
      sessions[id] = persistable;
    }
    writeRegistry(this.filePath, { schemaVersion: SCHEMA_VERSION, sessions });
    return this;
  }

  _ensureSystemSession() {
    if (this._sessions.has(SYSTEM_SESSION_ID)) return;
    const ts = this._now();
    this._sessions.set(SYSTEM_SESSION_ID, {
      id: SYSTEM_SESSION_ID,
      state: 'idle',
      missionIds: [],
      workspace: null,
      identity: 'default',
      clientKind: null,
      title: 'system',
      createdAt: ts,
      updatedAt: ts,
      lastSeenAt: ts,
    });
  }

  /**
   * Copy a record for handing out. Must clone `missionIds` too: a spread is
   * shallow, so callers would otherwise hold a live reference into the registry
   * and could mutate it through what looks like a read-only copy.
   */
  _snapshot(rec) {
    return { ...rec, missionIds: [...(rec.missionIds || [])] };
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Open a new conversation.
   * @param {object} [opts]
   * @param {string} [opts.workspace]  default working directory for its missions
   * @param {string} [opts.clientKind] 'tui' | 'cli' | 'web' | 'voice'
   * @param {*}      [opts.client]     live handle, kept in memory only
   */
  create({ workspace = null, clientKind = null, client = null, identity = 'default', title = null } = {}) {
    this.load();
    const ts = this._now();
    const id = this._newId();
    const rec = {
      id,
      state: 'idle',
      missionIds: [],
      workspace: workspace || null,
      identity,
      clientKind,
      title: title || null,
      createdAt: ts,
      updatedAt: ts,
      lastSeenAt: ts,
    };
    this._sessions.set(id, rec);
    if (client) this._clients.set(id, client);
    this.save();
    this._emit(rec, 'created');
    return this._snapshot(rec);
  }

  /** Fetch a session record (a copy — callers must not mutate the registry). */
  get(id) {
    this.load();
    const rec = this._sessions.get(id);
    return rec ? this._snapshot(rec) : null;
  }

  /** All sessions, optionally filtered by state. Newest first. */
  list({ state = null } = {}) {
    this.load();
    let all = [...this._sessions.values()].map(r => this._snapshot(r));
    if (state) all = all.filter(r => r.state === state);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Patch a session. Unknown ids throw — a silent no-op here would make a
   * routing bug look like a delivery bug much later.
   */
  update(id, patch = {}) {
    this.load();
    const rec = this._sessions.get(id);
    if (!rec) throw new Error(`unknown session "${id}"`);
    if (patch.state !== undefined && !SESSION_STATES.includes(patch.state)) {
      throw new Error(`invalid session state "${patch.state}" (expected: ${SESSION_STATES.join(', ')})`);
    }
    // id and createdAt are identity, not data.
    const { id: _ignoredId, createdAt: _ignoredCreated, client, ...safe } = patch;
    const next = { ...rec, ...safe, updatedAt: this._now() };
    this._sessions.set(id, next);
    if (client !== undefined) {
      if (client) this._clients.set(id, client);
      else this._clients.delete(id);
    }
    this.save();
    this._emit(next, 'updated');
    return this._snapshot(next);
  }

  /** Record that a client is alive on this session (drives idle reaping). */
  touch(id) {
    return this.update(id, { lastSeenAt: this._now() });
  }

  /** Attach a mission to a session and move it into the `mission` state. */
  attachMission(id, missionId) {
    this.load();
    const rec = this._sessions.get(id);
    if (!rec) throw new Error(`unknown session "${id}"`);
    if (rec.missionIds.includes(missionId)) return this._snapshot(rec);
    return this.update(id, {
      missionIds: [...rec.missionIds, missionId],
      state: 'mission',
    });
  }

  /**
   * Detach a finished mission. The session returns to `idle` only when its last
   * mission ends — a session running two missions that loses one is still busy.
   */
  detachMission(id, missionId) {
    this.load();
    const rec = this._sessions.get(id);
    if (!rec) throw new Error(`unknown session "${id}"`);
    const missionIds = rec.missionIds.filter(m => m !== missionId);
    const state = missionIds.length === 0 && rec.state === 'mission' ? 'idle' : rec.state;
    return this.update(id, { missionIds, state });
  }

  /** Live client handle for a session, if one is currently attached. */
  client(id) { return this._clients.get(id) ?? null; }

  /** Attach a live client handle (memory only) and record its kind. */
  attachClient(id, client, clientKind = null) {
    this.load();
    if (!this._sessions.has(id)) throw new Error(`unknown session "${id}"`);
    this._clients.set(id, client);
    return this.update(id, {
      clientKind: clientKind ?? this._sessions.get(id).clientKind,
      lastSeenAt: this._now(),
    });
  }

  /** Detach the live client. The session itself survives — that is presence. */
  detachClient(id) {
    this.load();
    this._clients.delete(id);
    if (!this._sessions.has(id)) return null;
    return this.update(id, { lastSeenAt: this._now() });
  }

  /**
   * Close a session. Marked `closed` rather than deleted so its transcript and
   * mission history stay resolvable; `purge()` is the destructive one.
   */
  close(id) {
    if (id === SYSTEM_SESSION_ID) throw new Error('the system session cannot be closed');
    const rec = this.update(id, { state: 'closed' });
    this._clients.delete(id);
    return rec;
  }

  /** Permanently remove closed sessions older than `olderThanMs`. */
  purge({ olderThanMs = 30 * 86_400_000 } = {}) {
    this.load();
    const cutoff = this._now() - olderThanMs;
    const removed = [];
    for (const [id, rec] of [...this._sessions]) {
      if (id === SYSTEM_SESSION_ID) continue;
      if (rec.state !== 'closed' || rec.updatedAt > cutoff) continue;
      this._sessions.delete(id);
      this._clients.delete(id);
      removed.push(id);
    }
    if (removed.length) this.save();
    return removed;
  }

  _emit(rec, action) {
    if (!this._bus) return;
    try {
      this._bus.publish({
        source: 'system',
        kind: 'session_update',
        sessionId: rec.id,
        payload: { action, state: rec.state, missionIds: rec.missionIds, workspace: rec.workspace },
      });
    } catch {
      // The registry is the source of truth; a bus failure must not roll back a
      // committed state change.
    }
  }
}
