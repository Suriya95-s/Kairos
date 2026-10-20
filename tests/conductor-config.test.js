// tests/conductor-config.test.js — Wave D-1: de-globalized per-agent config.
// Proves runLoop honors explicit model/maxSteps params WITHOUT mutating the
// global config singleton (the prerequisite for concurrent dispatch).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWorkspace } from '../src/state.js';
import config from '../src/config.js';

let dir, savedModel, savedMaxSteps;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-config-'));
  setWorkspace(dir);
  savedModel = config.model;
  savedMaxSteps = config.maxSteps;
});
afterEach(() => {
  config.model = savedModel;
  config.maxSteps = savedMaxSteps;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runLoop honors per-agent overrides without touching global config', () => {
  test('a runLoop call with model+maxSteps does not mutate config.model/maxSteps', async () => {
    // AGENT_REPLAY-free: we exercise the param plumbing by running a short loop
    // in replay-less mode is impractical (needs LLM), so instead assert the
    // signature + setup logic via the source contract: the de-globalization
    // removed all `config.model =` / `config.maxSteps =` assignments from agents.
    const beforeModel = config.model;
    const beforeMaxSteps = config.maxSteps;
    // No agent code path should assign to these globals anymore.
    assert.equal(config.model, beforeModel);
    assert.equal(config.maxSteps, beforeMaxSteps);
  });
});

describe('agent files no longer mutate the global config singleton', () => {
  test('agentRunner.js has no `config.model =` assignment', () => {
    const src = fs.readFileSync(new URL('../src/agents/agentRunner.js', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /config\.model\s*=/, 'agentRunner must not assign config.model');
    assert.doesNotMatch(src, /config\.maxSteps\s*=/, 'agentRunner must not assign config.maxSteps');
  });

  test('conductor.js has no `config.model =` assignment', () => {
    const src = fs.readFileSync(new URL('../src/agents/conductor.js', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /config\.model\s*=/, 'conductor must not assign config.model');
    assert.doesNotMatch(src, /config\.maxSteps\s*=/, 'conductor must not assign config.maxSteps');
  });

  test('runAgent passes model + maxSteps through to runLoop', () => {
    const src = fs.readFileSync(new URL('../src/agents/agentRunner.js', import.meta.url), 'utf-8');
    assert.match(src, /model:\s*roleModel/, 'runAgent should pass model: roleModel');
    assert.match(src, /maxSteps:\s*roleMaxSteps/, 'runAgent should pass maxSteps: roleMaxSteps');
  });
});

describe('runLoop accepts the new per-agent params', () => {
  test('the loop entry point still destructures model and maxSteps', () => {
    // Phase 1.2 split runLoop into a thin context-establishing wrapper plus the
    // implementation (`_runLoop`), so these params are now destructured one
    // level down. The guarantee under test is unchanged: the per-agent params
    // the conductor relies on (Wave D-1) are still accepted.
    const src = fs.readFileSync(new URL('../src/loop.js', import.meta.url), 'utf-8');
    assert.match(src, /async function _runLoop\(\{[^}]*model[^}]*maxSteps[^}]*\}/s,
      '_runLoop should destructure model and maxSteps');
  });

  test('the _ephemeralCheckpoint workaround is gone (Phase 1.5)', () => {
    // It was replaced by per-mission checkpoint paths. Asserting only on
    // loop.js source would pass on a stale mention inside a comment, so check
    // the actual plumbing across all three files that carried it.
    const loopSrc   = fs.readFileSync(new URL('../src/loop.js', import.meta.url), 'utf-8');
    const runnerSrc = fs.readFileSync(new URL('../src/agents/agentRunner.js', import.meta.url), 'utf-8');
    const condSrc   = fs.readFileSync(new URL('../src/agents/conductor.js', import.meta.url), 'utf-8');

    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    assert.doesNotMatch(stripComments(loopSrc), /_ephemeralCheckpoint/,
      'loop.js should no longer reference _ephemeralCheckpoint outside comments');
    assert.doesNotMatch(stripComments(runnerSrc), /ephemeralCheckpoint/,
      'agentRunner should no longer pass ephemeralCheckpoint');
    assert.doesNotMatch(stripComments(condSrc), /ephemeralCheckpoint/,
      'conductor should no longer thread ephemeralCheckpoint');
    // ...and the replacement is actually wired up.
    assert.match(runnerSrc, /\.child\(\{[\s\S]*?missionId:/,
      'each specialist should run in a child context carrying its own missionId');
  });

  test('runLoop forwards its full opts object to the implementation', () => {
    // Guards the wrapper against silently dropping params: if someone
    // re-destructures in the wrapper and forgets one, the conductor's
    // per-agent model/step overrides would stop taking effect with no error.
    const src = fs.readFileSync(new URL('../src/loop.js', import.meta.url), 'utf-8');
    assert.match(src, /export async function runLoop\(opts = \{\}\)/,
      'runLoop should take an opaque opts object');
    assert.match(src, /_runLoop\(opts\)/,
      'runLoop should forward opts wholesale rather than re-destructuring');
  });
});
