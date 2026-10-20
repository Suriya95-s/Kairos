// tests/tui-ontology-commands.test.js
// The TUI / palette's ontology + spend verbs (apps/tui/src/commands/ontologyCmds.js).
// The load-bearing claims: reports agree with the kernel modules the CLI uses,
// the /remove ceremony NEVER deletes, force rules match the CLI, and lens
// argv-building is whitelisted + injection-inert.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  usageReport, historyReport, removePreview, removeForce, lensArgs,
} from '../apps/tui/src/commands/ontologyCmds.js';
import { appendDocument, evidenceRef, listDomains, domainDir } from '../src/ontology/store.js';
import { recordUsage } from '../src/kernel/usage.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-tuicmd-'));
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

describe('/usage — same ledger the CLI sums', () => {
  test('reports totals, model and purpose buckets from the real ledger', async () => {
    recordUsage({
      model: 'gpt-4o-mini', baseURL: 'http://gw/v1', purpose: 'ontology.verify',
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    });
    const rep = await usageReport('');
    assert.ok(rep.ok);
    assert.match(rep.title, /^SPEND LEDGER — \d{4}-\d{2}$/);
    const text = rep.lines.join('\n');
    assert.match(text, /1 call\(s\) · 1,000 in \+ 500 out = 1,500 tokens/);
    assert.match(text, /gpt-4o-mini @ http:\/\/gw\/v1/);
    assert.match(text, /ontology\.verify/);
  });

  test('an empty ledger says so instead of rendering zeros as activity', async () => {
    const rep = await usageReport('all');
    assert.equal(rep.title, 'SPEND LEDGER — ALL TIME');
    assert.match(rep.lines.join('\n'), /no model calls in the ledger/);
  });
});

describe('/history — what was built, when', () => {
  test('bare form lists every domain with counts', async () => {
    seed('alpha'); seed('beta');
    const rep = await historyReport('', '');
    const text = rep.lines.join('\n');
    assert.match(text, /◆ alpha {2}2 doc\(s\)/);
    assert.match(text, /◆ beta {2}2 doc\(s\)/);
    assert.match(text, /1 object_type · 1 instance/);
  });

  test('domain form shows attributed journal events, honoring the limit', async () => {
    seed('gamma');
    const rep = await historyReport('gamma', '1');
    assert.equal(rep.ok, true);
    const events = rep.lines.slice(3); // header, kinds, blank, then entries
    assert.equal(events.length, 1);
    assert.match(events[0], /instance/); // the LAST write, newest-first
    assert.match(events[0], /by kairos-induction/);
  });

  test('a missing domain is a red toast, not an empty overlay', async () => {
    const rep = await historyReport('nope', '');
    assert.equal(rep.ok, false);
    assert.match(rep.text, /nope/);
  });
});

describe('/remove — ceremony first, deletion only on --force', () => {
  test('the preview counts docs + intake files and NEVER deletes', async () => {
    seed('doomed');
    const intake = path.join(domainDir('doomed'), 'intake');
    fs.mkdirSync(intake, { recursive: true });
    fs.writeFileSync(path.join(intake, 'a.csv'), 'x');
    fs.writeFileSync(path.join(intake, 'b.csv'), 'y');

    const p = await removePreview('doomed');
    assert.equal(p.exists, true);
    assert.equal(p.docs, 2);
    assert.equal(p.intakeFiles, 2);
    assert.match(p.lines.join('\n'), /cannot be undone/);
    assert.match(p.lines.join('\n'), /--force/);
    assert.ok(fs.existsSync(domainDir('doomed')), 'preview must not delete anything');
  });

  test('force removes the domain; a missing one reports, never throws', async () => {
    seed('doomed2');
    const res = await removeForce('doomed2', {});
    assert.equal(res.ok, true);
    assert.equal(listDomains().includes('doomed2'), false);
    const again = await removeForce('doomed2', {});
    assert.equal(again.ok, false);
  });

  test('the kairos loop-memory domain demands --loop-memory on top of --force', async () => {
    seed('kairos');
    const refused = await removeForce('kairos', {});
    assert.equal(refused.ok, false);
    assert.match(refused.text, /--loop-memory/);
    assert.ok(fs.existsSync(domainDir('kairos')), 'refusal must not delete');

    const p = await removePreview('kairos');
    assert.equal(p.isLoopMemory, true);
    assert.match(p.lines.join('\n'), /--force --loop-memory/);

    const gone = await removeForce('kairos', { loopMemory: true });
    assert.equal(gone.ok, true);
    assert.equal(listDomains().includes('kairos'), false);
  });
});

describe('lens argv building — whitelisted and injection-inert', () => {
  test('builds the exact CLI argv, model flag only when given', () => {
    assert.deepEqual(lensArgs('verify', 'btoshop', 'mini54'),
      ['ontology', 'verify', 'btoshop', '--model', 'mini54']);
    assert.deepEqual(lensArgs('critique', 'btoshop', ''),
      ['ontology', 'critique', 'btoshop']);
  });

  test('only verify/resolve/critique pass the whitelist', () => {
    assert.throws(() => lensArgs('approve', 'btoshop', ''), /not a lens command/);
    assert.throws(() => lensArgs('remove', 'btoshop', ''), /not a lens command/);
    assert.throws(() => lensArgs('verify', '', ''), /domain is required/);
  });

  test('a hostile domain stays one inert argv element (no shell ever sees it)', () => {
    const args = lensArgs('verify', 'x; rm -rf / && echo pwn', '');
    assert.deepEqual(args, ['ontology', 'verify', 'x; rm -rf / && echo pwn']);
  });
});
