// src/ontology/induce.js
// Deterministic ontology induction: file bytes → object types, typed
// properties, instances, relationships. No model involved.
//
// This is the "deterministic floor" LOGOS demands under every AI capability:
// drag-and-drop must produce a correct, evidence-backed ontology with zero
// API keys and an exhausted gateway quota. An LLM enrichment pass (workstream
// O3) can later RENAME and CONNECT more intelligently, but only ever as
// candidates over this substrate — never replacing it.
//
// Everything returned is a proposal: state 'candidate', proposedBy
// 'kairos-induction', each item carrying evidence refs back into the snapshot
// (row/line/pointer locators). The store's publish boundary does the caging.

// ── Naming ───────────────────────────────────────────────────────────────────

// Irregular plurals the suffix rules get wrong (G1). Table first, rules after —
// "statuses" through the rules becomes "statuse", and no rule will ever turn
// "people" into "person".
const IRREGULAR_PLURALS = {
  people: 'person', children: 'child', men: 'man', women: 'woman',
  mice: 'mouse', geese: 'goose', feet: 'foot', teeth: 'tooth',
  statuses: 'status', buses: 'bus', analyses: 'analysis', crises: 'crisis',
  indices: 'index', matrices: 'matrix',
};

/** Singularize one word: irregular table, then exactly one suffix rule. */
export function singularizeWord(word) {
  const w = String(word);
  const irregular = IRREGULAR_PLURALS[w.toLowerCase()];
  if (irregular) return irregular;
  // Exactly one rule may fire — chained replaces compound (warehouses → warehous → warehou).
  if (/ies$/i.test(w)) return w.replace(/ies$/i, 'y');
  if (/(ss|x|z|ch|sh)es$/i.test(w)) return w.replace(/es$/i, '');
  if (/[^s]s$/i.test(w)) return w.replace(/s$/i, '');
  return w;
}

/** customers.csv → Customer; order_items.json → OrderItem; people.csv → Person.
 *  Locale-safe: non-ASCII words (顧客) pass through untouched — case mapping
 *  and singularization are no-ops for them, never mangling. */
export function typeNameFromFile(filename) {
  const base = String(filename).replace(/\.[^.]+$/, '').replace(/[_\-\s]+/g, ' ').trim();
  const words = base.split(' ').filter(Boolean);
  if (words.length) words[words.length - 1] = singularizeWord(words[words.length - 1]);
  const pascal = words
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('');
  return pascal || 'Record';
}

export function propName(header) {
  const cleaned = String(header).trim().replace(/^[﻿]+/, '');
  // Unicode word characters survive (G1): a 名前 or 顧客ID header keeps its
  // identity instead of every CJK column collapsing into one 'field'.
  const words = cleaned.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return 'field';
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
}

// ── Value typing ─────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/;
const BOOL_SET = new Set(['true', 'false', 'yes', 'no', '0', '1']);

// Header hints (G1): what a column is CALLED carries signal its values lack.
const ID_NAME_RE = /(^id$|Id$|^key$|Code$|^sku$|Number$|No$)/;
const MONEY_NAME_RE = /(price|amount|cost|total|fee|salary)$/i;
const DATE_NAME_RE = /(date|Date|At|Day|_at)$/;

/**
 * Infer a property's type from its values, sharpened by its (cleaned) name.
 * `name` is optional — value-only inference still works, hints only ever ADD:
 *   - a date-named column whose values all Date.parse gets type 'date' even
 *     when they aren't ISO ("Jan 5, 2026")
 *   - role 'identifier' (id-like name, or unique+full coverage) vs 'quantity'
 *     (numbers that measure) — G2's agents and the graph plane need to know
 *     which numbers are references and which are amounts
 *   - money-named numeric columns get semantic 'money'
 * Enum detection is calibrated: ≥8 present values and distinct ≤ present/4 —
 * and identifier columns are never enums, however few and repeated.
 */
export function inferType(values, { name = '' } = {}) {
  const present = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (present.length === 0) return { type: 'string', nullable: true };
  const strs = present.map((v) => String(v).trim());
  const every = (fn) => strs.every(fn);
  let type = 'string';
  if (every((s) => /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s))) type = 'number';
  else if (every((s) => BOOL_SET.has(s.toLowerCase())) && new Set(strs.map((s) => s.toLowerCase())).size <= 2) type = 'boolean';
  else if (every((s) => DATE_RE.test(s))) type = 'date';
  else if (DATE_NAME_RE.test(name) && every((s) => !Number.isNaN(Date.parse(s)))) type = 'date';

  const distinct = new Set(strs);
  const out = { type, nullable: present.length < values.length };

  const idLike = ID_NAME_RE.test(name);
  const unique = present.length === values.length && distinct.size === strs.length;
  if (idLike && unique) out.role = 'identifier';
  else if (type === 'number' && !idLike) out.role = 'quantity';
  if (type === 'number' && MONEY_NAME_RE.test(name)) out.semantic = 'money';

  if (type === 'string' && !idLike
    && present.length >= 8
    && distinct.size >= 2 && distinct.size <= Math.min(10, Math.floor(present.length / 4))) {
    out.enum = [...distinct].sort().slice(0, 10);
  }
  return out;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** Minimal RFC-4180-ish CSV parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

function induceFromTable(headers, rows, { typeName, snapshotId, sourceName }) {
  const props = headers.map(propName);
  const columns = props.map((_, c) => rows.map((r) => r[c] ?? ''));
  // Each property records which snapshot taught it to us (G1 provenance) —
  // when two files contribute to one type, the union stays auditable per column.
  const propDefs = props.map((name, c) => ({ name, ...inferType(columns[c], { name }), sources: [snapshotId] }));

  // Key column: prefer an explicit *id* name whose values are unique; fall
  // back to any unique, fully-present column; else synthesize row numbers.
  const uniq = (c) => {
    const vals = columns[c].map((v) => String(v).trim());
    return vals.every((v) => v !== '') && new Set(vals).size === vals.length;
  };
  let keyIdx = props.findIndex((p, c) => /(^id$|Id$|^key$)/.test(p) && uniq(c));
  if (keyIdx === -1) keyIdx = props.findIndex((_, c) => uniq(c));

  const objectType = {
    id: `type:${typeName}`,
    payload: {
      name: typeName,
      ...(sourceName ? { sourceName: String(sourceName) } : {}),
      category: 'source_object',
      properties: propDefs,
      keyProperty: keyIdx >= 0 ? props[keyIdx] : null,
      state: 'candidate',
      proposedBy: 'kairos-induction',
      evidence: [{ snapshot: snapshotId, locator: 'header' }],
    },
  };

  const instances = rows.map((r, i) => {
    const properties = {};
    props.forEach((p, c) => { properties[p] = r[c] ?? ''; });
    const key = keyIdx >= 0 ? String(r[keyIdx]).trim() : `row-${i + 1}`;
    return {
      id: `inst:${typeName}:${key}`,
      payload: {
        type: typeName, key, properties,
        state: 'candidate', proposedBy: 'kairos-induction',
        evidence: [{ snapshot: snapshotId, locator: `row:${i + 2}` }], // 1-based + header
      },
    };
  });

  return { objectTypes: [objectType], instances, relationships: [] };
}

export function induceCsv(text, { filename, snapshotId }) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { objectTypes: [], instances: [], relationships: [] };
  return induceFromTable(rows[0], rows.slice(1), { typeName: typeNameFromFile(filename), snapshotId, sourceName: filename });
}

// ── JSON / JSONL ─────────────────────────────────────────────────────────────

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else if (Array.isArray(v)) out[key] = v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)).join('; ');
    else out[key] = v;
  }
  return out;
}

export function induceJson(text, { filename, snapshotId }) {
  let data;
  try { data = JSON.parse(text); } catch { return { objectTypes: [], instances: [], relationships: [] }; }
  const records = Array.isArray(data) ? data : [data];
  const objects = records.filter((r) => r && typeof r === 'object');
  if (objects.length === 0) return { objectTypes: [], instances: [], relationships: [] };
  const flat = objects.map((o) => flatten(o));
  const headers = [...new Set(flat.flatMap((o) => Object.keys(o)))];
  const rows = flat.map((o) => headers.map((h) => (o[h] === undefined || o[h] === null ? '' : String(o[h]))));
  const induced = induceFromTable(headers, rows, { typeName: typeNameFromFile(filename), snapshotId, sourceName: filename });
  // Locators for JSON are element pointers, not CSV rows.
  induced.instances.forEach((inst, i) => { inst.payload.evidence = [{ snapshot: snapshotId, locator: Array.isArray(data) ? `item:${i}` : 'root' }]; });
  return induced;
}

export function induceJsonl(text, { filename, snapshotId }) {
  const objects = [];
  const lines = String(text).split('\n');
  lines.forEach((line) => {
    if (!line.trim()) return;
    try { const o = JSON.parse(line); if (o && typeof o === 'object') objects.push(o); } catch { /* skip torn lines */ }
  });
  if (objects.length === 0) return { objectTypes: [], instances: [], relationships: [] };
  return induceJson(JSON.stringify(objects), { filename, snapshotId });
}

// ── Markdown / text ──────────────────────────────────────────────────────────

export function induceMarkdown(text, { filename, snapshotId }) {
  const lines = String(text).split('\n');
  const topics = [];
  let current = null;
  lines.forEach((line, i) => {
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      current = { title: h[2].trim(), level: h[1].length, line: i + 1, body: [] };
      topics.push(current);
    } else if (current && line.trim()) current.body.push(line.trim());
  });
  if (topics.length === 0) {
    const title = typeNameFromFile(filename);
    topics.push({ title, level: 1, line: 1, body: lines.filter((l) => l.trim()).slice(0, 5) });
  }
  const typeName = 'Topic';
  const objectType = {
    id: `type:${typeName}`,
    payload: {
      name: typeName, category: 'derived_object',
      properties: [{ name: 'title', type: 'string' }, { name: 'level', type: 'number' }, { name: 'excerpt', type: 'string' }],
      keyProperty: 'title',
      state: 'candidate', proposedBy: 'kairos-induction',
      evidence: [{ snapshot: snapshotId, locator: 'document' }],
    },
  };
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9぀-ヿ一-鿿]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const instances = topics.map((t) => ({
    id: `inst:${typeName}:${slug(t.title)}`,
    payload: {
      type: typeName, key: t.title,
      properties: { title: t.title, level: t.level, excerpt: t.body.join(' ').slice(0, 240) },
      state: 'candidate', proposedBy: 'kairos-induction',
      evidence: [{ snapshot: snapshotId, locator: `line:${t.line}` }],
    },
  }));
  // A topic that names another topic in its body is a mention — the cheapest
  // honest edge a text file offers.
  const relationships = [];
  for (const a of topics) {
    const bodyText = a.body.join(' ');
    for (const b of topics) {
      if (a === b || b.title.length < 4) continue;
      if (bodyText.includes(b.title)) {
        relationships.push({
          id: `rel:mentions:${slug(a.title)}:${slug(b.title)}`,
          payload: {
            name: 'mentions', from: `inst:${typeName}:${slug(a.title)}`, to: `inst:${typeName}:${slug(b.title)}`,
            fromType: typeName, toType: typeName,
            state: 'candidate', proposedBy: 'kairos-induction',
            evidence: [{ snapshot: snapshotId, locator: `line:${a.line}` }],
          },
        });
      }
    }
  }
  return { objectTypes: [objectType], instances, relationships };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

const HANDLERS = {
  '.csv': induceCsv, '.tsv': (t, o) => induceCsv(t.replace(/\t/g, ','), o),
  '.json': induceJson, '.jsonl': induceJsonl, '.ndjson': induceJsonl,
  '.md': induceMarkdown, '.markdown': induceMarkdown, '.txt': induceMarkdown,
};

export const SUPPORTED_EXTENSIONS = Object.keys(HANDLERS);

export function induceFromFile({ filename, content, snapshotId }) {
  const ext = String(filename).toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  const handler = HANDLERS[ext];
  if (!handler) return { objectTypes: [], instances: [], relationships: [], unsupported: ext || 'no-extension' };
  return handler(String(content), { filename, snapshotId });
}

// ── Type unification (G1) ────────────────────────────────────────────────────

/**
 * Merge a freshly induced object_type payload into the existing one, instead
 * of last-write-wins. Rules:
 *   - properties: union by name; a property seen by both keeps the existing
 *     definition and unions its `sources` provenance; a TYPE disagreement
 *     widens to 'string' and records every observed type — losing information
 *     beats inventing certainty
 *   - keyProperty: the first file to establish a key keeps it
 *   - evidence: union, deduplicated
 *   - everything human-owned survives: state, approvedBy, description — a
 *     re-dropped file must NEVER demote an approved type back to candidate
 * Pure over payloads (no _version/_at), so identical re-drops still deep-equal
 * and replay without appending.
 */
export function mergeObjectTypePayload(existing, incoming) {
  const { _version, _at, ...prev } = existing || {};
  if (!prev.name) return incoming;
  const props = new Map((prev.properties || []).map((p) => [p.name, { ...p }]));
  for (const p of incoming.properties || []) {
    const cur = props.get(p.name);
    if (!cur) { props.set(p.name, { ...p }); continue; }
    const merged = { ...cur };
    if (cur.type !== p.type) {
      merged.observedTypes = [...new Set([...(cur.observedTypes || [cur.type]), ...(p.observedTypes || [p.type])])];
      merged.type = 'string';
    }
    const sources = [...new Set([...(cur.sources || []), ...(p.sources || [])])];
    if (sources.length) merged.sources = sources;
    props.set(p.name, merged);
  }
  const evidence = [];
  const seen = new Set();
  for (const e of [...(prev.evidence || []), ...(incoming.evidence || [])]) {
    const k = JSON.stringify(e);
    if (!seen.has(k)) { seen.add(k); evidence.push(e); }
  }
  return {
    ...prev,
    properties: [...props.values()],
    keyProperty: prev.keyProperty || incoming.keyProperty || null,
    evidence,
  };
}

// ── Cross-file linking ───────────────────────────────────────────────────────

/**
 * Foreign-key discovery over a whole domain projection: when object type A has
 * a property whose values overlap ≥ 60% with type B's key values (and B has at
 * least 2 instances), propose `A.<prop> refers_to B` plus the instance-level
 * edges. Runs after every ingest; content-addressed IDs make re-runs idempotent.
 *
 * `touchedTypes` (G0, incremental mode): when given, only pairs where at least
 * one side was touched by the current ingest are scanned. Pairs among
 * untouched types cannot have changed — their links are already journaled from
 * the ingest that touched them — so re-scanning them is pure waste that grows
 * O(types² × instances) with the domain.
 */
export function discoverLinks(projection, { touchedTypes } = {}) {
  const touched = touchedTypes ? new Set(touchedTypes) : null;
  const types = [...(projection.object_type?.values() || [])];
  const instances = [...(projection.instance?.values() || [])];
  const byType = new Map();
  for (const inst of instances) {
    if (!byType.has(inst.type)) byType.set(inst.type, []);
    byType.get(inst.type).push(inst);
  }

  const relationships = [];
  for (const a of types) {
    const aInsts = byType.get(a.name) || [];
    if (aInsts.length === 0) continue;
    for (const prop of a.properties || []) {
      if (a.keyProperty === prop.name) continue;
      for (const b of types) {
        if (b.name === a.name || !b.keyProperty) continue;
        if (touched && !touched.has(a.name) && !touched.has(b.name)) continue;
        const bInsts = byType.get(b.name) || [];
        if (bInsts.length < 2) continue;
        const bKeys = new Set(bInsts.map((i) => String(i.key)));
        const aVals = aInsts.map((i) => String(i.properties?.[prop.name] ?? '').trim()).filter((v) => v !== '');
        if (aVals.length === 0) continue;
        const hits = aVals.filter((v) => bKeys.has(v));
        if (hits.length / aVals.length >= 0.6 && hits.length >= 2) {
          relationships.push({
            id: `rel:refers:${a.name}.${prop.name}->${b.name}`,
            payload: {
              name: `${a.name}.${prop.name} → ${b.name}`,
              kind: 'reference', fromType: a.name, toType: b.name, viaProperty: prop.name,
              coverage: Math.round((hits.length / aVals.length) * 100) / 100,
              state: 'candidate', proposedBy: 'kairos-induction',
              evidence: (a.evidence || []).slice(0, 1),
            },
          });
          for (const inst of aInsts) {
            const v = String(inst.properties?.[prop.name] ?? '').trim();
            if (!bKeys.has(v)) continue;
            relationships.push({
              id: `rel:ref:${a.name}:${inst.key}:${prop.name}:${v}`,
              payload: {
                name: prop.name, kind: 'reference_instance',
                from: `inst:${a.name}:${inst.key}`, to: `inst:${b.name}:${v}`,
                fromType: a.name, toType: b.name,
                state: 'candidate', proposedBy: 'kairos-induction',
                evidence: (inst.evidence || []).slice(0, 1),
              },
            });
          }
        }
      }
    }
  }
  return relationships;
}

export default {
  typeNameFromFile, singularizeWord, propName, inferType, parseCsv,
  induceCsv, induceJson, induceJsonl, induceMarkdown,
  induceFromFile, discoverLinks, mergeObjectTypePayload, SUPPORTED_EXTENSIONS,
};
