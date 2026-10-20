// src/chat/session.js
// Chat session persistence layer.
//
// Writes every turn to:
//   .agent/chats/<session-id>.jsonl   — turn-by-turn log
//   .agent/chats/index.json           — session index for lookup
//
// Each turn record:
//   { ts, sessionId, seq, role, content, workspace, mode, tags, promoted }
//
// When a chat session is promoted to long-running mode the promoted field is
// set to true and that turn is mirrored into the episodic store (if palace is
// active) with domain = "chat:<sessionId>".

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getWorkspace } from '../state.js';
import config from '../config.js';

// ── Paths ─────────────────────────────────────────────────────────────────────

function chatsDir() {
  return path.resolve(getWorkspace(), config.chatsDir);
}

function sessionFile(sessionId) {
  return path.join(chatsDir(), `${sessionId}.jsonl`);
}

function indexFile() {
  return path.join(chatsDir(), 'index.json');
}

// ── Index helpers ─────────────────────────────────────────────────────────────

function readIndex() {
  const f = indexFile();
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return {}; }
}

function writeIndex(idx) {
  fs.mkdirSync(chatsDir(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(idx, null, 2), 'utf-8');
}

function touchIndex(sessionId, meta) {
  const idx = readIndex();
  idx[sessionId] = { ...(idx[sessionId] || {}), ...meta, sessionId };
  writeIndex(idx);
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

/**
 * Generate a new session ID: date-prefix + 8 random hex chars.
 * @returns {string}
 */
export function newSessionId() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${d}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Append a turn to the session log and update the session index.
 *
 * @param {string} sessionId
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {object} [opts]
 * @param {string} [opts.mode]      'chat' or 'longrun'
 * @param {string[]} [opts.tags]
 * @param {boolean} [opts.promoted] true when this turn triggers long-running mode
 */
export function appendTurn(sessionId, role, content, opts = {}) {
  const dir = chatsDir();
  fs.mkdirSync(dir, { recursive: true });

  const idx = readIndex();
  const seq = (idx[sessionId]?.turnCount ?? 0) + 1;

  const turn = {
    ts:        new Date().toISOString(),
    sessionId,
    seq,
    role,
    content,
    workspace: getWorkspace(),
    mode:      opts.mode ?? 'chat',
    tags:      opts.tags ?? [],
    promoted:  opts.promoted ?? false,
  };

  fs.appendFileSync(sessionFile(sessionId), JSON.stringify(turn) + '\n', 'utf-8');

  touchIndex(sessionId, {
    firstTs:    idx[sessionId]?.firstTs ?? turn.ts,
    lastTs:     turn.ts,
    turnCount:  seq,
    workspace:  turn.workspace,
    mode:       turn.mode,
    promoted:   turn.promoted || (idx[sessionId]?.promoted ?? false),
  });

  // Mirror promoted turns into the episodic store when palace is active
  if (turn.promoted && config.palaceEnabled) {
    _mirrorToEpisodic(sessionId, turn);
  }

  return turn;
}

async function _mirrorToEpisodic(sessionId, turn) {
  try {
    const { getPalaceSession } = await import('../palace/session.js');
    const sess = getPalaceSession();
    if (!sess) return;
    sess.store.insert({
      who:      turn.role === 'user' ? 'user' : 'kairos-chat',
      domain:   `chat:${sessionId}`,
      summary:  turn.content.slice(0, 200),
      verbatim: JSON.stringify(turn),
    });
  } catch {
    // palace optional — ignore errors
  }
}

// ── Reading sessions ──────────────────────────────────────────────────────────

/**
 * Read all turns for a session, oldest-first.
 * @param {string} sessionId
 * @returns {object[]}
 */
export function readSession(sessionId) {
  const f = sessionFile(sessionId);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Return the N most recent turns across all sessions.
 * @param {number} n
 * @returns {object[]}
 */
export function recentTurns(n = 10) {
  const idx = readIndex();
  const sorted = Object.values(idx).sort((a, b) => (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));
  const turns = [];
  for (const meta of sorted) {
    if (turns.length >= n) break;
    const session = readSession(meta.sessionId);
    for (let i = session.length - 1; i >= 0 && turns.length < n; i--) {
      turns.push(session[i]);
    }
  }
  return turns.sort((a, b) => {
    const cmp = (a.ts ?? '').localeCompare(b.ts ?? '');
    return cmp !== 0 ? cmp : (a.seq ?? 0) - (b.seq ?? 0);
  });
}

/**
 * Search turns across all sessions for a keyword.
 * @param {string} query
 * @param {number} [limit=20]
 * @returns {object[]}
 */
export function searchTurns(query, limit = 20) {
  const idx = readIndex();
  const q = query.toLowerCase();
  const results = [];
  for (const meta of Object.values(idx)) {
    for (const turn of readSession(meta.sessionId)) {
      if (String(turn.content || '').toLowerCase().includes(q)) {
        results.push(turn);
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
}

/**
 * Return a brief human-readable summary of a session.
 * @param {string} sessionId
 * @returns {string}
 */
export function summarizeSession(sessionId) {
  const idx = readIndex();
  const meta = idx[sessionId];
  if (!meta) return `Session "${sessionId}" not found.`;
  const turns = readSession(sessionId);
  const firstUser = turns.find(t => t.role === 'user')?.content?.slice(0, 120) ?? '(no user turns)';
  return [
    `Session: ${sessionId}`,
    `  Turns:     ${meta.turnCount}`,
    `  First:     ${meta.firstTs ?? 'unknown'}`,
    `  Last:      ${meta.lastTs ?? 'unknown'}`,
    `  Workspace: ${meta.workspace ?? 'unknown'}`,
    `  Mode:      ${meta.mode ?? 'chat'}`,
    `  Promoted:  ${meta.promoted ? 'yes' : 'no'}`,
    `  Opening:   "${firstUser}"`,
  ].join('\n');
}

/**
 * List all sessions, most recent first.
 * @returns {object[]}
 */
export function listSessions() {
  const idx = readIndex();
  return Object.values(idx).sort((a, b) => (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));
}
