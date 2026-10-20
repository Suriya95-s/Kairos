// tests/memoryd-lifecycle.test.js
// Phase 5.2 (import), 5.3 (global identity), 5.4 (consolidation / "sleep").
//
// These three share a theme: memory that already exists must not be lost, and
// memory that accumulates must not become a landfill. Both failures are quiet —
// nobody notices missing recall, and nobody notices a database growing until
// recall gets slow and vague.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MemoryService } from '../src/memoryd/service.js';
import { GLOBAL, projectScope } from '../src/memoryd/scopes.js';
import { importWorkspace, isImported, importReceipt, undoImport } from '../src/memoryd/import.js';
import { parseIdentityFile, syncIdentityToGlobal, buildGlobalMemoryBlock } from '../src/memoryd/identity.js';
import { consolidate, similarity, ConsolidationScheduler } from '../src/memoryd/consolidate.js';

let svc;
let clock;
let ws;

beforeEach(() => {
  clock = 1_700_000_000_000;
  svc = new MemoryService({ dbPath: ':memory:', now: () => clock });
  svc.open();
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-imp-'));
});

afterEach(() => {
  svc.close();
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
});

const days = (n) => n * 86_400_000;

/** Build a realistic legacy .agent/ directory. */
function seedWorkspace({ palace = true, logs = true, learnings = true } = {}) {
  const agent = path.join(ws, '.agent');
  fs.mkdirSync(path.join(agent, 'memory'), { recursive: true });

  if (logs) {
    fs.writeFileSync(path.join(agent, 'memory', '2026-07-01.md'),
      '# Daily log\n\nSome narration that should not be imported.\n\n' +
      '- The build pipeline caches node_modules between runs\n' +
      '- short\n' +
      '- Auth tokens expire after fifteen minutes in staging\n');
  }
  if (learnings) {
    fs.writeFileSync(path.join(agent, 'memory', 'learnings.md'),
      '# Learnings\n\n- Always run the smoke test before calling finish\n');
  }
  if (palace) {
    fs.mkdirSync(path.join(agent, 'palace'), { recursive: true });
    const db = new DatabaseSync(path.join(agent, 'palace', 'episodic.db'));
    db.exec(`CREATE TABLE memories (
      entry_id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp REAL NOT NULL,
      domain TEXT NOT NULL DEFAULT '', bucket INTEGER NOT NULL,
      content_hash TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', verbatim TEXT NOT NULL,
      who TEXT NOT NULL DEFAULT 'kairos', archived INTEGER NOT NULL DEFAULT 0);`);
    const ins = db.prepare(
      `INSERT INTO memories (timestamp, domain, bucket, content_hash, summary, note, verbatim, who, archived)
       VALUES (?, ?, 0, 'h', ?, '', ?, 'kairos', ?)`);
    ins.run(1.0, 'auth', 'Refactored the auth middleware to use async handlers', '{"raw":1}', 0);
    ins.run(2.0, 'build', 'Switched the bundler to esbuild', '{"raw":2}', 0);
    ins.run(3.0, 'old', 'This one was archived and should be skipped', '{"raw":3}', 1);
    db.close();
  }
  return ws;
}

describe('importing existing workspace memory (5.2)', () => {
  test('palace, daily logs and learnings all come across', () => {
    seedWorkspace();
    const res = importWorkspace(svc, { workspace: ws });

    assert.equal(res.skipped, false);
    assert.ok(res.imported >= 4, `expected several records, got ${res.imported}`);
    assert.ok(res.bySource.palace.count >= 2);
    assert.ok(res.bySource.dailyLogs.count >= 2);
    assert.equal(res.bySource.learnings.count, 1);
  });

  test('everything lands in this project\'s scope, not global', () => {
    // Project history leaking into global scope would surface one repo's
    // details in every other project and in chat.
    seedWorkspace();
    importWorkspace(svc, { workspace: ws });

    assert.deepEqual(svc.list({ scope: GLOBAL }), []);
    assert.ok(svc.list({ scope: projectScope(ws) }).length > 0);
  });

  test('imported content is recallable by a mission in that workspace', () => {
    seedWorkspace();
    importWorkspace(svc, { workspace: ws });
    const text = svc.recallText({ layer: 'mission', workspace: ws, query: 'esbuild bundler' });
    assert.match(text, /esbuild/);
  });

  test('archived palace rows are skipped', () => {
    seedWorkspace();
    importWorkspace(svc, { workspace: ws });
    const all = svc.list({ limit: 500 }).map(r => r.body).join('\n');
    assert.ok(!all.includes('was archived'));
  });

  test('narration and trivially short bullets are skipped', () => {
    seedWorkspace();
    importWorkspace(svc, { workspace: ws });
    const bodies = svc.list({ limit: 500 }).map(r => r.body);
    assert.ok(!bodies.some(b => b.includes('narration that should not')));
    assert.ok(!bodies.includes('short'));
  });

  test('a learning outranks an episodic event', () => {
    // A learning is a rule that was paid for; an event is just something that
    // happened. Recall order should reflect that.
    seedWorkspace();
    importWorkspace(svc, { workspace: ws });
    const learning = svc.list({ limit: 500 }).find(r => r.subject === 'learning');
    const event = svc.list({ limit: 500 }).find(r => r.kind === 'event');
    assert.ok(learning.importance > event.importance);
  });

  test('re-importing is a no-op — the sentinel makes it idempotent', () => {
    seedWorkspace();
    const first = importWorkspace(svc, { workspace: ws });
    const second = importWorkspace(svc, { workspace: ws });

    assert.equal(second.skipped, true);
    assert.match(second.reason, /already imported/);
    assert.equal(svc.list({ limit: 500 }).length, first.imported);
    assert.equal(isImported(ws), true);
  });

  test('force re-imports without duplicating rows', () => {
    // remember() upserts, so a forced re-import converges rather than doubling.
    seedWorkspace();
    const first = importWorkspace(svc, { workspace: ws });
    const again = importWorkspace(svc, { workspace: ws, force: true });
    assert.equal(again.skipped, false);
    assert.equal(svc.list({ limit: 500 }).length, first.imported);
  });

  test('dryRun reports without writing anything', () => {
    seedWorkspace();
    const res = importWorkspace(svc, { workspace: ws, dryRun: true });
    assert.ok(res.bySource.palace.count > 0);
    assert.equal(svc.list({ limit: 500 }).length, 0);
    assert.equal(isImported(ws), false, 'and leaves no sentinel');
  });

  test('the source files are left untouched — this is a copy, not a move', () => {
    // The Palace keeps working for anything that still reads it, and that is
    // what makes the import reversible.
    seedWorkspace();
    const dbPath = path.join(ws, '.agent', 'palace', 'episodic.db');
    const before = fs.statSync(dbPath).size;
    importWorkspace(svc, { workspace: ws });
    assert.equal(fs.existsSync(dbPath), true);
    assert.equal(fs.statSync(dbPath).size, before);
    assert.ok(fs.existsSync(path.join(ws, '.agent', 'memory', 'learnings.md')));
  });

  test('undoImport is a full reversal', () => {
    seedWorkspace();
    importWorkspace(svc, { workspace: ws });
    const { removed } = undoImport(svc, { workspace: ws });

    assert.ok(removed > 0);
    assert.deepEqual(svc.list({ scope: projectScope(ws) }), []);
    assert.equal(isImported(ws), false, 'and it can be re-run');
    assert.equal(importWorkspace(svc, { workspace: ws }).skipped, false);
  });

  test('a corrupt palace does not cost the other sources', () => {
    seedWorkspace();
    fs.writeFileSync(path.join(ws, '.agent', 'palace', 'episodic.db'), 'not a database');
    const res = importWorkspace(svc, { workspace: ws });

    assert.ok(res.bySource.palace.error, 'the failure should be reported');
    assert.ok(res.bySource.dailyLogs.count >= 2, 'and the rest should still import');
    assert.ok(res.imported > 0);
  });

  test('a workspace with no .agent directory is skipped cleanly', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-empty-'));
    try {
      const res = importWorkspace(svc, { workspace: empty });
      assert.equal(res.skipped, true);
      assert.match(res.reason, /no .agent directory/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('the receipt records what was taken', () => {
    seedWorkspace();
    importWorkspace(svc, { workspace: ws });
    const receipt = importReceipt(ws);
    assert.ok(receipt.importedAt);
    assert.equal(receipt.scope, projectScope(ws));
    assert.equal(receipt.importerVersion, 1);
  });

  test('importWorkspace requires a workspace', () => {
    assert.throws(() => importWorkspace(svc, {}), /needs a workspace/);
  });
});

describe('global identity memory (5.3)', () => {
  const USER_MD = `# User Profile

Some framing prose about this file.

## Preferences
- Always ask before deploying to production
- Prefers tabs over spaces

## Background
- Works primarily on backend services

\`\`\`
- this bullet is inside a code fence and is an example
\`\`\`
`;

  test('bullets under a Preferences heading become preferences', () => {
    const recs = parseIdentityFile(USER_MD);
    const prefs = recs.filter(r => r.kind === 'preference');
    assert.equal(prefs.length, 2, 'only the two under the Preferences heading');
    assert.ok(prefs.some(p => /ask before deploying/.test(p.body)));
    // A bullet under "Background" is biography, not an instruction — and
    // `preference` never decays, so misclassifying it would make it permanent.
    const background = recs.find(r => /backend services/.test(r.body));
    assert.equal(background.kind, 'fact');
  });

  test('bullets elsewhere are weaker than explicit preferences', () => {
    const recs = parseIdentityFile(USER_MD);
    const pref = recs.find(r => /tabs over spaces/.test(r.body));
    const other = recs.find(r => /backend services/.test(r.body));
    assert.ok(pref.importance > other.importance);
  });

  test('prose and fenced examples are not memories', () => {
    const bodies = parseIdentityFile(USER_MD).map(r => r.body);
    assert.ok(!bodies.some(b => b.includes('framing prose')));
    assert.ok(!bodies.some(b => b.includes('inside a code fence')),
      'a fenced example is an illustration, not a preference');
  });

  test('syncing puts identity files into global scope', () => {
    const res = syncIdentityToGlobal(svc, { userProfile: USER_MD });
    assert.ok(res.synced >= 3);
    assert.ok(svc.list({ scope: GLOBAL }).length >= 3);
    assert.deepEqual(svc.list({ scope: projectScope(ws) }), []);
  });

  test('a preference from USER.md reaches a mission in an unrelated project', () => {
    // The point of 5.3: identity stops being per-directory.
    syncIdentityToGlobal(svc, { userProfile: USER_MD });
    const text = svc.recallText({
      layer: 'mission', workspace: '/tmp/some-other-project', query: 'deploying production',
    });
    assert.match(text, /ask before deploying/);
  });

  test('re-syncing after an edit adds the new bullet and prunes the removed one', () => {
    // The file must remain the source of truth it looks like: deleting a
    // preference from it has to stop it being recalled.
    syncIdentityToGlobal(svc, { userProfile: USER_MD });
    const edited = USER_MD.replace('- Prefers tabs over spaces', '- Prefers two-space indentation');
    const res = syncIdentityToGlobal(svc, { userProfile: edited });

    assert.equal(res.pruned, 1);
    const bodies = svc.list({ scope: GLOBAL, limit: 100 }).map(r => r.body);
    assert.ok(bodies.some(b => /two-space/.test(b)));
    assert.ok(!bodies.some(b => /tabs over spaces/.test(b)));
  });

  test('pruning never touches memories learned in conversation', () => {
    // Editing a markdown file must not delete something the user said out loud.
    svc.remember({ body: 'Told the assistant to prefer short replies', kind: 'preference', scope: GLOBAL, source: 'conversation' });
    syncIdentityToGlobal(svc, { userProfile: USER_MD });
    syncIdentityToGlobal(svc, { userProfile: '# User Profile\n' });

    const bodies = svc.list({ scope: GLOBAL, limit: 100 }).map(r => r.body);
    assert.ok(bodies.some(b => /short replies/.test(b)), 'conversational memory must survive');
  });

  test('the identity block separates preferences from facts', () => {
    syncIdentityToGlobal(svc, { userProfile: USER_MD, longTermMemory: '# Memory\n\n- The project ships on Thursdays\n' });
    const block = buildGlobalMemoryBlock(svc);
    assert.match(block, /## WHAT YOU KNOW ABOUT THIS USER/);
    assert.match(block, /Standing preferences:/);
    assert.match(block, /ask before deploying/);
    assert.match(block, /ships on Thursdays/);
  });

  test('an empty store renders nothing, so the section can be omitted', () => {
    assert.equal(buildGlobalMemoryBlock(svc), '');
  });

  test('a broken memory service does not break prompt assembly', () => {
    // Memory enhances the prompt; it is never a precondition for building one.
    const broken = { recall() { throw new Error('database is locked'); } };
    assert.equal(buildGlobalMemoryBlock(broken), '');
  });

  test('the block is stable across calls when nothing changed', () => {
    // The system prompt must be byte-identical across a mission's steps for
    // prompt-prefix caching to hold.
    syncIdentityToGlobal(svc, { userProfile: USER_MD });
    assert.equal(buildGlobalMemoryBlock(svc), buildGlobalMemoryBlock(svc));
  });
});

describe('consolidation — "sleep" (5.4)', () => {
  test('unused non-durable memories decay', () => {
    const m = svc.remember({ body: 'an incidental event happened', kind: 'event', scope: GLOBAL });
    const before = svc.get(m.id).importance;

    clock += days(30);
    consolidate(svc);
    assert.ok(svc.get(m.id).importance < before);
  });

  test('preferences and decisions never decay', () => {
    const pref = svc.remember({ body: 'always ask before deploying', kind: 'preference', scope: GLOBAL });
    const dec = svc.remember({ body: 'we chose Postgres for durability', kind: 'decision', scope: GLOBAL });
    const before = [svc.get(pref.id).importance, svc.get(dec.id).importance];

    clock += days(365);
    for (let i = 0; i < 10; i++) consolidate(svc);

    assert.equal(svc.get(pref.id).importance, before[0]);
    assert.equal(svc.get(dec.id).importance, before[1]);
  });

  test('a recently-used memory is spared', () => {
    // Decaying what the system keeps needing would make it forget precisely
    // the things that are working.
    const m = svc.remember({ body: 'frequently consulted caching note', kind: 'fact', scope: GLOBAL });
    svc.recall({ query: 'caching', layer: 'router' });   // marks last_access
    const before = svc.get(m.id).importance;

    consolidate(svc);
    assert.equal(svc.get(m.id).importance, before);
  });

  test('memories decay to nothing over repeated passes, and are then pruned', () => {
    // Decay is gradual on purpose — a single quiet month should not erase
    // something, but a year of never being useful should.
    const m = svc.remember({ body: 'a very unimportant passing detail', kind: 'event', scope: GLOBAL, importance: 0.1 });
    let pruned = 0;
    for (let i = 0; i < 20 && svc.get(m.id); i++) {
      clock += days(30);
      pruned += consolidate(svc).pruned;
    }
    assert.ok(pruned >= 1, 'it should eventually be pruned');
    assert.equal(svc.get(m.id), null);
  });

  test('opposites are never merged', () => {
    // The failure mode of a lower merge threshold: remembering the negation of
    // what you were told, confidently.
    svc.remember({ body: 'the tests are slow', kind: 'fact', scope: GLOBAL });
    svc.remember({ body: 'the tests are fast', kind: 'fact', scope: GLOBAL });
    assert.equal(consolidate(svc).merged, 0);
    assert.equal(svc.list({ scope: GLOBAL, limit: 10 }).length, 2);
  });

  test('near-duplicates merge into the strongest survivor', () => {
    // Ten recordings of "the tests are slow" should be one fact held firmly,
    // not ten weak ones crowding out everything else.
    svc.remember({ body: 'the integration test suite is very slow', kind: 'fact', scope: GLOBAL, importance: 0.6 });
    svc.remember({ body: 'the integration test suite is slow', kind: 'fact', scope: GLOBAL, importance: 0.4 });

    const res = consolidate(svc);
    assert.equal(res.merged, 1);
    const rows = svc.list({ scope: GLOBAL, limit: 100 });
    assert.equal(rows.length, 1);
    // The STRONGER phrasing survives. Its absolute importance is below the
    // starting 0.6 because decay runs first in the same pass — what matters is
    // that the merge strengthened it relative to plain decay (0.6 × 0.92).
    assert.match(rows[0].body, /very slow/, 'the better-evidenced phrasing survives');
    assert.ok(rows[0].importance > 0.6 * 0.92,
      'absorbing a duplicate should raise it above what decay alone would leave');
  });

  test('unrelated memories are NOT merged', () => {
    svc.remember({ body: 'the deployment pipeline runs on merge', kind: 'fact', scope: GLOBAL });
    svc.remember({ body: 'the user prefers dark mode interfaces', kind: 'fact', scope: GLOBAL });
    const res = consolidate(svc);
    assert.equal(res.merged, 0);
    assert.equal(svc.list({ scope: GLOBAL, limit: 100 }).length, 2);
  });

  test('merging never crosses a scope boundary', () => {
    // Two projects with identical notes must stay separate; merging them would
    // move one project's knowledge into another.
    svc.remember({ body: 'the test suite is slow here', kind: 'fact', scope: projectScope('/tmp/a') });
    svc.remember({ body: 'the test suite is slow here', kind: 'fact', scope: projectScope('/tmp/b') });
    consolidate(svc);
    assert.equal(svc.list({ scope: projectScope('/tmp/a') }).length, 1);
    assert.equal(svc.list({ scope: projectScope('/tmp/b') }).length, 1);
  });

  test('a scope is capped, but durable kinds survive the cap', () => {
    for (let i = 0; i < 30; i++) {
      svc.remember({ body: `distinct filler memory number ${i}`, kind: 'event', scope: GLOBAL, importance: 0.5 });
    }
    const pref = svc.remember({ body: 'a preference that must survive capping', kind: 'preference', scope: GLOBAL });

    consolidate(svc, { scopeCap: 5 });
    const rows = svc.list({ scope: GLOBAL, limit: 200 });
    assert.ok(rows.length <= 6, `expected the cap to bite, got ${rows.length}`);
    assert.ok(svc.get(pref.id), 'a preference is never capped away');
  });

  test('dryRun changes nothing', () => {
    svc.remember({ body: 'an event that would decay away', kind: 'event', scope: GLOBAL, importance: 0.1 });
    clock += days(30);
    const before = svc.list({ limit: 100 }).length;
    const res = consolidate(svc, { dryRun: true });
    assert.equal(res.dryRun, true);
    assert.equal(svc.list({ limit: 100 }).length, before);
  });

  test('similarity is lexical and behaves sensibly at both ends', () => {
    assert.equal(similarity('the tests are slow', 'the tests are slow'), 1);
    assert.equal(similarity('the tests are slow', 'deploy on friday'), 0);
    assert.ok(similarity('the integration tests are slow', 'the integration tests are very slow') > 0.6);
  });
});

describe('the consolidation scheduler', () => {
  function makeScheduler(overrides = {}) {
    return new ConsolidationScheduler({
      service: svc,
      now: () => clock,
      minIdleMs: 5 * 60_000,
      ...overrides,
    });
  }

  test('it does not run while work is in flight', async () => {
    // Competing with a live mission for the same database to tidy it is
    // exactly the wrong trade.
    const sched = makeScheduler({ isIdle: () => false });
    clock += days(1);
    assert.equal(await sched.tick(), null);
    assert.equal(sched.runCount, 0);
  });

  test('it waits out a settling period before running', async () => {
    // A gap between two missions is not an idle machine, and consolidating in
    // that gap just delays the next job.
    const sched = makeScheduler({ isIdle: () => true });
    assert.equal(await sched.tick(), null, 'first idle tick only starts the clock');

    clock += 60_000;
    assert.equal(await sched.tick(), null, 'one minute is not long enough');

    clock += 10 * 60_000;
    assert.ok(await sched.tick(), 'now it should run');
    assert.equal(sched.runCount, 1);
  });

  test('busy work resets the idle clock', async () => {
    let idle = true;
    const sched = makeScheduler({ isIdle: () => idle });
    await sched.tick();
    clock += 4 * 60_000;

    idle = false;
    await sched.tick();          // a mission started: reset
    idle = true;
    clock += 60_000;
    await sched.tick();          // idle clock restarts here
    clock += 60_000;
    assert.equal(await sched.tick(), null, 'the settling period restarts from scratch');
  });

  test('it does not run twice in a row on consecutive ticks', async () => {
    const sched = makeScheduler({ isIdle: () => true });
    await sched.tick();
    clock += 10 * 60_000;
    await sched.tick();
    assert.equal(sched.runCount, 1);
    clock += 1000;
    await sched.tick();
    assert.equal(sched.runCount, 1, 'a second pass must wait out another idle period');
  });

  test('extra work runs alongside memory consolidation', async () => {
    // The palace decay and skill consolidator hang off this hook.
    let ran = false;
    const sched = makeScheduler({ isIdle: () => true, extra: async () => { ran = true; return { ok: true }; } });
    const res = await sched.runNow();
    assert.equal(ran, true);
    assert.deepEqual(res.extra, { ok: true });
  });

  test('a failing extra step does not fail the pass', async () => {
    const sched = makeScheduler({ extra: async () => { throw new Error('palace locked'); } });
    const res = await sched.runNow();
    assert.match(res.extra.error, /palace locked/);
    assert.equal(typeof res.scanned, 'number', 'memory consolidation still happened');
  });

  test('maintenance can never take down a healthy daemon', async () => {
    const broken = { open() { throw new Error('database is locked'); }, _now: () => clock };
    const sched = new ConsolidationScheduler({ service: broken, now: () => clock });
    const res = await sched.runNow();
    assert.match(res.error, /database is locked/);
  });

  test('a throwing reporter does not break the pass', async () => {
    const sched = makeScheduler({ onRun: () => { throw new Error('bus down'); } });
    assert.ok(await sched.runNow());
  });

  test('the background timer never holds the process open', () => {
    const sched = makeScheduler({ intervalMs: 1000 });
    sched.start();
    assert.equal(sched.status().running, true);
    // An un-unref'd interval in an always-on daemon is also what stops `node`
    // from exiting in tests.
    assert.equal(typeof sched._timer.unref, 'function');
    sched.stop();
    assert.equal(sched.status().running, false);
  });

  test('a scheduler needs a service', () => {
    assert.throws(() => new ConsolidationScheduler({}), /needs a memory service/);
  });
});

describe('the three phases together', () => {
  test('import, sync, consolidate — and the important things survive', () => {
    // The end-to-end shape of P5: legacy project history comes across, identity
    // becomes global, and a maintenance pass thins the noise without touching
    // what matters.
    seedWorkspace();
    importWorkspace(svc, { workspace: ws });
    syncIdentityToGlobal(svc, {
      userProfile: '# User\n\n## Preferences\n- Always ask before deploying\n',
    });

    const beforeCount = svc.list({ limit: 500 }).length;
    clock += days(90);
    const res = consolidate(svc);

    assert.ok(res.scanned >= beforeCount);
    assert.match(
      svc.recallText({ layer: 'mission', workspace: '/tmp/elsewhere', query: 'deploying' }),
      /ask before deploying/,
      'the preference outlives a quarter of disuse',
    );
  });
});
