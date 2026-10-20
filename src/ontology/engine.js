// src/ontology/engine.js
// Orchestration: a dropped file becomes an evidence-backed ontology.
//
//   ingestFile(domain, filePath)
//     → snapshot (content-addressed)
//     → deterministic induction (object types, instances, relationships)
//     → documents journal (all candidates)
//     → cross-file link discovery over the whole domain
//     → summary for the bus / CLI / TUI
//
// Idempotent end to end: dropping the same bytes twice replays the snapshot
// and appends nothing new (appendDocument deep-equal check), so a watcher that
// fires twice — and on Windows fs.watch WILL fire twice — cannot double the
// ontology.

import fs from 'node:fs';
import path from 'node:path';
import { dir } from '../kernel/paths.js';
import crypto from 'node:crypto';
import {
  assertDomain, registerSnapshot, appendDocument, loadProjection, domainDir,
  withJournalLock,
} from './store.js';
import { induceFromFile, discoverLinks, mergeObjectTypePayload, SUPPORTED_EXTENSIONS } from './induce.js';

/** Files a file manager creates that must never be ingested. */
const IGNORE_RE = /(^~\$|^\.|\.tmp$|\.crdownload$|\.partial$|\.part$|\.swp$)/i;

export function isIngestible(filename) {
  const base = path.basename(String(filename));
  if (IGNORE_RE.test(base)) return false;
  const ext = base.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return SUPPORTED_EXTENSIONS.includes(ext);
}

/** The drag-and-drop inbox. A subfolder names its domain; the root is 'default'. */
export function dropDir() {
  return dir('drop');
}

export function domainForDroppedFile(filePath) {
  const rel = path.relative(dropDir(), path.resolve(filePath));
  if (rel.startsWith('..')) return 'default';
  const first = rel.split(path.sep)[0];
  if (!first || first === path.basename(rel)) return 'default';
  // Explorer folder names are arbitrary ("BTO Shop Test") — squeeze into the
  // domain rule (lowercase/digits/dashes, ≤41 chars) instead of failing.
  return first.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 41).replace(/^-+|-+$/g, '') || 'default';
}

// ── Intake: each ontology files its own source data away ────────────────────
//
// The drop folder is an INBOX, not a warehouse. Once a dropped file is safely
// snapshotted (content-addressed — the bytes can always be replayed), the
// original moves into the ontology's own intake folder, so each domain
// accumulates its source files in one place and the inbox stays empty.
// Evidence refs point at snapshots, never at these paths, so moving is free.

export function intakeDir(domain) {
  return path.join(domainDir(domain), 'intake');
}

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

/**
 * Move one ingested drop into its domain's intake folder. Only files inside
 * the drop inbox ever move — a CLI `ontology ingest ~/somewhere/file.csv`
 * must never relocate the user's file. Same-name collisions: identical bytes
 * delete the duplicate; different bytes get a numbered name. Never throws —
 * a failed move leaves the file in the inbox, which is safe (idempotent).
 * Returns the destination path, or null when nothing moved.
 */
export function archiveDroppedFile(domain, filePath) {
  const root = path.resolve(dropDir());
  const src = path.resolve(filePath);
  if (!src.startsWith(root + path.sep)) return null;
  try {
    const dest = path.join(intakeDir(domain), path.basename(src));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let target = dest;
    if (fs.existsSync(dest)) {
      if (sha256File(dest) === sha256File(src)) {
        fs.unlinkSync(src); // same bytes already filed — the drop was a duplicate
        pruneEmptyDropDirs(path.dirname(src));
        return dest;
      }
      const ext = path.extname(dest);
      const stem = path.basename(dest, ext);
      let n = 2;
      while (fs.existsSync(target = path.join(path.dirname(dest), `${stem}-${n}${ext}`))) n++;
    }
    try {
      fs.renameSync(src, target);
    } catch {
      fs.copyFileSync(src, target);
      fs.unlinkSync(src);
    }
    pruneEmptyDropDirs(path.dirname(src));
    return target;
  } catch {
    return null;
  }
}

/** Remove now-empty folders left behind by a move, up to (never including) the inbox root. */
function pruneEmptyDropDirs(from) {
  const root = path.resolve(dropDir());
  let cur = path.resolve(from);
  while (cur.startsWith(root + path.sep) && cur !== root) {
    try {
      if (fs.readdirSync(cur).length > 0) return;
      fs.rmdirSync(cur);
    } catch { return; }
    cur = path.dirname(cur);
  }
}

/**
 * Ingest one file into a domain. Returns a summary of what changed.
 * Never throws on unsupported content — the summary says so instead, because
 * a watcher must survive whatever gets dragged at it.
 */
export function ingestFile(domain, filePath, { sourceName } = {}) {
  assertDomain(domain);
  const name = sourceName || path.basename(filePath);
  if (!isIngestible(name)) {
    return { ok: false, domain, file: name, reason: `unsupported file type (supported: ${SUPPORTED_EXTENSIONS.join(' ')})` };
  }
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, domain, file: name, reason: `unreadable: ${err.code || err.message}` };
  }
  if (content.length === 0) return { ok: false, domain, file: name, reason: 'empty file' };
  if (content.length > 25 * 1024 * 1024) return { ok: false, domain, file: name, reason: 'file exceeds 25MB ingest cap' };

  const snapshot = registerSnapshot(domain, { sourceName: name, content });
  const induced = induceFromFile({ filename: name, content: content.toString('utf-8'), snapshotId: snapshot.id });
  if (induced.unsupported) {
    return { ok: false, domain, file: name, reason: `unsupported file type .${induced.unsupported}` };
  }

  let appended = 0;
  // One journal lock across the whole batch: a concurrent daemon/CLI ingest of
  // the same domain waits for a complete ingest, never interleaves with half
  // of one (and the version read-compute-append inside stays race-free).
  withJournalLock(domain, () => {
    const put = (kind, item) => {
      const res = appendDocument(domain, { kind, id: item.id, payload: item.payload });
      if (res.appended) appended++;
    };
    // Type unification (G1): a type this domain already knows gets the UNION
    // of property sets (with per-property provenance), never last-write —
    // and a re-drop can never demote an approved type back to candidate.
    const known = loadProjection(domain).object_type;
    induced.objectTypes.forEach((t) => {
      const prev = known.get(t.id);
      put('object_type', prev ? { id: t.id, payload: mergeObjectTypePayload(prev, t.payload) } : t);
    });
    induced.instances.forEach((i) => put('instance', i));
    induced.relationships.forEach((r) => put('relationship', r));

    // Cross-file linking sees the WHOLE domain, so a customers.csv dropped after
    // orders.csv still connects them — but only pairs this file touched are
    // re-scanned (G0 incremental mode); untouched pairs are already journaled.
    const touchedTypes = induced.objectTypes.map((t) => t.payload.name);
    const links = discoverLinks(loadProjection(domain), { touchedTypes });
    links.forEach((r) => put('relationship', r));

    put('ingest', {
      id: `ingest:${snapshot.id}:${name}`,
      payload: {
        file: name, snapshot: snapshot.id, bytes: snapshot.bytes,
        objectTypes: induced.objectTypes.length, instances: induced.instances.length,
        state: 'candidate', proposedBy: 'kairos-induction',
        evidence: [{ snapshot: snapshot.id, locator: 'file' }],
      },
    });
  });

  const proj = loadProjection(domain);
  return {
    ok: true, domain, file: name,
    snapshot: snapshot.id, snapshotExisted: snapshot.existed,
    appended,
    counts: proj.counts,
  };
}

/**
 * Scan the drop inbox and ingest everything that is new or changed.
 * Safe to run at every daemon boot and after every watcher event: idempotence
 * comes from content addressing, not from remembering what was seen.
 */
export function scanDropFolder() {
  const root = dropDir();
  let entries = [];
  try {
    entries = walk(root);
  } catch {
    return { scanned: 0, results: [] };
  }
  const results = [];
  for (const filePath of entries) {
    if (!isIngestible(filePath)) continue;
    const domain = domainForDroppedFile(filePath);
    const summary = ingestFile(domain, filePath);
    // Ingested drops get filed into the domain's intake folder; failed ones
    // stay visible in the inbox so the user notices them.
    if (summary.ok) summary.archivedTo = archiveDroppedFile(domain, filePath);
    results.push(summary);
  }
  return { scanned: entries.length, results };
}

function walk(root, depth = 0) {
  if (depth > 3) return [];
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) out.push(...walk(p, depth + 1));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * Watch the drop inbox. Debounced per file: editors and Explorer copy in
 * bursts, and a half-copied CSV must not be ingested. `onIngest(summary)` is
 * called once per settled file. Returns a close() function.
 */
export function watchDropFolder(onIngest, { settleMs = 1200 } = {}) {
  const root = dropDir();
  fs.mkdirSync(root, { recursive: true });
  const timers = new Map();
  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, relName) => {
      if (!relName) return;
      const filePath = path.join(root, relName.toString());
      const prev = timers.get(filePath);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        timers.delete(filePath);
        let stat;
        try { stat = fs.statSync(filePath); } catch { return; } // deleted mid-settle
        if (!stat.isFile() || !isIngestible(filePath)) return;
        const domain = domainForDroppedFile(filePath);
        const summary = ingestFile(domain, filePath);
        if (summary.ok) summary.archivedTo = archiveDroppedFile(domain, filePath);
        try { onIngest(summary); } catch { /* listener errors must not kill the watcher */ }
      }, settleMs);
      if (typeof t.unref === 'function') t.unref();
      timers.set(filePath, t);
    });
  } catch {
    return () => {};
  }
  return () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    try { watcher.close(); } catch { /* already closed */ }
  };
}

export default {
  isIngestible, dropDir, domainForDroppedFile, intakeDir, archiveDroppedFile,
  ingestFile, scanDropFolder, watchDropFolder,
};
