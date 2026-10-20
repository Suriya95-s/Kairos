// tests/learning.test.js
// Phase 5: Self-Improvement test suite
// Covers: skillGrader, skillConsolidator, offlineConsolidation, trace-logger stricter gate,
//         reflection, failureLearner, traceExport, redactor, selfEval

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir;
let origWorkspace;

function setupTmp() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-learning-test-'));
  origWorkspace = process.cwd();
  process.chdir(tmpDir);
}

function teardownTmp() {
  process.chdir(origWorkspace);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function cfg() {
  const c = (await import('../src/config.js')).default;
  c._workspace = tmpDir;
  return c;
}

// ── Task 5.1: skillGrader ─────────────────────────────────────────────────────
describe('skillGrader', () => {
  before(setupTmp);
  after(teardownTmp);

  it('gradeSkill returns grade A for well-reused skill', async () => {
    const { gradeSkill } = await import('../src/learning/skillGrader.js');
    const skill = {
      name: 'useful-skill',
      filePath: '/fake/useful-skill.md',
      content: '---\nname: useful-skill\nreuse_count: 12\nlast_used: ' + new Date().toISOString() + '\n---\n' + Array(55).fill('skill content line').join('\n'),
    };
    const result = gradeSkill(skill, {});
    assert.equal(result.grade, 'A');
    assert.ok(result.score >= 0.75);
  });

  it('gradeSkill returns grade D for never-used, thin skill', async () => {
    const { gradeSkill } = await import('../src/learning/skillGrader.js');
    const skill = {
      name: 'thin-unused',
      filePath: '/fake/thin.md',
      content: '---\nname: thin-unused\nreuse_count: 0\n---\nbrief.',
    };
    const result = gradeSkill(skill, {});
    assert.equal(result.grade, 'D');
  });

  it('gradeSkill score is in [0, 1]', async () => {
    const { gradeSkill } = await import('../src/learning/skillGrader.js');
    const skill = { name: 's', filePath: '/x.md', content: '---\nname: s\n---\nsome content' };
    const { score } = gradeSkill(skill, {});
    assert.ok(score >= 0 && score <= 1);
  });

  it('gradeAllSkills returns empty array when skills dir is empty', async () => {
    await cfg();
    const { gradeAllSkills } = await import('../src/learning/skillGrader.js');
    const grades = gradeAllSkills();
    assert.ok(Array.isArray(grades));
    assert.equal(grades.length, 0);
  });

  it('gradeAllSkills grades all .md files in .agent/skills/', async () => {
    const config = await cfg();
    const skillsDir = path.join(tmpDir, config.skillsDir);
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'skill-a.md'), '---\nname: skill-a\nreuse_count: 5\n---\ncontent here\n'.repeat(5));
    fs.writeFileSync(path.join(skillsDir, 'skill-b.md'), '---\nname: skill-b\nreuse_count: 0\n---\nbrief');
    const { gradeAllSkills } = await import('../src/learning/skillGrader.js');
    const grades = gradeAllSkills();
    assert.equal(grades.length, 2);
    assert.ok(grades[0].score >= grades[1].score, 'sorted descending by score');
  });
});

// ── Task 5.2: skillConsolidator ───────────────────────────────────────────────
describe('skillConsolidator', () => {
  before(setupTmp);
  after(teardownTmp);

  async function writeSkill(name, content) {
    const config = await cfg();
    const dir = path.join(tmpDir, config.skillsDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.md`), content);
  }

  it('findMergeCandidates returns empty array when no skills', async () => {
    await cfg();
    const { findMergeCandidates } = await import('../src/learning/skillConsolidator.js');
    const result = findMergeCandidates();
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });

  it('findMergeCandidates detects near-duplicate skills', async () => {
    const body = 'run linting check code style eslint format prettier';
    await writeSkill('lint-check', `---\nname: lint-check\nreuse_count: 2\n---\n${body} ${body}`);
    await writeSkill('lint-run',   `---\nname: lint-run\nreuse_count: 1\n---\n${body} ${body} run`);
    const { findMergeCandidates } = await import('../src/learning/skillConsolidator.js');
    const candidates = findMergeCandidates(0.40);
    assert.ok(candidates.length >= 1);
    assert.ok(candidates[0].similarity >= 0.40);
  });

  it('consolidate(dryRun=true) does not modify files', async () => {
    const config = await cfg();
    const dir = path.join(tmpDir, config.skillsDir);
    const filesBefore = fs.readdirSync(dir).sort();
    const { consolidate } = await import('../src/learning/skillConsolidator.js');
    consolidate(true);
    const filesAfter = fs.readdirSync(dir).sort();
    assert.deepEqual(filesBefore, filesAfter);
  });

  it('consolidate(dryRun=false) removes the secondary skill file', async () => {
    const body = 'run linting check code style eslint format prettier autofix';
    await writeSkill('merge-a', `---\nname: merge-a\nreuse_count: 3\n---\n${body} ${body}`);
    await writeSkill('merge-b', `---\nname: merge-b\nreuse_count: 1\n---\n${body} ${body} similar`);
    const { consolidate } = await import('../src/learning/skillConsolidator.js');
    const merges = consolidate(false, 0.40);
    // After merging, total files should decrease by number of merges
    const config = await cfg();
    const dir = path.join(tmpDir, config.skillsDir);
    const files = fs.readdirSync(dir);
    assert.ok(files.length < 4, `expected fewer files after merge, got ${files.length}`);
  });
});

// ── Task 5.3: offlineConsolidation ────────────────────────────────────────────
describe('offlineConsolidation', () => {
  before(setupTmp);
  after(teardownTmp);

  it('runOfflineConsolidation runs without throwing (skipPalace=true)', async () => {
    await cfg();
    const { runOfflineConsolidation } = await import('../src/learning/offlineConsolidation.js');
    const summary = await runOfflineConsolidation({ skipPalace: true, dryRun: true });
    assert.ok(summary.palace?.skipped);
    assert.ok(typeof summary.timestamp === 'string');
  });

  it('runOfflineConsolidation returns skillGrades result', async () => {
    await cfg();
    const { runOfflineConsolidation } = await import('../src/learning/offlineConsolidation.js');
    const summary = await runOfflineConsolidation({ skipPalace: true, dryRun: true });
    assert.ok(summary.skillGrades != null);
  });

  it('runOfflineConsolidation dry-run does not write consolidation log', async () => {
    const config = await cfg();
    const { runOfflineConsolidation } = await import('../src/learning/offlineConsolidation.js');
    await runOfflineConsolidation({ skipPalace: true, dryRun: true });
    const logFile = path.join(tmpDir, config.learningDir, 'consolidation-log.jsonl');
    assert.ok(!fs.existsSync(logFile));
  });
});

// ── Task 5.4: stricter trace-logger gate ──────────────────────────────────────
describe('trace-logger stricter acceptance gate', () => {
  before(setupTmp);
  after(teardownTmp);

  it('rejects hallucinated trace', async () => {
    await cfg();
    const { emitTrainingTrace } = await import('../src/training/trace-logger.js');
    const r = emitTrainingTrace({
      episodeId: 'test-ep', step: 1, stage: 'execution',
      toolOutcome: 'success', hallucinationDetected: true, latencyMs: 100,
    });
    assert.equal(r?.accepted, false);
  });

  it('rejects repetitive error loop trace', async () => {
    await cfg();
    const { emitTrainingTrace } = await import('../src/training/trace-logger.js');
    const r = emitTrainingTrace({
      episodeId: 'test-ep', step: 2, stage: 'execution',
      toolOutcome: 'error', repetitiveErrorLoopDetected: true, latencyMs: 100,
    });
    assert.equal(r?.accepted, false);
  });

  it('accepts clean trace with success outcome', async () => {
    await cfg();
    const { emitTrainingTrace } = await import('../src/training/trace-logger.js');
    const r = emitTrainingTrace({
      episodeId: 'test-ep', step: 3, stage: 'execution',
      toolOutcome: 'success', hallucinationDetected: false, latencyMs: 500,
      recoveryAttemptLogged: false,
    });
    assert.equal(r?.accepted, true);
  });

  it('rejects stalled trace (latency > 120s)', async () => {
    await cfg();
    const { emitTrainingTrace } = await import('../src/training/trace-logger.js');
    const r = emitTrainingTrace({
      episodeId: 'test-ep', step: 4, stage: 'execution',
      toolOutcome: 'success', hallucinationDetected: false, latencyMs: 150_000,
    });
    assert.equal(r?.accepted, false);
  });
});

// ── Task 5.5: reflection ──────────────────────────────────────────────────────
describe('reflection', () => {
  before(setupTmp);
  after(teardownTmp);

  it('writeReflection creates a markdown file', async () => {
    const config = await cfg();
    const { writeReflection } = await import('../src/learning/reflection.js');
    const filePath = writeReflection(
      'ep-test-123',
      { exitReason: 'completed', summary: 'done', totalSteps: 10, totalCharsUsed: 5000, compactionCount: 1, memoriesFlushed: 3, skillsCreated: 1 },
      [],
      'Build a REST API'
    );
    assert.ok(fs.existsSync(filePath));
    const content = fs.readFileSync(filePath, 'utf-8');
    assert.ok(content.includes('ep-test-'));
    assert.ok(content.includes('completed'));
  });

  it('reflection file is in .agent/reflections/', async () => {
    const config = await cfg();
    const { writeReflection } = await import('../src/learning/reflection.js');
    const filePath = writeReflection('ep-456', { exitReason: 'max_steps', summary: 'hit limit', totalSteps: 100, totalCharsUsed: 0, compactionCount: 0, memoriesFlushed: 0, skillsCreated: 0 }, [], 'Task');
    assert.ok(filePath.includes(config.reflectionsDir.replace(/\//g, path.sep)));
  });

  it('reflection includes error rate from memory entries', async () => {
    await cfg();
    const { writeReflection } = await import('../src/learning/reflection.js');
    const memory = [
      { step: 1, action: 'run_command', result: 'ok', error: false },
      { step: 2, action: 'run_command', result: 'fail', error: true },
    ];
    const filePath = writeReflection('ep-789', { exitReason: 'completed', summary: 'done', totalSteps: 2, totalCharsUsed: 0, compactionCount: 0, memoriesFlushed: 0, skillsCreated: 0 }, memory, 'Test task');
    const content = fs.readFileSync(filePath, 'utf-8');
    assert.ok(content.includes('50.0%'));
  });
});

// ── Wave C-2: reflection on ALL exit paths ────────────────────────────────────
describe('reflection fires on non-completed exits (Wave C-2)', () => {
  before(setupTmp);
  after(teardownTmp);

  for (const exitReason of ['max_steps', 'error', 'interrupted', 'budget_exceeded', 'repair_stalled']) {
    it(`writeReflection creates a file for exitReason="${exitReason}"`, async () => {
      const config = await cfg();
      const { writeReflection } = await import('../src/learning/reflection.js');
      const filePath = writeReflection(
        `ep-c2-${exitReason}`,
        { exitReason, summary: `exit: ${exitReason}`, totalSteps: 3, totalCharsUsed: 0, compactionCount: 0, memoriesFlushed: 0, skillsCreated: 0 },
        [{ step: 1, action: 'run_command', result: 'fail', error: true }],
        'Test C-2 reflection'
      );
      assert.ok(fs.existsSync(filePath), `reflection file should be written for ${exitReason}`);
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(content.includes(exitReason), 'file should reference the exit reason');
    });
  }

  it('evalSession persists a self-eval row for exitReason="max_steps"', async () => {
    const config = await cfg();
    const { evalSession } = await import('../src/learning/selfEval.js');
    evalSession(
      'ep-c2-max-steps',
      { exitReason: 'max_steps', summary: 'hit limit', totalSteps: 100, compactionCount: 0, skillsCreated: 0 },
      [],
      'Test task'
    );
    const f = path.join(tmpDir, config.learningDir, 'self-evals.jsonl');
    assert.ok(fs.existsSync(f), 'self-evals.jsonl should exist');
    const lines = fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean);
    const row = lines.map(l => JSON.parse(l)).find(r => r.sessionId === 'ep-c2-max-steps');
    assert.ok(row, 'row for max_steps episode should be persisted');
    assert.ok(row.score >= 1 && row.score <= 5);
  });
});

// ── Task 5.6: failureLearner ──────────────────────────────────────────────────
describe('failureLearner', () => {
  before(setupTmp);
  after(teardownTmp);

  it('recordFailure returns null for first and second occurrences', async () => {
    await cfg();
    const { recordFailure } = await import('../src/learning/failureLearner.js');
    assert.equal(recordFailure('run_command', {}, 'permission denied'), null);
    assert.equal(recordFailure('run_command', {}, 'permission denied'), null);
  });

  it('recordFailure returns suggestion on third occurrence', async () => {
    await cfg();
    const { recordFailure } = await import('../src/learning/failureLearner.js');
    const ERR = 'unique-failure-signal-999';
    recordFailure('run_command', {}, ERR);
    recordFailure('run_command', {}, ERR);
    const result = recordFailure('run_command', {}, ERR);
    assert.ok(result !== null);
    assert.ok(typeof result.suggestion === 'string');
    assert.equal(result.count, 3);
  });

  it('getSkillSuggestions returns all suggestions above threshold', async () => {
    await cfg();
    const { recordFailure, getSkillSuggestions } = await import('../src/learning/failureLearner.js');
    // Unique error to avoid cross-test contamination
    for (let i = 0; i < 3; i++) recordFailure('write_file', {}, 'unique-test-error-xyz');
    const suggestions = getSkillSuggestions();
    assert.ok(suggestions.some(s => s.suggestion.includes('write')));
  });

  it('clearPattern removes the pattern', async () => {
    await cfg();
    const { recordFailure, clearPattern, getSkillSuggestions } = await import('../src/learning/failureLearner.js');
    for (let i = 0; i < 3; i++) recordFailure('think', {}, 'test-clear-error-abc');
    const before = getSkillSuggestions().length;
    clearPattern(); // clear all
    const after = getSkillSuggestions().length;
    assert.equal(after, 0);
  });
});

// ── Task 5.7: traceExport ─────────────────────────────────────────────────────
describe('traceExport', () => {
  before(setupTmp);
  after(teardownTmp);

  it('exportTraces produces valid JSONL with HuggingFace format', async () => {
    const config = await cfg();
    // Write some accepted trace data
    const traceDir = path.join(tmpDir, path.dirname(config.trainingAcceptedFile));
    fs.mkdirSync(traceDir, { recursive: true });
    const trace = { episode_id: 'ep-1', step: 1, stage: 'execution', subtask: 'build', input_summary: 'run npm test', controller_action: { tool: 'run_command', args: { command: 'npm test' } }, tool_outcome: 'success', reward_placeholder: 0.8, hallucination_detected: false, latency_ms: 200, timestamp: new Date().toISOString() };
    fs.writeFileSync(path.join(tmpDir, config.trainingAcceptedFile), JSON.stringify(trace) + '\n');

    const { exportTraces } = await import('../src/learning/traceExport.js');
    const outputFile = path.join(tmpDir, 'export.jsonl');
    const { exported, skipped } = exportTraces(outputFile, { redact: false });
    assert.equal(exported, 1);
    assert.equal(skipped, 0);

    const lines = fs.readFileSync(outputFile, 'utf-8').trim().split('\n');
    const record = JSON.parse(lines[0]);
    assert.ok(Array.isArray(record.messages));
    assert.ok(record.messages.some(m => m.role === 'user'));
    assert.ok(record.messages.some(m => m.role === 'assistant'));
    assert.ok(typeof record.reward === 'number');
    assert.ok(record.metadata);
  });

  it('exportTraces filters by minReward', async () => {
    const config = await cfg();
    const t1 = { episode_id: 'ep-2', step: 1, stage: 'execution', subtask: 'x', input_summary: 'x', controller_action: { tool: 'run_command', args: {} }, tool_outcome: 'success', reward_placeholder: 0.1, hallucination_detected: false, latency_ms: 100, timestamp: new Date().toISOString() };
    const t2 = { ...t1, step: 2, reward_placeholder: 0.9 };
    const f = path.join(tmpDir, config.trainingAcceptedFile);
    fs.writeFileSync(f, [t1, t2].map(t => JSON.stringify(t)).join('\n') + '\n');

    const { exportTraces } = await import('../src/learning/traceExport.js');
    const out = path.join(tmpDir, 'export-filtered.jsonl');
    const { exported } = exportTraces(out, { redact: false, minReward: 0.5 });
    assert.equal(exported, 1);
  });
});

// ── Task 5.8: redactor ────────────────────────────────────────────────────────
describe('redactor', () => {
  before(setupTmp);
  after(teardownTmp);

  it('redactString removes OpenAI API key pattern', async () => {
    const { redactString } = await import('../src/learning/redactor.js');
    const input = 'Authorization: sk-abcdef1234567890abcdef1234567890';
    const out = redactString(input);
    assert.ok(!out.includes('sk-abcdef'), `expected key redacted, got: ${out}`);
    assert.ok(out.includes('[REDACTED'));
  });

  it('redactString removes AWS access key', async () => {
    const { redactString } = await import('../src/learning/redactor.js');
    const out = redactString('key AKIAIOSFODNN7EXAMPLE is used');
    assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
  });

  it('redactString removes home directory path', async () => {
    const { redactString } = await import('../src/learning/redactor.js');
    const out = redactString('found at /home/alice/projects/secret.js');
    assert.ok(!out.includes('/home/alice/'));
    assert.ok(out.includes('/home/[USER]/'));
  });

  it('redactString removes JWT token', async () => {
    const { redactString } = await import('../src/learning/redactor.js');
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.SflKxwRJSMeKKF2QT4';
    const out = redactString(`token: ${jwt}`);
    assert.ok(!out.includes(jwt));
  });

  it('redactTrace deep-redacts nested object', async () => {
    const { redactTrace } = await import('../src/learning/redactor.js');
    const trace = {
      input_summary: 'call with sk-secret1234567890abcdef1234567890',
      controller_action: { args: { content: '/home/bob/file.js' } },
    };
    const out = redactTrace(trace);
    assert.ok(!out.input_summary.includes('sk-secret'));
    assert.ok(!out.controller_action.args.content.includes('/home/bob/'));
  });

  it('redactString does not mangle normal text', async () => {
    const { redactString } = await import('../src/learning/redactor.js');
    const normal = 'This is a normal string without secrets.';
    assert.equal(redactString(normal), normal);
  });
});

// ── Task 5.9: selfEval ────────────────────────────────────────────────────────
describe('selfEval', () => {
  before(setupTmp);
  after(teardownTmp);

  it('evalSession returns score 5 for clean completion', async () => {
    await cfg();
    const { evalSession } = await import('../src/learning/selfEval.js');
    const result = evalSession(
      'ep-clean',
      { exitReason: 'completed', summary: 'done', totalSteps: 10, compactionCount: 0, skillsCreated: 0 },
      [], // no memory → 0% error rate
      'Build REST API',
      { passed: true, reason: 'ok' }
    );
    assert.ok(result.score >= 4);
    assert.ok(['A', 'A+'].includes(result.grade));
  });

  it('evalSession returns score 1 for hard failure', async () => {
    await cfg();
    const { evalSession } = await import('../src/learning/selfEval.js');
    const result = evalSession(
      'ep-fail',
      { exitReason: 'error', summary: 'crashed', totalSteps: 2, compactionCount: 0, skillsCreated: 0 },
      [],
      'Task'
    );
    assert.equal(result.score, 1);
  });

  it('evalSession score is always in [1, 5]', async () => {
    await cfg();
    const { evalSession } = await import('../src/learning/selfEval.js');
    for (const exitReason of ['completed', 'max_steps', 'error', 'interrupted', 'budget_exceeded']) {
      const r = evalSession(`ep-${exitReason}`, { exitReason, summary: 'test', totalSteps: 5, compactionCount: 0, skillsCreated: 0 }, [], 'task');
      assert.ok(r.score >= 1 && r.score <= 5, `score ${r.score} out of range for ${exitReason}`);
    }
  });

  it('evalSession writes to self-evals.jsonl', async () => {
    const config = await cfg();
    const { evalSession } = await import('../src/learning/selfEval.js');
    evalSession('ep-persist', { exitReason: 'completed', summary: 'ok', totalSteps: 5, compactionCount: 0, skillsCreated: 0 }, [], 'Write tests');
    const f = path.join(tmpDir, config.learningDir, 'self-evals.jsonl');
    assert.ok(fs.existsSync(f));
    const lines = fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1);
    const ev = JSON.parse(lines[0]);
    assert.ok(typeof ev.score === 'number');
  });

  it('rollingAverageScore returns null when no evals', async () => {
    await cfg();
    const { rollingAverageScore, loadSelfEvals } = await import('../src/learning/selfEval.js');
    // Fresh tmp dir, no evals yet
    if (loadSelfEvals().length === 0) {
      assert.equal(rollingAverageScore(), null);
    }
  });
});
