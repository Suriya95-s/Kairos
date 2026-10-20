// apps/tui/src/commands/ontologyCmds.js — the / palette's ontology + spend verbs.
//
// Read commands (usage, history, the remove ceremony) run in-process against
// the same kernel modules the CLI uses — instant, and they can never disagree
// with `kairos usage` / `kairos ontology history`. The lens commands
// (verify / resolve / critique) spend tokens, so they spawn the real CLI:
// same choke point, same ledger metering, same purpose attribution. The TUI
// is a faster hand on the same levers, never a second implementation.
//
// Every function returns plain data ({ok, title, lines} or {ok, text}) so
// app.js only decides toast-vs-overlay and tests can assert on content.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const KERNEL_CLI = path.join(REPO_ROOT, 'src', 'kernel', 'cli.js');

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const usd = (c) => (c > 0 && c < 0.0001 ? '<$0.0001' : `$${Number(c || 0).toFixed(4)}`);
const day = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : '?');

function bucketLine(label, b, width = 34) {
  return `  ${label.padEnd(width).slice(0, width)}  ${String(b.calls).padStart(4)} call(s)  ${fmt(b.totalTokens).padStart(10)} tok  ${usd(b.cost).padStart(9)}`;
}

/** /usage [YYYY-MM | all] — the spend ledger, same numbers as `kairos usage`. */
export async function usageReport(arg) {
  const { summarizeUsage } = await import('../../../../src/kernel/usage.js');
  const a = String(arg || '').trim().toLowerCase().replace(/^--/, '');
  const opts = a === 'all' ? { all: true } : /^\d{4}-\d{2}$/.test(a) ? { month: a } : {};
  const s = summarizeUsage(opts);

  const title = opts.all ? 'SPEND LEDGER — ALL TIME' : `SPEND LEDGER — ${s.months[0]}`;
  const lines = [];
  lines.push(`${fmt(s.totals.calls)} call(s) · ${fmt(s.totals.promptTokens)} in + ${fmt(s.totals.completionTokens)} out = ${fmt(s.totals.totalTokens)} tokens · ${usd(s.totals.cost)}`);
  if (s.totals.unpricedTokens > 0) {
    lines.push(`⚠ ${fmt(s.totals.unpricedTokens)} tokens on UNPRICED models (billed $0) — fix: kairos llm price <name>`);
  }
  const section = (name, obj) => {
    const entries = Object.entries(obj).sort((x, y) => y[1].cost - x[1].cost || y[1].totalTokens - x[1].totalTokens);
    if (!entries.length) return;
    lines.push('', name);
    for (const [label, b] of entries.slice(0, 12)) lines.push(bucketLine(label, b));
  };
  section('BY MODEL', s.byModel);
  section('BY PURPOSE', s.byPurpose);
  section('BY DAY', s.byDay);
  if (!s.records) lines.push('', 'no model calls in the ledger for this period');
  return { ok: true, title, lines };
}

/** /history [domain] [limit] — what was built, when, by whom. */
export async function historyReport(domainArg, limitArg) {
  const store = await import('../../../../src/ontology/store.js');
  const domain = String(domainArg || '').trim();

  if (!domain) {
    const names = store.listDomains();
    if (!names.length) return { ok: true, title: 'ONTOLOGY HISTORY', lines: ['no domains yet — drop a file on the Graph view to build one'] };
    const all = names.map((n) => store.domainHistory(n, { limit: 0 }))
      .sort((x, y) => (y.lastAt || 0) - (x.lastAt || 0));
    const lines = [];
    for (const h of all) {
      lines.push(`◆ ${h.domain}  ${h.docs} doc(s) · created ${day(h.createdAt)} · last change ${day(h.lastAt)}`);
      lines.push(`    ${Object.entries(h.byKind).map(([k, c]) => `${c} ${k}`).join(' · ') || '(empty)'}`);
    }
    lines.push('', 'details: /history <domain> [limit]');
    return { ok: true, title: 'ONTOLOGY HISTORY', lines };
  }

  let h;
  try {
    h = store.domainHistory(domain, { limit: Math.max(1, parseInt(limitArg, 10) || 30) });
  } catch (err) {
    return { ok: false, text: err.message };
  }
  if (!h.docs) return { ok: false, text: `No such domain (or empty): ${domain}` };
  const lines = [
    `${h.docs} doc(s) · created ${day(h.createdAt)} · last change ${day(h.lastAt)}`,
    Object.entries(h.byKind).map(([k, c]) => `${c} ${k}`).join(' · '),
    '',
  ];
  for (const e of h.entries) {
    lines.push(`${day(e.at)}  ${e.kind.padEnd(12)} ${e.id}  v${e.version}${e.state ? ` [${e.state}]` : ''}${e.by ? `  by ${e.by}` : ''}`);
  }
  return { ok: true, title: `HISTORY — ${domain}`, lines };
}

/**
 * /remove <domain> without --force — the ceremony. Shows what would be
 * destroyed and how to actually do it. NEVER deletes anything.
 */
export async function removePreview(domain) {
  const store = await import('../../../../src/ontology/store.js');
  const name = String(domain || '').trim();
  const dir = store.domainDir(name);
  if (!fs.existsSync(dir)) return { ok: false, exists: false, text: `No such domain: ${name}` };

  const h = store.domainHistory(name, { limit: 0 });
  let intakeFiles = 0;
  try { intakeFiles = fs.readdirSync(path.join(dir, 'intake')).length; } catch { /* no intake yet */ }

  const isLoopMemory = name === 'kairos';
  const lines = [
    `${h.docs} document(s) · ${intakeFiles} ingested source file(s) · created ${day(h.createdAt)}`,
    Object.entries(h.byKind).map(([k, c]) => `${c} ${k}`).join(' · ') || '(empty journal)',
    '',
    'This deletes the journal, graph, snapshots and intake copies — it cannot be undone.',
    isLoopMemory
      ? `⚠ "${name}" is the loop's own memory (missions, learnings).`
      : '',
    `To proceed: /remove ${name} --force${isLoopMemory ? ' --loop-memory' : ''}`,
  ].filter(Boolean);
  return { ok: true, exists: true, isLoopMemory, docs: h.docs, intakeFiles, lines };
}

/** /remove <domain> --force — the deletion, with the same rules as the CLI. */
export async function removeForce(domain, { loopMemory = false } = {}) {
  const store = await import('../../../../src/ontology/store.js');
  const name = String(domain || '').trim();
  if (name === 'kairos' && !loopMemory) {
    return { ok: false, text: '"kairos" holds the loop\'s memory — add --loop-memory to confirm' };
  }
  try {
    const removed = store.removeDomain(name);
    return removed
      ? { ok: true, text: `✓ removed domain "${name}" — re-create it any time by dropping a file` }
      : { ok: false, text: `No such domain: ${name}` };
  } catch (err) {
    return { ok: false, text: err.message };
  }
}

const LENS_KINDS = new Set(['verify', 'resolve', 'critique']);

/**
 * Build the argv for a lens run. Kind is whitelisted and every value is one
 * argv element handed to spawn without a shell — a domain named
 * "x; rm -rf /" stays an inert string.
 */
export function lensArgs(kind, domain, model) {
  if (!LENS_KINDS.has(kind)) throw new Error(`not a lens command: ${kind}`);
  const d = String(domain || '').trim();
  if (!d) throw new Error('a domain is required');
  const args = ['ontology', kind, d];
  const m = String(model || '').trim();
  if (m) args.push('--model', m);
  return args;
}

/**
 * Run a lens through the real CLI (choke point, metering, vault key handling
 * all reused). Resolves {code, output}; never rejects on a non-zero exit —
 * the CLI's own error text IS the useful output.
 */
export function runLens(kind, domain, model) {
  const args = lensArgs(kind, domain, model); // throws early on bad input
  return new Promise((resolve, reject) => {
    let out = '';
    const child = spawn(process.execPath, [KERNEL_CLI, ...args], {
      env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, output: out.trim() }));
  });
}
