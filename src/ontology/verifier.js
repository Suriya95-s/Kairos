// src/ontology/verifier.js
// O3 — the verifier agent. An LLM reviews what deterministic induction
// proposed (names, descriptions, missing semantic relations) and writes its
// findings back as PROPOSALS: candidate documents describing a change without
// making it. The store's publish boundary keeps it caged — the verifier can
// never approve anything, including its own suggestions.
//
// Three rules carried from LOGOS (see docs/plans/2026-08-13-ontology-engine.md,
// "Cross-check" section):
//   1. PII is redacted before anything reaches the model, and the assembled
//      prompt is guarded fail-closed (assertNoRawPii).
//   2. The model-visible action lists are GENERATED from the constants below —
//      never hand-copied into prompt text (the LOGOS 6-of-10 drift trap).
//   3. Deterministic floor: a failed call, unparseable reply, or low-confidence
//      proposal changes NOTHING. Enrichment is strictly additive; the induced
//      ontology stands on its own.

import crypto from 'node:crypto';
import {
  PROPOSAL_OPS, loadProjection, appendDocument, assertDomain,
} from './store.js';
import { loadPiiMap, savePiiMap, redactInstanceProperties, assertNoRawPii } from './redact.js';

export const MIN_CONFIDENCE = 0.55; // LOGOS's classifier gate; below this a proposal is noise
export const MAX_PROPOSALS = 20;    // per run — a verifier that "fixes" everything is hallucinating
const SAMPLE_INSTANCES = 3;         // instances shown to the model per type, redacted

// The verifier's entire permission slip. Prompt text derives from these two
// tables; enforcement derives from the same tables. One source, zero drift.
export const ALLOWED_ACTIONS = Object.freeze({
  rename: 'propose a better name for an object or relationship type',
  describe: 'propose a one-sentence description for a type',
  add_relation: 'propose a semantic relationship between two existing types',
  // G2 — graph engineering ops. Still proposals: a human applies or discards.
  merge_types: 'propose that two types are the same concept (keeper absorbs the loser as an alias)',
  retire_relation: 'propose retiring an induced relation that is a false or meaningless join',
  retype_property: 'propose a more precise type for a property (string|number|boolean|date)',
  merge_instances: 'propose that two instances of one type are the same real-world entity',
  annotate: 'propose semantic tags or units for a type or relation (e.g. unit:JPY, pii:name)',
});

export const BLOCKED_ACTIONS = Object.freeze({
  approve_document: 'approval is a human act — separation of duties is enforced in the store',
  retire_document: 'retirement is terminal and human-only',
  modify_instance_data: 'instances mirror source bytes; changing them would break evidence lineage',
  create_type: 'types come from induction over real data, never from imagination',
  delete_anything: 'the journal is append-only; nothing is ever deleted',
  ingest_data: 'ingestion is the drop folder’s job — the verifier only reviews what exists',
  query_external_systems: 'the projection in this prompt is the verifier’s entire world',
});

// Every allowed action must be an op the store will actually apply, and vice
// versa — checked at import time so drift refuses to boot (LOGOS §1.3).
for (const op of Object.keys(ALLOWED_ACTIONS)) {
  if (!PROPOSAL_OPS.includes(op)) throw new Error(`verifier allows "${op}" but the store cannot apply it`);
}
for (const op of PROPOSAL_OPS) {
  if (!ALLOWED_ACTIONS[op]) throw new Error(`store applies "${op}" but the verifier does not declare it`);
}

// ── Projection (what the model is allowed to see) ───────────────────────────

/**
 * Build the model-visible projection for a domain: types with properties and
 * counts, relations, and a few sample instances per type — every string
 * passed through the domain's PII map first. Returns { data, piiMap }.
 */
export function buildProjection(domain) {
  assertDomain(domain);
  const proj = loadProjection(domain);
  const piiMap = loadPiiMap(domain);

  const types = [...proj.object_type.entries()].map(([id, t]) => ({
    id,
    name: t.name,
    state: t.state,
    ...(t.description ? { description: t.description } : {}),
    properties: (t.properties || []).map((p) => ({ name: p.name, type: p.type, ...(p.key ? { key: true } : {}), ...(p.values ? { values: p.values } : {}) })),
    instances: [...proj.instance.values()].filter((i) => i.type === t.name).length,
    samples: [...proj.instance.entries()]
      .filter(([, i]) => i.type === t.name)
      .slice(0, SAMPLE_INSTANCES)
      .map(([iid, i]) => ({ id: iid, properties: redactInstanceProperties(i.properties || {}, piiMap) })),
  }));

  // Two relation planes reach the model: semantic relations (relationship_type,
  // human-approved via add_relation) AND the induced type-level references
  // (kind 'reference' — the syntactic FK guesses the critic lens exists to
  // refute). Instance-level edges stay out: thousands of rows of noise.
  const relations = [
    ...[...proj.relationship_type.entries()].map(([id, r]) => ({
      id, kind: 'relationship_type', name: r.name, from: r.from, to: r.to, state: r.state,
      ...(r.viaProperty ? { viaProperty: r.viaProperty } : {}),
      ...(r.coverage != null ? { coverage: r.coverage } : {}),
    })),
    ...[...proj.relationship.entries()]
      .filter(([, r]) => r.kind === 'reference')
      .map(([id, r]) => ({
        id, kind: 'relationship', name: r.name, from: r.fromType, to: r.toType, state: r.state,
        ...(r.viaProperty ? { viaProperty: r.viaProperty } : {}),
        ...(r.coverage != null ? { coverage: r.coverage } : {}),
      })),
  ];

  return { data: { domain, types, relations }, piiMap };
}

// ── Incremental slices (G2) ─────────────────────────────────────────────────
//
// One new file must not re-spend the whole domain. Each type, together with
// every relation touching it, is a SLICE keyed by the hash of exactly that
// subgraph. A slice whose key already carries an enrichment doc is unchanged
// since its last review — same bytes, same verdict — and is cut from the
// model's view. New instances, new properties, or a new relation touching the
// type all change the hash and re-arm just that slice.

/** Per-type subgraph keys over a projection's model-visible data. */
export function sliceKeys(projectionData) {
  return projectionData.types.map((t) => {
    const relations = projectionData.relations.filter((r) => r.from === t.name || r.to === t.name);
    const hash = crypto.createHash('sha256')
      .update(JSON.stringify({ type: t, relations })).digest('hex');
    return { name: t.name, key: `enrichment:slice:${hash.slice(0, 16)}` };
  });
}

/** The prompt, assembled ONLY from generated parts and guarded fail-closed. */
export function buildPrompt(projectionData) {
  const allowed = Object.entries(ALLOWED_ACTIONS)
    .map(([op, what]) => `- ${op}: ${what}`).join('\n');
  const blocked = Object.entries(BLOCKED_ACTIONS)
    .map(([op, why]) => `- ${op}: BLOCKED — ${why}`).join('\n');

  const system = [
    'You are the ontology verifier for a governed knowledge system.',
    'A deterministic pipeline induced the ontology below from real data files.',
    'Your job is to review it and PROPOSE improvements. You cannot change anything;',
    'every proposal goes to a human reviewer who may apply or discard it.',
    '',
    'Actions you may propose (the ONLY ops accepted):',
    allowed,
    '',
    'Actions that exist in this system but are blocked for you:',
    blocked,
    '',
    'Respond with ONLY a JSON object, no prose, in this exact shape:',
    '{"proposals":[{"op":"rename|describe|add_relation|merge_types|retire_relation|retype_property|merge_instances|annotate",',
    ' "target":{"kind":"object_type|relationship_type|relationship","id":"<id from the projection>"},',
    ' "name":"<for rename>", "description":"<for describe>",',
    ' "relation":{"name":"<verb>","from":"<TypeName>","to":"<TypeName>","description":"…"},',
    ' "merge":{"keep":"<id>","retire":"<id>"} for merge_types (type ids) and merge_instances (instance ids),',
    ' "property":"<name>", "type":"string|number|boolean|date" for retype_property,',
    ' "annotation":{"tags":["unit:JPY"],"note":"…"} for annotate,',
    ' "rationale":"<one sentence>", "confidence":0.0}]}',
    '',
    'Rules: at most ' + MAX_PROPOSALS + ' proposals. Only reference ids and type names',
    'that appear in the projection. confidence is your honest 0..1 estimate;',
    'below ' + MIN_CONFIDENCE + ' will be discarded. Values like [PII_EMAIL_1] are',
    'redaction tokens — treat them as opaque identity markers, never expand them.',
    'An empty {"proposals":[]} is a perfectly good answer for a clean ontology.',
  ].join('\n');

  const user = 'Review this induced ontology:\n' + JSON.stringify(projectionData, null, 2);

  assertNoRawPii(system, 'verifier system prompt');
  assertNoRawPii(user, 'verifier user prompt');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// ── Idempotency ──────────────────────────────────────────────────────────────

/**
 * Enrichment identity is the hash of exactly what the model would see.
 * Unchanged domain ⇒ same key ⇒ replay, not a second spend (LOGOS §2.3).
 */
export function enrichmentKey(projectionData) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(projectionData)).digest('hex');
  return `enrichment:${hash.slice(0, 16)}`;
}

// ── The run ──────────────────────────────────────────────────────────────────

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

function proposalId(p) {
  const basis = JSON.stringify({
    op: p.op, target: p.target, name: p.name, description: p.description, relation: p.relation,
    merge: p.merge, property: p.property, type: p.type, annotation: p.annotation,
  });
  return `proposal:${p.op}:${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 12)}`;
}

/**
 * Run the verifier over a domain.
 * `llm(messages)` is injectable (tests script it; the CLI wires the real one).
 * Never throws on model trouble — the deterministic floor is the induced set.
 */
export async function verifyDomain(domain, { llm, minConfidence = MIN_CONFIDENCE, force = false } = {}) {
  if (typeof llm !== 'function') throw new Error('verifyDomain requires an llm(messages) function');
  const { data, piiMap } = buildProjection(domain);
  if (data.types.length === 0) {
    return { domain, ok: true, skipped: 'empty domain — nothing to review', proposals: [] };
  }
  savePiiMap(domain, piiMap); // tokens minted for samples must stay stable next run

  const key = enrichmentKey(data);
  const proj = loadProjection(domain);
  const prior = proj.enrichment?.get?.(key);
  if (prior && !force) {
    return { domain, ok: true, replay: true, key, proposals: prior.proposalIds || [], discarded: prior.discarded || 0 };
  }

  // G2 incremental: cut already-reviewed slices from the model's view, so a
  // domain that grew by one file re-reviews only what that file touched.
  const slices = sliceKeys(data);
  const reviewed = force ? slices : slices.filter((s) => !proj.enrichment?.get?.(s.key));
  const sliceStats = { total: slices.length, reviewed: reviewed.length, skipped: slices.length - reviewed.length };
  let promptData = data;
  if (sliceStats.skipped > 0 && reviewed.length > 0) {
    const names = new Set(reviewed.map((s) => s.name));
    promptData = {
      domain: data.domain,
      types: data.types.filter((t) => names.has(t.name)),
      relations: data.relations.filter((r) => names.has(r.from) || names.has(r.to)),
    };
  }
  if (reviewed.length === 0) {
    // Every slice was already reviewed at exactly this content — record the
    // whole-domain key so the cheap replay path answers next time.
    appendDocument(domain, {
      kind: 'enrichment', id: key,
      payload: { key, at: Date.now(), proposalIds: [], discarded: 0, received: 0, slices: sliceStats },
    });
    return { domain, ok: true, replay: true, key, proposals: [], discarded: 0, slices: sliceStats };
  }

  const messages = buildPrompt(promptData);
  let reply;
  try {
    reply = await llm(messages);
  } catch (err) {
    return { domain, ok: false, floor: true, reason: `model call failed: ${err.message}`, proposals: [] };
  }
  const parsed = extractJson(reply);
  if (!parsed || !Array.isArray(parsed.proposals)) {
    return { domain, ok: false, floor: true, reason: 'reply was not the required JSON shape', proposals: [] };
  }

  const validTargets = new Set([
    ...[...proj.object_type.keys()].map((id) => `object_type/${id}`),
    ...[...proj.relationship_type.keys()].map((id) => `relationship_type/${id}`),
    ...[...proj.relationship.entries()].filter(([, r]) => r.kind === 'reference').map(([id]) => `relationship/${id}`),
  ]);
  const typeNames = new Set([...proj.object_type.values()].map((t) => t.name));
  const dedupEvidence = (list) => {
    const seen = new Set();
    return list.filter((e) => { const k = JSON.stringify(e); if (seen.has(k)) return false; seen.add(k); return true; });
  };

  const appended = [];
  let discarded = 0;
  for (const p of parsed.proposals.slice(0, MAX_PROPOSALS)) {
    const conf = Number(p?.confidence);
    if (!PROPOSAL_OPS.includes(p?.op)) { discarded++; continue; }
    if (!Number.isFinite(conf) || conf < minConfidence) { discarded++; continue; }

    let evidence = [];
    if (p.op === 'rename' || p.op === 'describe') {
      if (!validTargets.has(`${p.target?.kind}/${p.target?.id}`)) { discarded++; continue; }
      if (p.op === 'rename' && !String(p.name || '').trim()) { discarded++; continue; }
      if (p.op === 'describe' && !String(p.description || '').trim()) { discarded++; continue; }
      // Grounding: the proposal inherits the target's evidence — the claim is
      // about the same bytes the target was induced from. Models cannot mint refs.
      evidence = proj[p.target.kind].get(p.target.id)?.evidence || [];
    } else if (p.op === 'add_relation') {
      const r = p.relation || {};
      if (!r.name || !typeNames.has(r.from) || !typeNames.has(r.to)) { discarded++; continue; }
      const fromType = [...proj.object_type.values()].find((t) => t.name === r.from);
      evidence = fromType?.evidence || [];
    } else if (p.op === 'merge_types') {
      const { keep, retire } = p.merge || {};
      if (!keep || !retire || keep === retire) { discarded++; continue; }
      const kt = proj.object_type.get(keep);
      const rt = proj.object_type.get(retire);
      if (!kt || !rt || kt.state === 'retired' || rt.state === 'retired') { discarded++; continue; }
      // A merge claim is grounded in BOTH sides' bytes.
      evidence = dedupEvidence([...(kt.evidence || []), ...(rt.evidence || [])]);
    } else if (p.op === 'retire_relation') {
      const t = `${p.target?.kind}/${p.target?.id}`;
      if ((p.target?.kind !== 'relationship' && p.target?.kind !== 'relationship_type') || !validTargets.has(t)) { discarded++; continue; }
      evidence = proj[p.target.kind].get(p.target.id)?.evidence || [];
    } else if (p.op === 'retype_property') {
      const t = p.target?.kind === 'object_type' ? proj.object_type.get(p.target?.id) : null;
      if (!t || t.state === 'retired') { discarded++; continue; }
      if (!(t.properties || []).some((prop) => prop.name === p.property)) { discarded++; continue; }
      if (!['string', 'number', 'boolean', 'date'].includes(p.type)) { discarded++; continue; }
      evidence = t.evidence || [];
    } else if (p.op === 'merge_instances') {
      const { keep, retire } = p.merge || {};
      if (!keep || !retire || keep === retire) { discarded++; continue; }
      const ki = proj.instance.get(keep);
      const ri = proj.instance.get(retire);
      if (!ki || !ri || ki.type !== ri.type || ki.state === 'retired' || ri.state === 'retired') { discarded++; continue; }
      evidence = dedupEvidence([...(ki.evidence || []), ...(ri.evidence || [])]);
    } else if (p.op === 'annotate') {
      if (!validTargets.has(`${p.target?.kind}/${p.target?.id}`)) { discarded++; continue; }
      const tags = (p.annotation?.tags || []).map((t) => String(t).trim()).filter(Boolean);
      if (!tags.length && !String(p.annotation?.note || '').trim()) { discarded++; continue; }
      evidence = proj[p.target.kind].get(p.target.id)?.evidence || [];
    }
    if (evidence.length === 0) { discarded++; continue; } // unapprovable → worthless

    const id = proposalId(p);
    const isMerge = p.op === 'merge_types' || p.op === 'merge_instances';
    const payload = {
      target: p.op === 'add_relation' ? { kind: 'relationship_type', id: 'new' }
        : isMerge ? { kind: p.op === 'merge_types' ? 'object_type' : 'instance', id: p.merge.keep }
        : { kind: p.target.kind, id: p.target.id },
      change: {
        op: p.op,
        ...(p.op === 'rename' ? { name: String(p.name).trim() } : {}),
        ...(p.op === 'describe' ? { description: String(p.description).trim() } : {}),
        ...(p.op === 'add_relation' ? { relation: { name: p.relation.name, from: p.relation.from, to: p.relation.to, ...(p.relation.description ? { description: p.relation.description } : {}) } } : {}),
        ...(isMerge ? { keep: p.merge.keep, retire: p.merge.retire } : {}),
        ...(p.op === 'retype_property' ? { property: p.property, type: p.type } : {}),
        ...(p.op === 'annotate' ? {
          annotation: {
            tags: (p.annotation?.tags || []).map((t) => String(t).trim()).filter(Boolean),
            ...(String(p.annotation?.note || '').trim() ? { note: String(p.annotation.note).trim() } : {}),
          },
        } : {}),
      },
      rationale: String(p.rationale || '').slice(0, 500),
      confidence: conf,
      state: 'candidate',
      proposedBy: 'kairos-verifier',
      evidence,
    };
    appendDocument(domain, { kind: 'proposal', id, payload });
    appended.push(id);
  }

  // Every reviewed slice gets its own key doc — the incremental filter above
  // reads these to skip unchanged slices next run.
  for (const s of reviewed) {
    appendDocument(domain, { kind: 'enrichment', id: s.key, payload: { key: s.key, type: s.name, at: Date.now() } });
  }
  appendDocument(domain, {
    kind: 'enrichment', id: key,
    payload: { key, at: Date.now(), proposalIds: appended, discarded, received: parsed.proposals.length, slices: sliceStats },
  });

  return { domain, ok: true, key, proposals: appended, discarded, received: parsed.proposals.length, slices: sliceStats };
}

// ── The critic lens (G2) ────────────────────────────────────────────────────
//
// The verifier looks for what is MISSING; the critic looks for what is WRONG.
// Induction's FK heuristic (≥60% value overlap) invents false joins — a
// status column overlapping a priority column, a quantity hitting id ranges.
// The critic is prompted to REFUTE candidate induced relations, and every
// refutation lands as a retire_relation PROPOSAL: the critic points, a human
// retires. Same floor, same confidence gate, same replay-by-content-key.

/**
 * Run the critic over a domain's candidate induced relations.
 * `llm(messages)` is injectable exactly like verifyDomain's.
 */
export async function critiqueDomain(domain, { llm, minConfidence = MIN_CONFIDENCE, force = false } = {}) {
  if (typeof llm !== 'function') throw new Error('critiqueDomain requires an llm(messages) function');
  assertDomain(domain);
  const proj = loadProjection(domain);
  const suspects = [...proj.relationship.entries()]
    .filter(([, r]) => r.kind === 'reference' && r.state === 'candidate')
    .map(([id, r]) => ({
      id, name: r.name, from: r.fromType, to: r.toType,
      ...(r.viaProperty ? { viaProperty: r.viaProperty } : {}),
      ...(r.coverage != null ? { coverage: r.coverage } : {}),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!suspects.length) {
    return { domain, ok: true, skipped: 'no candidate induced relations to refute', proposals: [] };
  }

  const key = `enrichment:critic:${crypto.createHash('sha256').update(JSON.stringify(suspects)).digest('hex').slice(0, 16)}`;
  const prior = proj.enrichment?.get?.(key);
  if (prior && !force) {
    return { domain, ok: true, replay: true, key, proposals: prior.proposalIds || [], discarded: prior.discarded || 0 };
  }

  // Context the critic judges against: the types, their key properties, and a
  // few redacted sample values per property involved in a suspect join.
  const piiMap = loadPiiMap(domain);
  const typeContext = [...proj.object_type.values()]
    .filter((t) => t.state !== 'retired')
    .map((t) => ({
      name: t.name, keyProperty: t.keyProperty || null,
      properties: (t.properties || []).map((p) => ({ name: p.name, type: p.type, ...(p.role ? { role: p.role } : {}) })),
    }));
  const sampleValues = {};
  for (const s of suspects) {
    const vals = [...proj.instance.values()]
      .filter((i) => i.type === s.from)
      .map((i) => String(i.properties?.[s.viaProperty] ?? ''))
      .filter(Boolean).slice(0, 5);
    if (vals.length) sampleValues[`${s.from}.${s.viaProperty}`] = vals.map((v) => redactInstanceProperties({ v }, piiMap).v);
  }
  savePiiMap(domain, piiMap);

  const system = [
    'You are the ontology CRITIC for a governed knowledge system.',
    'A deterministic pipeline guessed the foreign-key relations below from value',
    'overlap alone (≥60%). Overlap invents false joins: a status column hitting a',
    'priority column, quantities landing in id ranges, two unrelated code lists.',
    'Your ONLY job is to REFUTE relations that are semantically wrong. You cannot',
    'change anything; every refutation becomes a retirement PROPOSAL for a human.',
    '',
    'Respond with ONLY a JSON object, no prose, in this exact shape:',
    '{"refutations":[{"id":"<relation id from the list>",',
    ' "rationale":"<one sentence: why this join is false>", "confidence":0.0}]}',
    '',
    'Rules: only ids from the list. confidence is your honest 0..1 estimate that',
    'the relation is WRONG; below ' + minConfidence + ' is discarded. Values like',
    '[PII_EMAIL_1] are redaction tokens — treat them as opaque. An empty',
    '{"refutations":[]} is the right answer when the joins all look sound.',
  ].join('\n');
  const user = 'Candidate relations to review:\n' + JSON.stringify({ domain, relations: suspects, types: typeContext, sampleValues }, null, 2);
  assertNoRawPii(system, 'critic system prompt');
  assertNoRawPii(user, 'critic user prompt');

  let reply;
  try {
    reply = await llm([{ role: 'system', content: system }, { role: 'user', content: user }]);
  } catch (err) {
    return { domain, ok: false, floor: true, reason: `model call failed: ${err.message}`, proposals: [] };
  }
  const parsed = extractJson(reply);
  if (!parsed || !Array.isArray(parsed.refutations)) {
    return { domain, ok: false, floor: true, reason: 'reply was not the required JSON shape', proposals: [] };
  }

  const suspectIds = new Map(suspects.map((s) => [s.id, s]));
  const appended = [];
  let discarded = 0;
  for (const r of parsed.refutations.slice(0, MAX_PROPOSALS)) {
    const conf = Number(r?.confidence);
    const suspect = suspectIds.get(r?.id);
    if (!suspect) { discarded++; continue; }
    if (!Number.isFinite(conf) || conf < minConfidence) { discarded++; continue; }
    const evidence = proj.relationship.get(r.id)?.evidence || [];
    if (evidence.length === 0) { discarded++; continue; }
    const p = { op: 'retire_relation', target: { kind: 'relationship', id: r.id } };
    const id = proposalId(p);
    appendDocument(domain, {
      kind: 'proposal', id,
      payload: {
        target: p.target,
        change: { op: 'retire_relation' },
        rationale: String(r.rationale || '').slice(0, 500),
        confidence: conf,
        state: 'candidate', proposedBy: 'kairos-critic', evidence,
      },
    });
    appended.push(id);
  }

  appendDocument(domain, {
    kind: 'enrichment', id: key,
    payload: { key, at: Date.now(), proposalIds: appended, discarded, received: parsed.refutations.length },
  });
  return { domain, ok: true, key, proposals: appended, discarded, received: parsed.refutations.length };
}

export default {
  ALLOWED_ACTIONS, BLOCKED_ACTIONS, MIN_CONFIDENCE, MAX_PROPOSALS,
  buildProjection, buildPrompt, sliceKeys, enrichmentKey, verifyDomain, critiqueDomain,
};
