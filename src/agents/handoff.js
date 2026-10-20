// src/agents/handoff.js
// Phase 3 — Handoff contract: memory deltas between agents.
// Each agent writes .agent/handoffs/<session-id>/<role>.md when it finishes.
// The next agent reads all previous handoffs as additional context.

import fs   from 'node:fs';
import path from 'node:path';
import { getWorkspace } from '../state.js';

const HANDOFFS_DIR = '.agent/handoffs';

function handoffDir(sessionId) {
  return path.join(getWorkspace(), HANDOFFS_DIR, sessionId);
}

function handoffPath(sessionId, role) {
  return path.join(handoffDir(sessionId), `${role}.md`);
}

/**
 * Write a handoff file for a completed agent role.
 * @param {string} sessionId  — conductor session ID (e.g. "ep-1234567890")
 * @param {string} role       — agent role name
 * @param {{ summary: string, artifacts?: string[], notes?: string }} content
 */
export function writeHandoff(sessionId, role, content) {
  const dir = handoffDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });

  // Explicit ordering key. Sorting by mtimeMs alone is unreliable: consecutive
  // handoffs frequently land in the same filesystem millisecond, after which
  // ordering degrades to readdir order. That is not merely a flaky test — the
  // order here IS the order the next specialist reads its predecessors' context
  // in (see buildHandoffContext), so an unstable sort silently scrambles the
  // narrative handed to the next agent.
  const seq = fs.readdirSync(dir).filter(f => f.endsWith('.md')).length;

  const lines = [
    `<!-- handoff seq=${seq} -->`,
    `# Handoff: ${role}`,
    `_Written at ${new Date().toISOString()}_`,
    '',
    '## Summary',
    content.summary || '(no summary)',
  ];

  if (content.artifacts?.length) {
    lines.push('', '## Artifacts Produced');
    for (const a of content.artifacts) lines.push(`- ${a}`);
  }

  if (content.notes) {
    lines.push('', '## Notes for Next Agent');
    lines.push(content.notes);
  }

  fs.writeFileSync(handoffPath(sessionId, role), lines.join('\n') + '\n', 'utf-8');
}

/**
 * Read all handoff files for a session, ordered by modification time.
 * @param {string} sessionId
 * @returns {{ role: string, content: string }[]}
 */
export function readHandoffs(sessionId) {
  const dir = handoffDir(sessionId);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const seqMatch = content.match(/^<!-- handoff seq=(\d+) -->/);
      return {
        role:    path.basename(f, '.md'),
        // Handoffs written before the seq header existed fall back to mtime
        // ordering, which is what they were written with.
        seq:     seqMatch ? Number(seqMatch[1]) : Number.POSITIVE_INFINITY,
        mtime:   fs.statSync(path.join(dir, f)).mtimeMs,
        content,
      };
    })
    // Deterministic total order: explicit seq → mtime → filename. The final
    // tiebreak matters because same-millisecond writes are the common case.
    .sort((a, b) => (a.seq - b.seq) || (a.mtime - b.mtime) || a.role.localeCompare(b.role))
    .map(({ role, content }) => ({ role, content }));
}

/**
 * Build the handoff context block to prepend to a specialist agent's task.
 * Includes all handoffs from roles that completed before this one.
 * @param {string} sessionId
 * @param {string} currentRole  — exclude this role's own handoff
 * @returns {string}  Markdown block, empty string if no handoffs yet.
 */
export function buildHandoffContext(sessionId, currentRole) {
  const handoffs = readHandoffs(sessionId).filter(h => h.role !== currentRole);
  if (handoffs.length === 0) return '';

  const parts = ['## Previous Agent Handoffs\n'];
  for (const h of handoffs) {
    parts.push(`### From ${h.role}\n${h.content}\n`);
  }
  return parts.join('\n');
}

/**
 * List all session IDs that have handoff directories.
 * @returns {string[]}
 */
export function listSessions() {
  const base = path.join(getWorkspace(), HANDOFFS_DIR);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter(d =>
    fs.statSync(path.join(base, d)).isDirectory()
  );
}

/** Delete all handoffs for a session (cleanup). */
export function clearHandoffs(sessionId) {
  const dir = handoffDir(sessionId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
