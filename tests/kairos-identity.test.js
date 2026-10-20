import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkingMemory } from '../src/memory.js';
import { buildMessages } from '../src/context.js';
import {
  bootstrapIdentity,
  buildIdentityBlock,
  buildRecoveryPrompt,
  getIdentityLoadTrace,
} from '../src/identity.js';
import { initAgentDir, setWorkspace, writeTask } from '../src/state.js';

let testDir;

function setupWorkspace() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kairos-'));
  setWorkspace(testDir);
  initAgentDir();
  bootstrapIdentity();
  writeTask('Integrate the Kairos identity layer into the loop.');
}

function cleanupWorkspace() {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

describe('Kairos Identity Integration', () => {
  beforeEach(() => setupWorkspace());
  afterEach(() => cleanupWorkspace());

  test('bootstrapIdentity seeds the Kairos SOUL template', () => {
    const soul = fs.readFileSync(path.join(testDir, 'SOUL.md'), 'utf-8');
    assert.ok(soul.startsWith('# SOUL.md — Kairos Identity'));
  });

  test('identity trace and assembled block follow SOUL, AGENTS, USER, MEMORY order', () => {
    const trace = getIdentityLoadTrace().map((entry) => entry.path);
    assert.deepEqual(trace, ['SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md']);

    const block = buildIdentityBlock();
    assert.ok(block.startsWith('## KAIROS IDENTITY'));

    const soulIndex = block.indexOf('### SOUL.md');
    const agentsIndex = block.indexOf('### AGENTS.md');
    const userIndex = block.indexOf('### USER.md');
    const memoryIndex = block.indexOf('### MEMORY.md');

    assert.ok(soulIndex >= 0);
    assert.ok(agentsIndex > soulIndex);
    assert.ok(userIndex > agentsIndex);
    assert.ok(memoryIndex > userIndex);
  });

  test('post-compaction recovery prompt starts with the Kairos anchor', () => {
    const recoveryPrompt = buildRecoveryPrompt();
    assert.equal(
      recoveryPrompt.split('\n')[0],
      'You are Kairos. Re-read SOUL.md and AGENTS.md before continuing.',
    );
  });

  test('buildMessages injects the Kairos system header and identity layer label', () => {
    const messages = buildMessages({
      step: 1,
      memory: new WorkingMemory(),
      workspace: testDir,
    });

    assert.ok(messages[0].content.startsWith('You are Kairos — an autonomous reasoning and engineering agent.'));
    assert.ok(messages[0].content.includes('## KAIROS IDENTITY'));
  });
});
