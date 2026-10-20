// tests/ontology-history-remove.test.js
// domainHistory (what was built, when, by whom) and removeDomain (permanent,
// cache-safe deletion). The owner's ask: "see the earlier built ones, and
// delete and add functionalities" — add already exists (ingest/drop); these
// two close the loop.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendDocument, evidenceRef, listDomains, loadProjection,
  domainHistory, removeDomain, domainDir,
} from '../src/ontology/store.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-histrm-'));
  process.env.KAIROS_HOME = tmpHome;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* Windows locks */ }
});

const EV = [evidenceRef('snapshot:aaa', 'header')];

function seed(domain) {
  appendDocument(domain, {
    kind: 'object_type', id: 'type:Thing',
    payload: { name: 'Thing', properties: [], keyProperty: null, state: 'candidate', proposedBy: 'kairos-induction', evidence: EV },
  });
  appendDocument(domain, {
    kind: 'instance', id: 'inst:Thing:1',
    payload: { type: 'Thing', key: 'one', properties: {}, state: 'candidate', proposedBy: 'kairos-induction', evidence: EV },
  });
}

describe('domainHistory', () => {
  test('summarizes birth, latest change, and per-kind counts from the journal', () => {
    seed('h1');
    const h = domainHistory('h1');
    assert.equal(h.docs, 2);
    assert.equal(h.byKind.object_type, 1);
    assert.equal(h.byKind.instance, 1);
    assert.ok(h.createdAt > 0 && h.lastAt >= h.createdAt);
  });

  test('entries come newest-first, carry attribution, and honor the limit', () => {
    seed('h2');
    const h = domainHistory('h2', { limit: 1 });
    assert.equal(h.entries.length, 1);
    assert.equal(h.entries[0].kind, 'instance'); // the LAST write, not the first
    assert.equal(h.entries[0].by, 'kairos-induction');
    assert.equal(h.docs, 2); // the summary still counts everything
  });

  test('limit 0 means summary only — slice(-0) must not leak the whole journal', () => {
    seed('h3');
    const h = domainHistory('h3', { limit: 0 });
    assert.equal(h.entries.length, 0);
    assert.equal(h.docs, 2);
  });
});

describe('removeDomain', () => {
  test('deletes the domain directory and it vanishes from listDomains', () => {
    seed('rm1');
    assert.ok(listDomains().includes('rm1'));
    assert.equal(removeDomain('rm1'), true);
    assert.equal(listDomains().includes('rm1'), false);
    assert.equal(fs.existsSync(domainDir('rm1')), false);
  });

  test('a missing domain returns false, never throws', () => {
    assert.equal(removeDomain('never-existed'), false);
  });

  test('a re-created domain starts EMPTY — the fold cache must not resurrect ghosts', () => {
    // The fold cache stamps journals mtimeMs:size. This test forces the
    // collision the stamp cannot see: the re-created journal has the SAME
    // byte length and the SAME mtime as the dead one, differing only in the
    // type id. Without eviction at removal, loadProjection serves the ghost.
    const journal = path.join(domainDir('rm2'), 'documents.jsonl');
    const doc = (id) => JSON.stringify({
      kind: 'object_type', id, version: 1, at: 1700000000000,
      payload: { name: 'X', properties: [], keyProperty: null, state: 'candidate', proposedBy: 'kairos-induction', evidence: EV },
    }) + '\n';
    const T = new Date('2026-01-01T00:00:00Z');

    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, doc('type:AAAA'));
    fs.utimesSync(journal, T, T);
    assert.ok(loadProjection('rm2').object_type.has('type:AAAA'), 'cache warmed with the old domain');

    removeDomain('rm2');

    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, doc('type:BBBB')); // same length as AAAA on purpose
    fs.utimesSync(journal, T, T);                // same mtime — the stamp collides

    const proj = loadProjection('rm2');
    assert.ok(proj.object_type.has('type:BBBB'), 'the new domain\'s type must be visible');
    assert.equal(proj.object_type.has('type:AAAA'), false, 'the deleted domain\'s types must not reappear');
  });
});
