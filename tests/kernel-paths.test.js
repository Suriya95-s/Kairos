// tests/kernel-paths.test.js
// Phase 3 (presence kernel) — the daemon's home on disk.
//
// paths.js is load-bearing for every other kernel module, and its two failure
// modes are both silent: a cached home means tests share state with the real
// ~/.kairos, and a non-atomic registry write means a daemon killed mid-write
// bricks its own next boot. Both are tested here rather than assumed.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BRAND,
  SCHEMA_VERSION,
  home,
  dir,
  file,
  ensureHome,
  readRegistry,
  writeRegistry,
  migrateRegistry,
  snapshotRegistry,
  restoreSnapshot,
  SUBDIRS,
} from '../src/kernel/paths.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-home-'));
  process.env.KAIROS_HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* windows lock */ }
});

describe('kernel paths — home resolution', () => {
  test('KAIROS_HOME overrides the default home', () => {
    assert.equal(home(), path.resolve(tmpHome));
  });

  test('home() is re-resolved on every call, never cached at import', () => {
    // The whole point: a module-level `const HOME = ...` would make every test
    // in this suite (and every concurrent daemon) share one directory.
    const first = home();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-home2-'));
    process.env.KAIROS_HOME = other;
    assert.equal(home(), path.resolve(other));
    assert.notEqual(home(), first);
    fs.rmSync(other, { recursive: true, force: true });
  });

  test('without an override, home is ~/.<brand>', () => {
    delete process.env.KAIROS_HOME;
    assert.equal(home(), path.join(os.homedir(), `.${BRAND}`));
  });

  test('the brand name is a single knob, and everything user-facing derives from it', () => {
    // Renaming the system must not be a codebase sweep. If this ever fails,
    // some path has hardcoded "kairos" instead of asking paths.js.
    delete process.env.KAIROS_HOME;
    assert.ok(home().endsWith(`.${BRAND}`), `home ${home()} should end with .${BRAND}`);
  });

  test('dir() rejects unknown keys instead of inventing a path', () => {
    assert.throws(() => dir('nope'), /unknown kernel dir/);
  });

  test('ensureHome creates the full subdirectory tree, idempotently', () => {
    ensureHome();
    for (const sub of Object.values(SUBDIRS)) {
      assert.ok(fs.existsSync(path.join(tmpHome, sub)), `${sub}/ should exist`);
    }
    assert.doesNotThrow(() => ensureHome());
  });
});

describe('kernel paths — registry I/O', () => {
  test('write then read round-trips', () => {
    const p = file('daemon.json');
    writeRegistry(p, { schemaVersion: 1, pid: 42 });
    assert.deepEqual(readRegistry(p), { schemaVersion: 1, pid: 42 });
  });

  test('reading an absent registry returns the fallback, not a throw', () => {
    assert.equal(readRegistry(file('missing.json'), null), null);
    assert.deepEqual(readRegistry(file('missing.json'), { a: 1 }), { a: 1 });
  });

  test('a corrupt registry falls back AND is preserved for inspection', () => {
    // A daemon that refuses to boot because one JSON file is truncated is a
    // worse outcome than booting fresh — but silently deleting the evidence
    // is worse still.
    const p = file('sessions.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{"half":');
    assert.deepEqual(readRegistry(p, { sessions: {} }), { sessions: {} });
    assert.ok(fs.existsSync(`${p}.corrupt-1`), 'corrupt file should be quarantined');
    assert.equal(fs.readFileSync(`${p}.corrupt-1`, 'utf-8'), '{"half":');
  });

  test('writeRegistry leaves no temp file behind', () => {
    const p = file('daemon.json');
    writeRegistry(p, { a: 1 });
    const leftovers = fs.readdirSync(path.dirname(p)).filter(f => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  });

  test('the temp file is created in the target directory, not os.tmpdir', () => {
    // Cross-device rename is not atomic on POSIX and outright fails on Windows.
    // Assert on the source rather than trusting the comment.
    const src = fs.readFileSync(new URL('../src/kernel/paths.js', import.meta.url), 'utf-8');
    // Strip comments before asserting on source. A prose mention of os.tmpdir()
    // in the rationale comment would otherwise fail (or pass) this check on
    // text that never executes.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const body = code.slice(code.indexOf('export function writeRegistry'));
    assert.ok(/const tmp = `\$\{absPath\}\.tmp-/.test(body),
      'temp path must be derived from absPath so rename stays intra-directory');
    assert.ok(!/tmpdir\(\)/.test(body.slice(0, body.indexOf('renameSync'))),
      'writeRegistry must not stage through os.tmpdir()');
  });

  test('an overwrite is never observed as a partial file', () => {
    const p = file('daemon.json');
    writeRegistry(p, { generation: 1, blob: 'x'.repeat(200_000) });
    writeRegistry(p, { generation: 2, blob: 'y'.repeat(200_000) });
    const got = readRegistry(p);
    assert.equal(got.generation, 2);
    assert.equal(got.blob.length, 200_000);
    assert.ok(/^y+$/.test(got.blob), 'content must be wholly from one generation');
  });
});

describe('kernel paths — schema migration (S4)', () => {
  test('an unversioned record is treated as v0 and migrated forward', () => {
    // Pre-versioning files exist in the wild the moment anyone runs a dev
    // build. Rejecting them would mean "delete your state to upgrade".
    const { data, migrated, from, to } = migrateRegistry(
      { sessions: {} },
      { 1: d => ({ ...d, missions: {} }) },
      1,
    );
    assert.equal(migrated, true);
    assert.equal(from, 0);
    assert.equal(to, 1);
    assert.deepEqual(data, { sessions: {}, missions: {}, schemaVersion: 1 });
  });

  test('migration steps run in order, and each is applied exactly once', () => {
    const order = [];
    const { data } = migrateRegistry(
      { schemaVersion: 1, n: 0 },
      {
        2: d => { order.push(2); return { ...d, n: d.n + 1 }; },
        3: d => { order.push(3); return { ...d, n: d.n * 10 }; },
      },
      3,
    );
    assert.deepEqual(order, [2, 3]);
    assert.equal(data.n, 10, 'step 2 then step 3 → (0+1)*10');
    assert.equal(data.schemaVersion, 3);
  });

  test('migrating an already-current record is a no-op', () => {
    const input = { schemaVersion: SCHEMA_VERSION, a: 1 };
    const { data, migrated } = migrateRegistry(input, { [SCHEMA_VERSION]: () => ({ a: 999 }) });
    assert.equal(migrated, false);
    assert.equal(data, input, 'should return the same object, unmodified');
  });

  test('a record from a NEWER build is refused, not silently downgraded', () => {
    // Dropping fields this build does not understand is unrecoverable data
    // loss. Refusing is the only safe answer.
    assert.throws(
      () => migrateRegistry({ schemaVersion: SCHEMA_VERSION + 5 }, {}, SCHEMA_VERSION),
      /newer than this build understands/,
    );
  });

  test('a missing migration step is skipped rather than throwing', () => {
    // Version bumps that need no data change are normal.
    const { data, migrated } = migrateRegistry({ schemaVersion: 1, a: 1 }, {}, 3);
    assert.equal(migrated, true);
    assert.equal(data.schemaVersion, 3);
    assert.equal(data.a, 1);
  });

  test('snapshot + restore round-trips one version back (S4 rollback)', () => {
    const p = file('daemon.json');
    writeRegistry(p, { schemaVersion: 1, keep: 'me' });
    const snap = snapshotRegistry(p);
    assert.ok(snap && fs.existsSync(snap));

    writeRegistry(p, { schemaVersion: 2, keep: 'clobbered' });
    assert.equal(readRegistry(p).keep, 'clobbered');

    assert.equal(restoreSnapshot(p), true);
    assert.deepEqual(readRegistry(p), { schemaVersion: 1, keep: 'me' });
  });

  test('snapshotting an absent file is a no-op, and restore reports failure', () => {
    assert.equal(snapshotRegistry(file('nothing.json')), null);
    assert.equal(restoreSnapshot(file('nothing.json')), false);
  });
});
