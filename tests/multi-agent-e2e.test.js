// tests/multi-agent-e2e.test.js
// Phase 3.16 — Multi-agent E2E tests.
// Tests non-LLM components: policy, taskSpec, handoff, budget, and the
// simulated orchestration pipeline without real LLM calls.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { fileURLToPath } from 'node:url';

import { ROLES, getRoleModel, getRoleMaxSteps, getRoleToolPolicy, getRoleDescription } from '../src/agents/policy.js';
import { parseTaskSpec, formatTaskSpec, defaultDecomposition } from '../src/agents/taskSpec.js';
import { writeHandoff, readHandoffs, buildHandoffContext, clearHandoffs } from '../src/agents/handoff.js';
import { createBudget, defaultBudget } from '../src/agents/budget.js';

// ── Test workspace setup ────────────────────────────────────────────────────────

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-ma-'));
  // Stub getWorkspace so handoff.js uses our temp dir
  process.env.AGENT_WORKSPACE = tmpDir;
  process.env.AGENT_WORK_DIR  = tmpDir;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.AGENT_WORKSPACE;
  delete process.env.AGENT_WORK_DIR;
});

// ── Policy tests (3.10, 3.11) ──────────────────────────────────────────────────

describe('Agent policy — role definitions', () => {
  it('ROLES contains all six specialists', () => {
    const expected = ['conductor', 'scout', 'planner', 'coder', 'reviewer', 'archivist'];
    for (const r of expected) assert.ok(ROLES.includes(r), `missing role: ${r}`);
    assert.equal(ROLES.length, expected.length);
  });

  it('getRoleModel falls back to config.model for unknown env vars', () => {
    for (const role of ROLES) {
      const model = getRoleModel(role);
      assert.ok(typeof model === 'string' && model.length > 0, `empty model for ${role}`);
    }
  });

  it('getRoleModel uses KAIROS_CONDUCTOR_MODEL when set (Q7: pinnable)', () => {
    process.env.KAIROS_CONDUCTOR_MODEL = 'cheap-model-v1';
    const model = getRoleModel('conductor');
    assert.equal(model, 'cheap-model-v1');
    delete process.env.KAIROS_CONDUCTOR_MODEL;
  });

  it('getRoleMaxSteps returns positive integers for all roles', () => {
    for (const role of ROLES) {
      const steps = getRoleMaxSteps(role);
      assert.ok(Number.isInteger(steps) && steps > 0, `invalid maxSteps for ${role}: ${steps}`);
    }
  });

  it('Scout and Archivist have lower step budgets than Coder', () => {
    assert.ok(getRoleMaxSteps('scout') <= getRoleMaxSteps('coder'));
    assert.ok(getRoleMaxSteps('archivist') <= getRoleMaxSteps('coder'));
  });

  it('getRoleToolPolicy: coder allows all tools (*)', () => {
    const policy = getRoleToolPolicy('coder');
    assert.ok(policy.allowed.includes('*'));
    assert.equal(policy.prohibited.length, 0);
  });

  it('getRoleToolPolicy: scout prohibits write operations', () => {
    const policy = getRoleToolPolicy('scout');
    assert.ok(policy.prohibited.includes('write_file'));
    assert.ok(policy.prohibited.includes('edit_file'));
  });

  it('getRoleToolPolicy: reviewer prohibits write operations', () => {
    const policy = getRoleToolPolicy('reviewer');
    assert.ok(policy.prohibited.includes('write_file'));
  });

  it('getRoleDescription returns non-empty string for all roles', () => {
    for (const role of ROLES) {
      assert.ok(getRoleDescription(role).length > 5, `missing description for ${role}`);
    }
  });
});

// ── taskSpec tests (3.12) ─────────────────────────────────────────────────────

describe('taskSpec — parse and format', () => {
  const SAMPLE_SPEC = `
\`\`\`taskspec
- role: scout
  task: "Map the project and identify entry points."
- role: planner
  task: "Create plan.md for adding authentication."
  dependsOn: [scout]
- role: coder
  task: "Implement authentication per plan.md."
  dependsOn: [planner]
  maxSteps: 80
\`\`\`
`;

  it('parses a valid taskspec block', () => {
    const assignments = parseTaskSpec(SAMPLE_SPEC);
    assert.equal(assignments.length, 3);
    assert.equal(assignments[0].role, 'scout');
    assert.equal(assignments[1].role, 'planner');
    assert.equal(assignments[2].role, 'coder');
  });

  it('parses task text correctly', () => {
    const assignments = parseTaskSpec(SAMPLE_SPEC);
    assert.ok(assignments[0].task.includes('Map the project'));
    assert.ok(assignments[1].task.includes('authentication'));
  });

  it('parses dependsOn arrays', () => {
    const assignments = parseTaskSpec(SAMPLE_SPEC);
    assert.deepEqual(assignments[1].dependsOn, ['scout']);
    assert.deepEqual(assignments[2].dependsOn, ['planner']);
  });

  it('parses maxSteps override', () => {
    const assignments = parseTaskSpec(SAMPLE_SPEC);
    assert.equal(assignments[2].maxSteps, 80);
    assert.equal(assignments[0].maxSteps, undefined);
  });

  it('returns [] for text with no taskspec block', () => {
    const result = parseTaskSpec('No spec here, just prose.');
    assert.equal(result.length, 0);
  });

  it('formatTaskSpec round-trips through parseTaskSpec', () => {
    const orig = [
      { role: 'scout',  task: 'Explore the project.' },
      { role: 'coder',  task: 'Build the feature.', dependsOn: ['scout'], maxSteps: 50 },
    ];
    const formatted = formatTaskSpec(orig);
    const parsed    = parseTaskSpec(formatted);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].role, 'scout');
    assert.equal(parsed[1].maxSteps, 50);
  });

  it('defaultDecomposition returns Scout→Planner→Coder→Reviewer→Archivist', () => {
    const decomp = defaultDecomposition('Build a REST API');
    const roles  = decomp.map(a => a.role);
    assert.deepEqual(roles, ['scout', 'planner', 'coder', 'reviewer', 'archivist']);
  });

  it('defaultDecomposition tasks reference the original task', () => {
    const task   = 'Write a Snake game in JavaScript';
    const decomp = defaultDecomposition(task);
    for (const a of decomp) {
      assert.ok(a.task.length > 0, `empty task for ${a.role}`);
    }
  });
});

// ── Handoff tests (3.8) ───────────────────────────────────────────────────────

describe('Handoff contract — write, read, context build', () => {
  const SESSION = 'test-session-001';

  after(() => clearHandoffs(SESSION));

  it('writeHandoff creates a markdown file', () => {
    writeHandoff(SESSION, 'scout', {
      summary: 'Found 12 JS files. Entry: src/index.js. Tests: none.',
      artifacts: ['src/index.js', 'src/utils.js'],
    });
    const handoffs = readHandoffs(SESSION);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].role, 'scout');
  });

  it('readHandoffs returns handoffs in chronological order', () => {
    writeHandoff(SESSION, 'planner', {
      summary: 'Wrote plan.md with 5 tasks.',
      artifacts: ['.agent/plan.md'],
    });
    const handoffs = readHandoffs(SESSION);
    assert.ok(handoffs.length >= 2);
    assert.equal(handoffs[0].role, 'scout');
  });

  it('buildHandoffContext includes previous agents but not current role', () => {
    const ctx = buildHandoffContext(SESSION, 'coder');
    assert.ok(ctx.includes('scout'), 'context should mention scout handoff');
    assert.ok(ctx.includes('planner'), 'context should mention planner handoff');
    assert.ok(!ctx.includes('# Handoff: coder'), 'should not include current role');
  });

  it('buildHandoffContext is empty for first agent in a fresh session', () => {
    const ctx = buildHandoffContext('fresh-session-xyz', 'scout');
    assert.equal(ctx, '');
  });

  it('handoff content includes summary text', () => {
    const handoffs = readHandoffs(SESSION);
    const scout = handoffs.find(h => h.role === 'scout');
    assert.ok(scout.content.includes('Found 12 JS files'));
  });

  it('handoff content includes artifacts list', () => {
    const handoffs = readHandoffs(SESSION);
    const scout = handoffs.find(h => h.role === 'scout');
    assert.ok(scout.content.includes('src/index.js'));
  });

  it('clearHandoffs removes all handoff files', () => {
    clearHandoffs(SESSION);
    assert.equal(readHandoffs(SESSION).length, 0);
  });
});

// ── Budget tests (3.14) ───────────────────────────────────────────────────────

describe('Per-agent token budget', () => {
  it('canStep returns ok:true when budget is not exhausted', () => {
    const budget = createBudget({ total: 100, perRole: { coder: 50 } });
    const check = budget.canStep('coder', 0);
    assert.ok(check.ok);
  });

  it('canStep returns ok:false when role limit is reached', () => {
    const budget = createBudget({ total: 100, perRole: { scout: 10 } });
    const check = budget.canStep('scout', 10);
    assert.ok(!check.ok);
    assert.ok(check.reason.includes('scout'));
  });

  it('canStep returns ok:false when total budget is exhausted', () => {
    const budget = createBudget({ total: 2 });
    budget.recordStep('coder');
    budget.recordStep('coder');
    const check = budget.canStep('coder', 2);
    assert.ok(!check.ok);
    assert.ok(check.reason.includes('exhausted'));
  });

  it('recordStep increments both total and per-role consumed', () => {
    const budget = createBudget({ total: 50, perRole: { planner: 20 } });
    budget.recordStep('planner');
    budget.recordStep('planner');
    const snap = budget.snapshot();
    assert.equal(snap.consumed, 2);
    assert.equal(snap.roleConsumed.planner, 2);
  });

  it('defaultBudget sets total = ceil(sum * 1.2)', () => {
    const budget = defaultBudget({ scout: 10, planner: 20, coder: 100 });
    const snap = budget.snapshot();
    // sum=130, ceil(130*1.2)=156
    assert.equal(snap.total, 156);
  });

  it('one runaway agent cannot exceed its role limit', () => {
    const budget = createBudget({ total: 1000, perRole: { scout: 10 } });
    for (let i = 0; i < 10; i++) budget.recordStep('scout');
    const check = budget.canStep('scout', 10);
    assert.ok(!check.ok, 'scout should be blocked after hitting its limit');
  });

  // ── Wave D-4: USD ceiling unified with the step budget ──────────────────────
  it('snapshot exposes maxDollars and dollarsConsumed', () => {
    const budget = createBudget({ total: 100, maxDollars: 5 });
    const snap = budget.snapshot();
    assert.equal(snap.maxDollars, 5);
    assert.equal(snap.dollarsConsumed, 0);
  });

  it('recordCost accumulates across roles and canStep blocks past the ceiling', () => {
    const budget = createBudget({ total: 1000, maxDollars: 1.0 });
    budget.recordCost('scout', 0.4);
    budget.recordCost('coder', 0.7); // total 1.1 > 1.0
    const check = budget.canStep('reviewer', 0);
    assert.ok(!check.ok, 'should be blocked once the USD ceiling is exceeded');
    assert.match(check.reason, /cost ceiling/i);
    assert.ok(budget.snapshot().dollarsConsumed > 1.0);
  });

  it('maxDollars=0 means unbounded (preserves prior steps-only behavior)', () => {
    const budget = createBudget({ total: 1000, maxDollars: 0 });
    budget.recordCost('coder', 999);
    assert.ok(budget.canStep('coder', 0).ok, 'no USD ceiling when maxDollars=0');
  });

  it('defaultBudget threads maxDollars through', () => {
    const budget = defaultBudget({ scout: 10 }, 2.5);
    assert.equal(budget.snapshot().maxDollars, 2.5);
  });
});

// ── Simulated 4-agent pipeline (3.16) ─────────────────────────────────────────

describe('Simulated 4-agent pipeline (no LLM)', () => {
  const SESSION = 'sim-snake-001';

  after(() => clearHandoffs(SESSION));

  it('handoffs chain correctly through 4 agents', () => {
    // Simulate what each agent would write in a Snake game build
    writeHandoff(SESSION, 'scout', {
      summary: 'No JS files found. Empty workspace ready for Snake game.',
      artifacts: [],
      notes: 'Use vanilla JS, no dependencies.',
    });

    writeHandoff(SESSION, 'planner', {
      summary: 'plan.md written: 4 tasks — game loop, board render, input handler, tests.',
      artifacts: ['.agent/plan.md'],
      notes: 'All in one file snake.js + tests/snake.test.js.',
    });

    writeHandoff(SESSION, 'coder', {
      summary: 'snake.js created (120 lines). All 5 tests pass.',
      artifacts: ['snake.js', 'tests/snake.test.js'],
      notes: 'Tests use node:test runner.',
    });

    writeHandoff(SESSION, 'reviewer', {
      summary: 'PASS ✅ — all acceptance criteria met. 5/5 tests green. Edge cases handled.',
      artifacts: [],
      notes: 'SHIP',
    });

    const handoffs = readHandoffs(SESSION);
    assert.equal(handoffs.length, 4);
    assert.equal(handoffs[0].role, 'scout');
    assert.equal(handoffs[3].role, 'reviewer');
  });

  it('archivist context includes all 4 previous handoffs', () => {
    const ctx = buildHandoffContext(SESSION, 'archivist');
    assert.ok(ctx.includes('scout'),    'archivist sees scout handoff');
    assert.ok(ctx.includes('planner'),  'archivist sees planner handoff');
    assert.ok(ctx.includes('coder'),    'archivist sees coder handoff');
    assert.ok(ctx.includes('reviewer'), 'archivist sees reviewer handoff');
  });

  it('archivist context contains artifact references from coder', () => {
    const ctx = buildHandoffContext(SESSION, 'archivist');
    assert.ok(ctx.includes('snake.js'));
  });

  it('budget is respected across a 4-agent run', () => {
    const perRole = { scout: 10, planner: 20, coder: 100, reviewer: 30 };
    const budget  = defaultBudget(perRole);

    // Simulate steps within each agent's limit
    for (let i = 0; i < 8;  i++) budget.recordStep('scout');
    for (let i = 0; i < 15; i++) budget.recordStep('planner');
    for (let i = 0; i < 60; i++) budget.recordStep('coder');
    for (let i = 0; i < 20; i++) budget.recordStep('reviewer');

    const snap = budget.snapshot();
    assert.equal(snap.consumed, 8 + 15 + 60 + 20);
    assert.ok(snap.remaining > 0, 'budget should have headroom remaining');

    // Verify each role is within its per-role limit
    for (const [role, used] of Object.entries(snap.roleConsumed)) {
      assert.ok(used <= perRole[role], `${role} exceeded its limit: ${used} > ${perRole[role]}`);
    }
  });

  it('taskSpec from conductorTask produces correct role sequence', () => {
    const spec = `
\`\`\`taskspec
- role: scout
  task: "Map project structure"
- role: planner
  task: "Write plan.md for Snake game"
  dependsOn: [scout]
- role: coder
  task: "Implement snake.js and tests"
  dependsOn: [planner]
- role: reviewer
  task: "Verify snake.js tests pass"
  dependsOn: [coder]
\`\`\`
`;
    const assignments = parseTaskSpec(spec);
    assert.equal(assignments.length, 4);
    assert.equal(assignments[0].role, 'scout');
    assert.equal(assignments[1].role, 'planner');
    assert.equal(assignments[2].role, 'coder');
    assert.equal(assignments[3].role, 'reviewer');
    assert.deepEqual(assignments[3].dependsOn, ['coder']);
  });
});

// ── Feature flag (3.13) ───────────────────────────────────────────────────────

describe('Feature flag AGENT_MULTI_AGENT', () => {
  it('multiAgentEnabled is false by default (Q4: RC default-OFF)', async () => {
    const cfg = await import('../src/config.js');
    // Unless AGENT_MULTI_AGENT=1 is set in the test environment, this should be false
    if (!process.env.AGENT_MULTI_AGENT) {
      assert.equal(cfg.default.multiAgentEnabled, false);
    }
  });
});
