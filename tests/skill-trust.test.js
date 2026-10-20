// tests/skill-trust.test.js — Wave B skill trust tiers.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWorkspace } from '../src/state.js';
import { envForTier, parseTrustTier, loadSkills, executeSkill, isSkillTool } from '../src/skills.js';

describe('parseTrustTier', () => {
  test('## Trust section', () => {
    assert.equal(parseTrustTier('# Skill: x\n## Trust\nsandboxed\n'), 'sandboxed');
  });
  test('inline trust: line', () => {
    assert.equal(parseTrustTier('# Skill: x\ntrust: trusted\n'), 'trusted');
  });
  test('missing → semi-trusted default', () => {
    assert.equal(parseTrustTier('# Skill: x\n## Description\nhi'), 'semi-trusted');
  });
  test('unknown value → semi-trusted', () => {
    assert.equal(parseTrustTier('trust: banana'), 'semi-trusted');
  });
});

/**
 * Look up an environment variable the way the OS does.
 *
 * Windows spells it `Path`, POSIX spells it `PATH`, and Node's `process.env`
 * hides the difference on reads but not on `{...process.env}` — so a scrubbed
 * env carries whichever casing the platform actually uses. Windows environment
 * blocks are case-insensitive, so this is a property of the spelling, not a
 * bug; asserting on one casing just made the suite POSIX-only.
 */
function envGet(env, name) {
  const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

describe('envForTier', () => {
  let saved;
  beforeEach(() => {
    saved = {
      AGENT_API_KEY: process.env.AGENT_API_KEY,
      KAIROS_TEST_PLAIN: process.env.KAIROS_TEST_PLAIN,
    };
    process.env.AGENT_API_KEY = 'SECRET123';
    process.env.KAIROS_TEST_PLAIN = 'plainval';
  });
  afterEach(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('trusted keeps the full env (incl. secrets)', () => {
    const e = envForTier('trusted');
    assert.equal(e.AGENT_API_KEY, 'SECRET123');
    assert.equal(e.KAIROS_TEST_PLAIN, 'plainval');
  });
  test('semi-trusted strips secrets, keeps ordinary vars', () => {
    const e = envForTier('semi-trusted');
    assert.equal(e.AGENT_API_KEY, undefined);
    assert.equal(e.KAIROS_TEST_PLAIN, 'plainval');
    assert.ok(envGet(e, 'PATH'));
  });
  test('sandboxed keeps only the minimal allowlist', () => {
    const e = envForTier('sandboxed');
    assert.equal(e.AGENT_API_KEY, undefined);
    assert.equal(e.KAIROS_TEST_PLAIN, undefined); // ordinary var dropped too
    assert.ok(envGet(e, 'PATH')); // PATH is on the minimal allowlist
  });
});

describe('sandboxed skill has no shell access', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-trust-')); setWorkspace(dir); });
  afterEach(() => { if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); });

  test('execSync is withheld from a sandboxed skill', () => {
    const skillDir = path.join(dir, '.agent', 'skills');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'probe.md'),
      '# Skill: probe\n## Description\nprobe\n## Trust\nsandboxed\n## Implementation\n```javascript\nreturn execSync("echo hi");\n```\n');
    loadSkills();
    assert.ok(isSkillTool('skill_probe'));
    const out = executeSkill('skill_probe', {});
    // execSync is not defined in the sandboxed context → the skill errors out.
    assert.match(out.result, /execSync is not defined/);
  });

  test('a semi-trusted skill CAN use the shell', () => {
    const skillDir = path.join(dir, '.agent', 'skills');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'probe2.md'),
      '# Skill: probe2\n## Description\nprobe\n## Implementation\n```javascript\nreturn execSync("echo KAIROS_OK").trim();\n```\n');
    loadSkills();
    const out = executeSkill('skill_probe2', {});
    assert.match(out.result, /KAIROS_OK/);
  });
});
