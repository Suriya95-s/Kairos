// tests/ontology-engine.test.js
// The ontology engine: store invariants, deterministic induction, ingest
// orchestration. All hermetic — KAIROS_HOME points at a temp dir per test.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  registerSnapshot, appendDocument, loadProjection, setPublicationState,
  listDomains, assertDomain,
} from '../src/ontology/store.js';
import {
  typeNameFromFile, propName, inferType, parseCsv, induceCsv, induceJson,
  induceJsonl, induceMarkdown, induceFromFile, discoverLinks,
} from '../src/ontology/induce.js';
import {
  ingestFile, scanDropFolder, domainForDroppedFile, isIngestible, dropDir,
  archiveDroppedFile,
} from '../src/ontology/engine.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-onto-'));
  process.env.KAIROS_HOME = tmpHome;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* Windows locks */ }
});

// ── Store ────────────────────────────────────────────────────────────────────

describe('ontology store', () => {
  test('snapshots are content-addressed and idempotent', () => {
    const a = registerSnapshot('sales', { sourceName: 'x.csv', content: 'a,b\n1,2\n' });
    const b = registerSnapshot('sales', { sourceName: 'x.csv', content: 'a,b\n1,2\n' });
    assert.equal(a.id, b.id, 'same bytes → same identity');
    assert.equal(a.existed, false);
    assert.equal(b.existed, true, 'the second registration is a replay, not a duplicate');
    assert.match(a.id, /^snapshot:[0-9a-f]{24}$/);
  });

  test('a tampered snapshot file is refused, not papered over', () => {
    const snap = registerSnapshot('sales', { sourceName: 'x.csv', content: 'original' });
    fs.writeFileSync(snap.contentPath, 'tampered bytes');
    assert.throws(
      () => registerSnapshot('sales', { sourceName: 'x.csv', content: 'original' }),
      /different bytes/,
      'content-addressed IDs must never change meaning',
    );
  });

  test('documents are append-only with deep-equal idempotence', () => {
    const p = { name: 'Customer', state: 'candidate', proposedBy: 'kairos-induction', evidence: [{ snapshot: 's', locator: 'l' }] };
    const v1 = appendDocument('sales', { kind: 'object_type', id: 'type:Customer', payload: p });
    const again = appendDocument('sales', { kind: 'object_type', id: 'type:Customer', payload: { ...p } });
    const v2 = appendDocument('sales', { kind: 'object_type', id: 'type:Customer', payload: { ...p, name: 'Client' } });
    assert.equal(v1.version, 1);
    assert.equal(again.appended, false, 'identical payload appends nothing');
    assert.equal(v2.version, 2, 'a changed payload appends a new version');
    const proj = loadProjection('sales');
    assert.equal(proj.object_type.get('type:Customer').name, 'Client', 'projection folds to the latest version');
  });

  test('publish boundary: no evidence → no approval, regardless of who asks', () => {
    appendDocument('sales', {
      kind: 'instance', id: 'inst:Customer:1',
      payload: { type: 'Customer', key: '1', state: 'candidate', proposedBy: 'kairos-induction', evidence: [] },
    });
    assert.throws(
      () => setPublicationState('sales', 'instance', 'inst:Customer:1', 'approved', 'the-owner'),
      /without evidence cannot be approved/,
    );
  });

  test('publish boundary: separation of duties is enforced in the store', () => {
    appendDocument('sales', {
      kind: 'instance', id: 'inst:Customer:2',
      payload: { type: 'Customer', key: '2', state: 'candidate', proposedBy: 'kairos-induction', evidence: [{ snapshot: 's', locator: 'row:2' }] },
    });
    assert.throws(
      () => setPublicationState('sales', 'instance', 'inst:Customer:2', 'approved', 'kairos-induction'),
      /separation of duties/,
      'the proposer must not approve its own proposal',
    );
    const ok = setPublicationState('sales', 'instance', 'inst:Customer:2', 'approved', 'the-owner');
    assert.equal(ok.payload.state, 'approved');
    assert.equal(ok.payload.approvedBy, 'the-owner');
  });

  test('retirement is terminal — the missing edge is policy', () => {
    appendDocument('sales', {
      kind: 'instance', id: 'inst:Customer:3',
      payload: { type: 'Customer', key: '3', state: 'candidate', proposedBy: 'kairos-induction', evidence: [{ snapshot: 's', locator: 'row:3' }] },
    });
    setPublicationState('sales', 'instance', 'inst:Customer:3', 'retired', 'the-owner');
    assert.throws(
      () => setPublicationState('sales', 'instance', 'inst:Customer:3', 'approved', 'the-owner'),
      /retirement is terminal/,
    );
  });

  test('domain names are validated; traversal cannot escape the store', () => {
    assert.throws(() => assertDomain('../escape'), /invalid ontology domain/);
    assert.throws(() => assertDomain('UPPER'), /invalid ontology domain/);
    assert.equal(assertDomain('my-domain-2'), 'my-domain-2');
  });

  test('listDomains reflects what exists', () => {
    registerSnapshot('alpha', { sourceName: 'a.csv', content: 'x\n1\n' });
    registerSnapshot('beta', { sourceName: 'b.csv', content: 'y\n2\n' });
    assert.deepEqual(listDomains(), ['alpha', 'beta']);
  });
});

// ── Induction ────────────────────────────────────────────────────────────────

describe('deterministic induction', () => {
  test('type and property naming', () => {
    assert.equal(typeNameFromFile('customers.csv'), 'Customer');
    assert.equal(typeNameFromFile('order_items.json'), 'OrderItem');
    assert.equal(typeNameFromFile('companies.csv'), 'Company');
    // The strip rules must be exclusive alternatives — chained replaces once
    // compounded this into 'Warehou' (live drop, 2026-08-14).
    assert.equal(typeNameFromFile('warehouses.json'), 'Warehouse');
    assert.equal(typeNameFromFile('boxes.csv'), 'Box');
    assert.equal(typeNameFromFile('classes.csv'), 'Class');
    assert.equal(propName('Order ID'), 'orderId');
    assert.equal(propName('created_at'), 'createdAt');
  });

  test('value typing: number, boolean, date, enum, nullable', () => {
    assert.equal(inferType(['1', '2', '3.5']).type, 'number');
    assert.equal(inferType(['true', 'false', 'true']).type, 'boolean');
    assert.equal(inferType(['2026-01-01', '2026-02-03 10:00']).type, 'date');
    const status = inferType(['open', 'closed', 'open', 'closed', 'open', 'closed', 'open', 'closed']);
    assert.equal(status.type, 'string');
    assert.deepEqual(status.enum, ['closed', 'open'], 'low-cardinality strings are enums');
    assert.equal(inferType(['a', '', 'b']).nullable, true);
  });

  test('CSV parser handles quoted fields with commas and escaped quotes', () => {
    const rows = parseCsv('name,note\n"Doe, J","said ""hi"""\n');
    assert.deepEqual(rows, [['name', 'note'], ['Doe, J', 'said "hi"']]);
  });

  test('CSV induction: key column, instances, evidence locators', () => {
    const csv = 'id,name,city\nC1,Ada,Osaka\nC2,Lin,Kobe\n';
    const out = induceCsv(csv, { filename: 'customers.csv', snapshotId: 'snapshot:abc' });
    const t = out.objectTypes[0].payload;
    assert.equal(t.name, 'Customer');
    assert.equal(t.keyProperty, 'id');
    assert.equal(t.state, 'candidate');
    assert.equal(out.instances.length, 2);
    assert.equal(out.instances[0].id, 'inst:Customer:C1');
    assert.deepEqual(out.instances[0].payload.evidence, [{ snapshot: 'snapshot:abc', locator: 'row:2' }],
      'every instance is pinned to the exact row that evidences it');
  });

  test('JSON array induction flattens nested objects', () => {
    const json = JSON.stringify([{ id: 1, who: { name: 'Ada' } }, { id: 2, who: { name: 'Lin' } }]);
    const out = induceJson(json, { filename: 'people.json', snapshotId: 'snapshot:x' });
    const props = out.objectTypes[0].payload.properties.map((p) => p.name);
    assert.ok(props.includes('whoName'), `nested keys flatten then camelCase (who.name → whoName), got ${props}`);
    assert.equal(out.instances[0].payload.evidence[0].locator, 'item:0');
  });

  test('JSONL induction skips torn lines and keeps the rest', () => {
    const out = induceJsonl('{"id":1}\nnot json\n{"id":2}\n', { filename: 'events.jsonl', snapshotId: 's' });
    assert.equal(out.instances.length, 2);
  });

  test('markdown induction: topics with heading evidence + mention edges', () => {
    const md = '# Ontology\nSee Knowledge Graph for the view.\n\n# Knowledge Graph\nDrawn from data.\n';
    const out = induceMarkdown(md, { filename: 'notes.md', snapshotId: 's' });
    assert.equal(out.instances.length, 2);
    assert.equal(out.instances[0].payload.evidence[0].locator, 'line:1');
    assert.equal(out.relationships.length, 1, 'the first topic mentions the second');
    assert.equal(out.relationships[0].payload.name, 'mentions');
  });

  test('unsupported extensions are reported, not thrown', () => {
    const out = induceFromFile({ filename: 'photo.png', content: '...', snapshotId: 's' });
    assert.equal(out.unsupported, '.png');
  });

  test('cross-file linking: a foreign key is discovered from value overlap', () => {
    appendDocument('shop', { kind: 'object_type', id: 'type:Customer', payload: { name: 'Customer', keyProperty: 'id', properties: [{ name: 'id', type: 'string' }], state: 'candidate', proposedBy: 'kairos-induction', evidence: [{ snapshot: 's', locator: 'header' }] } });
    appendDocument('shop', { kind: 'object_type', id: 'type:Order', payload: { name: 'Order', keyProperty: 'id', properties: [{ name: 'id', type: 'string' }, { name: 'customerId', type: 'string' }], state: 'candidate', proposedBy: 'kairos-induction', evidence: [{ snapshot: 's', locator: 'header' }] } });
    for (const key of ['C1', 'C2']) {
      appendDocument('shop', { kind: 'instance', id: `inst:Customer:${key}`, payload: { type: 'Customer', key, properties: { id: key }, state: 'candidate', proposedBy: 'kairos-induction', evidence: [{ snapshot: 's', locator: 'row' }] } });
    }
    for (const [key, cust] of [['O1', 'C1'], ['O2', 'C2'], ['O3', 'C1']]) {
      appendDocument('shop', { kind: 'instance', id: `inst:Order:${key}`, payload: { type: 'Order', key, properties: { id: key, customerId: cust }, state: 'candidate', proposedBy: 'kairos-induction', evidence: [{ snapshot: 's', locator: 'row' }] } });
    }
    const links = discoverLinks(loadProjection('shop'));
    const typeLevel = links.find((l) => l.payload.kind === 'reference');
    assert.ok(typeLevel, 'a type-level reference edge is proposed');
    assert.equal(typeLevel.payload.fromType, 'Order');
    assert.equal(typeLevel.payload.toType, 'Customer');
    assert.equal(typeLevel.payload.viaProperty, 'customerId');
    const instLevel = links.filter((l) => l.payload.kind === 'reference_instance');
    assert.equal(instLevel.length, 3, 'every matching row gets its instance edge');
  });

  test('NEGATIVE CONTROL: weak overlap does not fabricate a foreign key', () => {
    appendDocument('weak', { kind: 'object_type', id: 'type:A', payload: { name: 'A', keyProperty: 'id', properties: [{ name: 'id' }, { name: 'note' }], state: 'candidate', proposedBy: 'kairos-induction', evidence: [{ snapshot: 's', locator: 'h' }] } });
    appendDocument('weak', { kind: 'object_type', id: 'type:B', payload: { name: 'B', keyProperty: 'id', properties: [{ name: 'id' }], state: 'candidate', proposedBy: 'kairos-induction', evidence: [{ snapshot: 's', locator: 'h' }] } });
    for (const key of ['B1', 'B2']) appendDocument('weak', { kind: 'instance', id: `inst:B:${key}`, payload: { type: 'B', key, properties: { id: key }, state: 'candidate', proposedBy: 'kairos-induction', evidence: [{ snapshot: 's', locator: 'r' }] } });
    // Only 1 of 4 note values matches a B key — 25% coverage is coincidence, not structure.
    for (const [key, note] of [['A1', 'B1'], ['A2', 'x'], ['A3', 'y'], ['A4', 'z']]) {
      appendDocument('weak', { kind: 'instance', id: `inst:A:${key}`, payload: { type: 'A', key, properties: { id: key, note }, state: 'candidate', proposedBy: 'kairos-induction', evidence: [{ snapshot: 's', locator: 'r' }] } });
    }
    assert.equal(discoverLinks(loadProjection('weak')).length, 0);
  });
});

// ── Engine orchestration ─────────────────────────────────────────────────────

describe('ingest orchestration', () => {
  test('a dropped CSV becomes an evidence-backed candidate ontology', () => {
    const f = path.join(tmpHome, 'customers.csv');
    fs.writeFileSync(f, 'id,name,city\nC1,Ada,Osaka\nC2,Lin,Kobe\n');
    const res = ingestFile('sales', f);
    assert.equal(res.ok, true);
    assert.equal(res.counts.object_type, 1);
    assert.equal(res.counts.instance, 2);
    assert.equal(res.counts.ingest, 1);
    const proj = loadProjection('sales');
    for (const inst of proj.instance.values()) {
      assert.equal(inst.state, 'candidate', 'induction NEVER publishes — everything is born a candidate');
      assert.ok(inst.evidence?.length > 0, 'no instance without evidence');
    }
  });

  test('re-dropping the same file appends nothing (watcher double-fire safety)', () => {
    const f = path.join(tmpHome, 'customers.csv');
    fs.writeFileSync(f, 'id,name\nC1,Ada\n');
    const first = ingestFile('sales', f);
    const second = ingestFile('sales', f);
    assert.equal(first.appended > 0, true);
    assert.equal(second.appended, 0, 'identical bytes must append zero documents');
    assert.equal(second.snapshotExisted, true);
  });

  test('two related files dropped separately still get linked', () => {
    const c = path.join(tmpHome, 'customers.csv');
    const o = path.join(tmpHome, 'orders.csv');
    fs.writeFileSync(c, 'id,name\nC1,Ada\nC2,Lin\n');
    fs.writeFileSync(o, 'id,customer_id,total\nO1,C1,90\nO2,C2,50\nO3,C1,10\n');
    ingestFile('shop2', c);
    const res = ingestFile('shop2', o);
    assert.equal(res.ok, true);
    const proj = loadProjection('shop2');
    const refs = [...proj.relationship.values()].filter((r) => r.kind === 'reference');
    assert.equal(refs.length, 1, 'the cross-file foreign key is discovered at ingest time');
    assert.equal(refs[0].viaProperty, 'customerId');
  });

  test('unsupported, empty, and unreadable drops are reported, never thrown', () => {
    const bad = path.join(tmpHome, 'photo.png');
    fs.writeFileSync(bad, 'not really a png');
    assert.equal(ingestFile('sales', bad).ok, false);
    const empty = path.join(tmpHome, 'empty.csv');
    fs.writeFileSync(empty, '');
    assert.equal(ingestFile('sales', empty).ok, false);
    assert.equal(ingestFile('sales', path.join(tmpHome, 'missing.csv')).ok, false);
  });

  test('drop-folder scan: subfolder names the domain, root is default', () => {
    const root = dropDir();
    fs.mkdirSync(path.join(root, 'sales'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sales', 'items.csv'), 'id,label\nI1,Widget\n');
    fs.writeFileSync(path.join(root, 'loose.csv'), 'id\nX1\n');
    const scan = scanDropFolder();
    const domains = scan.results.filter((r) => r.ok).map((r) => r.domain).sort();
    assert.deepEqual(domains, ['default', 'sales']);
    assert.equal(domainForDroppedFile(path.join(root, 'sales', 'items.csv')), 'sales');
    assert.equal(domainForDroppedFile(path.join(root, 'loose.csv')), 'default');
  });

  test('ignore patterns: temp/partial files never ingest', () => {
    assert.equal(isIngestible('~$report.csv'), false);
    assert.equal(isIngestible('data.csv.crdownload'), false);
    assert.equal(isIngestible('.hidden.csv'), false);
    assert.equal(isIngestible('report.csv'), true);
  });

  test('an Explorer folder name becomes a legal domain: spaces, case, length', () => {
    const root = dropDir();
    const messy = path.join(root, 'BTO Shop Test!', 'a.csv');
    assert.equal(domainForDroppedFile(messy), 'bto-shop-test');
    const long = path.join(root, 'x'.repeat(80), 'a.csv');
    assert.ok(domainForDroppedFile(long).length <= 41);
  });
});

describe('intake archiving — the inbox stays an inbox', () => {
  test('an ingested drop moves into the domain intake folder; its empty folder is pruned; failures stay visible', () => {
    const root = dropDir();
    const sub = path.join(root, 'shop');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'items.csv'), 'id,label\nI1,Widget\n');
    fs.writeFileSync(path.join(sub, 'photo.png'), 'not-ingestible');
    const scan = scanDropFolder();
    const ok = scan.results.find((r) => r.ok);
    assert.ok(ok.archivedTo, 'the summary says where the file went');
    assert.ok(fs.existsSync(ok.archivedTo));
    assert.ok(ok.archivedTo.includes(path.join('ontology', 'shop', 'intake')));
    assert.ok(!fs.existsSync(path.join(sub, 'items.csv')), 'the inbox copy is gone');
    assert.ok(fs.existsSync(path.join(sub, 'photo.png')), 'a skipped file stays visible in the inbox');
    assert.ok(fs.existsSync(root), 'the inbox root itself is never pruned');
  });

  test('a fully ingested folder disappears from the inbox', () => {
    const sub = path.join(dropDir(), 'clean');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'only.csv'), 'id\nA\n');
    scanDropFolder();
    assert.ok(!fs.existsSync(sub), 'the emptied domain folder is pruned');
  });

  test('re-dropping identical bytes dedups; different bytes get a numbered name', () => {
    const sub = path.join(dropDir(), 'dup');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'd.csv'), 'id\nA\n');
    scanDropFolder();
    // Same name, same bytes → the duplicate is simply consumed.
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'd.csv'), 'id\nA\n');
    scanDropFolder();
    const intake = path.join(tmpHome, 'ontology', 'dup', 'intake');
    assert.deepEqual(fs.readdirSync(intake), ['d.csv']);
    // Same name, NEW bytes → both survive, the newcomer numbered.
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'd.csv'), 'id\nA\nB\n');
    scanDropFolder();
    assert.deepEqual(fs.readdirSync(intake).sort(), ['d-2.csv', 'd.csv']);
  });

  test('archiveDroppedFile refuses to move anything outside the inbox', () => {
    const outside = path.join(tmpHome, 'precious.csv');
    fs.writeFileSync(outside, 'id\nA\n');
    assert.equal(archiveDroppedFile('shop', outside), null);
    assert.ok(fs.existsSync(outside), 'a CLI-ingested user file is never relocated');
  });
});
