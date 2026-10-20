// src/memoryd/scopes.js
// Memory keys change from `cwd` to `(identity, scope)` — design decision D5.
//
// Until now, memory was per-workspace by construction: `.agent/` lived beside
// the code, so what the system knew depended on which directory it happened to
// be in. That is right for "this project uses tabs" and completely wrong for
// "I prefer to be told before anything is deployed" — a standing preference
// that vanishes when you change directory is not a preference, it is a note.
//
// Three scopes, and the boundaries matter more than the mechanism:
//
//   global          who the user is, standing preferences — today's USER.md
//   project:<path>  what is true about one codebase — today's .agent/
//   session:<id>    what was said in one conversation — today's chats
//
// The reason to be strict about this is not tidiness. A reflex answering a
// question in a chat window must not be able to read a private project's
// contents, and a mission running in one repository must not learn facts from
// another. Scope IS the access-control boundary; 5.5's policy is built on it.

import path from 'node:path';

/** The three scope kinds. */
export const SCOPE_KINDS = Object.freeze(['global', 'project', 'session']);

/** The single global scope. */
export const GLOBAL = 'global';

/**
 * Scope for a project directory.
 *
 * The path is normalised and lower-cased: on Windows `C:\Proj` and `c:\proj`
 * are the same directory, and treating them as different scopes would silently
 * split a project's memory in two.
 */
export function projectScope(workspace) {
  if (!workspace) return GLOBAL;
  let resolved = path.resolve(String(workspace));
  // Trailing separators are cosmetic; keep the root's.
  if (resolved.length > 1) resolved = resolved.replace(/[\\/]+$/, '');
  const normalized = process.platform === 'win32'
    ? resolved.replace(/\\/g, '/').toLowerCase()
    : resolved;
  return `project:${normalized}`;
}

/** Scope for one conversation. */
export function sessionScope(sessionId) {
  if (!sessionId) return GLOBAL;
  return `session:${String(sessionId)}`;
}

/** Split a scope string into its kind and value. */
export function parseScope(scope) {
  const s = String(scope || GLOBAL);
  if (s === GLOBAL) return { kind: 'global', value: null };
  const idx = s.indexOf(':');
  if (idx === -1) return { kind: 'global', value: null };
  const kind = s.slice(0, idx);
  if (!SCOPE_KINDS.includes(kind)) return { kind: 'global', value: null };
  return { kind, value: s.slice(idx + 1) };
}

/** Is this a well-formed scope string? */
export function isValidScope(scope) {
  const s = String(scope || '');
  if (s === GLOBAL) return true;
  const { kind, value } = parseScope(s);
  return kind !== 'global' && !!value;
}

// ── Recall policy (5.5) ─────────────────────────────────────────────────────

/**
 * Which scopes each layer may read, by default.
 *
 * Deliberately asymmetric. A reflex is conversational and often answers about
 * the user rather than about code, so it gets `global + session` — but NOT
 * project memory, because a fast path with no gates should not be able to
 * surface a private repository's contents into a chat window.
 *
 * A mission is already scoped to a workspace and already runs behind the
 * finish gates, so it gets all three.
 *
 * The router only needs to know who it is talking to.
 */
export const RECALL_POLICY = Object.freeze({
  reflex:  Object.freeze(['global', 'session']),
  mission: Object.freeze(['global', 'project', 'session']),
  router:  Object.freeze(['global']),
  system:  Object.freeze(['global', 'project', 'session']),
});

/**
 * Resolve the concrete scope strings a layer may read right now.
 *
 * @param {'reflex'|'mission'|'router'|'system'} layer
 * @param {object} [ctx]
 * @param {string} [ctx.sessionId]
 * @param {string} [ctx.workspace]
 * @returns {string[]} concrete scopes, most-general first
 */
export function scopesFor(layer, { sessionId = null, workspace = null } = {}) {
  const allowed = RECALL_POLICY[layer];
  if (!allowed) throw new Error(`unknown recall layer "${layer}" (expected: ${Object.keys(RECALL_POLICY).join(', ')})`);

  const out = [];
  for (const kind of allowed) {
    if (kind === 'global') out.push(GLOBAL);
    // A layer entitled to project memory but running without a workspace gets
    // nothing rather than everything — an absent scope must never widen access.
    if (kind === 'project' && workspace) out.push(projectScope(workspace));
    if (kind === 'session' && sessionId) out.push(sessionScope(sessionId));
  }
  return out;
}

/**
 * May `layer` read `scope` without an explicit cross-scope request?
 * Used to decide whether a recall needs an audit entry.
 */
export function isScopeAllowed(layer, scope, ctx = {}) {
  return scopesFor(layer, ctx).includes(scope);
}
