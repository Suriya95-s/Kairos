// tests/hitl.test.js
// Phase 4: Human-in-the-Loop test suite
// Tests: approvalQueue, gateway (detection + timeout + approve), clarificationQueue,
//        steeringChannel, pause/resume, audit log, policy loading.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Test workspace setup ──────────────────────────────────────────────────────
let tmpDir;
let origWorkspace;

function setupTmp() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-hitl-test-'));
  origWorkspace = process.cwd();
  process.chdir(tmpDir);
}

function teardownTmp() {
  process.chdir(origWorkspace);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// We need to reload config with tmpDir as workspace after chdir.
// Since config is a singleton, we patch _workspace on it directly.
async function getModules() {
  const config = (await import('../src/config.js')).default;
  config._workspace = tmpDir;

  const aq = await import('../src/hitl/approvalQueue.js');
  const gw = await import('../src/hitl/gateway.js');
  const steer = await import('../src/hitl/steeringChannel.js');
  const clar = await import('../src/hitl/clarificationQueue.js');
  return { config, aq, gw, steer, clar };
}

// ── Task 4.1: approvalQueue ───────────────────────────────────────────────────
describe('approvalQueue', () => {
  before(setupTmp);
  after(teardownTmp);

  it('enqueue returns a UUID', async () => {
    const { aq } = await getModules();
    const id = aq.enqueue('run_command', { command: 'ls' }, 'test reason', 600000);
    assert.match(id, /^[0-9a-f-]{36}$/);
  });

  it('listPending returns the enqueued request', async () => {
    const { aq } = await getModules();
    const id = aq.enqueue('run_command', { command: 'echo hi' }, 'list test', 600000);
    const pending = aq.listPending();
    assert.ok(pending.some(r => r.id === id));
  });

  it('getRequest returns the request by id', async () => {
    const { aq } = await getModules();
    const id = aq.enqueue('delete_file', { path: 'foo.js' }, 'delete test', 600000);
    const req = aq.getRequest(id);
    assert.equal(req.tool, 'delete_file');
    assert.equal(req.status, 'pending');
  });

  it('writeResponse + getResponse round-trip', async () => {
    const { aq } = await getModules();
    const id = aq.enqueue('run_command', { command: 'rm foo' }, 'approve test', 600000);
    aq.writeResponse(id, true, 'user approved');
    const resp = aq.getResponse(id);
    assert.equal(resp.approved, true);
    assert.equal(resp.reason, 'user approved');
  });

  it('writeResponse marks request as approved', async () => {
    const { aq } = await getModules();
    const id = aq.enqueue('run_command', { command: 'test' }, 'status test', 600000);
    aq.writeResponse(id, true, 'ok');
    const req = aq.getRequest(id);
    assert.equal(req.status, 'approved');
  });

  it('denied response sets status denied', async () => {
    const { aq } = await getModules();
    const id = aq.enqueue('delete_file', { path: 'x.js' }, 'deny test', 600000);
    aq.writeResponse(id, false, 'not now');
    const req = aq.getRequest(id);
    assert.equal(req.status, 'denied');
  });

  it('removeRequest cleans up pending file', async () => {
    const { aq } = await getModules();
    const id = aq.enqueue('run_command', { command: 'test' }, 'remove test', 600000);
    aq.removeRequest(id);
    assert.equal(aq.getRequest(id), null);
  });

  it('getResponse returns null for non-existent id', async () => {
    const { aq } = await getModules();
    assert.equal(aq.getResponse('nonexistent-id'), null);
  });
});

// ── Task 4.2: gateway — action detection ─────────────────────────────────────
describe('gateway — checkRequiresApproval', () => {
  before(setupTmp);
  after(teardownTmp);

  it('safe read_file does not require approval', async () => {
    const { gw } = await getModules();
    const { required } = gw.checkRequiresApproval('read_file', { path: 'README.md' });
    assert.equal(required, false);
  });

  it('delete_file always requires approval', async () => {
    const { gw } = await getModules();
    const { required } = gw.checkRequiresApproval('delete_file', { path: 'important.js' });
    assert.equal(required, true);
  });

  it('rm -rf command requires approval', async () => {
    const { gw } = await getModules();
    const { required } = gw.checkRequiresApproval('run_command', { command: 'rm -rf dist/' });
    assert.equal(required, true);
  });

  it('rm -r command requires approval', async () => {
    const { gw } = await getModules();
    const { required } = gw.checkRequiresApproval('run_command', { command: 'rm -r tmp' });
    assert.equal(required, true);
  });

  it('DROP TABLE requires approval', async () => {
    const { gw } = await getModules();
    const { required } = gw.checkRequiresApproval('run_command', { command: 'DROP TABLE users;' });
    assert.equal(required, true);
  });

  it('safe ls command does not require approval', async () => {
    const { gw } = await getModules();
    const { required } = gw.checkRequiresApproval('run_command', { command: 'ls -la' });
    assert.equal(required, false);
  });

  it('think tool does not require approval', async () => {
    const { gw } = await getModules();
    const { required } = gw.checkRequiresApproval('think', { thought: 'analyzing...' });
    assert.equal(required, false);
  });
});

// ── Task 4.2+4.3: gateway — approve flow ─────────────────────────────────────
describe('gateway — requestApproval (approve path)', () => {
  before(setupTmp);
  after(teardownTmp);

  it('safe action auto-approves without queuing', async () => {
    const { gw } = await getModules();
    const res = await gw.requestApproval('read_file', { path: 'foo.js' }, 'test');
    assert.equal(res.approved, true);
  });

  it('approve flow: write response then requestApproval returns approved', async () => {
    const { gw, aq } = await getModules();
    // Override poll interval to 50ms for test speed
    const origPoll = gw._testSetPollInterval?.(50) || null;

    // Patch hitlPollIntervalMs
    const config = (await import('../src/config.js')).default;
    config._workspace = tmpDir;
    const savedPoll = config.hitlPollIntervalMs;
    config.hitlPollIntervalMs = 50;

    // Start the approval request in background, answer it after 100ms
    let approvalResult = null;
    const approvalPromise = gw.requestApproval('delete_file', { path: 'x.js' }, 'test thought').then(r => { approvalResult = r; });

    // Give the approval queue a moment to enqueue
    await new Promise(r => setTimeout(r, 80));

    // Find the pending request and approve it
    const pending = aq.listPending();
    assert.ok(pending.length >= 1, 'should have a pending request');
    const req = pending[pending.length - 1];
    aq.writeResponse(req.id, true, 'test approval');

    await approvalPromise;
    assert.equal(approvalResult.approved, true);

    config.hitlPollIntervalMs = savedPoll;
  });
});

// ── Task 4.3: gateway — timeout deny ─────────────────────────────────────────
describe('gateway — requestApproval (timeout deny)', () => {
  before(setupTmp);
  after(teardownTmp);

  it('times out and auto-denies after timeoutMs', async () => {
    const config = (await import('../src/config.js')).default;
    config._workspace = tmpDir;
    const savedTimeout = config.hitlTimeoutMs;
    const savedPoll = config.hitlPollIntervalMs;
    config.hitlTimeoutMs = 150;  // 150ms for test
    config.hitlPollIntervalMs = 50;

    const { gw } = await getModules();
    const res = await gw.requestApproval('delete_file', { path: 'gone.js' }, 'timeout test');

    assert.equal(res.approved, false);
    assert.match(res.reason, /[Tt]imeout/);

    config.hitlTimeoutMs = savedTimeout;
    config.hitlPollIntervalMs = savedPoll;
  });
});

// ── Task 4.4: clarificationQueue ─────────────────────────────────────────────
describe('clarificationQueue', () => {
  before(setupTmp);
  after(teardownTmp);

  it('askClarification returns an id and writes to disk', async () => {
    const { clar } = await getModules();
    const id = clar.askClarification('Which database should I use?');
    assert.match(id, /^[0-9a-f-]{36}$/);
    const pending = clar.getPendingClarifications();
    assert.ok(pending.some(c => c.id === id));
  });

  it('answerClarification + consumeAnswers round-trip', async () => {
    const { clar } = await getModules();
    const id = clar.askClarification('Use TypeScript or JavaScript?');
    clar.answerClarification(id, 'TypeScript please');
    const answers = clar.consumeAnswers();
    assert.ok(answers.some(a => a.id === id && a.answer === 'TypeScript please'));
  });

  it('consumeAnswers removes files from disk', async () => {
    const { clar } = await getModules();
    const id = clar.askClarification('Delete old tests?');
    clar.answerClarification(id, 'yes');
    clar.consumeAnswers();
    const pending = clar.getPendingClarifications();
    assert.ok(!pending.some(c => c.id === id));
  });

  it('answered clarification no longer appears in getPendingClarifications', async () => {
    const { clar } = await getModules();
    const id = clar.askClarification('Which port?');
    const beforeAnswer = clar.getPendingClarifications();
    assert.ok(beforeAnswer.some(c => c.id === id));
    clar.answerClarification(id, '3000');
    const afterAnswer = clar.getPendingClarifications();
    assert.ok(!afterAnswer.some(c => c.id === id));
  });

  it('answerClarification throws for unknown id', async () => {
    const { clar } = await getModules();
    assert.throws(() => clar.answerClarification('nonexistent', 'answer'), /No clarification/);
  });
});

// ── Task 4.5: steeringChannel ────────────────────────────────────────────────
describe('steeringChannel', () => {
  before(setupTmp);
  after(teardownTmp);

  it('addSteeringMessage returns an id and persists to disk', async () => {
    const { steer } = await getModules();
    const id = steer.addSteeringMessage('Focus on tests first');
    assert.match(id, /^[0-9a-f-]{36}$/);
    const msgs = steer.listSteering();
    assert.ok(msgs.some(m => m.id === id));
  });

  it('consumeSteering returns messages in order and deletes them', async () => {
    const { steer } = await getModules();
    // Ensure deterministic timestamps with small delays
    steer.addSteeringMessage('first');
    await new Promise(r => setTimeout(r, 5));
    steer.addSteeringMessage('second');
    const msgs = steer.consumeSteering();
    assert.ok(msgs.includes('first'));
    assert.ok(msgs.includes('second'));
    assert.ok(msgs.indexOf('first') < msgs.indexOf('second'));
    // Messages should be gone
    assert.equal(steer.consumeSteering().length, 0);
  });

  it('listSteering does not consume messages', async () => {
    const { steer } = await getModules();
    steer.addSteeringMessage('persisted');
    steer.listSteering();
    steer.listSteering();
    assert.equal(steer.consumeSteering().length, 1);
  });
});

// ── Task 4.12: pause / resume ────────────────────────────────────────────────
describe('pause / resume', () => {
  before(setupTmp);
  after(teardownTmp);

  it('isPaused returns false initially', async () => {
    const { gw } = await getModules();
    assert.equal(gw.isPaused(), false);
  });

  it('pause() makes isPaused() return true', async () => {
    const { gw } = await getModules();
    gw.pause();
    assert.equal(gw.isPaused(), true);
  });

  it('resume() makes isPaused() return false', async () => {
    const { gw } = await getModules();
    gw.pause();
    gw.resume();
    assert.equal(gw.isPaused(), false);
  });

  it('resume() is idempotent when not paused', async () => {
    const { gw } = await getModules();
    gw.resume(); // should not throw
    assert.equal(gw.isPaused(), false);
  });

  it('paused flag survives process restart simulation (reads from disk)', async () => {
    const { gw, config } = await getModules();
    gw.pause();
    // Simulate "restart" by re-importing (same module cache, but file stays)
    const { isPaused: isPaused2 } = await import('../src/hitl/gateway.js');
    assert.equal(isPaused2(), true);
    gw.resume();
  });
});

// ── Task 4.14: audit log ─────────────────────────────────────────────────────
describe('audit log', () => {
  before(setupTmp);
  after(teardownTmp);

  it('appendAudit writes a JSONL line', async () => {
    const { gw, config } = await getModules();
    gw.appendAudit({ type: 'test_event', detail: 'hello' });
    const auditPath = path.join(tmpDir, config.hitlAuditFile);
    assert.ok(fs.existsSync(auditPath));
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.type, 'test_event');
    assert.equal(last.detail, 'hello');
  });

  it('audit log appends (does not overwrite)', async () => {
    const { gw, config } = await getModules();
    gw.appendAudit({ type: 'event_a' });
    gw.appendAudit({ type: 'event_b' });
    const auditPath = path.join(tmpDir, config.hitlAuditFile);
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
    const types = lines.map(l => JSON.parse(l).type);
    assert.ok(types.includes('event_a'));
    assert.ok(types.includes('event_b'));
  });

  it('pause() writes to audit log', async () => {
    const { gw, config } = await getModules();
    gw.pause();
    const auditPath = path.join(tmpDir, config.hitlAuditFile);
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.ok(lines.some(l => JSON.parse(l).type === 'paused'));
    gw.resume();
  });
});

// ── Task 4.13: policy loading ─────────────────────────────────────────────────
describe('policy file loading', () => {
  before(setupTmp);
  after(teardownTmp);

  it('auto_approve rule works for a reversible tool', async () => {
    // Policy auto_approve still reduces friction — for anything that can be
    // taken back. `webfetch` is T2: external, but harmless to repeat.
    const { config } = await getModules();
    const policyPath = path.join(tmpDir, config.hitlPolicyFile);
    fs.writeFileSync(policyPath, JSON.stringify({
      rules: [{ tool: 'webfetch', auto_approve: true, reason: 'test' }]
    }));
    const gw = await import('../src/hitl/gateway.js');
    assert.equal(gw.checkRequiresApproval('webfetch', { url: 'https://x' }).required, false);
  });

  it('auto_approve CANNOT bypass the gate on an irreversible tool', async () => {
    // CHANGED IN PHASE 7, deliberately. This test previously asserted the
    // opposite: that `auto_approve: true` on `delete_file` disabled the
    // destructive check. That was the old ordering — policy was consulted
    // first, so a single line in a config file switched off the strongest
    // protection in the system, and a prompt-injected agent that could write
    // that file could switch it off for itself.
    //
    // `delete_file` is now T3, and T3 short-circuits before the policy is read.
    // Policy can still lower friction for T0–T2; it can no longer authorise
    // something that cannot be undone. See the P7 acceptance criterion:
    // "a hostile mission cannot email, purchase, or delete without a gate".
    const { config } = await getModules();
    const policyPath = path.join(tmpDir, config.hitlPolicyFile);
    fs.writeFileSync(policyPath, JSON.stringify({
      rules: [{ tool: 'delete_file', auto_approve: true, reason: 'attempted bypass' }]
    }));
    const gw = await import('../src/hitl/gateway.js');
    const decision = gw.checkRequiresApproval('delete_file', { path: 'x.js' });
    assert.equal(decision.required, true, 'a policy file must not be able to authorise a delete');
    assert.equal(decision.tier, 'T3');
  });

  it('require_approval rule enforces approval on safe tools', async () => {
    const { config } = await getModules();
    const policyPath = path.join(tmpDir, config.hitlPolicyFile);
    fs.writeFileSync(policyPath, JSON.stringify({
      rules: [{ tool: 'read_file', require_approval: true, reason: 'paranoid mode' }]
    }));
    const gw = await import('../src/hitl/gateway.js');
    const { required } = gw.checkRequiresApproval('read_file', { path: 'secret.md' });
    assert.equal(required, true);
  });
});

// ── Task 4.15: episodic writes (smoke test) ───────────────────────────────────
describe('episodic writes on HITL events', () => {
  before(setupTmp);
  after(teardownTmp);

  it('requestApproval completes without throwing when palace disabled', async () => {
    const { gw, config } = await getModules();
    // Ensure palace disabled (default in tests)
    assert.equal(config.palaceEnabled, false);
    // Safe action — should resolve immediately
    const res = await gw.requestApproval('read_file', { path: 'foo.js' }, 'smoke test');
    assert.equal(res.approved, true);
  });
});

// ── Wave C-4: pause deadline + non-retryable LLM errors ──────────────────────
describe('pauseAgeMs (Wave C-4)', () => {
  before(setupTmp);
  after(teardownTmp);

  it('returns 0 when not paused', async () => {
    const { gw } = await getModules();
    assert.equal(gw.pauseAgeMs(), 0);
  });

  it('returns a positive age after pause()', async () => {
    const { gw } = await getModules();
    gw.pause();
    const age = gw.pauseAgeMs();
    assert.ok(age >= 0, `age ${age} should be ≥ 0`);
    gw.resume();
    assert.equal(gw.pauseAgeMs(), 0, 'age should be 0 after resume');
  });
});
