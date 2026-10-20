// tests/conductor-manifest.test.js — Wave D-2: durable conductor manifest.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWorkspace } from '../src/state.js';
import { initManifest, writeManifest, readManifest, clearManifest } from '../src/agents/manifest.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-manifest-'));
  setWorkspace(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ASSIGN = [
  { role: 'scout', task: 'map' },
  { role: 'planner', task: 'plan', dependsOn: ['scout'] },
  { role: 'coder', task: 'build', dependsOn: ['planner'] },
];

describe('initManifest', () => {
  test('marks every role pending', () => {
    const m = initManifest('ep-1', 'do the thing', ASSIGN);
    assert.equal(m.sessionId, 'ep-1');
    assert.deepEqual(m.status, { scout: 'pending', planner: 'pending', coder: 'pending' });
    assert.deepEqual(m.results, []);
  });
});

describe('write/read round-trip', () => {
  test('writeManifest then readManifest returns the same shape + an updatedAt stamp', () => {
    const m = initManifest('ep-2', 'task', ASSIGN);
    writeManifest(dir, m);
    const got = readManifest(dir, 'ep-2');
    assert.equal(got.sessionId, 'ep-2');
    assert.deepEqual(got.status, m.status);
    assert.ok(got.updatedAt, 'updatedAt stamp present');
    assert.ok(fs.existsSync(path.join(dir, '.agent/conductor-state.json')));
  });

  test('readManifest returns null for a different sessionId (stale guard)', () => {
    writeManifest(dir, initManifest('ep-3', 't', ASSIGN));
    assert.equal(readManifest(dir, 'ep-OTHER'), null);
  });

  test('readManifest returns null when no manifest exists', () => {
    assert.equal(readManifest(dir, 'ep-none'), null);
  });

  test('atomic write leaves no .tmp file behind', () => {
    writeManifest(dir, initManifest('ep-4', 't', ASSIGN));
    assert.equal(fs.existsSync(path.join(dir, '.agent/conductor-state.json.tmp')), false);
  });
});

describe('resume semantics', () => {
  test('completed-role set is recoverable from a persisted manifest', () => {
    const m = initManifest('ep-5', 't', ASSIGN);
    m.status.scout = 'completed';
    m.status.planner = 'completed';
    m.results = [
      { role: 'scout', exitReason: 'completed', summary: 'mapped', steps: 4 },
      { role: 'planner', exitReason: 'completed', summary: 'planned', steps: 6 },
    ];
    writeManifest(dir, m);

    const resumed = readManifest(dir, 'ep-5');
    const completed = Object.entries(resumed.status)
      .filter(([, s]) => s === 'completed').map(([r]) => r);
    assert.deepEqual(completed.sort(), ['planner', 'scout']);
    // coder is the only role left to run.
    const pending = Object.entries(resumed.status)
      .filter(([, s]) => s === 'pending').map(([r]) => r);
    assert.deepEqual(pending, ['coder']);
    assert.equal(resumed.results.length, 2);
  });

  test('clearManifest removes the file (fresh start)', () => {
    writeManifest(dir, initManifest('ep-6', 't', ASSIGN));
    clearManifest(dir);
    assert.equal(fs.existsSync(path.join(dir, '.agent/conductor-state.json')), false);
    assert.equal(readManifest(dir, 'ep-6'), null);
  });
});
