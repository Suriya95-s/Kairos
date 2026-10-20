// src/chat/conversation.js
// One transcript per session (4.3).
//
// Before the daemon, a conversation was a chat log and a run was a run, and
// they lived in different places. That is fine when you watch one run to
// completion; it falls apart the moment a session owns several missions and
// the user drifts between asking questions and starting work. "What did we
// decide about the auth refactor?" has to be answerable from one ordered
// record, not by mentally interleaving a chat file with a mission registry.
//
// So: user turns, reflex answers, and mission milestones all append to one
// JSONL file per session, in the order they happened.
//
// What deliberately does NOT go in: per-step mission events. A mission emits
// hundreds, and a transcript that is 98% `step 47: read_file` is not a
// conversation — it is a log with some talking in it. Milestones only; the bus
// journal remains the place to see every step.

import fs from 'node:fs';
import path from 'node:path';

/** Turn kinds that may appear in a transcript. */
export const TURN_ROLES = Object.freeze(['user', 'assistant', 'mission', 'system']);

/**
 * Mission actions worth a line in the conversation. Everything else — steps,
 * heartbeats, hitl chatter — stays on the bus.
 */
const MILESTONE_ACTIONS = Object.freeze(['running', 'ended', 'blocked', 'interrupted', 'stopping']);

/** Default location: alongside the session registry in the daemon home. */
function defaultDir() {
  const override = process.env.KAIROS_HOME;
  const brand = (process.env.KAIROS_BRAND || 'kairos').trim().toLowerCase();
  const home = override && override.trim()
    ? path.resolve(override.trim())
    : path.join(process.env.HOME || process.env.USERPROFILE || '.', `.${brand}`);
  return path.join(home, 'sessions');
}

export class Conversation {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dir]  where transcripts live
   * @param {function} [opts.now]
   */
  constructor({ dir = null, now = Date.now } = {}) {
    this._dir = dir;
    this._now = now;
    this._seq = new Map();   // sessionId → last sequence number
  }

  get dir() { return this._dir || defaultDir(); }

  transcriptPath(sessionId) {
    return path.join(this.dir, sanitize(sessionId), 'transcript.jsonl');
  }

  /** Append a turn. Returns the written record. */
  append(sessionId, role, content, meta = {}) {
    if (!TURN_ROLES.includes(role)) throw new Error(`unknown turn role "${role}"`);
    const file = this.transcriptPath(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // A monotonic sequence alongside the timestamp: several turns can land in
    // the same millisecond (a reflex answer and the mission it proposed), and
    // sorting by time alone would let them swap places on read.
    const seq = (this._seq.get(sessionId) ?? this._lastSeqOnDisk(sessionId)) + 1;
    this._seq.set(sessionId, seq);

    const turn = {
      ts: this._now(),
      seq,
      sessionId,
      role,
      content: String(content ?? ''),
      ...meta,
    };
    fs.appendFileSync(file, JSON.stringify(turn) + '\n');
    return turn;
  }

  _lastSeqOnDisk(sessionId) {
    const turns = this.read(sessionId);
    return turns.length ? turns[turns.length - 1].seq ?? turns.length : 0;
  }

  /** What the user said. */
  userSaid(sessionId, text, meta = {}) {
    return this.append(sessionId, 'user', text, meta);
  }

  /** What the reflex answered. */
  assistantSaid(sessionId, text, meta = {}) {
    return this.append(sessionId, 'assistant', text, meta);
  }

  /**
   * Record a mission milestone — or ignore it, if it is routine progress.
   * @returns {object|null} the turn, or null when the event was not a milestone
   */
  missionEvent(sessionId, payload = {}) {
    if (!MILESTONE_ACTIONS.includes(payload.action)) return null;
    const text = describeMission(payload);
    if (!text) return null;
    return this.append(sessionId, 'mission', text, {
      missionId: payload.missionId ?? null,
      action: payload.action,
      state: payload.state ?? null,
      exitReason: payload.exitReason ?? null,
    });
  }

  /** Read the whole transcript, oldest first. */
  read(sessionId) {
    let text;
    try { text = fs.readFileSync(this.transcriptPath(sessionId), 'utf-8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn final line */ }
    }
    return out;
  }

  /**
   * The last N turns as `{role, content}` — the shape the reflex engine wants.
   * Mission milestones become `system` notes so the model knows what has been
   * happening without being able to mistake them for something the user said.
   */
  history(sessionId, n = 10) {
    return this.read(sessionId).slice(-n).map(t => ({
      role: t.role === 'assistant' ? 'assistant' : t.role === 'user' ? 'user' : 'system',
      content: t.role === 'mission' ? `[mission] ${t.content}` : t.content,
    }));
  }

  /** Turns belonging to one mission — "what happened with that job?". */
  forMission(sessionId, missionId) {
    return this.read(sessionId).filter(t => t.missionId === missionId);
  }

  /** Drop a session's transcript. */
  clear(sessionId) {
    try { fs.rmSync(this.transcriptPath(sessionId)); return true; } catch { return false; }
  }
}

function describeMission(p) {
  switch (p.action) {
    case 'running':     return `started: ${p.title || p.missionId}`;
    case 'blocked':     return `waiting: ${p.blockedReason || 'blocked'}`;
    case 'stopping':    return 'stopping…';
    case 'interrupted': return 'interrupted — resumable from its checkpoint';
    case 'ended': {
      const how = p.exitReason || p.state || 'ended';
      return p.error ? `finished (${how}): ${p.error}` : `finished (${how})`;
    }
    default: return '';
  }
}

function sanitize(id) {
  const cleaned = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  // `.` and `..` survive a charset filter intact and ARE meaningful path
  // segments — the same trap as the mission-id sanitiser in state.js.
  if (!cleaned || /^\.+$/.test(cleaned)) return 'unnamed';
  return cleaned;
}

let _conversation = null;

export function getConversation(opts) {
  if (!_conversation) _conversation = new Conversation(opts);
  return _conversation;
}

export function resetConversation() {
  _conversation = null;
}
