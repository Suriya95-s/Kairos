// src/memoryd/import.js
// Bring existing per-workspace memory into the daemon's store (5.2).
//
// Every workspace that has ever run Kairos has an `.agent/` directory holding
// real history: an episodic Palace database, daily memory logs, learnings. None
// of it is disposable, and none of it should have to be re-earned because the
// storage model changed underneath it.
//
// So this is an *import*, not a migration in the destructive sense. The source
// files are read and left exactly where they are — the Palace keeps working for
// anything that still reads it, and if the import turns out to be wrong it can
// be undone by deleting rows in one scope rather than by restoring a backup.
// That asymmetry is the whole reason 5.1 added a new table instead of altering
// the Palace's schema in place.
//
// Idempotence is by sentinel file, following the `palace/migrate.js` pattern
// that already exists in this repo: `.agent/.memoryd-imported` records what was
// taken and when. Re-running is a no-op unless `force` is set.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite'; // built-in since Node 22.5

import config from '../config.js';
import { projectScope, GLOBAL } from './scopes.js';

const SENTINEL = '.memoryd-imported';

/** How many rows to take from each source. Import is a bootstrap, not a mirror. */
const LIMITS = Object.freeze({
  palace: 500,
  dailyLogs: 200,
  learnings: 100,
});

/**
 * Import one workspace's memory into the service.
 *
 * @param {object} service        MemoryService
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {boolean} [opts.force]  re-import even if the sentinel exists
 * @param {boolean} [opts.dryRun] report what would happen, write nothing
 * @param {string} [opts.identity]
 * @returns {{imported: number, skipped: boolean, bySource: object, scope: string}}
 */
export function importWorkspace(service, { workspace, force = false, dryRun = false, identity = 'default' } = {}) {
  if (!workspace) throw new Error('importWorkspace needs a workspace');
  const root = path.resolve(workspace);
  const scope = projectScope(root);
  const sentinelPath = path.join(root, config.agentDir, SENTINEL);

  if (!force && fs.existsSync(sentinelPath)) {
    return { imported: 0, skipped: true, bySource: {}, scope, reason: 'already imported' };
  }
  if (!fs.existsSync(path.join(root, config.agentDir))) {
    return { imported: 0, skipped: true, bySource: {}, scope, reason: 'no .agent directory' };
  }

  const bySource = {};
  let imported = 0;

  for (const [name, collect] of Object.entries(COLLECTORS)) {
    let records = [];
    try {
      records = collect(root) || [];
    } catch (err) {
      // One unreadable source must not abort the whole import — a corrupt
      // Palace should not cost the user their daily logs too.
      bySource[name] = { error: err.message, count: 0 };
      continue;
    }
    bySource[name] = { count: records.length };
    if (dryRun) continue;

    for (const rec of records) {
      try {
        service.remember({
          ...rec,
          scope: rec.scope || scope,
          identity,
          source: rec.source || `import:${name}`,
        });
        imported++;
      } catch {
        // A single malformed row (empty body, odd kind) is skipped rather than
        // failing the import around it.
      }
    }
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, JSON.stringify({
      importedAt: new Date().toISOString(),
      scope,
      identity,
      imported,
      bySource,
      // Recorded so a later build can tell whether an older, thinner import
      // needs re-running without guessing from row counts.
      importerVersion: 1,
    }, null, 2));
  }

  return { imported, skipped: false, bySource, scope };
}

// ── Sources ─────────────────────────────────────────────────────────────────

const COLLECTORS = {
  /** The episodic Palace: the richest source when it exists. */
  palace(root) {
    const dbPath = path.join(root, config.palaceDbFile);
    if (!fs.existsSync(dbPath)) return [];

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare(
        `SELECT timestamp, domain, summary, note, verbatim, who
           FROM memories
          WHERE archived = 0
          ORDER BY timestamp DESC
          LIMIT ?`
      ).all(LIMITS.palace);

      return rows.map(r => ({
        // The summary is what a human wrote or the model distilled; the
        // verbatim blob is usually a serialized event and makes poor recall
        // text. Prefer the summary, fall back only when there isn't one.
        body: (r.summary || r.note || String(r.verbatim || '')).slice(0, 2000),
        subject: r.domain || '',
        kind: 'event',
        // Palace timestamps are seconds, this service uses milliseconds.
        importance: 0.4,
      })).filter(r => r.body.trim().length > 0);
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  },

  /** Daily markdown logs under .agent/memory/. */
  dailyLogs(root) {
    const dir = path.join(root, config.memoryDir);
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 30);

    const out = [];
    for (const file of files) {
      let text;
      try { text = fs.readFileSync(path.join(dir, file), 'utf-8'); } catch { continue; }
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        // Bullets only: prose paragraphs from a daily log are usually narration
        // and make noisy recall hits.
        if (!/^[-*]\s+/.test(trimmed)) continue;
        const body = trimmed.replace(/^[-*]\s+/, '').trim();
        if (body.length < 12) continue;
        out.push({ body: body.slice(0, 1000), subject: file.replace(/\.md$/, ''), kind: 'fact', importance: 0.45 });
        if (out.length >= LIMITS.dailyLogs) return out;
      }
    }
    return out;
  },

  /** Accumulated learnings — closest thing the old model had to durable facts. */
  learnings(root) {
    const file = path.join(root, config.learningsFile);
    if (!fs.existsSync(file)) return [];
    let text;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { return []; }

    const out = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!/^[-*]\s+/.test(trimmed)) continue;
      const body = trimmed.replace(/^[-*]\s+/, '').trim();
      if (body.length < 12) continue;
      // A learning is a rule that was paid for; it outranks an episodic event.
      out.push({ body: body.slice(0, 1000), subject: 'learning', kind: 'skill', importance: 0.7 });
      if (out.length >= LIMITS.learnings) break;
    }
    return out;
  },
};

/** Has this workspace already been imported? */
export function isImported(workspace) {
  return fs.existsSync(path.join(path.resolve(workspace), config.agentDir, SENTINEL));
}

/** Read the import receipt, or null. */
export function importReceipt(workspace) {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(path.resolve(workspace), config.agentDir, SENTINEL), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Undo an import: drop the scope's rows and remove the sentinel.
 * This is the property that made an import the right choice over a schema
 * migration — the source files were never touched, so this is a full reversal.
 */
export function undoImport(service, { workspace, identity = 'default' } = {}) {
  const root = path.resolve(workspace);
  const removed = service.forgetScope(projectScope(root), identity);
  try { fs.rmSync(path.join(root, config.agentDir, SENTINEL)); } catch { /* already gone */ }
  return { removed, scope: projectScope(root) };
}

export { SENTINEL, GLOBAL };
