// tests/mission-profiles.test.js
// Phase 2 — mission profiles. Two things under test:
//   1. the BUILD profile is a byte-for-byte behavioural match of the old
//      hardcoded lifecycle (the regression guarantee that made this landable)
//   2. non-build profiles are actually finishable — the whole point of Phase 2

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PROFILES, getProfile, selectProfile, profileNames, isProfile, DEFAULT_PROFILE,
} from '../src/missions/profiles.js';
import {
  STAGE_ORDER, STAGE_TOOL_ALLOWLIST,
  createInitialStageState, getStageGuidance, filterToolsByStage,
  getStageBudget, completionGuard, getProfileGates, getProfileName,
} from '../src/stages.js';
import { isStateChangingTool } from '../src/loop.js';
import { setWorkspace, initAgentDir } from '../src/state.js';
import { resetAmbientContext } from '../src/runtime/context.js';
import { TOOL_DEFINITIONS } from '../src/tools.js';
import { buildMessages } from '../src/context.js';
import { WorkingMemory } from '../src/memory.js';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `profiles-${t}-`));

describe('Profile registry integrity', () => {
  test('every profile is well-formed and self-consistent', () => {
    for (const [key, p] of Object.entries(PROFILES)) {
      assert.equal(p.name, key, `${key}: name must match its registry key`);
      assert.ok(typeof p.description === 'string' && p.description.length > 0, `${key}: needs a description`);
      assert.ok(Array.isArray(p.stages), `${key}: stages must be an array`);
      assert.equal(typeof p.guidance, 'function', `${key}: guidance must be a function`);
      assert.ok(p.gates && typeof p.gates === 'object', `${key}: needs a gates object`);
      assert.ok(p.toolAllowlist && typeof p.toolAllowlist === 'object', `${key}: needs a toolAllowlist`);

      // Every stage must have a budget ratio and every ratio a stage.
      for (const stage of p.stages) {
        assert.ok(stage in p.budgetRatios, `${key}: stage "${stage}" has no budget ratio`);
      }
      for (const stage of Object.keys(p.budgetRatios)) {
        assert.ok(p.stages.includes(stage), `${key}: ratio for unknown stage "${stage}"`);
      }
      // Ratios should roughly fill the budget — a profile summing to 0.3 would
      // silently starve itself of steps.
      if (p.stages.length > 0) {
        const total = Object.values(p.budgetRatios).reduce((a, b) => a + b, 0);
        assert.ok(Math.abs(total - 1) < 0.01, `${key}: budget ratios sum to ${total}, expected ~1`);
      }
      // Allowlists must only name real tools.
      const known = new Set(TOOL_DEFINITIONS.map(t => t.function.name));
      for (const [stage, allow] of Object.entries(p.toolAllowlist)) {
        if (allow === null) continue;
        for (const toolName of allow) {
          assert.ok(known.has(toolName), `${key}/${stage}: unknown tool "${toolName}" in allowlist`);
        }
      }
      // A gated stage must be able to finish, or the profile can never complete.
      for (const [stage, allow] of Object.entries(p.toolAllowlist)) {
        if (allow === null) continue;
        if (stage === p.stages[p.stages.length - 1]) {
          assert.ok(allow.includes('finish'), `${key}: final stage "${stage}" cannot call finish`);
        }
      }
    }
  });

  test('getProfile falls back to the default for unknown or missing names', () => {
    // A bad --profile or a checkpoint from a newer build must not strand a run.
    assert.equal(getProfile('nope').name, DEFAULT_PROFILE);
    assert.equal(getProfile('').name, DEFAULT_PROFILE);
    assert.equal(getProfile(undefined).name, DEFAULT_PROFILE);
    assert.equal(getProfile('BUILD').name, 'build', 'lookup should be case-insensitive');
  });

  test('profileNames / isProfile agree with the registry', () => {
    assert.deepEqual(profileNames().sort(), ['build', 'converse', 'errand', 'research']);
    assert.ok(isProfile('research'));
    assert.ok(!isProfile('nonsense'));
  });
});

describe('BUILD profile is a byte-for-byte regression baseline', () => {
  test('stage order and allowlist match the pre-Phase-2 constants', () => {
    assert.deepEqual(STAGE_ORDER, ['intake', 'discovery', 'planning', 'execution', 'verification', 'finalization']);
    assert.deepEqual(getProfile('build').stages, STAGE_ORDER);
    assert.equal(STAGE_TOOL_ALLOWLIST.execution, null, 'execution must remain unrestricted');
    assert.deepEqual(
      STAGE_TOOL_ALLOWLIST.intake,
      ['read_file', 'list_dir', 'think', 'write_file', 'save_memory', 'finish']
    );
  });

  test('budget ratios are unchanged (execution still gets 55%)', () => {
    assert.equal(getStageBudget('execution', 100), 55);
    assert.equal(getStageBudget('intake', 100), 5);
  });

  test('default-arg callers still get build behaviour', () => {
    // Every pre-existing call site omits the profile argument.
    const guidance = getStageGuidance('verification', 10, 2);
    assert.match(guidance, /STAGE: VERIFICATION/);
    assert.match(guidance, /SMOKE OK/, 'build verification guidance must still demand a smoke test');
    const state = createInitialStageState('Build a snake game', 100);
    assert.equal(state.profile, 'build');
    assert.equal(state.currentStage, 'intake');
  });
});

describe('stageState stays JSON-serializable (checkpoint constraint)', () => {
  test('only the profile NAME is stored, never the profile object', () => {
    // stageState is written into checkpoint.json every step. A profile holds
    // functions, so embedding one would silently vanish across a resume and the
    // lifecycle would revert to the default mid-mission.
    const state = createInitialStageState('Research the options', 100, null, 'research');
    assert.equal(typeof state.profile, 'string');

    const round = JSON.parse(JSON.stringify(state));
    assert.deepEqual(round, state, 'stage state must survive a JSON round-trip unchanged');
    assert.equal(getProfileName(round), 'research', 'profile is recoverable from the name after resume');
    assert.equal(getProfileGates(round).requireSmokeTest, false);
  });

  test('no function-valued fields anywhere in stage state', () => {
    for (const name of profileNames()) {
      const state = createInitialStageState('some task', 50, null, name);
      for (const [k, v] of Object.entries(state)) {
        assert.notEqual(typeof v, 'function', `${name}: stageState.${k} is a function`);
      }
    }
  });
});

describe('Profiles change the lifecycle', () => {
  test('research skips intake/planning/verification and starts at discovery', () => {
    const state = createInitialStageState('Compare these three libraries', 100, null, 'research');
    assert.equal(state.profile, 'research');
    assert.equal(state.currentStage, 'discovery');
    assert.deepEqual(getProfile('research').stages, ['discovery', 'execution', 'finalization']);
  });

  test('research guidance NEVER instructs the model to write a smoke test', () => {
    // This is the concrete bug Phase 2 fixes: a research task was told to
    // produce _smoke_test.py and then blocked at finish for not having one.
    for (const stage of getProfile('research').stages) {
      const g = getStageGuidance(stage, 5, 1, 'research');
      assert.ok(g.length > 0, `research/${stage} must have guidance`);
      assert.doesNotMatch(g, /SMOKE OK/, `research/${stage} must not demand a smoke test`);
      assert.doesNotMatch(g, /_smoke_test/, `research/${stage} must not name a smoke test file`);
    }
  });

  test('converse has no stages, so the stage machine is disabled', () => {
    assert.deepEqual(getProfile('converse').stages, []);
    assert.equal(getProfile('converse').guidance('anything', 1, 1), '');
  });

  test('errand does not parse output contracts from the task text', () => {
    // A task mentioning result/*.md must not saddle an errand with deliverables
    // it is then blocked on producing. Uses the structure parseRequiredOutputs
    // actually recognises (a bulleted list) so the build control is meaningful.
    const task = [
      'Email Bob about the release and add it to my calendar.',
      'Required final outputs:',
      '- result/report.md',
    ].join('\n');

    const errand = createInitialStageState(task, 100, null, 'errand');
    assert.deepEqual(errand.requiredOutputs, [], 'errand must not invent deliverables');
    assert.deepEqual(errand.lockedTargets, []);

    const build = createInitialStageState(task, 100, null, 'build');
    assert.deepEqual(build.requiredOutputs, ['result/report.md'],
      'build still parses contracts (control)');
  });

  test('tool allowlists are per-profile', () => {
    const researchDiscovery = filterToolsByStage(TOOL_DEFINITIONS, 'discovery', 'research')
      .map(t => t.function.name);
    assert.ok(researchDiscovery.includes('websearch'), 'research discovery needs web access');

    const buildDiscovery = filterToolsByStage(TOOL_DEFINITIONS, 'discovery', 'build')
      .map(t => t.function.name);
    assert.ok(!buildDiscovery.includes('websearch'), 'build discovery is repo-local (unchanged)');

    // errand execution is deliberately unrestricted (null) — an action needs
    // whatever tool performs it, including MCP tools.
    assert.equal(
      filterToolsByStage(TOOL_DEFINITIONS, 'execution', 'errand').length,
      TOOL_DEFINITIONS.length
    );
  });
});

describe('Finish gates are profile-driven', () => {
  // completionGuard takes a `workspace` argument, but hasFileModifications is
  // derived from state.js file tracking, which resolves through the ambient
  // context — so the context must point at the same dir or the guard reads a
  // previous test's tracking data.
  const useWorkspace = (tag) => {
    const ws = tmp(tag);
    resetAmbientContext();
    setWorkspace(ws);
    initAgentDir();
    return ws;
  };
  afterEach(() => resetAmbientContext());

  test('errand can finish without modifying any file; build cannot', () => {
    const ws = useWorkspace('gates');

    // No file modifications recorded in either case.
    const errand = createInitialStageState('Turn off the office lights', 100, null, 'errand');
    assert.equal(completionGuard(errand, ws), '',
      'an errand whose outcome is external must not be blocked for touching no files');

    const build = createInitialStageState('Build a thing', 100, null, 'build');
    assert.match(completionGuard(build, ws), /no workspace files were modified/,
      'build must still require a real artifact');
  });

  test('gate flags resolve correctly for every profile', () => {
    const gatesFor = (n) => getProfileGates(createInitialStageState('t', 10, null, n));
    assert.equal(gatesFor('build').requireSmokeTest, true);
    assert.equal(gatesFor('research').requireSmokeTest, false);
    assert.equal(gatesFor('errand').requireSmokeTest, false);
    assert.equal(gatesFor('converse').requireSmokeTest, false);

    assert.equal(gatesFor('build').requireSandboxVerify, true);
    assert.equal(gatesFor('errand').requireSandboxVerify, false);
    assert.equal(gatesFor('errand').requireActuationReceipts, true);
    assert.notEqual(gatesFor('build').requireActuationReceipts, true);
  });

  test('research still requires an artifact — it cannot finish having written nothing', () => {
    const ws = useWorkspace('research-gate');
    const research = createInitialStageState('Investigate the options', 100, null, 'research');
    assert.match(completionGuard(research, ws), /no workspace files were modified/);
  });
});

describe('The system prompt itself is profile-aware', () => {
  // The stage guidance being clean is not sufficient: the SYSTEM PROMPT
  // contained "ALWAYS write _smoke_test.py" as an unconditional rule, so a
  // research mission was instructed to build a test harness and then blocked at
  // finish for not having one. Both had to be fixed for the Phase 2 AC to hold.
  const promptFor = (profileName) => {
    const ws = tmp(`sysprompt-${profileName}`);
    resetAmbientContext();
    setWorkspace(ws);
    initAgentDir();
    const stageState = createInitialStageState('summarize what changed', 100, null, profileName);
    const msgs = buildMessages({
      step: 1, memory: new WorkingMemory(), stageState, workspace: ws, routedTools: [],
    });
    return msgs.find(m => m.role === 'system').content;
  };
  afterEach(() => resetAmbientContext());

  test('only build is told to write a smoke test', () => {
    assert.match(promptFor('build'), /_smoke_test/, 'build must keep its smoke-test rule');
    assert.doesNotMatch(promptFor('research'), /_smoke_test/);
    assert.doesNotMatch(promptFor('errand'), /_smoke_test/);
    assert.doesNotMatch(promptFor('converse'), /_smoke_test/);
  });

  test('non-build profiles get an appropriate rule in its place', () => {
    assert.match(promptFor('research'), /written work, not software/);
    assert.match(promptFor('errand'), /not to write about it/);
  });

  test('the prompt stays byte-stable across steps of one mission', () => {
    // Prompt-prefix caching depends on the system prompt being byte-identical
    // every step. The profile is fixed for a whole mission, so per-mission
    // variation is safe — per-STEP variation would silently break caching.
    const ws = tmp('stability');
    resetAmbientContext();
    setWorkspace(ws);
    initAgentDir();
    const stageState = createInitialStageState('research something', 100, null, 'research');
    const at = (step) => buildMessages({
      step, memory: new WorkingMemory(), stageState, workspace: ws, routedTools: [],
    }).find(m => m.role === 'system').content;

    assert.equal(at(1), at(47));
    assert.equal(at(47), at(300));
  });
});

describe('isStateChangingTool (actuation receipts)', () => {
  test('mutating and MCP tools count; read-only and bookkeeping do not', () => {
    for (const t of ['write_file', 'edit_file', 'patch', 'run_command', 'delete_path', 'move_path', 'copy_path', 'create_dir']) {
      assert.ok(isStateChangingTool(t), `${t} should count as state-changing`);
    }
    assert.ok(isStateChangingTool('github__create_issue'), 'MCP tools are external side effects');

    for (const t of ['read_file', 'list_dir', 'search_files', 'glob', 'think', 'finish',
                     'save_memory', 'search_memory', 'update_plan', 'todowrite', 'add_learning',
                     'webfetch', 'websearch']) {
      assert.ok(!isStateChangingTool(t), `${t} must NOT count as doing the errand`);
    }
    assert.ok(!isStateChangingTool(''), 'empty name is not state-changing');
    assert.ok(!isStateChangingTool(undefined));
  });
});

describe('Heuristic profile selection', () => {
  test('an explicit profile always wins over the heuristic', () => {
    const r = selectProfile('build me a REST API', { explicit: 'research' });
    assert.equal(r.name, 'research');
    assert.equal(r.reason, 'explicit');
  });

  test('an unknown explicit profile falls back to the default, and says so', () => {
    const r = selectProfile('anything', { explicit: 'bogus' });
    assert.equal(r.name, DEFAULT_PROFILE);
    assert.match(r.reason, /unknown_profile/);
  });

  test('representative tasks route to the intended profile', () => {
    const cases = [
      ['Build a REST API with Express',                     'build'],
      ['implement a snake game in python',                  'build'],
      ['fix the bug in the auth module',                    'build'],
      ['research and compare three logging libraries',      'research'],
      ['summarize what changed in this repo this week',      'research'],
      ['analyze why the build is slow',                     'research'],
      ['send Bob an email about the release',               'errand'],
      ['remind me to check the deploy on Friday',           'errand'],
      ['turn off the office lights',                        'errand'],
      ['what do you think about this architecture',         'converse'],
      // The mission that burned a weekly token quota: "study" matched no
      // signal, fell back to build, and the smoke-test gate blocked a written
      // study from ever finishing (52 consecutive attempts, live).
      ['I want you to study about ontology.',               'research'],
      ['learn about vector databases and write it up',      'research'],
      ['teach me how DNS resolution works',                 'research'],
    ];
    for (const [task, expected] of cases) {
      const got = selectProfile(task);
      assert.equal(got.name, expected,
        `"${task}" → ${got.name} (expected ${expected}); scores=${JSON.stringify(got.scores)}`);
    }
  });

  test('ambiguity and emptiness fall back to build, the strictest profile', () => {
    // Deliberate: build has the tightest gates, so a misroute gets blocked and
    // corrected rather than finishing on weaker evidence than it should have.
    assert.equal(selectProfile('').name, 'build');
    assert.equal(selectProfile('').reason, 'empty_task');
    assert.equal(selectProfile('zzzz qqqq').name, 'build');
    assert.equal(selectProfile('zzzz qqqq').reason, 'no_signal');
  });
});
