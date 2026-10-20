// src/ontology/redact.js
// PII never reaches a model (LOGOS §4.1). Dropped files carry real emails and
// phone numbers; the verifier sends candidate data to an EXTERNAL endpoint, so
// everything model-bound passes through here first.
//
// Design: deterministic tokenization, not deletion. Each distinct value gets a
// stable token per domain ([PII_EMAIL_1], [PII_PHONE_2], …) so the model can
// still reason about identity ("the same customer appears twice") without ever
// seeing the value. The value→token map lives in the domain dir NEXT TO the
// raw snapshots that already contain those values — redaction is about what
// leaves the machine, not about disk encryption (the vault covers secrets;
// dropped business data stays where the user put it).

import fs from 'node:fs';
import path from 'node:path';
import { domainDir } from './store.js';

// Order matters: earlier categories claim their text first.
const CATEGORIES = [
  // john.doe+x@example.co.jp
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  // +81-90-1234-5678 / 03-1234-5678 / 090 1234 5678 — separators required so
  // plain integers (prices, quantities, ids) never match…
  ['PHONE', /(?:\+\d{1,3}[-\s])?\d{2,4}[-\s]\d{2,4}[-\s]\d{3,4}(?!\d)/g],
  // …except contiguous JP-style numbers, which must start with +81 or 0 and
  // run 10–11 digits (09012345678). A 7-digit price can't hit this.
  ['PHONE', /(?<![\d-])(?:\+81|0)\d{9,10}(?![\d-])/g],
];

const TOKEN_RE = /\[PII_[A-Z]+_\d+\]/;

export function emptyPiiMap() {
  return { version: 1, entries: {}, counters: {} };
}

function tokenFor(map, category, value) {
  if (map.entries[value]) return map.entries[value];
  const n = (map.counters[category] || 0) + 1;
  map.counters[category] = n;
  const token = `[PII_${category}_${n}]`;
  map.entries[value] = token;
  return token;
}

/** Replace every PII hit in `text` with its stable token, mutating `map`. */
export function redactText(text, map) {
  let out = String(text);
  for (const [category, re] of CATEGORIES) {
    out = out.replace(re, (m) => tokenFor(map, category, m));
  }
  return out;
}

/** Deep-walk any JSON value, redacting every string in place of a copy. */
export function redactValue(value, map) {
  if (typeof value === 'string') return redactText(value, map);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, map));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, map)]));
  }
  return value;
}

// ── Name-aware redaction (G1) ────────────────────────────────────────────────
//
// Regexes cannot recognise "Tanaka Hiroshi" as PII — but the ontology can:
// it already knows which columns are name-like. The person test is contextual
// and deterministic: a row whose OTHER fields carry PII tokens (an email, a
// phone) is a row about a person, so its name-like fields tokenize as
// [PII_NAME_n]. A products row has no email — its "name" column (the product
// name) survives untouched, exactly as it should.

const NAMEISH_RE = /^(name|fullname|firstname|lastname|contactname|personname|customername|username|氏名|名前)$/i;

/** True when a property name is a name-column (normalised: separators dropped). */
export function isNameishProp(prop) {
  return NAMEISH_RE.test(String(prop).replace(/[^\p{L}\p{N}]/gu, ''));
}

/**
 * Redact one instance's properties for a model: regex categories first, then —
 * only when the row already proved it is about a person — name-like fields.
 * Tokens stay stable via the same map the regex categories use.
 */
export function redactInstanceProperties(properties, map) {
  const redacted = redactValue(properties || {}, map);
  const aboutAPerson = Object.values(redacted).some((v) => typeof v === 'string' && hasPiiTokens(v));
  if (!aboutAPerson) return redacted;
  return Object.fromEntries(Object.entries(redacted).map(([k, v]) => {
    if (typeof v === 'string' && v.trim() && isNameishProp(k) && !hasPiiTokens(v)) {
      return [k, tokenFor(map, 'NAME', v)];
    }
    return [k, v];
  }));
}

/**
 * The fail-closed guard the verifier runs over its fully assembled prompt.
 * Defense in depth: even if some new code path skips redactValue, a raw email
 * or phone number in model-bound text throws instead of leaving the machine.
 */
export function assertNoRawPii(text, label = 'model-bound text') {
  const map = emptyPiiMap();
  const redacted = redactText(String(text), map);
  if (redacted !== String(text)) {
    const kinds = Object.keys(map.counters).join(', ');
    throw new Error(`raw PII (${kinds}) found in ${label} — redact before the model sees it`);
  }
}

/** True when the text already carries redaction tokens (useful in tests). */
export function hasPiiTokens(text) {
  return TOKEN_RE.test(String(text));
}

/**
 * Reverse redaction for LOCAL display (G3): the model answers in tokens, the
 * user reads real values. Safe precisely because it never feeds a model —
 * rehydration happens after generation, on the way to the user's own screen,
 * where the raw values already live on disk anyway.
 */
export function rehydrateText(text, map) {
  let out = String(text);
  for (const [value, token] of Object.entries(map.entries || {})) {
    out = out.split(token).join(value);
  }
  return out;
}

// ── Persistence (per domain, beside the journal) ────────────────────────────

function mapPath(domain) {
  return path.join(domainDir(domain), 'pii-map.json');
}

export function loadPiiMap(domain) {
  try {
    const m = JSON.parse(fs.readFileSync(mapPath(domain), 'utf-8'));
    if (m && m.version === 1 && m.entries && m.counters) return m;
  } catch { /* absent or torn — start fresh; tokens stay stable via entries */ }
  return emptyPiiMap();
}

export function savePiiMap(domain, map) {
  fs.mkdirSync(domainDir(domain), { recursive: true });
  fs.writeFileSync(mapPath(domain), JSON.stringify(map, null, 2));
}

export default {
  emptyPiiMap, redactText, redactValue, redactInstanceProperties, isNameishProp,
  assertNoRawPii, hasPiiTokens, rehydrateText, loadPiiMap, savePiiMap,
};
