import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { setWorkspace, initAgentDir } from '../src/state.js';
import { loadSkills, getSkillsSummary, getRelevantSkillBlocks } from '../src/skills.js';

let testDir;

function setupWorkspace() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-'));
  setWorkspace(testDir);
  initAgentDir();
}

function cleanupWorkspace() {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

describe('standard skill loading', () => {
  beforeEach(() => setupWorkspace());
  afterEach(() => cleanupWorkspace());

  test('loads skills.sh style SKILL.md from .agents/skills', () => {
    const skillDir = path.join(testDir, '.agents', 'skills', 'frontend-design');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: frontend-design
description: Improve interface layout, spacing, and typography.
tags: design,frontend,ui
---
# Frontend Design

Use strong visual hierarchy, spacing systems, and responsive structure.
`, 'utf-8');

    const loaded = loadSkills();
    assert.ok(loaded.some((skill) => skill.name === 'frontend-design'));
    assert.ok(getSkillsSummary().includes('reference skill'));
  });

  test('returns relevant skill blocks for matching tasks', () => {
    const skillDir = path.join(testDir, '.agents', 'skills', 'systematic-debugging');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: systematic-debugging
description: Debug failing tests and runtime issues step by step.
tags: debugging,tests
---
# Systematic Debugging

1. Reproduce the issue.
2. Narrow the failing surface.
3. Confirm the fix with a targeted command.
`, 'utf-8');

    loadSkills();
    const blocks = getRelevantSkillBlocks({
      task: 'Debug failing smoke tests in the Python workspace.',
      currentSubtask: 'Find why the render smoke test crashes.',
      recentActions: ['run_command {"command":"python3 _smoke_test.py"}'],
    });

    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].includes('systematic-debugging'));
    assert.ok(blocks[0].includes('Reproduce the issue'));
  });
});
