// tests/palace-writers.test.js — Wave C-1: semantic + procedural writers, importance deleted.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWorkspace } from '../src/state.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palace-writers-'));
  setWorkspace(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── semanticGraph ─────────────────────────────────────────────────────────────

describe('semanticGraph.assert idempotency', () => {
  test('first assert writes a triple', async () => {
    const { assert: assertTriple, flush } = await import('../src/palace/semanticGraph.js');
    flush();
    assertTriple('src/foo.js', 'modified_by', 'write_file', 1.0);
    const jsonlPath = path.join(dir, '.agent/palace/semantic.jsonl');
    assert.ok(fs.existsSync(jsonlPath), 'semantic.jsonl should be created');
    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'exactly one line written');
    const triple = JSON.parse(lines[0]);
    assert.equal(triple.subject, 'src/foo.js');
    assert.equal(triple.predicate, 'modified_by');
    assert.equal(triple.object, 'write_file');
  });

  test('repeating the same assert does not add a duplicate line', async () => {
    const { assert: assertTriple, flush } = await import('../src/palace/semanticGraph.js');
    flush();
    assertTriple('src/bar.js', 'modified_by', 'edit_file', 1.0);
    assertTriple('src/bar.js', 'modified_by', 'edit_file', 1.0); // same triple
    const jsonlPath = path.join(dir, '.agent/palace/semantic.jsonl');
    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'idempotent — only one line despite two calls');
  });

  test('different triples for same subject all get written', async () => {
    const { assert: assertTriple, flush } = await import('../src/palace/semanticGraph.js');
    flush();
    assertTriple('src/baz.js', 'modified_by', 'write_file', 1.0);
    assertTriple('src/baz.js', 'modified_by', 'edit_file', 1.0);
    const jsonlPath = path.join(dir, '.agent/palace/semantic.jsonl');
    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
  });

  test('queryBySubject surfaces the asserted triple', async () => {
    const { assert: assertTriple, queryBySubject, flush } = await import('../src/palace/semanticGraph.js');
    flush();
    assertTriple('src/q.js', 'modified_by', 'copy_path', 0.9);
    const hits = queryBySubject('src/q.js');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].object, 'copy_path');
  });
});

// ── proceduralIndex ───────────────────────────────────────────────────────────

describe('proceduralIndex.recordSuccess', () => {
  test('no-op for tools without a normalised trigger', async () => {
    const { recordSuccess, getAllRecipes, flush } = await import('../src/palace/proceduralIndex.js');
    flush();
    recordSuccess({ tool: 'think', args: {}, result: 'ok', domain: '' });
    assert.equal(getAllRecipes().length, 0, 'think has no trigger — no recipe yet');
  });

  test('recipe auto-created after 3 successes of write_file', async () => {
    const { recordSuccess, getAllRecipes, flush } = await import('../src/palace/proceduralIndex.js');
    flush();
    for (let i = 0; i < 3; i++) {
      recordSuccess({ tool: 'write_file', args: { path: `f${i}.js` }, result: 'ok', domain: '' });
    }
    const recipes = getAllRecipes();
    assert.ok(recipes.length >= 1, 'recipe should exist after 3 successes');
    assert.ok(recipes[0].trigger.startsWith('write:'), `trigger should start with "write:", got ${recipes[0].trigger}`);
  });

  test('recipe persisted to procedures.jsonl after threshold', async () => {
    const { recordSuccess, flush } = await import('../src/palace/proceduralIndex.js');
    flush();
    for (let i = 0; i < 3; i++) {
      recordSuccess({ tool: 'edit_file', args: {}, result: 'ok', domain: '' });
    }
    const jsonlPath = path.join(dir, '.agent/palace/procedures.jsonl');
    assert.ok(fs.existsSync(jsonlPath), 'procedures.jsonl should be created');
    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1);
    const recipe = JSON.parse(lines[0]);
    assert.ok(recipe.trigger, 'recipe has trigger');
  });
});

// ── importance.js deleted ─────────────────────────────────────────────────────

describe('importance.js is deleted', () => {
  test('importing importance.js throws — the module no longer exists', async () => {
    await assert.rejects(
      () => import('../src/palace/importance.js'),
      /Cannot find module|ERR_MODULE_NOT_FOUND/i
    );
  });
});

// ── episodic-store.addLink removed ───────────────────────────────────────────

describe('episodic-store: insert and addLink both work (links table kept intact)', () => {
  test('episodic insert returns a numeric id', async () => {
    const { EpisodicStore } = await import('../src/palace/episodic-store.js');
    const store = new EpisodicStore(':memory:');
    const id = store.insert({ verbatim: 'test event', domain: 'test' });
    assert.ok(typeof id === 'number' && id >= 1);
    assert.equal(store.count(), 1);
  });

  test('addLink is present (needed for link-decay test infrastructure)', async () => {
    const { EpisodicStore } = await import('../src/palace/episodic-store.js');
    const store = new EpisodicStore(':memory:');
    const id1 = store.insert({ verbatim: 'a', domain: 'x' });
    const id2 = store.insert({ verbatim: 'b', domain: 'x' });
    assert.doesNotThrow(() => store.addLink(id1, id2, 1.0), 'addLink should not throw');
  });
});
