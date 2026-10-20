// tests/plan-focus.test.js — Wave E-4b: getFocusChain feeds the cockpit focus strip.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWorkspace, writePlan } from '../src/state.js';
import { getFocusChain } from '../src/plan.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-focus-')); setWorkspace(dir); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const PLAN = [
  '### Phase 1: Setup [completed]',
  '- [x] init repo',
  '- [x] add deps',
  '### Phase 2: Build [in_progress]',
  '- [x] scaffold',
  '- [ ] implement core ← CURRENT',
  '- [ ] write tests',
].join('\n');

describe('getFocusChain', () => {
  test('returns [] when there is no plan', () => {
    assert.deepEqual(getFocusChain(), []);
  });

  test('flattens checklist items with done/current/pending states', () => {
    writePlan(PLAN);
    const chain = getFocusChain();
    const byText = Object.fromEntries(chain.map(i => [i.text, i.state]));
    assert.equal(byText['init repo'], 'done');
    assert.equal(byText['scaffold'], 'done');
    assert.equal(byText['implement core'], 'current');
    assert.equal(byText['write tests'], 'pending');
  });

  test('windows around the current item when over the cap', () => {
    const many = ['### Phase 1: P [in_progress]'];
    for (let i = 0; i < 12; i++) many.push(`- [${i < 5 ? 'x' : ' '}] item${i}${i === 5 ? ' ← CURRENT' : ''}`);
    writePlan(many.join('\n'));
    const chain = getFocusChain(4);
    assert.equal(chain.length, 4);
    assert.ok(chain.some(i => i.state === 'current'), 'window includes the current item');
  });

  test('never throws on malformed plan content', () => {
    writePlan('garbage ### not a real plan [[[');
    assert.doesNotThrow(() => getFocusChain());
  });
});
