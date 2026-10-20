// src/ontology/resolve.js
// G2 — entity resolution: the same real-world thing dropped twice under
// different keys (C1 in customers.csv, CU-1 in a CRM export) becomes ONE
// governed merge proposal, never a silent rewrite.
//
// Division of labor, LOGOS-style:
//   - DETERMINISTIC code finds candidate pairs (shared identity values —
//     normalized name/email/phone columns). No model, no false creativity:
//     a pair the heuristic can't see, the agent never judges.
//   - The AGENT judges each pair (same entity or not, structured output,
//     confidence gate). Its verdicts become merge_instances PROPOSALS carrying
//     BOTH sides' evidence; a human applies or discards them.
//   - Deterministic floor: dead model, garbage output, or zero pairs changes
//     nothing. Replay by content key: unchanged pairs spend zero tokens.

import crypto from 'node:crypto';
import { loadProjection, appendDocument, assertDomain } from './store.js';
import {
  loadPiiMap, savePiiMap, redactInstanceProperties, isNameishProp, assertNoRawPii,
} from './redact.js';
import { MIN_CONFIDENCE, MAX_PROPOSALS } from './verifier.js';

export const MAX_PAIRS = 25; // pairs sent to the model per run — resolution is iterative, not exhaustive

/** Normalize a value for identity comparison: case, spacing, punctuation gone. */
function norm(v) {
  return String(v ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Columns whose equal values suggest "same entity": names, emails, phones. */
function isIdentityProp(name) {
  return isNameishProp(name) || /(email|mail|phone|tel|contact)/i.test(String(name));
}

/**
 * Deterministic candidate pairs: two live instances of the SAME type whose
 * ids differ but that share a normalized value in an identity column.
 * Sorted and capped so the same projection always yields the same pair list —
 * the replay key depends on it.
 */
export function candidatePairs(projection, { max = MAX_PAIRS } = {}) {
  const byType = new Map();
  for (const [id, inst] of projection.instance.entries()) {
    if (inst.state === 'retired' || inst.mergedInto) continue;
    if (!byType.has(inst.type)) byType.set(inst.type, []);
    byType.get(inst.type).push({ id, inst });
  }
  const pairs = [];
  const seen = new Set();
  for (const [type, list] of [...byType.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const index = new Map(); // `${prop}\n${normalizedValue}` → entries sharing it
    for (const e of list) {
      for (const [prop, value] of Object.entries(e.inst.properties || {})) {
        if (!isIdentityProp(prop)) continue;
        const n = norm(value);
        if (n.length < 3) continue; // "a", "-", empty: identity needs substance
        const k = `${prop}\n${n}`;
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(e);
      }
    }
    for (const [k, entries] of [...index.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (entries.length < 2) continue;
      const via = k.split('\n')[0];
      const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
      for (let i = 0; i < sorted.length - 1; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i], b = sorted[j];
          if (a.id === b.id) continue;
          const pairKey = `${a.id}||${b.id}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          pairs.push({ key: pairKey, type, via, a: a.id, b: b.id });
        }
      }
    }
  }
  return pairs.sort((x, y) => (x.key < y.key ? -1 : 1)).slice(0, max);
}

/** The keeper is the richer record: more filled properties wins, ties go to the smaller id. */
function chooseKeeper(aId, aInst, bId, bInst) {
  const filled = (inst) => Object.values(inst.properties || {}).filter((v) => String(v ?? '').trim()).length;
  const fa = filled(aInst), fb = filled(bInst);
  if (fa !== fb) return fa > fb ? [aId, bId] : [bId, aId];
  return aId < bId ? [aId, bId] : [bId, aId];
}

function extractJson(text) {
  // Accept a bare string OR a chatCompletion-style {content} envelope — an
  // adapter that forgets .content must not silently floor a paid model run.
  if (text && typeof text === 'object' && 'content' in text) text = text.content;
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  for (let end = s.length; end > start; end--) {
    try { return JSON.parse(s.slice(start, end)); } catch { /* trim trailing junk */ }
  }
  return null;
}

/**
 * Run entity resolution over a domain.
 * `llm(messages)` is injectable (tests script it; the CLI wires the real one).
 * Returns { pairs, proposals, discarded } — proposals are candidate
 * merge_instances docs by 'kairos-resolver'; nothing is ever merged here.
 */
export async function resolveEntities(domain, { llm, minConfidence = MIN_CONFIDENCE, force = false, max = MAX_PAIRS } = {}) {
  if (typeof llm !== 'function') throw new Error('resolveEntities requires an llm(messages) function');
  assertDomain(domain);
  const proj = loadProjection(domain);
  const pairs = candidatePairs(proj, { max });
  if (!pairs.length) {
    return { domain, ok: true, skipped: 'no candidate duplicate pairs — identity columns show no shared values', pairs: 0, proposals: [] };
  }

  const key = `enrichment:resolve:${crypto.createHash('sha256').update(JSON.stringify(pairs)).digest('hex').slice(0, 16)}`;
  const prior = proj.enrichment?.get?.(key);
  if (prior && !force) {
    return { domain, ok: true, replay: true, key, pairs: pairs.length, proposals: prior.proposalIds || [], discarded: prior.discarded || 0 };
  }

  // What the model sees: both records of each pair, PII-redacted with the
  // domain's stable token map — same person, same token, so "these two rows
  // carry [PII_EMAIL_3]" is still a judgeable fact.
  const piiMap = loadPiiMap(domain);
  const view = pairs.map((p, i) => ({
    pair: i, type: p.type, matchedOn: p.via,
    a: { id: p.a, properties: redactInstanceProperties(proj.instance.get(p.a)?.properties || {}, piiMap) },
    b: { id: p.b, properties: redactInstanceProperties(proj.instance.get(p.b)?.properties || {}, piiMap) },
  }));
  savePiiMap(domain, piiMap);

  const system = [
    'You are the entity-resolution judge for a governed knowledge system.',
    'Each pair below holds two records of the same type that share an identity',
    'value. Decide for each pair whether they describe the SAME real-world',
    'entity (a duplicate) or DIFFERENT entities that merely collide.',
    'You cannot merge anything; a human reviews every verdict as a proposal.',
    '',
    'Respond with ONLY a JSON object, no prose, in this exact shape:',
    '{"judgments":[{"pair":0,"same":true,"confidence":0.0,"rationale":"<one sentence>"}]}',
    '',
    'Rules: one judgment per pair, using the pair index. confidence is your',
    'honest 0..1 estimate; below ' + minConfidence + ' is discarded. Values like',
    '[PII_NAME_1] are redaction tokens — IDENTICAL tokens mean identical raw',
    'values; treat them as opaque but comparable. When unsure, same:false.',
  ].join('\n');
  const user = 'Judge these candidate duplicate pairs:\n' + JSON.stringify({ domain, pairs: view }, null, 2);
  assertNoRawPii(system, 'resolver system prompt');
  assertNoRawPii(user, 'resolver user prompt');

  let reply;
  try {
    reply = await llm([{ role: 'system', content: system }, { role: 'user', content: user }]);
  } catch (err) {
    return { domain, ok: false, floor: true, reason: `model call failed: ${err.message}`, pairs: pairs.length, proposals: [] };
  }
  const parsed = extractJson(reply);
  if (!parsed || !Array.isArray(parsed.judgments)) {
    return { domain, ok: false, floor: true, reason: 'reply was not the required JSON shape', pairs: pairs.length, proposals: [] };
  }

  const appended = [];
  let discarded = 0;
  let keptApart = 0;
  for (const j of parsed.judgments.slice(0, MAX_PROPOSALS)) {
    const pair = pairs[Number(j?.pair)];
    if (!pair) { discarded++; continue; }
    const conf = Number(j?.confidence);
    if (!Number.isFinite(conf) || conf < minConfidence) { discarded++; continue; }
    if (j.same !== true) { keptApart++; continue; } // a confident "different" is a good answer, not noise
    const aInst = proj.instance.get(pair.a);
    const bInst = proj.instance.get(pair.b);
    const [keep, retire] = chooseKeeper(pair.a, aInst, pair.b, bInst);
    const seen = new Set();
    const evidence = [
      ...(aInst.evidence || []), ...(bInst.evidence || []),
    ].filter((e) => { const k = JSON.stringify(e); if (seen.has(k)) return false; seen.add(k); return true; });
    if (evidence.length === 0) { discarded++; continue; } // unapprovable → worthless
    const basis = JSON.stringify({ op: 'merge_instances', merge: { keep, retire } });
    const id = `proposal:merge_instances:${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 12)}`;
    appendDocument(domain, {
      kind: 'proposal', id,
      payload: {
        target: { kind: 'instance', id: keep },
        change: { op: 'merge_instances', keep, retire },
        rationale: String(j.rationale || '').slice(0, 500),
        confidence: conf,
        state: 'candidate', proposedBy: 'kairos-resolver', evidence,
      },
    });
    appended.push(id);
  }

  appendDocument(domain, {
    kind: 'enrichment', id: key,
    payload: { key, at: Date.now(), proposalIds: appended, discarded, keptApart, pairs: pairs.length },
  });
  return { domain, ok: true, key, pairs: pairs.length, proposals: appended, discarded, keptApart };
}

export default { MAX_PAIRS, candidatePairs, resolveEntities };
