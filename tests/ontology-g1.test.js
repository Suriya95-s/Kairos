// tests/ontology-g1.test.js
// G1 — induction v2: type unification across files, header-driven typing,
// locale-safe naming, and name-aware PII redaction. Hermetic — KAIROS_HOME
// points at a temp dir per test.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  typeNameFromFile, singularizeWord, propName, inferType, mergeObjectTypePayload,
} from '../src/ontology/induce.js';
import { loadProjection, setPublicationState } from '../src/ontology/store.js';
import { ingestFile } from '../src/ontology/engine.js';
import {
  emptyPiiMap, redactInstanceProperties, isNameishProp, hasPiiTokens,
} from '../src/ontology/redact.js';
import { buildProjection } from '../src/ontology/verifier.js';

let tmpHome, dataDir;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-g1-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-g1-data-'));
  process.env.KAIROS_HOME = tmpHome;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  for (const d of [tmpHome, dataDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows locks */ }
  }
});

function writeData(name, content) {
  const p = path.join(dataDir, name);
  fs.writeFileSync(p, content);
  return p;
}

// ── Naming v2 ────────────────────────────────────────────────────────────────

describe('G1 naming', () => {
  test('irregular plurals come from the table, not the suffix rules', () => {
    assert.equal(typeNameFromFile('people.csv'), 'Person');
    assert.equal(typeNameFromFile('statuses.csv'), 'Status');
    assert.equal(typeNameFromFile('analyses.json'), 'Analysis');
    assert.equal(singularizeWord('children'), 'child');
  });

  test('the regular rules still hold (the Warehou bug stays dead)', () => {
    assert.equal(typeNameFromFile('warehouses.json'), 'Warehouse');
    assert.equal(typeNameFromFile('order_items.csv'), 'OrderItem');
    assert.equal(typeNameFromFile('companies.csv'), 'Company');
  });

  test('non-ASCII filenames and headers survive untouched', () => {
    assert.equal(typeNameFromFile('顧客.csv'), '顧客');
    assert.equal(propName('名前'), '名前', 'CJK headers must not all collapse into "field"');
    assert.equal(propName('顧客ID'), '顧客id');
    assert.equal(propName('Order ID'), 'orderId', 'ASCII behavior unchanged');
  });

  test('end to end: a Japanese CSV ingests with its own identity', () => {
    const file = writeData('顧客.csv', 'id,名前,都市\n1,田中,東京\n2,鈴木,大阪\n');
    const res = ingestFile('jpshop', file);
    assert.equal(res.ok, true);
    const proj = loadProjection('jpshop');
    const t = proj.object_type.get('type:顧客');
    assert.equal(t.name, '顧客');
    assert.equal(t.sourceName, '顧客.csv', 'provenance keeps the original filename');
    assert.ok(t.properties.some((p) => p.name === '名前'));
  });
});

// ── Header-driven typing ─────────────────────────────────────────────────────

describe('G1 typing', () => {
  test('identifier vs quantity: ids reference, quantities measure', () => {
    const id = inferType(['101', '102', '103'], { name: 'orderId' });
    assert.equal(id.role, 'identifier');
    const qty = inferType(['3', '1', '3'], { name: 'quantity' });
    assert.equal(qty.role, 'quantity');
    const fk = inferType(['7', '7', '9'], { name: 'customerId' });
    assert.notEqual(fk.role, 'quantity', 'a repeating id-named column is a reference, never an amount');
  });

  test('money-named numeric columns carry the money semantic', () => {
    assert.equal(inferType(['1200', '990'], { name: 'unitPrice' }).semantic, 'money');
    assert.equal(inferType(['1200', '990'], { name: 'total' }).semantic, 'money');
    assert.equal(inferType(['1200', '990'], { name: 'quantity' }).semantic, undefined);
  });

  test('a date-named header rescues non-ISO date values', () => {
    const hinted = inferType(['Jan 5, 2026', 'Feb 12, 2026'], { name: 'shippedDate' });
    assert.equal(hinted.type, 'date');
    const unhinted = inferType(['Jan 5, 2026', 'Feb 12, 2026'], { name: 'note' });
    assert.equal(unhinted.type, 'string', 'without the name hint, loose parsing stays off');
  });

  test('enums are calibrated: no verdicts from tiny samples, none from identifiers', () => {
    const tiny = inferType(['open', 'closed', 'open', 'closed']);
    assert.equal(tiny.enum, undefined, '4 values cannot establish an enum');
    const solid = inferType(Array.from({ length: 12 }, (_, i) => (i % 2 ? 'open' : 'closed')));
    assert.deepEqual(solid.enum, ['closed', 'open']);
    const idish = inferType(['a1', 'a2', 'a1', 'a2', 'a1', 'a2', 'a1', 'a2'], { name: 'sku' });
    assert.equal(idish.enum, undefined, 'identifier-named columns are never enums');
  });
});

// ── Type unification ─────────────────────────────────────────────────────────

describe('G1 type unification', () => {
  test('two files feeding one type union their properties with provenance', () => {
    const csv = writeData('orders.csv', 'id,total\no1,1200\no2,990\n');
    const json = writeData('orders.json', JSON.stringify([
      { id: 'o1', status: 'shipped' }, { id: 'o2', status: 'open' },
    ]));
    assert.equal(ingestFile('shop', csv).ok, true);
    assert.equal(ingestFile('shop', json).ok, true);
    const t = loadProjection('shop').object_type.get('type:Order');
    const names = t.properties.map((p) => p.name).sort();
    assert.deepEqual(names, ['id', 'status', 'total'], 'union, not last-write');
    const id = t.properties.find((p) => p.name === 'id');
    assert.equal(id.sources.length, 2, 'a property both files taught us cites both snapshots');
    const total = t.properties.find((p) => p.name === 'total');
    assert.equal(total.sources.length, 1);
    assert.equal(t.evidence.length, 2, 'evidence unions across files');
  });

  test('a type disagreement widens to string and records what was observed', () => {
    const merged = mergeObjectTypePayload(
      { name: 'Order', properties: [{ name: 'code', type: 'number', sources: ['snapshot:a'] }], evidence: [] },
      { name: 'Order', properties: [{ name: 'code', type: 'string', sources: ['snapshot:b'] }], evidence: [] },
    );
    const code = merged.properties.find((p) => p.name === 'code');
    assert.equal(code.type, 'string', 'losing precision beats inventing certainty');
    assert.deepEqual(code.observedTypes.sort(), ['number', 'string']);
    assert.deepEqual(code.sources.sort(), ['snapshot:a', 'snapshot:b']);
  });

  test('re-dropping a file can NEVER demote an approved type', () => {
    const csv = writeData('orders.csv', 'id,total\no1,1200\no2,990\n');
    assert.equal(ingestFile('shop', csv).ok, true);
    setPublicationState('shop', 'object_type', 'type:Order', 'approved', 'the-owner');
    // Same file again (replay) and a NEW file for the same type (real merge):
    assert.equal(ingestFile('shop', csv).ok, true);
    const json = writeData('orders.json', JSON.stringify([{ id: 'o1', status: 'shipped' }, { id: 'o2', status: 'open' }]));
    assert.equal(ingestFile('shop', json).ok, true);
    const t = loadProjection('shop').object_type.get('type:Order');
    assert.equal(t.state, 'approved', 'the human signature survives new data');
    assert.equal(t.approvedBy, 'the-owner');
    assert.ok(t.properties.some((p) => p.name === 'status'), 'while the union still happened');
  });

  test('identical re-drops still replay — unification did not break idempotence', () => {
    const csv = writeData('orders.csv', 'id,total\no1,1200\no2,990\n');
    assert.equal(ingestFile('shop', csv).ok, true);
    const second = ingestFile('shop', csv);
    assert.equal(second.ok, true);
    assert.equal(second.appended, 0, 'same bytes → nothing new in the journal');
  });

  test('the first key wins; a keyless second file cannot erase it', () => {
    const merged = mergeObjectTypePayload(
      { name: 'Order', keyProperty: 'id', properties: [], evidence: [] },
      { name: 'Order', keyProperty: null, properties: [], evidence: [] },
    );
    assert.equal(merged.keyProperty, 'id');
  });
});

// ── Name-aware PII ───────────────────────────────────────────────────────────

describe('G1 name-aware PII redaction', () => {
  test('a row about a person tokenizes its name; a product row keeps its name', () => {
    const map = emptyPiiMap();
    const person = redactInstanceProperties(
      { name: 'Tanaka Hiroshi', email: 'tanaka@example.jp', city: 'Tokyo' }, map);
    assert.match(person.name, /^\[PII_NAME_1\]$/, 'the email proved this row is about a person');
    assert.match(person.email, /^\[PII_EMAIL_1\]$/);
    assert.equal(person.city, 'Tokyo', 'non-name fields untouched');

    const product = redactInstanceProperties(
      { name: 'RTX 4090 GPU', price: '298000', stock: '4' }, map);
    assert.equal(product.name, 'RTX 4090 GPU', 'no PII in the row → the name is a label, not a person');
  });

  test('name tokens are stable across calls through the same map', () => {
    const map = emptyPiiMap();
    const a = redactInstanceProperties({ name: 'Suzuki Ai', email: 'ai@example.jp' }, map);
    const b = redactInstanceProperties({ name: 'Suzuki Ai', email: 'ai@example.jp' }, map);
    assert.equal(a.name, b.name, 'same person, same token, every time');
  });

  test('nameish detection is normalised and multi-locale', () => {
    assert.equal(isNameishProp('fullName'), true);
    assert.equal(isNameishProp('customer_name'), true);
    assert.equal(isNameishProp('名前'), true);
    assert.equal(isNameishProp('productTitle'), false);
    assert.equal(isNameishProp('city'), false);
  });

  test('end to end: the verifier projection never shows a customer name', () => {
    const csv = writeData('customers.csv',
      'id,name,email\nc1,Tanaka Hiroshi,tanaka@example.jp\nc2,Suzuki Ai,ai@example.jp\n');
    assert.equal(ingestFile('shop', csv).ok, true);
    const { data } = buildProjection('shop');
    const samples = JSON.stringify(data.types.find((t) => t.name === 'Customer').samples);
    assert.ok(!samples.includes('Tanaka'), 'raw person names must not reach the model');
    assert.ok(!samples.includes('tanaka@example.jp'));
    assert.ok(hasPiiTokens(samples), 'identity survives as opaque tokens');
  });
});
