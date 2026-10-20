// tests/config.test.js — config env parsing/validation.
// config.js is a module-cached singleton, so each case runs in a fresh child
// process with its own env and prints the resolved values as JSON.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadConfig(env = {}) {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e',
      'import c from "./src/config.js"; process.stdout.write(JSON.stringify({' +
      'maxOutputTokens:c.maxOutputTokens,contextWindow:c.contextWindow,maxSteps:c.maxSteps,' +
      'temperature:c.temperature,maxConsecutiveErrors:c.maxConsecutiveErrors,confinePaths:c.confinePaths}));'],
    { cwd: repoRoot, env: { ...process.env, ...env }, encoding: 'utf-8' },
  );
  return JSON.parse(out);
}

describe('config numeric env validation', () => {
  test('invalid AGENT_MAX_OUTPUT falls back to a finite default (no NaN max_tokens)', () => {
    const c = loadConfig({ AGENT_MAX_OUTPUT: 'abc' });
    assert.ok(Number.isFinite(c.maxOutputTokens), 'maxOutputTokens must be finite');
    assert.ok(c.maxOutputTokens > 0);
  });

  test('valid AGENT_MAX_OUTPUT is honored', () => {
    const c = loadConfig({ AGENT_MAX_OUTPUT: '8192' });
    assert.equal(c.maxOutputTokens, 8192);
  });

  test('invalid AGENT_CONTEXT_WINDOW falls back to finite, not NaN', () => {
    const c = loadConfig({ AGENT_CONTEXT_WINDOW: 'not-a-number' });
    assert.ok(Number.isFinite(c.contextWindow) && c.contextWindow > 0);
  });

  test('invalid AGENT_MAX_ERRORS falls back to the default (>=1)', () => {
    const c = loadConfig({ AGENT_MAX_ERRORS: 'xyz' });
    assert.ok(Number.isFinite(c.maxConsecutiveErrors) && c.maxConsecutiveErrors >= 1);
  });

  test('invalid AGENT_TEMPERATURE falls back to a finite value', () => {
    const c = loadConfig({ AGENT_TEMPERATURE: 'hot' });
    assert.ok(Number.isFinite(c.temperature));
  });

  test('AGENT_MAX_STEPS=0 (disable hard stop) is preserved, not treated as invalid', () => {
    const c = loadConfig({ AGENT_MAX_STEPS: '0' });
    assert.equal(c.maxSteps, 0);
  });
});

describe('config confinePaths default', () => {
  test('defaults ON (workspace confinement) when unset', () => {
    const env = { ...process.env };
    delete env.AGENT_CONFINE_PATHS;
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', 'import c from "./src/config.js"; process.stdout.write(String(c.confinePaths));'],
      { cwd: repoRoot, env, encoding: 'utf-8' },
    );
    assert.equal(out.trim(), 'true');
  });

  test('opt-out with AGENT_CONFINE_PATHS=0', () => {
    const c = loadConfig({ AGENT_CONFINE_PATHS: '0' });
    assert.equal(c.confinePaths, false);
  });
});
