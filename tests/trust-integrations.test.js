// tests/trust-integrations.test.js
// 7.4 — graduated capability, and the plan's "email (draft-only first)".
//
// Tiers answer "how much confirmation does this need". Stages answer a different
// question: "is this capability switched on at all". Conflating them is how the
// first day of an email integration becomes the day it sends something, so the
// tests here are mostly about the boundary being *hard* rather than a prompt.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  IntegrationRegistry, INTEGRATIONS, STAGES, stageRank, auditServerTools,
  resetIntegrationRegistry,
} from '../src/trust/integrations.js';
import { checkRequiresApproval } from '../src/hitl/gateway.js';
import { classify } from '../src/trust/tiers.js';

let tmp;
let clock;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-integ-'));
  process.env.KAIROS_HOME = tmp;
  clock = 1_700_000_000_000;
  resetIntegrationRegistry();
});

afterEach(() => {
  resetIntegrationRegistry();
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const reg = () => new IntegrationRegistry({ filePath: path.join(tmp, 'integrations.json'), now: () => clock });

describe('everything starts off', () => {
  test('no capability is enabled by default', () => {
    // Enabling a real-world capability is a decision, so it has no default.
    const r = reg();
    for (const capability of Object.keys(INTEGRATIONS)) {
      assert.equal(r.stageOf(capability), 'off', `${capability} must start off`);
    }
  });

  test('even READING is blocked while a capability is off', () => {
    // "Off" means off. A half-configured integration should not be quietly
    // listing someone's inbox.
    const r = reg();
    assert.equal(r.check('gmail__list_messages').allowed, false);
    assert.equal(r.check('gcal__get_events').allowed, false);
  });

  test('an unmanaged tool is unaffected — this layer has no opinion on those', () => {
    const r = reg();
    for (const tool of ['write_file', 'run_command', 'read_file']) {
      assert.equal(r.check(tool).allowed, true);
    }
    // Nor on an MCP server that is not one of the managed classes.
    assert.equal(r.check('sqlite__query').allowed, true);
  });
});

describe('email is draft-only first (the plan\'s wording, made mechanical)', () => {
  test('at "draft", drafting works and sending does NOT', () => {
    const r = reg();
    r.setStage('email', 'draft');

    assert.equal(r.check('gmail__create_draft').allowed, true);
    assert.equal(r.check('gmail__list_messages').allowed, true);

    const send = r.check('gmail__send_email');
    assert.equal(send.allowed, false);
    assert.equal(send.needsStage, 'full');
    assert.match(send.reason, /drafting is allowed, sending is not/);
  });

  test('every send-shaped verb is caught, not just the obvious one', () => {
    const r = reg();
    r.setStage('email', 'draft');
    for (const tool of ['gmail__send', 'gmail__send_email', 'mail__reply_to', 'mail__forward_message']) {
      assert.equal(r.check(tool).allowed, false, `${tool} must not be reachable at draft`);
    }
  });

  test('advancing to full enables sending', () => {
    const r = reg();
    r.setStage('email', 'full');
    assert.equal(r.check('gmail__send_email').allowed, true);
  });

  test('the refusal says exactly how to enable it', () => {
    // A gate that blocks without saying what to do gets worked around.
    const r = reg();
    r.setStage('email', 'draft');
    assert.match(r.check('gmail__send_email').reason, /Advance to "full"/);
  });
});

describe('the stage boundary is hard, not a prompt', () => {
  test('a blocked call is DENIED by the gate, and marked blocked', () => {
    // Not "ask the user" — asking is how a half-configured integration gets
    // approved at 2am by someone who assumes the system knows better.
    const d = checkRequiresApproval('gmail__send_email', { to: 'x@y.z' });
    assert.equal(d.required, true);
    assert.equal(d.blocked, true);
    assert.equal(d.grant, 'blocked');
    assert.match(d.reason, /not enabled/);
  });

  test('the stage check runs BEFORE the tier, policy and standing approvals', () => {
    // Ordering is the guarantee. If policy ran first, an auto_approve rule
    // could reach a capability that is switched off.
    const src = fs.readFileSync(new URL('../src/hitl/gateway.js', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('export function checkRequiresApproval'));
    const stageIdx = body.indexOf('checkIntegrationStage(tool)');
    const tierIdx = body.indexOf("atLeastTier(tier, 'T3')");
    const policyIdx = body.indexOf('loadPolicy()');
    const standingIdx = body.indexOf('findStandingApproval');

    assert.ok(stageIdx > 0);
    assert.ok(stageIdx < tierIdx, 'stage must precede the T3 short-circuit');
    assert.ok(stageIdx < policyIdx, 'stage must precede the policy file');
    assert.ok(stageIdx < standingIdx, 'stage must precede standing approvals');
  });

  test('a standing approval cannot reach a disabled capability', () => {
    // The two mechanisms are orthogonal on purpose: permission to skip the
    // prompt is not permission to use a capability that is off.
    const d = checkRequiresApproval('gcal__create_event', {});
    assert.equal(d.blocked, true, 'still blocked regardless of any grant');
  });

  test('an unreadable registry fails CLOSED for managed tools', () => {
    // If we cannot tell whether email sending was enabled, the answer is no.
    fs.writeFileSync(path.join(tmp, 'integrations.json'), '{"stages":');
    resetIntegrationRegistry();
    const d = checkRequiresApproval('gmail__send_email', {});
    assert.equal(d.required, true);
  });
});

describe('stages and their ordering', () => {
  test('the plan\'s ordering is encoded', () => {
    const order = Object.entries(INTEGRATIONS)
      .sort((a, b) => a[1].order - b[1].order)
      .map(([k]) => k);
    assert.deepEqual(order, ['calendar', 'email', 'messaging', 'browser', 'devices']);
  });

  test('an unrecognised stage ranks as the MOST restrictive', () => {
    // A typo in a state file must not switch a capability on.
    assert.equal(stageRank('typo'), 0);
    assert.equal(stageRank('off'), 0);
    assert.ok(stageRank('full') > stageRank('draft'));
  });

  test('skipping a stage is allowed but recorded', () => {
    // off → full skips the stage where you would have discovered the server
    // names its tools something unexpected.
    const r = reg();
    const res = r.setStage('email', 'full');
    assert.equal(res.jumped, true);
    assert.equal(r.list().find(i => i.capability === 'email').jumped, true);
  });

  test('a one-step advance is not flagged', () => {
    const r = reg();
    r.setStage('email', 'read');
    assert.equal(r.setStage('email', 'draft').jumped, false);
  });

  test('who changed a stage is recorded — this is the audit trail', () => {
    const audits = [];
    const r = new IntegrationRegistry({
      filePath: path.join(tmp, 'i.json'), now: () => clock,
      onAudit: (e) => audits.push(e),
    });
    r.setStage('email', 'full', { by: 'cli', reason: 'I trust it now' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].to, 'full');
    assert.equal(audits[0].by, 'cli');
  });

  test('stages persist across a restart', () => {
    reg().setStage('calendar', 'draft');
    assert.equal(reg().stageOf('calendar'), 'draft');
  });

  test('unknown capabilities and stages are rejected', () => {
    const r = reg();
    assert.throws(() => r.setStage('telepathy', 'full'), /unknown capability/);
    assert.throws(() => r.setStage('email', 'maximum'), /unknown stage/);
    for (const s of STAGES) assert.doesNotThrow(() => r.setStage('email', s));
  });

  test('capabilities can be turned back off', () => {
    const r = reg();
    r.setStage('email', 'full');
    r.setStage('email', 'off');
    assert.equal(r.check('gmail__send_email').allowed, false);
  });
});

describe('capability detection', () => {
  test('a server name maps to its capability class', () => {
    const r = reg();
    assert.equal(r.capabilityOf('gmail__send'), 'email');
    assert.equal(r.capabilityOf('gcal__create_event'), 'calendar');
    assert.equal(r.capabilityOf('slack__post_message'), 'messaging');
    assert.equal(r.capabilityOf('playwright__click'), 'browser');
    assert.equal(r.capabilityOf('homeassistant__turn_on'), 'devices');
  });

  test('an unrelated server is not captured by any class', () => {
    const r = reg();
    assert.equal(r.capabilityOf('github__create_issue'), null);
    assert.equal(r.capabilityOf('write_file'), null);
  });

  test('an unrecognised verb requires the FULL stage', () => {
    // An unanticipated verb on an email server is likelier to be `send_now`
    // than `list_folders`, so it is treated as the most capable thing.
    const r = reg();
    r.setStage('email', 'draft');
    const res = r.check('gmail__blast_everyone');
    assert.equal(res.allowed, false);
    assert.equal(res.needsStage, 'full');
    assert.match(res.reason, /not a verb the email integration recognises/);
  });

  test('devices have no draft stage — a light is either switched or it is not', () => {
    const r = reg();
    r.setStage('devices', 'draft');
    assert.equal(r.check('hue__turn_on_light').allowed, false, 'acting needs full');
    r.setStage('devices', 'full');
    assert.equal(r.check('hue__turn_on_light').allowed, true);
  });
});

describe('auditing a server before trusting it', () => {
  test('it reports each tool\'s tier and reachability', () => {
    const r = reg();
    r.setStage('calendar', 'draft');
    const { tools } = auditServerTools(
      ['gcal__list_events', 'gcal__create_event', 'gcal__delete_event'], r, { classify });

    const byName = Object.fromEntries(tools.map(t => [t.tool, t]));
    assert.equal(byName['gcal__list_events'].allowed, true);
    assert.equal(byName['gcal__create_event'].allowed, true);
    assert.equal(byName['gcal__delete_event'].allowed, false, 'delete needs full');
    assert.equal(byName['gcal__delete_event'].tier, 'T3');
  });

  test('it warns about tools the tier heuristics could NOT place', () => {
    // The heuristics are guesses about naming conventions. A server that calls
    // its delete `cleanup` is exactly where a wrong guess is dangerous, and
    // reading a warning beats finding out because something got cleaned up.
    const r = reg();
    const { warnings } = auditServerTools(['gcal__frobnicate'], r, { classify });
    assert.ok(warnings.some(w => /unrecognised verb/.test(w)));
    assert.ok(warnings.some(w => /Confirm what it does/.test(w)));
  });

  test('it flags a reachable irreversible tool', () => {
    const r = reg();
    r.setStage('calendar', 'full');
    const { warnings } = auditServerTools(['gcal__delete_event'], r, { classify });
    assert.ok(warnings.some(w => /irreversible \(T3\)/.test(w)));
    assert.ok(warnings.some(w => /confirmed every time/.test(w)));
  });

  test('a clean server produces no warnings', () => {
    const r = reg();
    r.setStage('calendar', 'read');
    const { warnings } = auditServerTools(['gcal__list_events', 'gcal__get_event'], r, { classify });
    assert.deepEqual(warnings, []);
  });
});

describe('the calendar-first path works end to end', () => {
  test('enable calendar to draft: read and create work, delete does not', () => {
    // The plan puts calendar first because its mistakes are visible and
    // reversible. This is the sequence a user would actually run.
    const r = reg();
    assert.equal(r.check('gcal__create_event').allowed, false, 'off by default');

    r.setStage('calendar', 'read');
    assert.equal(r.check('gcal__list_events').allowed, true);
    assert.equal(r.check('gcal__create_event').allowed, false);

    r.setStage('calendar', 'draft');
    assert.equal(r.check('gcal__create_event').allowed, true);
    assert.equal(r.check('gcal__delete_event').allowed, false);

    // And enabling calendar does not enable anything else.
    assert.equal(r.check('gmail__create_draft').allowed, false);
    assert.equal(r.check('slack__send_message').allowed, false);
  });

  test('a reachable calendar create is still gated by its tier', () => {
    // Stages and tiers are independent: reachable does not mean unconfirmed.
    reg().setStage('calendar', 'draft');
    resetIntegrationRegistry();
    const d = checkRequiresApproval('gcal__create_event', {});
    assert.equal(d.blocked, undefined, 'no longer blocked by stage');
    assert.equal(d.required, true, 'but still confirmed as a T2 action');
    assert.equal(d.tier, 'T2');
  });
});
