// src/ontology/store.js
// The ontology engine's persistence: content-addressed snapshots + an
// append-only documents journal folded into typed projections.
//
// Adapted from LOGOS (packages/persistence + the documents-table pattern),
// minified to Kairos's zero-dependency rules. Three invariants carried over,
// because each has already earned its keep there or here:
//
//   1. CONTENT ADDRESSING. A snapshot's identity IS its sha256. Re-ingesting
//      the same bytes replays idempotently; a snapshot file whose bytes no
//      longer match its own name is detected as tampering and refused.
//   2. APPEND-ONLY + PROJECTION. Documents are never edited in place — a new
//      version is appended and the projection folds to the latest. History is
//      an audit trail for free, and a crash mid-write loses one line, not the
//      store.
//   3. THE PUBLISH BOUNDARY. Everything induced from data is born a
//      `candidate`. Promotion to `approved` requires evidence refs and an
//      approver different from the proposer — "agents propose, humans
//      dispose", enforced in the store, not the UI.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dir } from '../kernel/paths.js';
import { mergeObjectTypePayload } from './induce.js';

/** Document kinds the projection understands. Anything else is preserved but unprojected. */
export const DOC_KINDS = ['object_type', 'relationship_type', 'instance', 'relationship', 'ingest', 'proposal'];

/** Change operations a proposal may carry. A closed set — the verifier's permission slip. */
export const PROPOSAL_OPS = [
  'rename', 'describe', 'add_relation',
  // G2 — agentic graph engineering: the verifier grows up, but every op still
  // lands as a candidate proposal a human must approve before anything moves.
  'merge_types', 'retire_relation', 'retype_property', 'merge_instances', 'annotate',
];

/** Publication states, LOGOS-style. Missing edges are policy: retired never returns. */
export const PUB_STATES = ['candidate', 'approved', 'retired'];

const DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function assertDomain(domain) {
  if (!DOMAIN_RE.test(String(domain || ''))) {
    throw new Error(`invalid ontology domain "${domain}" (lowercase letters, digits, dashes)`);
  }
  return domain;
}

export function domainDir(domain) {
  return path.join(dir('ontology'), assertDomain(domain));
}

export function listDomains() {
  try {
    return fs.readdirSync(dir('ontology'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && DOMAIN_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── Snapshots ────────────────────────────────────────────────────────────────

/**
 * Register source bytes as a content-addressed snapshot.
 * Identity derives from content, so identical bytes replay (existed: true).
 * A pre-existing snapshot file whose bytes hash differently from its own name
 * is tampering, and registration throws rather than papering over it.
 */
export function registerSnapshot(domain, { sourceName, content, mediaType = 'text/plain' }) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf-8');
  const hash = sha256(bytes);
  const id = `snapshot:${hash.slice(0, 24)}`;
  const snapDir = path.join(domainDir(domain), 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  const contentPath = path.join(snapDir, `${hash.slice(0, 24)}.bin`);
  const metaPath = path.join(snapDir, `${hash.slice(0, 24)}.json`);

  if (fs.existsSync(contentPath)) {
    const onDisk = sha256(fs.readFileSync(contentPath));
    if (onDisk !== hash) {
      throw new Error(`snapshot ${id} exists with different bytes — content-addressed IDs never change meaning`);
    }
    return { id, sha256: hash, bytes: bytes.length, contentPath, existed: true };
  }

  fs.writeFileSync(contentPath, bytes);
  fs.writeFileSync(metaPath, JSON.stringify({
    id, sha256: hash, bytes: bytes.length, sourceName: String(sourceName || 'unknown'),
    mediaType, capturedAt: Date.now(),
  }, null, 2));
  return { id, sha256: hash, bytes: bytes.length, contentPath, existed: false };
}

export function readSnapshotMeta(domain, snapshotId) {
  const short = String(snapshotId).replace(/^snapshot:/, '');
  const metaPath = path.join(domainDir(domain), 'snapshots', `${short}.json`);
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { return null; }
}

/** An evidence ref pins a claim to bytes: snapshot + locator inside it. */
export function evidenceRef(snapshotId, locator, contentHash = null) {
  return { snapshot: snapshotId, locator: String(locator), ...(contentHash ? { contentHash } : {}) };
}

// ── Documents journal ────────────────────────────────────────────────────────

function journalPath(domain) {
  return path.join(domainDir(domain), 'documents.jsonl');
}

// ── Journal write lock (G0) ──────────────────────────────────────────────────
//
// The daemon's watcher and a CLI command are separate processes writing the
// same journal. Version numbers are read-compute-append, so two unsynchronised
// writers can both compute version N+1 and the projection silently drops one
// of them. An advisory lockfile (O_EXCL create) serialises writers; readers
// never block. Re-entrant within a process so one ingest can hold the lock
// across its whole append batch.

const LOCK_STALE_MS = 10_000; // a writer gone this long is dead — steal its lock
const heldLocks = new Set();  // lock paths this process currently holds

function lockTimeoutMs() {
  const n = Number(process.env.KAIROS_LOCK_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
}

/** Synchronous sleep without spinning a core — Atomics.wait on a throwaway buffer. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding the domain's journal write lock. Re-entrant in-process;
 * cross-process contention waits up to KAIROS_LOCK_TIMEOUT_MS (default 2s) and
 * then throws — blocking a UI forever is worse than telling the user to retry.
 * A lockfile older than LOCK_STALE_MS belongs to a dead writer and is stolen.
 */
export function withJournalLock(domain, fn) {
  const file = journalPath(domain) + '.lock';
  if (heldLocks.has(file)) return fn();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs();
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; } // vanished between open and stat — retry now
      if (ageMs > LOCK_STALE_MS) { try { fs.unlinkSync(file); } catch { /* raced another stealer */ } continue; }
      if (Date.now() >= deadline) {
        throw new Error(`ontology journal for "${domain}" is locked by another writer — try again`);
      }
      sleepSync(25);
    }
  }
  heldLocks.add(file);
  try {
    return fn();
  } finally {
    heldLocks.delete(file);
    try { fs.unlinkSync(file); } catch { /* stolen as stale — nothing left to release */ }
  }
}

// ── Journal fold cache (G0) ──────────────────────────────────────────────────
//
// Every read used to re-parse the whole journal — O(journal) per call, and an
// ingest of N rows made N such calls. The fold (latest version per kind/id) is
// now cached per journal FILE (never per domain name — tests repoint
// KAIROS_HOME, and a name-keyed cache would leak across homes), invalidated by
// the file's (mtimeMs, size) stamp. An append from another process changes the
// stamp; the next read refolds. Correct beats fast: a missing stamp match
// always refolds from bytes.

const FOLD_CACHE_MAX = 32;
const foldCache = new Map(); // journalPath → { stamp, latest: Map<kind\n id, doc> }

function journalStamp(file) {
  try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return 'absent'; }
}

function foldJournal(domain) {
  const file = journalPath(domain);
  const stamp = journalStamp(file);
  const hit = foldCache.get(file);
  if (hit && hit.stamp === stamp) return hit.latest;
  const latest = new Map();
  for (const doc of readJournal(domain)) {
    const key = `${doc.kind}\n${doc.id}`;
    const cur = latest.get(key);
    if (!cur || doc.version > cur.version) latest.set(key, doc);
  }
  if (foldCache.size >= FOLD_CACHE_MAX) foldCache.delete(foldCache.keys().next().value);
  foldCache.set(file, { stamp, latest });
  return latest;
}

/**
 * Append a document version. Idempotent: when the latest version of (kind,id)
 * already carries a payload deep-equal to this one, nothing is written and the
 * existing version is returned. Otherwise version = latest + 1. The whole
 * read-compute-append runs under the journal write lock, so concurrent writers
 * cannot both mint the same version number.
 */
export function appendDocument(domain, { kind, id, payload }) {
  if (!kind || !id) throw new Error('appendDocument requires kind and id');
  return withJournalLock(domain, () => {
    const existing = latestVersion(domain, kind, id);
    if (existing && JSON.stringify(existing.payload) === JSON.stringify(payload)) {
      return { ...existing, appended: false };
    }
    const version = (existing?.version || 0) + 1;
    const doc = { kind, id, version, payload, at: Date.now() };
    const file = journalPath(domain);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(doc) + '\n');
    // Keep the fold warm: we know exactly what changed, so update in place and
    // restamp instead of refolding the whole file on the next read.
    const hit = foldCache.get(file);
    if (hit) { hit.latest.set(`${kind}\n${id}`, doc); hit.stamp = journalStamp(file); }
    return { ...doc, appended: true };
  });
}

function readJournal(domain) {
  let raw;
  try { raw = fs.readFileSync(journalPath(domain), 'utf-8'); } catch { return []; }
  const docs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { docs.push(JSON.parse(line)); } catch { /* a torn tail line is not fatal */ }
  }
  return docs;
}

function latestVersion(domain, kind, id) {
  return foldJournal(domain).get(`${kind}\n${id}`) || null;
}

// ── Projection ───────────────────────────────────────────────────────────────

/**
 * Fold the journal to its latest state: Map per kind of id → payload.
 * Built from the cached fold — parsing the journal is the expensive part and
 * happens once per change; the Maps and payload copies returned here are fresh
 * per call, so callers can never corrupt the cache.
 */
export function loadProjection(domain) {
  const byKind = new Map(DOC_KINDS.map((k) => [k, new Map()]));
  for (const doc of foldJournal(domain).values()) {
    if (!byKind.has(doc.kind)) byKind.set(doc.kind, new Map());
    byKind.get(doc.kind).set(doc.id, { ...doc.payload, _version: doc.version, _at: doc.at });
  }
  const proj = { domain };
  for (const [kind, m] of byKind) proj[kind] = m;
  proj.counts = Object.fromEntries([...byKind.entries()].map(([k, m]) => [k, m.size]));
  return proj;
}

// ── Temporal views (G4) ─────────────────────────────────────────────────────
//
// Every appended document carries its timestamp, so the journal IS a history:
// folding only the docs at or before an instant reproduces exactly what the
// domain looked like then. An audit view, deliberately uncached — you ask for
// a moment, you get a fresh fold of that moment.

/** Fold the journal as it stood at `atMs` (epoch millis). */
export function loadProjectionAsOf(domain, atMs) {
  const cutoff = Number(atMs);
  if (!Number.isFinite(cutoff)) throw new Error(`loadProjectionAsOf needs an epoch-ms timestamp, got "${atMs}"`);
  const latest = new Map();
  for (const doc of readJournal(domain)) {
    if ((doc.at || 0) > cutoff) continue;
    const key = `${doc.kind}\n${doc.id}`;
    const cur = latest.get(key);
    if (!cur || doc.version > cur.version) latest.set(key, doc);
  }
  const byKind = new Map(DOC_KINDS.map((k) => [k, new Map()]));
  for (const doc of latest.values()) {
    if (!byKind.has(doc.kind)) byKind.set(doc.kind, new Map());
    byKind.get(doc.kind).set(doc.id, { ...doc.payload, _version: doc.version, _at: doc.at });
  }
  const proj = { domain, asOf: cutoff };
  for (const [kind, m] of byKind) proj[kind] = m;
  proj.counts = Object.fromEntries([...byKind.entries()].map(([k, m]) => [k, m.size]));
  return proj;
}

// ── The publish boundary ─────────────────────────────────────────────────────

/**
 * Promote a candidate to approved.
 * Enforced here, not in any UI:
 *   - evidence refs are required regardless of who asks (LOGOS: "candidates
 *     missing EvidenceRef must not be published regardless of review status")
 *   - the approver must differ from the proposer (separation of duties)
 *   - retired is terminal
 */
export function setPublicationState(domain, kind, id, nextState, approver) {
  if (!PUB_STATES.includes(nextState)) throw new Error(`unknown publication state "${nextState}"`);
  return withJournalLock(domain, () => setPublicationStateLocked(domain, kind, id, nextState, approver));
}

function setPublicationStateLocked(domain, kind, id, nextState, approver) {
  const latest = latestVersion(domain, kind, id);
  if (!latest) throw new Error(`no such document: ${kind}/${id} in domain ${domain}`);
  const cur = latest.payload;
  if (cur.state === 'retired') throw new Error(`${kind}/${id} is retired — retirement is terminal`);
  if (nextState === 'approved') {
    const evidence = cur.evidence || [];
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new Error(`${kind}/${id} has no evidence refs — a claim without evidence cannot be approved`);
    }
    const who = String(approver || '').trim();
    if (!who) throw new Error('approval requires a named approver');
    if (who === String(cur.proposedBy || '')) {
      throw new Error(`separation of duties: ${who} proposed ${kind}/${id} and cannot also approve it`);
    }
  }
  return appendDocument(domain, {
    kind, id,
    payload: { ...cur, state: nextState, ...(nextState === 'approved' ? { approvedBy: approver, approvedAt: Date.now() } : {}) },
  });
}

// ── Proposals (the verifier's only write path) ──────────────────────────────
//
// A proposal is a candidate document that DESCRIBES a change without making
// it: { target: {kind,id}, change: {op,…}, rationale, confidence, evidence }.
// The verifier appends proposals; only applyProposal — driven by a human —
// turns one into an actual change, and it rides the same publish boundary
// (evidence required, approver ≠ proposer, retired terminal). LOGOS §2.8:
// build-time agents produce candidates that still go through human review.

/**
 * Approve a proposal AND apply its change in one act.
 * The human approval of the proposal is the authorization; the resulting
 * documents inherit it (approvedBy) while attribution stays with the
 * original proposer.
 */
export function applyProposal(domain, proposalId, approver) {
  return withJournalLock(domain, () => applyProposalLocked(domain, proposalId, approver));
}

function applyProposalLocked(domain, proposalId, approver) {
  const latest = latestVersion(domain, 'proposal', proposalId);
  if (!latest) throw new Error(`no such proposal: ${proposalId} in domain ${domain}`);
  const p = latest.payload;
  if (p.state !== 'candidate') throw new Error(`proposal ${proposalId} is ${p.state} — only candidates apply`);
  if (!PROPOSAL_OPS.includes(p.change?.op)) throw new Error(`unknown proposal op "${p.change?.op}"`);

  // Two phases: validate and STAGE every write first, then approve, then land.
  // A proposal whose application would fail must fail before the approval is
  // journaled — an approved-but-unapplied proposal would be a lie.
  const writes = [];
  if (p.change.op === 'rename' || p.change.op === 'describe') {
    const target = latestVersion(domain, p.target?.kind, p.target?.id);
    if (!target) throw new Error(`proposal target missing: ${p.target?.kind}/${p.target?.id}`);
    const patch = p.change.op === 'rename'
      ? { name: String(p.change.name) }
      : { description: String(p.change.description) };
    // The target keeps its own publication state — renaming a candidate
    // doesn't promote it; that stays a separate human act.
    writes.push({
      kind: p.target.kind, id: p.target.id,
      payload: { ...target.payload, ...patch, lastProposal: proposalId },
    });
  } else if (p.change.op === 'add_relation') {
    const r = p.change.relation || {};
    if (!r.name || !r.from || !r.to) throw new Error('add_relation proposal needs relation {name, from, to}');
    const id = `rel:sem:${r.from}:${r.name}:${r.to}`;
    // Born approved: the human just approved exactly this relation, with the
    // proposal's evidence attached; attribution stays with the proposer.
    writes.push({
      kind: 'relationship_type', id,
      payload: {
        name: r.name, from: r.from, to: r.to, semantic: true,
        ...(r.description ? { description: r.description } : {}),
        state: 'approved', proposedBy: p.proposedBy, approvedBy: approver,
        approvedAt: Date.now(), evidence: p.evidence || [], fromProposal: proposalId,
      },
    });
  } else if (p.change.op === 'merge_types') {
    // Two induced types are the same concept. The keeper absorbs the loser's
    // property set (union with provenance — same merge induction uses), gains
    // the loser's name as an alias, and the loser is retired pointing home.
    // Instances are NOT rewritten: they mirror source bytes; traversal follows
    // aliases instead.
    const { keep, retire } = p.change;
    if (!keep || !retire || keep === retire) throw new Error('merge_types proposal needs distinct {keep, retire} type ids');
    const keeper = latestVersion(domain, 'object_type', keep);
    const loser = latestVersion(domain, 'object_type', retire);
    if (!keeper || !loser) throw new Error(`merge_types target missing: ${keeper ? retire : keep}`);
    if (loser.payload.state === 'retired') throw new Error(`${retire} is already retired`);
    const merged = mergeObjectTypePayload(keeper.payload, loser.payload);
    const aliases = [...new Set([...(keeper.payload.aliases || []), loser.payload.name, ...(loser.payload.aliases || [])])]
      .filter((n) => n !== keeper.payload.name);
    writes.push({
      kind: 'object_type', id: keep,
      payload: { ...merged, aliases, lastProposal: proposalId },
    });
    writes.push({
      kind: 'object_type', id: retire,
      payload: { ...loser.payload, state: 'retired', mergedInto: keep, lastProposal: proposalId },
    });
  } else if (p.change.op === 'retire_relation') {
    // The critic lens found a false join. Retirement stays a human act — the
    // approval of this proposal IS that act; the critic only pointed. Both
    // induced references (kind 'relationship') and semantic relations
    // (kind 'relationship_type') can be retired this way.
    const relKind = p.target?.kind;
    if (relKind !== 'relationship' && relKind !== 'relationship_type') {
      throw new Error(`retire_relation target must be a relationship or relationship_type, not "${relKind}"`);
    }
    const target = latestVersion(domain, relKind, p.target?.id);
    if (!target) throw new Error(`retire_relation target missing: ${relKind}/${p.target?.id}`);
    if (target.payload.state === 'retired') throw new Error(`${p.target.id} is already retired`);
    writes.push({
      kind: relKind, id: p.target.id,
      payload: { ...target.payload, state: 'retired', retiredBy: approver, lastProposal: proposalId },
    });
  } else if (p.change.op === 'retype_property') {
    const target = latestVersion(domain, p.target?.kind || 'object_type', p.target?.id);
    if (!target) throw new Error(`retype_property target missing: object_type/${p.target?.id}`);
    const { property, type } = p.change;
    const props = (target.payload.properties || []).map((prop) => ({ ...prop }));
    const hit = props.find((prop) => prop.name === property);
    if (!hit) throw new Error(`retype_property: "${property}" is not a property of ${p.target.id}`);
    if (hit.type !== type) { hit.retypedFrom = hit.type; hit.type = String(type); }
    writes.push({
      kind: p.target.kind || 'object_type', id: p.target.id,
      payload: { ...target.payload, properties: props, lastProposal: proposalId },
    });
  } else if (p.change.op === 'merge_instances') {
    // Entity resolution: two rows are the same real-world thing. The keeper
    // gains a sameAs pointer and BOTH sides' evidence; the loser retires
    // pointing home. Property values are never rewritten — instances mirror
    // source bytes, and inventing a merged row would break evidence lineage.
    const { keep, retire } = p.change;
    if (!keep || !retire || keep === retire) throw new Error('merge_instances proposal needs distinct {keep, retire} instance ids');
    const keeper = latestVersion(domain, 'instance', keep);
    const loser = latestVersion(domain, 'instance', retire);
    if (!keeper || !loser) throw new Error(`merge_instances target missing: ${keeper ? retire : keep}`);
    if (keeper.payload.type !== loser.payload.type) {
      throw new Error(`merge_instances: ${keep} is ${keeper.payload.type} but ${retire} is ${loser.payload.type} — different types never merge`);
    }
    if (loser.payload.state === 'retired') throw new Error(`${retire} is already retired`);
    const seen = new Set();
    const evidence = [...(keeper.payload.evidence || []), ...(loser.payload.evidence || [])]
      .filter((e) => { const k = JSON.stringify(e); if (seen.has(k)) return false; seen.add(k); return true; });
    const sameAs = [...new Set([...(keeper.payload.sameAs || []), retire, ...(loser.payload.sameAs || [])])];
    writes.push({
      kind: 'instance', id: keep,
      payload: { ...keeper.payload, sameAs, evidence, lastProposal: proposalId },
    });
    writes.push({
      kind: 'instance', id: retire,
      payload: { ...loser.payload, state: 'retired', mergedInto: keep, lastProposal: proposalId },
    });
  } else if (p.change.op === 'annotate') {
    // Semantic tags and units ("unit:JPY", "pii:name"). Additive only: tags
    // union across annotations, a new note replaces the old one.
    const ann = p.change.annotation || {};
    const tags = (ann.tags || []).map((t) => String(t)).filter(Boolean);
    if (!tags.length && !ann.note) throw new Error('annotate proposal needs annotation {tags[] and/or note}');
    const target = latestVersion(domain, p.target?.kind, p.target?.id);
    if (!target) throw new Error(`annotate target missing: ${p.target?.kind}/${p.target?.id}`);
    const prev = target.payload.annotations || {};
    const annotations = {
      tags: [...new Set([...(prev.tags || []), ...tags])],
      ...(ann.note ? { note: String(ann.note).slice(0, 300) } : (prev.note ? { note: prev.note } : {})),
    };
    writes.push({
      kind: p.target.kind, id: p.target.id,
      payload: { ...target.payload, annotations, lastProposal: proposalId },
    });
  }

  // The boundary does the vetting: evidence present, approver ≠ proposer.
  // Only after staging succeeds does the approval reach the journal, followed
  // by the staged writes — authorization always precedes effect.
  setPublicationState(domain, 'proposal', proposalId, 'approved', approver);
  const applied = writes.map((w) => appendDocument(domain, w));
  return { proposalId, op: p.change.op, applied };
}

// ── Releases (G0): pin the approved graph to an immutable version ────────────
//
// A release freezes the domain's APPROVED documents into one content-addressed
// file: same approved set ⇒ same id, forever. Queries that pin a release get
// the same answer next year that they got today — the property old O4 wanted,
// delivered where it belongs, in the store. Candidates and retired docs never
// enter a release: a release is what the humans have signed, nothing else.

/** Deep-sort object keys so identical data always serialises to identical bytes. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

function releasesDir(domain) {
  return path.join(domainDir(domain), 'releases');
}

/**
 * Freeze the current approved set as a release. Content-addressed and
 * idempotent: releasing an unchanged approved set replays the existing release
 * (existed: true) rather than minting a new version. Throws when nothing is
 * approved — an empty release would pin a lie.
 */
export function createRelease(domain, { createdBy = 'owner' } = {}) {
  const proj = loadProjection(domain);
  const docs = {};
  let total = 0;
  for (const kind of Object.keys(proj).sort()) {
    if (!(proj[kind] instanceof Map)) continue;
    const approved = [...proj[kind].entries()]
      .filter(([, p]) => p && p.state === 'approved')
      .map(([id, p]) => { const { _version, _at, ...payload } = p; return [id, canonical(payload)]; })
      .sort((x, y) => (x[0] < y[0] ? -1 : 1));
    if (approved.length) { docs[kind] = Object.fromEntries(approved); total += approved.length; }
  }
  if (total === 0) {
    throw new Error(`domain "${domain}" has no approved documents — approve something before releasing`);
  }
  const hash = sha256(Buffer.from(JSON.stringify(docs), 'utf-8'));
  const id = `release:${hash.slice(0, 16)}`;
  const file = path.join(releasesDir(domain), `${hash.slice(0, 16)}.json`);
  const counts = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, Object.keys(v).length]));
  if (fs.existsSync(file)) return { id, file, counts, total, existed: true };
  fs.mkdirSync(releasesDir(domain), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    id, domain, sha256: hash, createdAt: Date.now(), createdBy, counts, docs,
  }, null, 2));
  return { id, file, counts, total, existed: false };
}

/**
 * Load a release and verify it against its own id — a release file whose docs
 * no longer hash to its name has been edited, and a tampered release must be
 * refused, not served.
 */
export function loadRelease(domain, releaseId) {
  const short = String(releaseId).replace(/^release:/, '');
  const file = path.join(releasesDir(domain), `${short}.json`);
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {
    throw new Error(`no such release: ${releaseId} in domain ${domain}`);
  }
  const hash = sha256(Buffer.from(JSON.stringify(canonical(rec.docs)), 'utf-8'));
  if (hash.slice(0, 16) !== short) {
    throw new Error(`release ${releaseId} does not match its own hash — tampered releases are refused`);
  }
  return rec;
}

/**
 * Diff two releases (G4): which approved documents were added, removed, or
 * changed between them. Both sides are loaded through loadRelease, so a
 * tampered release refuses to diff exactly as it refuses to serve.
 */
export function diffReleases(domain, fromId, toId) {
  const a = loadRelease(domain, fromId);
  const b = loadRelease(domain, toId);
  const flat = (rec) => {
    const m = new Map();
    for (const [kind, docs] of Object.entries(rec.docs || {})) {
      for (const [id, payload] of Object.entries(docs)) m.set(`${kind}/${id}`, payload);
    }
    return m;
  };
  const A = flat(a), B = flat(b);
  const added = [], removed = [], changed = [];
  for (const key of B.keys()) if (!A.has(key)) added.push(key);
  for (const key of A.keys()) if (!B.has(key)) removed.push(key);
  for (const [key, payload] of A) {
    if (B.has(key) && JSON.stringify(canonical(payload)) !== JSON.stringify(canonical(B.get(key)))) changed.push(key);
  }
  return { from: a.id, to: b.id, added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/** List a domain's releases, newest first. */
export function listReleases(domain) {
  let entries = [];
  try { entries = fs.readdirSync(releasesDir(domain)).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of entries) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(releasesDir(domain), f), 'utf-8'));
      out.push({ id: rec.id, createdAt: rec.createdAt, createdBy: rec.createdBy, counts: rec.counts });
    } catch { /* an unreadable release shows up when loaded explicitly, not here */ }
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// ── History & removal ───────────────────────────────────────────────────────

/**
 * The domain's story from its own journal: when it was born, what it holds,
 * and the latest `limit` events newest-first. Read-only — the journal is the
 * single source of truth, so history is a fold, never a second record.
 */
export function domainHistory(domain, { limit = 30 } = {}) {
  assertDomain(domain);
  const docs = readJournal(domain);
  const byKind = {};
  for (const d of docs) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
  // limit 0 means "summary only" — and slice(-0) is slice(0), the whole
  // journal, so the guard is explicit.
  const entries = (limit > 0 ? docs.slice(-limit) : []).reverse().map((d) => ({
    at: d.at || 0,
    kind: d.kind,
    id: d.id,
    version: d.version,
    state: d.payload?.state ?? null,
    by: d.payload?.approvedBy || d.payload?.proposedBy || null,
  }));
  return {
    domain,
    docs: docs.length,
    createdAt: docs.length ? (docs[0].at || 0) : null,
    lastAt: docs.length ? (docs[docs.length - 1].at || 0) : null,
    byKind,
    entries,
  };
}

/**
 * Permanently delete a domain: journal, snapshots, releases, and the intake
 * copies of its source files. The fold-cache entry is dropped FIRST so a
 * domain re-created under the same name can never see the ghost of this one.
 * Irreversible by design — the CLI owns the confirmation ceremony, this
 * function only executes a decision already made.
 */
export function removeDomain(domain) {
  assertDomain(domain);
  const d = domainDir(domain);
  if (!fs.existsSync(d)) return false;
  // Evict BEFORE deleting: the fold cache is keyed by journal path and stamped
  // mtimeMs:size. A domain re-created under the same name whose first journal
  // write collides on both (coarse mtime resolution makes this real) would be
  // served the DEAD domain's fold. Deletion must take the cache with it.
  foldCache.delete(journalPath(domain));
  fs.rmSync(d, { recursive: true, force: true });
  return true;
}

export default {
  DOC_KINDS, PUB_STATES, PROPOSAL_OPS, assertDomain, domainDir, listDomains,
  registerSnapshot, readSnapshotMeta, evidenceRef,
  appendDocument, loadProjection, loadProjectionAsOf, setPublicationState, applyProposal,
  withJournalLock, createRelease, loadRelease, listReleases, diffReleases,
  domainHistory, removeDomain,
};
