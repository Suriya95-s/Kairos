// src/selfimprove/router-training.js
// The router learns from being wrong (9.1).
//
// P4 logged every routing decision and left room for a `corrected` field. This
// is what reads that back. The loop is deliberately *not* "retrain a model":
// the classifier is a weighted keyword table, and the useful output of a month
// of corrections is not new weights — it is **new fixture cases**, added to the
// 100-case set that keeps accuracy honest.
//
// That is the conservative choice on purpose. Auto-tuning weights from a
// correction log would let one week of unusual usage silently reshape how every
// utterance is routed, with no diff to review and no test that failed. Proposing
// fixtures instead keeps a human in the loop at the only point where it matters:
// deciding what the right answer *is*.
//
// So the deliverables here are measurements and proposals, never mutations.

import fs from 'node:fs';
import path from 'node:path';

import { readDecisions, classify, INTENTS } from '../router/classify.js';

/** A correction is only meaningful if the user actually disagreed. */
function isCorrected(row) {
  return !!row.corrected && row.corrected !== row.intent;
}

/**
 * Measure the router against its own logged corrections.
 *
 * `accuracy` here means something narrow and worth stating: of the decisions a
 * human bothered to correct or confirm, how many were right. Uncorrected
 * decisions are NOT counted as correct — silence is not agreement, and treating
 * it as such would report 99% accuracy forever.
 *
 * @returns {object} report
 */
export function measureRouter({ dir = null, since = null } = {}) {
  const all = readDecisions({ dir }).filter(r => !since || r.ts >= since);
  const judged = all.filter(r => r.corrected != null);
  const wrong = judged.filter(isCorrected);

  const byIntent = {};
  for (const intent of INTENTS) {
    const mine = judged.filter(r => r.intent === intent);
    if (!mine.length) continue;
    byIntent[intent] = {
      judged: mine.length,
      wrong: mine.filter(isCorrected).length,
    };
  }

  // Where the mistakes cluster. "reflex→mission" is a very different problem
  // from "mission→reflex": one wastes twenty minutes, the other wastes a
  // sentence.
  const confusion = {};
  for (const row of wrong) {
    const key = `${row.intent}→${row.corrected}`;
    confusion[key] = (confusion[key] || 0) + 1;
  }

  return {
    total: all.length,
    judged: judged.length,
    wrong: wrong.length,
    // Null rather than 1.0 when nothing has been judged: an accuracy figure
    // computed from zero samples is worse than no figure, because it looks
    // like evidence.
    accuracy: judged.length ? Number(((judged.length - wrong.length) / judged.length).toFixed(4)) : null,
    byIntent,
    confusion,
    // How much of the traffic went to the model. High and rising means the
    // keyword table is falling behind the way this user actually talks.
    llmFallbackRate: all.length
      ? Number((all.filter(r => r.method === 'llm').length / all.length).toFixed(4))
      : 0,
    lowConfidenceRate: all.length
      ? Number((all.filter(r => (r.confidence ?? 1) < 0.34).length / all.length).toFixed(4))
      : 0,
  };
}

/**
 * Propose fixture cases from corrections.
 *
 * Only corrections the classifier *still* gets wrong are proposed — a case that
 * now passes adds nothing but runtime. Duplicates and near-duplicates of the
 * existing set are dropped, because a fixture set full of ten phrasings of the
 * same mistake overweights it in the accuracy figure.
 *
 * @returns {Array<{text: string, intent: string, note: string, seen: number}>}
 */
export function proposeFixtures({ dir = null, existing = [], limit = 25 } = {}) {
  const rows = readDecisions({ dir }).filter(isCorrected);
  const known = new Set(existing.map(c => normalize(c.text)));

  // Group by (normalised text, corrected intent) so a mistake made forty times
  // becomes one proposal with a count — which is also the signal for how much
  // it matters.
  const grouped = new Map();
  for (const row of rows) {
    const text = String(row.text || '').trim();
    if (!text || text.length > 200) continue;
    const key = `${normalize(text)}::${row.corrected}`;
    if (!grouped.has(key)) grouped.set(key, { text, intent: row.corrected, wasRoutedAs: row.intent, seen: 0 });
    grouped.get(key).seen++;
  }

  const proposals = [];
  for (const cand of grouped.values()) {
    if (known.has(normalize(cand.text))) continue;
    // Skip anything the classifier already handles: a fixture that passes on
    // the day it is added is a fixture that never catches anything.
    if (classify(cand.text).intent === cand.intent) continue;
    proposals.push({
      text: cand.text,
      intent: cand.intent,
      seen: cand.seen,
      note: `corrected ${cand.seen}× from ${cand.wasRoutedAs} to ${cand.intent}`,
    });
  }

  // Most-corrected first: frequency is the best available proxy for how much a
  // mistake costs this particular user.
  return proposals.sort((a, b) => b.seen - a.seen).slice(0, limit);
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Render proposals as a fixture file fragment a person can paste in.
 *
 * A fragment, not a patch. Writing directly into the fixture set would mean the
 * thing being measured edits its own exam.
 */
export function renderFixtureProposals(proposals) {
  if (!proposals.length) return '';
  const lines = proposals.map(p =>
    `  { text: ${JSON.stringify(p.text)}, intent: '${p.intent}',\n` +
    `    note: ${JSON.stringify(p.note)} },`);
  return [
    '// Proposed from the router decision log. Review each one: the corrected',
    '// label is what a user chose in the moment, which is usually right and',
    '// occasionally just impatience.',
    ...lines,
  ].join('\n');
}

/**
 * Record a correction. The one write path into the training data.
 *
 * Appends rather than editing the original decision: the fact that the router
 * said X and a human said Y is two facts, and collapsing them loses the one
 * that matters.
 */
export function recordCorrection({ text, was, corrected, sessionId = null, dir = null }) {
  if (!INTENTS.includes(corrected)) throw new Error(`unknown intent "${corrected}"`);
  const target = dir || defaultDir();
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.appendFileSync(path.join(target, 'decisions.jsonl'), JSON.stringify({
      ts: Date.now(),
      sessionId,
      text: String(text || '').slice(0, 500),
      intent: was,
      corrected,
      method: 'correction',
      confidence: 1,
      reason: 'user correction',
    }) + '\n');
    return true;
  } catch {
    return false;
  }
}

function defaultDir() {
  const override = process.env.KAIROS_HOME;
  const brand = (process.env.KAIROS_BRAND || 'kairos').trim().toLowerCase();
  const home = override && override.trim()
    ? path.resolve(override.trim())
    : path.join(process.env.HOME || process.env.USERPROFILE || '.', `.${brand}`);
  return path.join(home, 'router');
}
