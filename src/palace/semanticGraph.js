// src/palace/semanticGraph.js
// Semantic triple store: (subject, predicate, object) facts about the workspace.
// Persisted as JSONL in .agent/palace/semantic.jsonl.
// Supports query-by-subject, query-by-object, and full-text search.

import fs   from 'node:fs';
import path from 'node:path';
import { resolveContext } from '../runtime/context.js';

const REL_PATH = '.agent/palace/semantic.jsonl';

/** @typedef {{ id: string, subject: string, predicate: string, object: string, confidence: number, createdAt: number }} Triple */

// Resolve against the PASSED context, not the ambient one. Keeping the cache
// per-context while the file path stayed ambient meant both contexts read and
// wrote the same file — a half-migration that looks isolated and is not.
function absPath(ctx) {
  return resolveContext(ctx).resolve(REL_PATH);
}

function load(ctx) {
  const abs = absPath(ctx);
  if (!fs.existsSync(abs)) return [];
  return fs.readFileSync(abs, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function append(triple, ctx) {
  const abs = absPath(ctx);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(triple) + '\n', 'utf-8');
}

// Phase 1.3: the triple cache was module-level while its backing file is
// workspace-relative, so switching workspaces served the previous project's
// semantic facts. Now workspace-scoped per-context state.
const SLOT = 'palace:semanticGraph';

function store(ctx) {
  return resolveContext(ctx).slot(
    SLOT,
    () => ({ cache: null, dirty: false }),
    { workspaceScoped: true }
  );
}

function getAll(ctx) {
  const s = store(ctx);
  if (!s.cache) s.cache = load(ctx);
  return s.cache;
}

/**
 * Assert a semantic fact.
 * @param {string} subject
 * @param {string} predicate
 * @param {string} object
 * @param {number} confidence  0–1
 * @returns {Triple}
 */
export function assert(subject, predicate, object, confidence = 1.0, ctx) {
  const id = `${subject}::${predicate}::${object}`;
  const all = getAll(ctx);
  const existing = all.find(t => t.id === id);
  if (existing) return existing; // idempotent — same triple already stored
  const triple = {
    id,
    subject:    String(subject),
    predicate:  String(predicate),
    object:     String(object),
    confidence: Math.max(0, Math.min(1, confidence)),
    createdAt:  Date.now() / 1000,
  };
  all.push(triple);
  append(triple, ctx);
  store(ctx).dirty = true;
  return triple;
}

/**
 * Query all triples where subject matches.
 * @param {string} subject
 * @returns {Triple[]}
 */
export function queryBySubject(subject, ctx) {
  return getAll(ctx).filter(t => t.subject === subject);
}

/**
 * Query all triples where object matches.
 * @param {string} object
 * @returns {Triple[]}
 */
export function queryByObject(object, ctx) {
  return getAll(ctx).filter(t => t.object === object);
}

/**
 * Full-text search across all triple fields.
 * @param {string} query
 * @param {number} topK
 * @returns {Triple[]}
 */
export function search(query, topK = 10, ctx) {
  const q = query.toLowerCase();
  return getAll(ctx)
    .filter(t =>
      t.subject.toLowerCase().includes(q) ||
      t.predicate.toLowerCase().includes(q) ||
      t.object.toLowerCase().includes(q)
    )
    .slice(0, topK);
}

/** Return all triples. */
export function getTriples(ctx) { return getAll(ctx); }

/** Return count of stored facts. */
export function count(ctx) { return getAll(ctx).length; }

/** Flush cache (called after migration or compaction). */
export function flush(ctx) {
  const s = store(ctx);
  s.cache = null;
  s.dirty = false;
}
