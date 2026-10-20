// tests/memoryd-service.test.js
// Phase 5.1 + 5.5 — the memory service and its recall policy.
//
// The acceptance criterion is a story, not a unit: tell it a preference in a
// chat session; three days and two projects later, a mission's context includes
// it. That story is the last test in this file, and the rest exist to make its
// failure diagnosable.
//
// Scope is also the access-control boundary, so the negative cases matter as
// much as the positive ones: a reflex must not be able to read a project's
// memory, and one project must not see another's.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryService, MEMORY_KINDS } from '../src/memoryd/service.js';
import {
  GLOBAL, projectScope, sessionScope, parseScope, isValidScope,
  scopesFor, isScopeAllowed, RECALL_POLICY,
} from '../src/memoryd/scopes.js';

let svc;
let clock;

beforeEach(() => {
  clock = 1_700_000_000_000;
  svc = new MemoryService({ dbPath: ':memory:', now: () => clock });
  svc.open();
});

afterEach(() => { svc.close(); });

const days = (n) => n * 86_400_000;

describe('scopes (D5)', () => {
  test('project scope is derived from a resolved path', () => {
    assert.match(projectScope('/tmp/proj'), /^project:/);
    assert.equal(sessionScope('s-1'), 'session:s-1');
    assert.equal(projectScope(null), GLOBAL, 'no workspace means no project scope');
  });

  test('paths differing only in case or trailing slash are ONE project', () => {
    // Splitting a project's memory in two because of a trailing slash would be
    // invisible until someone noticed half their facts had vanished.
    assert.equal(projectScope('/tmp/proj'), projectScope('/tmp/proj/'));
    if (process.platform === 'win32') {
      assert.equal(projectScope('C:\\Proj'), projectScope('c:/proj'));
    }
  });

  test('different projects are different scopes', () => {
    assert.notEqual(projectScope('/tmp/a'), projectScope('/tmp/b'));
  });

  test('scopes round-trip through parseScope', () => {
    assert.deepEqual(parseScope(GLOBAL), { kind: 'global', value: null });
    assert.deepEqual(parseScope('session:s-1'), { kind: 'session', value: 's-1' });
    assert.equal(parseScope('project:/tmp/a').kind, 'project');
  });

  test('a malformed scope is not silently accepted', () => {
    assert.equal(isValidScope('nonsense:x'), false);
    assert.equal(isValidScope('project:'), false);
    assert.equal(isValidScope(GLOBAL), true);
  });
});

describe('recall policy (5.5)', () => {
  test('a reflex sees global and session, but NOT project', () => {
    // A fast path with no gates must not be able to surface a private
    // repository's contents into a chat window.
    const s = scopesFor('reflex', { sessionId: 's-1', workspace: '/tmp/proj' });
    assert.ok(s.includes(GLOBAL));
    assert.ok(s.includes('session:s-1'));
    assert.ok(!s.some(x => x.startsWith('project:')), 'reflex must not read project memory');
  });

  test('a mission sees all three', () => {
    const s = scopesFor('mission', { sessionId: 's-1', workspace: '/tmp/proj' });
    assert.equal(s.length, 3);
    assert.ok(s.some(x => x.startsWith('project:')));
  });

  test('the router only needs to know who it is talking to', () => {
    assert.deepEqual(scopesFor('router', { sessionId: 's-1', workspace: '/tmp/p' }), [GLOBAL]);
  });

  test('a missing workspace narrows access — it never widens it', () => {
    // The dangerous failure would be "no workspace, so read everything".
    const s = scopesFor('mission', { sessionId: 's-1' });
    assert.deepEqual(s, [GLOBAL, 'session:s-1']);
  });

  test('an unknown layer throws rather than defaulting to permissive', () => {
    assert.throws(() => scopesFor('wizard', {}), /unknown recall layer/);
  });

  test('every declared layer resolves', () => {
    for (const layer of Object.keys(RECALL_POLICY)) {
      assert.ok(Array.isArray(scopesFor(layer, { sessionId: 's', workspace: '/w' })));
    }
  });
});

describe('remembering', () => {
  test('a memory round-trips', () => {
    const m = svc.remember({ body: 'The user prefers tabs', kind: 'preference', scope: GLOBAL });
    assert.equal(m.body, 'The user prefers tabs');
    assert.equal(m.scope, GLOBAL);
    assert.equal(svc.get(m.id).id, m.id);
  });

  test('restating a fact updates it rather than duplicating', () => {
    // Duplicate rows would let repetition quietly outrank importance at recall.
    const a = svc.remember({ body: 'deploys need approval', kind: 'preference' });
    const b = svc.remember({ body: 'deploys need approval', kind: 'preference' });
    assert.equal(a.id, b.id);
    assert.equal(svc.list().length, 1);
    assert.ok(b.importance > a.importance, 'restating it makes it firmer');
  });

  test('importance is capped at 1 however often something is restated', () => {
    let m;
    for (let i = 0; i < 20; i++) m = svc.remember({ body: 'x'.repeat(20), kind: 'preference' });
    assert.ok(m.importance <= 1);
  });

  test('the same body in different scopes is two memories', () => {
    svc.remember({ body: 'uses tabs', scope: GLOBAL });
    svc.remember({ body: 'uses tabs', scope: projectScope('/tmp/a') });
    assert.equal(svc.list().length, 2);
  });

  test('an unknown kind is rejected', () => {
    assert.throws(() => svc.remember({ body: 'x', kind: 'vibe' }), /unknown memory kind/);
    for (const k of MEMORY_KINDS) {
      assert.doesNotThrow(() => svc.remember({ body: `body for ${k}`, kind: k }));
    }
  });

  test('an invalid scope is rejected', () => {
    assert.throws(() => svc.remember({ body: 'x', scope: 'nonsense:y' }), /invalid scope/);
  });

  test('an empty body is rejected', () => {
    assert.throws(() => svc.remember({ body: '' }), /needs a body/);
  });

  test('superseding keeps the old fact but hides it from recall', () => {
    // "We decided Postgres" replacing "we decided MySQL" is different from the
    // first decision never having happened.
    const old = svc.remember({ body: 'we chose MySQL', kind: 'decision', scope: GLOBAL });
    svc.supersede(old.id, { body: 'we chose Postgres', kind: 'decision', scope: GLOBAL });

    const bodies = svc.recall({ layer: 'router' }).map(r => r.body);
    assert.deepEqual(bodies, ['we chose Postgres']);
    assert.ok(svc.get(old.id), 'the history is still there');
  });

  test('forget removes a memory; forgetScope clears a whole project', () => {
    const scope = projectScope('/tmp/gone');
    svc.remember({ body: 'a', scope });
    svc.remember({ body: 'b', scope });
    const keep = svc.remember({ body: 'c', scope: GLOBAL });

    assert.equal(svc.forgetScope(scope), 2);
    assert.equal(svc.list().length, 1);
    assert.ok(svc.get(keep.id));
    assert.equal(svc.forget(keep.id), true);
    assert.equal(svc.forget(99999), false);
  });
});

describe('recall', () => {
  test('a query matches on subject and body', () => {
    svc.remember({ subject: 'deployment', body: 'staging deploys run on merge', scope: GLOBAL });
    svc.remember({ subject: 'testing', body: 'the suite takes four minutes', scope: GLOBAL });

    const hits = svc.recall({ query: 'deployment', layer: 'router' });
    assert.equal(hits.length, 1);
    assert.match(hits[0].body, /staging deploys/);
  });

  test('an empty query returns the most salient, not nothing', () => {
    // "What should I know before starting?" is a real question.
    svc.remember({ body: 'trivial detail', kind: 'event', scope: GLOBAL });
    svc.remember({ body: 'never deploy on Friday', kind: 'preference', scope: GLOBAL });

    const hits = svc.recall({ layer: 'router', limit: 1 });
    assert.equal(hits[0].body, 'never deploy on Friday', 'importance should win');
  });

  test('a non-matching query returns nothing rather than noise', () => {
    svc.remember({ body: 'the suite takes four minutes', scope: GLOBAL });
    assert.deepEqual(svc.recall({ query: 'kubernetes ingress', layer: 'router' }), []);
  });

  test('preferences do not decay, events do', () => {
    // A preference stated in January is not less true in March.
    svc.remember({ body: 'always ask before deploying', kind: 'preference', scope: GLOBAL });
    svc.remember({ body: 'always ask before merging', kind: 'event', scope: GLOBAL });

    clock += days(120);
    const hits = svc.recall({ query: 'always ask before', layer: 'router' });
    assert.equal(hits[0].kind, 'preference', 'the durable one should outrank the stale event');
  });

  test('recency breaks ties between equally important facts', () => {
    svc.remember({ subject: 'x', body: 'older note about caching', kind: 'fact', scope: GLOBAL });
    clock += days(60);
    svc.remember({ subject: 'x', body: 'newer note about caching', kind: 'fact', scope: GLOBAL });

    const hits = svc.recall({ query: 'caching', layer: 'router' });
    assert.match(hits[0].body, /newer/);
  });

  test('recall respects the limit', () => {
    for (let i = 0; i < 20; i++) svc.remember({ body: `caching note ${i}`, scope: GLOBAL });
    assert.equal(svc.recall({ query: 'caching', layer: 'router', limit: 5 }).length, 5);
  });

  test('recall can be filtered by kind', () => {
    svc.remember({ body: 'caching preference', kind: 'preference', scope: GLOBAL });
    svc.remember({ body: 'caching event', kind: 'event', scope: GLOBAL });
    const hits = svc.recall({ query: 'caching', layer: 'router', kinds: ['preference'] });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].kind, 'preference');
  });

  test('recallText renders a context block, empty when there is nothing', () => {
    assert.equal(svc.recallText({ layer: 'router' }), '');
    svc.remember({ subject: 'style', body: 'tabs, not spaces', kind: 'preference', scope: GLOBAL });
    assert.equal(svc.recallText({ layer: 'router' }), '- style: tabs, not spaces');
  });

  test('using a memory records the access — the input to consolidation', () => {
    const m = svc.remember({ body: 'accessed fact about caching', scope: GLOBAL });
    assert.equal(svc.get(m.id).access_count, 0);
    svc.recall({ query: 'caching', layer: 'router' });
    assert.equal(svc.get(m.id).access_count, 1);
  });
});

describe('scope isolation is access control, not tidiness', () => {
  test('one project cannot see another project\'s memory', () => {
    svc.remember({ body: 'secret from project A', scope: projectScope('/tmp/a') });
    const hits = svc.recall({ query: 'secret', layer: 'mission', workspace: '/tmp/b' });
    assert.deepEqual(hits, []);
  });

  test('a reflex cannot read project memory even when a workspace is known', () => {
    svc.remember({ body: 'private repository detail', scope: projectScope('/tmp/a') });
    const hits = svc.recall({ query: 'private', layer: 'reflex', workspace: '/tmp/a', sessionId: 's-1' });
    assert.deepEqual(hits, [], 'the reflex has no gates; it must not read project scope');
  });

  test('one session cannot read another session', () => {
    svc.remember({ body: 'said in session one', scope: sessionScope('s-1') });
    const hits = svc.recall({ query: 'session', layer: 'reflex', sessionId: 's-2' });
    assert.deepEqual(hits, []);
  });

  test('requesting a forbidden scope THROWS rather than quietly returning less', () => {
    // Silently returning fewer results looks like "it forgot" and gets debugged
    // in the wrong place.
    svc.remember({ body: 'project detail', scope: projectScope('/tmp/a') });
    assert.throws(
      () => svc.recall({ layer: 'reflex', scopes: [projectScope('/tmp/a')], sessionId: 's-1' }),
      /may not read/,
    );
  });

  test('crossScope works but is audited', () => {
    const audits = [];
    const audited = new MemoryService({ dbPath: ':memory:', now: () => clock, onAudit: e => audits.push(e) });
    audited.remember({ body: 'project detail', scope: projectScope('/tmp/a') });

    const hits = audited.recall({
      layer: 'reflex', scopes: [projectScope('/tmp/a')], sessionId: 's-1',
      query: 'project', crossScope: true,
    });
    assert.equal(hits.length, 1);
    assert.equal(audits.length, 1, 'crossing a scope boundary must leave a record');
    assert.equal(audits[0].layer, 'reflex');
    audited.close();
  });

  test('isScopeAllowed matches what recall enforces', () => {
    const ctx = { sessionId: 's-1', workspace: '/tmp/a' };
    assert.equal(isScopeAllowed('mission', projectScope('/tmp/a'), ctx), true);
    assert.equal(isScopeAllowed('reflex', projectScope('/tmp/a'), ctx), false);
    assert.equal(isScopeAllowed('reflex', GLOBAL, ctx), true);
  });
});

describe('the 5.1 acceptance story', () => {
  test('a preference stated in chat reaches a mission days later in another project', () => {
    // "Tell it a preference in a chat session; three days and two projects
    // later, a mission's context includes it." This is the whole point of the
    // phase — before it, memory was whichever .agent/ directory you were
    // standing in.
    svc.remember({
      body: 'Always run the linter before opening a pull request',
      kind: 'preference',
      scope: GLOBAL,
      source: 'session:s-monday',
    });

    // A different project, three days later, a different session.
    clock += days(3);
    const context = svc.recallText({
      layer: 'mission',
      workspace: '/tmp/a-completely-different-project',
      sessionId: 's-thursday',
      query: 'pull request',
    });

    assert.match(context, /Always run the linter/);
  });

  test('project knowledge stays with its project across sessions', () => {
    svc.remember({ body: 'This repo pins Node 22 for node:sqlite', kind: 'fact', scope: projectScope('/tmp/kairos') });
    clock += days(10);

    const here = svc.recallText({ layer: 'mission', workspace: '/tmp/kairos', sessionId: 's-later', query: 'node' });
    assert.match(here, /pins Node 22/);

    const elsewhere = svc.recallText({ layer: 'mission', workspace: '/tmp/other', sessionId: 's-later', query: 'node' });
    assert.equal(elsewhere, '');
  });

  test('memory survives a restart', () => {
    // :memory: cannot show this, so use a real file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-mem-'));
    const dbPath = path.join(dir, 'memory.db');
    try {
      const first = new MemoryService({ dbPath });
      first.remember({ body: 'persisted across restarts', kind: 'preference', scope: GLOBAL });
      first.close();

      const second = new MemoryService({ dbPath });
      assert.match(second.recallText({ layer: 'router', query: 'persisted' }), /persisted across restarts/);
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stats summarise without dumping content', () => {
    svc.remember({ body: 'a preference', kind: 'preference', scope: GLOBAL });
    svc.remember({ body: 'a project fact', kind: 'fact', scope: projectScope('/tmp/a') });
    const s = svc.stats();
    assert.equal(s.total, 2);
    assert.ok(!JSON.stringify(s).includes('a preference'));
  });
});
