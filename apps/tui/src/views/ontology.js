// src/views/ontology.js — the Ontology view (page 7).
//
// The drag-and-drop knowledge engine, live: which domains exist, what the
// last drops induced (types / instances / relations, all born candidates),
// and where the knowledge-graph HTML was written. Ingests happen in the
// daemon's watcher; everything here arrives over the bus as `ontology`
// events, so this view works from any attached terminal.

import fs from 'node:fs';
import path from 'node:path';
import {
  boxTop, boxBot, boxRow,
  C, gr, bold, visLen,
} from '../render.js';
import { state } from '../state.js';

/** Ring-buffer cap for ontology events. */
export const ONTOLOGY_EVENT_CAP = 60;

/**
 * Fold one adapted `ontology` event into state.ontology. Pure over its inputs.
 * @param {object} onto  state.ontology (copied, not mutated)
 * @param {object} ev    {action, domain, file, counts, appended, graphPath, reason}
 * @param {number} [nowMs]
 */
export function foldOntologyEvent(onto, ev, nowMs = Date.now()) {
  const o = { ...onto };
  o.events = [{ ts: nowMs, ...ev }, ...(o.events || [])].slice(0, ONTOLOGY_EVENT_CAP);
  if (ev.action === 'ingested') {
    if (ev.graphPath) o.lastGraphPath = ev.graphPath;
    // The bus told us the store changed → the cached domain table is stale.
    o.probedAt = 0;
  }
  return o;
}

function clockStr(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return gr(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
}

function clip(s, n) {
  const str = String(s || '');
  return str.length <= n ? str : str.slice(0, Math.max(0, n - 1)) + '…';
}

/** One activity line. Exported for tests. */
export function ontologyEventLine(ev, width) {
  let icon, body;
  if (ev.action === 'ingested') {
    icon = `${C.green}▲${C.reset}`;
    const c = ev.counts || {};
    body = `${ev.file} → ${ev.domain}  ${gr(`${c.object_type || 0}t/${c.instance || 0}i/${c.relationship || 0}r`)}${ev.appended ? ` +${ev.appended}` : gr(' (replay)')}`;
  } else if (ev.action === 'ingest_skipped') {
    icon = `${C.yellow}○${C.reset}`;
    body = `${ev.file}: ${ev.reason || 'skipped'}`;
  } else if (ev.action === 'approved') {
    icon = `${C.green}✓${C.reset}`;
    body = `${ev.id || ''} approved${ev.by ? ` by ${ev.by}` : ''}`;
  } else {
    icon = gr('·');
    body = `${ev.action}${ev.file ? `: ${ev.file}` : ''}`;
  }
  return clip(`${clockStr(ev.ts)}  ${icon} ${body}`, width * 2).slice(0, Math.max(0, width + 20));
}

function domainLine(d, width) {
  const c = d.counts || {};
  const approvedNote = c.approvedTypes ? `${C.green}${c.approvedTypes}✓${C.reset} ` : '';
  // Verifier proposals awaiting a human are the one number that demands
  // attention — amber, and only shown when non-zero.
  const proposalNote = c.openProposals ? `  ${C.yellow}◇ ${c.openProposals} proposal${c.openProposals > 1 ? 's' : ''}${C.reset}` : '';
  return clip(
    `  ${C.cyan}◆${C.reset} ${bold(d.name)}  ${approvedNote}${gr(`${c.object_type || 0} types · ${c.instance || 0} instances · ${c.relationship || 0} relations · ${c.ingest || 0} ingests`)}${proposalNote}`,
    width + 30,
  );
}

/**
 * Render the Ontology view.
 * @param {number} W terminal width
 * @param {number} H rows available
 * @returns {string[]}
 */
export function renderOntology(W, H) {
  const o = state.ontology;
  const lines = [];
  const row = (content = '') => lines.push(boxRow('  ' + content, W));
  const iW = W - 6;

  lines.push(boxTop(W, 'ONTOLOGY'));
  row();

  // ── The inbox ────────────────────────────────────────────────
  row(`${C.green}●${C.reset} ${bold('drag a file or folder onto this window')}  ${gr('csv · tsv · json · jsonl · md — a folder becomes its own ontology')}`);
  if (o.dropDir) row(gr(clip(`…or drop it into the inbox folder: ${o.dropDir}`, iW)));
  row();

  // ── Domains ──────────────────────────────────────────────────
  row(gr(`─ DOMAINS ${'─'.repeat(Math.max(0, iW - 10))}`));
  const domains = o.domains || [];
  if (!o.probedAt) {
    row(gr('reading the store…'));
  } else if (!domains.length) {
    row(gr('no domains yet — drop a file into the inbox, or:'));
    row(gr('  kairos ontology ingest <file> --domain <name>'));
  } else {
    for (const d of domains.slice(0, 6)) row(domainLine(d, iW));
  }
  if (o.lastGraphPath) row(gr(clip(`graph: ${o.lastGraphPath}   (kairos ontology graph --open)`, iW)));
  row();

  // ── Review queue (G4) ────────────────────────────────────────
  // Candidate proposals across every domain, one keystroke from a decision:
  // ↑/↓ selects, [a]pprove applies through the publish boundary, [x] rejects.
  const proposals = o.proposals || [];
  if (proposals.length) {
    row(gr(`─ PROPOSALS ${'─'.repeat(Math.max(0, iW - 12))}`));
    row(gr('↑/↓ select · [a]pprove (applies the change) · [x] reject'));
    const cursor = Math.min(o.cursor || 0, proposals.length - 1);
    for (let i = 0; i < Math.min(proposals.length, 6); i++) {
      const p = proposals[i];
      const sel = i === cursor;
      const mark = sel ? `${C.cyan}▸${C.reset}` : ' ';
      const pct = `${Math.round((p.confidence || 0) * 100)}%`;
      const line = `${mark} ${C.yellow}◇${C.reset} ${bold(p.domain)} ${clip(p.summary, iW - 24)}  ${gr(`${pct} · ${p.by}`)}`;
      row(sel ? line : clip(line, iW + 40));
    }
    if (proposals.length > 6) row(gr(`  … ${proposals.length - 6} more (kairos ontology proposals <domain>)`));
    row();
  }

  // ── Activity ─────────────────────────────────────────────────
  row(gr(`─ ACTIVITY ${'─'.repeat(Math.max(0, iW - 11))}`));
  const used = lines.length + 2;
  const roomFor = Math.max(1, H - used);
  const events = o.events || [];
  if (!events.length) {
    row(gr('nothing ingested yet — drops are announced here as the daemon eats them'));
  } else {
    for (const ev of events.slice(0, roomFor)) row(ontologyEventLine(ev, iW));
  }

  while (lines.length < H - 1) row();
  lines.push(boxBot(W));
  return lines.slice(0, H);
}

// ── Drop-onto-the-window (F-7) ───────────────────────────────────────────────
// A terminal delivers a drag as a pasted path. While the Ontology view is
// open, that drop means "build knowledge from this" — copy it into the inbox
// and let the daemon's watcher do everything else (one ingest path, and the
// resulting events flow back into ACTIVITY over the bus).

export const INBOX_DROP_MAX_FILES = 500;
export const INBOX_DROP_MAX_BYTES = 100 * 1024 * 1024; // a copy that big would freeze the UI

function measure(root, acc = { files: 0, bytes: 0 }) {
  const st = fs.statSync(root);
  if (st.isFile()) { acc.files++; acc.bytes += st.size; return acc; }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(root)) {
      measure(path.join(root, e), acc);
      if (acc.files > INBOX_DROP_MAX_FILES || acc.bytes > INBOX_DROP_MAX_BYTES) return acc; // stop early
    }
  }
  return acc;
}

/**
 * Copy dropped files/folders into the ontology inbox. Returns one result per
 * path: {name, ok, files?} or {name, ok:false, reason}. Never throws — the
 * caller turns results into toasts.
 */
export async function copyIntoInbox(paths) {
  const results = [];
  let inbox;
  try {
    const engine = await import('../../../../src/ontology/engine.js');
    inbox = path.resolve(engine.dropDir());
    fs.mkdirSync(inbox, { recursive: true });
  } catch (err) {
    return (paths || []).map((p) => ({ name: path.basename(p), ok: false, reason: err.message }));
  }
  for (const p of paths || []) {
    const name = path.basename(p);
    try {
      const src = path.resolve(p);
      if (src === inbox || src.startsWith(inbox + path.sep)) {
        results.push({ name, ok: false, reason: 'already in the inbox' });
        continue;
      }
      const size = measure(src);
      if (size.files > INBOX_DROP_MAX_FILES || size.bytes > INBOX_DROP_MAX_BYTES) {
        results.push({ name, ok: false, reason: `too large for a drop (>${INBOX_DROP_MAX_FILES} files or >100MB)` });
        continue;
      }
      fs.cpSync(src, path.join(inbox, name), { recursive: true });
      results.push({ name, ok: true, files: size.files });
    } catch (err) {
      results.push({ name, ok: false, reason: err.code || err.message });
    }
  }
  return results;
}

// ── Store probe ──────────────────────────────────────────────────────────────
// Reads the same store the CLI uses, so the view can never disagree with
// `kairos ontology list`. Runs when the view opens and after ingest events
// (probedAt reset); never per render.

/** Cap on review-queue rows carried in state — the queue is a docket, not an archive. */
export const PROPOSAL_QUEUE_CAP = 20;

/** One-line human summary of a proposal's change. Exported for tests. */
export function proposalSummary(p) {
  const c = p.change || {};
  switch (c.op) {
    case 'rename': return `rename ${p.target?.id} → "${c.name}"`;
    case 'describe': return `describe ${p.target?.id}`;
    case 'add_relation': return `relate ${c.relation?.from} —${c.relation?.name}→ ${c.relation?.to}`;
    case 'merge_types': return `merge ${c.retire} into ${c.keep}`;
    case 'merge_instances': return `merge ${c.retire} into ${c.keep}`;
    case 'retire_relation': return `retire ${p.target?.id}`;
    case 'retype_property': return `retype ${p.target?.id}.${c.property} → ${c.type}`;
    case 'annotate': return `annotate ${p.target?.id} [${(c.annotation?.tags || []).join(', ')}]`;
    default: return c.op || 'unknown';
  }
}

export async function probeOntology() {
  const out = { dropDir: '', domains: [], proposals: [] };
  try {
    const store = await import('../../../../src/ontology/store.js');
    const engine = await import('../../../../src/ontology/engine.js');
    out.dropDir = engine.dropDir();
    for (const name of store.listDomains()) {
      const proj = store.loadProjection(name);
      const approvedTypes = [...proj.object_type.values()].filter((t) => t.state === 'approved').length;
      const open = [...(proj.proposal || new Map()).entries()].filter(([, p]) => p.state === 'candidate');
      out.domains.push({ name, counts: { ...proj.counts, approvedTypes, openProposals: open.length } });
      // The review queue (G4): flattened across domains, newest first, capped.
      for (const [id, p] of open) {
        out.proposals.push({
          domain: name, id, op: p.change?.op || '?',
          summary: proposalSummary(p),
          confidence: p.confidence || 0, by: p.proposedBy || '',
          at: p._at || 0,
        });
      }
    }
    out.proposals.sort((x, y) => (y.at || 0) - (x.at || 0));
    out.proposals = out.proposals.slice(0, PROPOSAL_QUEUE_CAP);
  } catch { /* the empty default already says "no domains" */ }
  return out;
}

/**
 * Apply or reject one queued proposal — the TUI's approve/retire keys land
 * here. Same store module the CLI uses, same publish boundary, same
 * separation of duties; the TUI is just a faster hand on the same lever.
 * Returns {ok, text} for the toast; never throws.
 */
export async function actOnProposal({ domain, id }, action, approver) {
  try {
    const store = await import('../../../../src/ontology/store.js');
    if (action === 'approve') {
      const res = store.applyProposal(domain, id, approver);
      return { ok: true, text: `✓ applied ${res.op} (${id.slice(0, 34)}…)` };
    }
    store.setPublicationState(domain, 'proposal', id, 'retired', approver);
    return { ok: true, text: `✗ rejected ${id.slice(0, 34)}…` };
  } catch (err) {
    return { ok: false, text: err.message };
  }
}
