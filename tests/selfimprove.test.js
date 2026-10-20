// tests/selfimprove.test.js
// Phase 9 — closing the self-improvement loop, and the 8.4 web surface.
//
// The Phase 9 acceptance criterion is unusually blunt:
//
//   month-over-month: guard-fire rate down, reflex accuracy up, cost per
//   mission down — measured by 9.2, NOT VIBES.
//
// So the tests here are mostly about refusing to claim improvement. A
// self-improvement loop that grades its own homework generously is worse than
// none: it produces confident weekly reports while everything gets slower.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  measureRouter, proposeFixtures, renderFixtureProposals, recordCorrection,
} from '../src/selfimprove/router-training.js';
import {
  collect, compare, regressions, renderDigest, TRACKED, DIRECTION, MIN_SAMPLE,
} from '../src/selfimprove/metrics.js';
import { evaluate, applyPromotions, renderPromotions, PROMOTION } from '../src/selfimprove/promotion.js';
import { StandingApprovals } from '../src/trust/approvals.js';
import { ActuationLedger } from '../src/trust/ledger.js';
import { WEB_CLIENT_HTML, webClientUrl } from '../src/kernel/webclient.js';

let tmp;
let clock;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-si-'));
  process.env.KAIROS_HOME = tmp;
  clock = 1_700_000_000_000;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const routerDir = () => path.join(tmp, 'router');
const days = (n) => n * 86_400_000;

/** Write decision-log rows directly. */
function seedDecisions(rows) {
  fs.mkdirSync(routerDir(), { recursive: true });
  fs.appendFileSync(path.join(routerDir(), 'decisions.jsonl'),
    rows.map(r => JSON.stringify({ ts: clock, method: 'keyword', confidence: 0.8, ...r })).join('\n') + '\n');
}

// ── 9.1 ─────────────────────────────────────────────────────────────────────

describe('router training (9.1)', () => {
  test('silence is NOT counted as agreement', () => {
    // The single most important property. If uncorrected decisions counted as
    // correct, this would report 99% accuracy forever and mean nothing.
    seedDecisions([
      { text: 'a', intent: 'reflex' },
      { text: 'b', intent: 'mission' },
      { text: 'c', intent: 'reflex', corrected: 'mission' },
    ]);
    const r = measureRouter({ dir: routerDir() });
    assert.equal(r.total, 3);
    assert.equal(r.judged, 1, 'only the one a human touched');
    assert.equal(r.accuracy, 0, 'and it was wrong');
  });

  test('accuracy is null with nothing judged, not 1.0', () => {
    // A figure computed from zero samples looks like evidence.
    seedDecisions([{ text: 'a', intent: 'reflex' }]);
    assert.equal(measureRouter({ dir: routerDir() }).accuracy, null);
  });

  test('a confirmation counts as correct', () => {
    seedDecisions([
      { text: 'a', intent: 'reflex', corrected: 'reflex' },
      { text: 'b', intent: 'mission', corrected: 'reflex' },
    ]);
    const r = measureRouter({ dir: routerDir() });
    assert.equal(r.judged, 2);
    assert.equal(r.accuracy, 0.5);
  });

  test('the confusion map shows WHICH way the mistakes go', () => {
    // "reflex→mission" wastes twenty minutes; "mission→reflex" wastes a
    // sentence. Collapsing them into one error rate hides that.
    seedDecisions([
      { text: 'a', intent: 'reflex', corrected: 'mission' },
      { text: 'b', intent: 'reflex', corrected: 'mission' },
      { text: 'c', intent: 'mission', corrected: 'reflex' },
    ]);
    const r = measureRouter({ dir: routerDir() });
    assert.equal(r.confusion['reflex→mission'], 2);
    assert.equal(r.confusion['mission→reflex'], 1);
  });

  test('the model-fallback rate is tracked — it means the keywords are behind', () => {
    seedDecisions([
      { text: 'a', intent: 'reflex', method: 'keyword' },
      { text: 'b', intent: 'reflex', method: 'llm' },
    ]);
    assert.equal(measureRouter({ dir: routerDir() }).llmFallbackRate, 0.5);
  });

  test('proposals come only from cases the classifier STILL gets wrong', () => {
    // A fixture that passes on the day it is added never catches anything.
    seedDecisions([
      { text: 'build a REST API with Express', intent: 'reflex', corrected: 'mission' },  // already fixed
      { text: 'the widget situation needs sorting', intent: 'reflex', corrected: 'mission' },
    ]);
    const proposals = proposeFixtures({ dir: routerDir() });
    assert.ok(!proposals.some(p => /REST API/.test(p.text)), 'the classifier gets this right now');
    assert.ok(proposals.some(p => /widget/.test(p.text)));
  });

  test('repeated mistakes become ONE proposal with a count', () => {
    seedDecisions(Array.from({ length: 7 }, () => (
      { text: 'the widget situation needs sorting', intent: 'reflex', corrected: 'mission' })));
    const proposals = proposeFixtures({ dir: routerDir() });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].seen, 7);
    assert.match(proposals[0].note, /corrected 7×/);
  });

  test('proposals are ordered by how often the mistake happens', () => {
    seedDecisions([
      ...Array.from({ length: 2 }, () => ({ text: 'alpha widget thing', intent: 'reflex', corrected: 'mission' })),
      ...Array.from({ length: 9 }, () => ({ text: 'beta widget thing', intent: 'reflex', corrected: 'mission' })),
    ]);
    const proposals = proposeFixtures({ dir: routerDir() });
    assert.match(proposals[0].text, /beta/);
  });

  test('cases already in the fixture set are not re-proposed', () => {
    seedDecisions([{ text: 'the widget situation needs sorting', intent: 'reflex', corrected: 'mission' }]);
    const proposals = proposeFixtures({
      dir: routerDir(),
      existing: [{ text: 'The Widget Situation Needs Sorting!' }],   // normalised match
    });
    assert.deepEqual(proposals, []);
  });

  test('the output is a fragment to paste, not a patch to apply', () => {
    // Writing into the fixture set directly would mean the thing being
    // measured edits its own exam.
    seedDecisions([{ text: 'the widget situation needs sorting', intent: 'reflex', corrected: 'mission' }]);
    const text = renderFixtureProposals(proposeFixtures({ dir: routerDir() }));
    assert.match(text, /Review each one/);
    assert.match(text, /intent: 'mission'/);
    assert.equal(renderFixtureProposals([]), '');
  });

  test('a correction is APPENDED, never an edit of the original decision', () => {
    // "The router said X" and "a human said Y" are two facts. Collapsing them
    // loses the one that matters.
    seedDecisions([{ text: 'do the thing', intent: 'reflex' }]);
    recordCorrection({ text: 'do the thing', was: 'reflex', corrected: 'mission', dir: routerDir() });

    const lines = fs.readFileSync(path.join(routerDir(), 'decisions.jsonl'), 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).corrected, undefined, 'the original is untouched');
    assert.equal(JSON.parse(lines[1]).corrected, 'mission');
  });

  test('a correction to an unknown intent is rejected', () => {
    assert.throws(() => recordCorrection({ text: 'x', was: 'reflex', corrected: 'telepathy' }), /unknown intent/);
  });
});

// ── 9.2 / 9.4 ───────────────────────────────────────────────────────────────

describe('self-measurement (9.2)', () => {
  function fakeMissions(list) { return { list: () => list }; }
  function mission(over = {}) {
    return {
      id: 'm', state: 'done', exitReason: 'completed', endedAt: clock, lastStep: 50,
      result: { costUsd: 0.10, guardFires: 1 }, ...over,
    };
  }

  test('metrics come from records the system already keeps', () => {
    const ledger = new ActuationLedger({ dirPath: path.join(tmp, 'audit'), now: () => clock });
    ledger.record({ tool: 'mail__send_email', args: {}, outcome: 'ok', result: { messageId: 'x' } });
    ledger.record({ tool: 'shop__purchase', args: {}, outcome: 'refused', grant: 'denied' });

    const m = collect({ missions: fakeMissions([mission(), mission({ state: 'failed', exitReason: 'error' })]), ledger },
      { from: 0, to: clock + 1 });

    assert.equal(m.missions, 2);
    assert.equal(m.missionSuccessRate, 0.5);
    assert.equal(m.costPerMission, 0.1);
    assert.equal(m.guardFireRate, 0.02, '2 guard fires over 100 steps');
    assert.equal(m.irreversibleActions, 1);
    assert.equal(m.refusedActions, 1);
  });

  test('an empty period yields nulls, not zeros', () => {
    // A zero success rate and "no missions ran" are different facts.
    const m = collect({ missions: fakeMissions([]) }, { from: 0, to: clock });
    assert.equal(m.missions, 0);
    assert.equal(m.missionSuccessRate, null);
    assert.equal(m.costPerMission, null);
  });

  test('a thin sample refuses to produce a trend', () => {
    // "Cost per mission down 40%" across two weeks of two missions each is
    // noise reported as progress.
    const prev = collect({ missions: fakeMissions([mission()]) }, { from: 0, to: clock + 1 });
    const cur = collect({ missions: fakeMissions([mission({ result: { costUsd: 0.01, guardFires: 0 } })]) }, { from: 0, to: clock + 1 });
    const c = compare(prev, cur);

    assert.equal(c.verdicts.costPerMission.verdict, 'insufficient-data');
    assert.match(c.sampleWarning, /sample too small/);
    assert.match(c.verdicts.costPerMission.reason, /would be noise/);
  });

  test('with enough data, a real improvement is recognised', () => {
    const many = (cost, guards) => Array.from({ length: 10 }, () => mission({ result: { costUsd: cost, guardFires: guards } }));
    const prev = collect({ missions: fakeMissions(many(0.20, 3)) }, { from: 0, to: clock + 1 });
    const cur = collect({ missions: fakeMissions(many(0.10, 1)) }, { from: 0, to: clock + 1 });
    const c = compare(prev, cur);

    assert.equal(c.verdicts.costPerMission.verdict, 'better');
    assert.equal(c.verdicts.guardFireRate.verdict, 'better');
    assert.equal(c.headline.costPerMission, 'better');
  });

  test('a regression is called a regression', () => {
    const many = (cost) => Array.from({ length: 10 }, () => mission({ result: { costUsd: cost, guardFires: 1 } }));
    const c = compare(
      collect({ missions: fakeMissions(many(0.10)) }, { from: 0, to: clock + 1 }),
      collect({ missions: fakeMissions(many(0.30)) }, { from: 0, to: clock + 1 }),
    );
    assert.equal(c.verdicts.costPerMission.verdict, 'worse');
    const regs = regressions(c);
    assert.equal(regs.length, 1);
    assert.equal(regs[0].metric, 'costPerMission');
  });

  test('a 1% wobble is not a trend', () => {
    const many = (cost) => Array.from({ length: 10 }, () => mission({ result: { costUsd: cost, guardFires: 1 } }));
    const c = compare(
      collect({ missions: fakeMissions(many(0.100)) }, { from: 0, to: clock + 1 }),
      collect({ missions: fakeMissions(many(0.101)) }, { from: 0, to: clock + 1 }),
    );
    assert.equal(c.verdicts.costPerMission.verdict, 'flat');
  });

  test('"insufficient data" is never counted as a regression', () => {
    // "We do not know" is not bad news, and alarming on it would train the
    // user to ignore the alarm.
    const c = compare({ missions: 1 }, { missions: 1 });
    assert.deepEqual(regressions(c), []);
  });

  test('the three metrics the AC names are surfaced separately', () => {
    // So a regression in one cannot hide behind improvement in the others.
    const c = compare({ missions: 10 }, { missions: 10 });
    assert.deepEqual(Object.keys(c.headline).sort(), ['costPerMission', 'guardFireRate', 'routerAccuracy']);
  });

  test('every tracked metric declares which direction is good', () => {
    for (const key of TRACKED) {
      assert.ok(['up', 'down', 'neutral'].includes(DIRECTION[key]), `${key} has no declared direction`);
    }
    assert.ok(MIN_SAMPLE >= 3);
  });
});

describe('the weekly digest (9.4)', () => {
  const base = {
    missions: 12, missionSuccessRate: 0.75, costUsd: 3.4, costPerMission: 0.28,
    guardFireRate: 0.02, irreversibleActions: 0, refusedActions: 0,
    exitReasons: { completed: 9, max_steps: 2, repair_stalled: 1 },
  };

  test('a quiet week says so briefly', () => {
    const text = renderDigest({ missions: 0 });
    assert.match(text, /No missions ran/);
    assert.ok(text.split('\n').length < 5, 'a quiet week should not produce a page');
  });

  test('irreversible actions are surfaced prominently, always', () => {
    // The thing a person most wants to know happened. Burying it under counts
    // is how a digest becomes something to skim.
    const text = renderDigest({ ...base, irreversibleActions: 3 });
    assert.match(text, /3 irreversible actions were taken/);
  });

  test('refusals are reported too', () => {
    assert.match(renderDigest({ ...base, refusedActions: 1 }), /1 action was refused at the gate/);
  });

  test('the digest leads with what got WORSE', () => {
    const c = compare(
      { missions: 10, costPerMission: 0.10, guardFireRate: 0.01, missionSuccessRate: 0.9 },
      { missions: 10, costPerMission: 0.30, guardFireRate: 0.01, missionSuccessRate: 0.9 },
    );
    const text = renderDigest(base, c);
    assert.match(text, /Getting worse:/);
    assert.match(text, /cost per mission/);
  });

  test('a thin sample is stated rather than dressed up as a trend', () => {
    const c = compare({ missions: 2 }, { missions: 3 });
    assert.match(renderDigest(base, c), /sample too small/);
  });

  test('unfinished work is listed', () => {
    assert.match(renderDigest(base), /2 max_steps/);
  });

  test('a steady week says steady, not "improving"', () => {
    const c = compare({ missions: 10, costPerMission: 0.1 }, { missions: 10, costPerMission: 0.1 });
    assert.match(renderDigest(base, c), /Steady/);
  });
});

// ── 9.3 ─────────────────────────────────────────────────────────────────────

describe('skill promotion (9.3)', () => {
  const approvals = () => new StandingApprovals({ filePath: path.join(tmp, 'sa.json'), now: () => clock });
  const proven = (over = {}) => ({
    name: 'create-calendar-event', tool: 'gcal__create_event',
    uses: 25, failures: 0, lastUsedAt: clock, ...over,
  });

  test('a proven skill stops asking permission', () => {
    const d = evaluate(proven(), { now: clock });
    assert.equal(d.promote, true);
    assert.match(d.reason, /25 successes/);
  });

  test('an unproven skill is not promoted, and says how far off it is', () => {
    const d = evaluate(proven({ uses: 5 }), { now: clock });
    assert.equal(d.promote, false);
    assert.match(d.reason, /5\/20 uses/);
  });

  test('a T3 skill can NEVER be promoted, however good its record', () => {
    // Twenty successful deletions is not evidence that the twenty-first is
    // wanted. Same rule as standing approvals.
    const d = evaluate(proven({ name: 'purge', tool: 'storage__purge_bucket', uses: 1000, failures: 0 }), { now: clock });
    assert.equal(d.promote, false);
    assert.equal(d.blocked, true);
    assert.match(d.reason, /confirmed every time/);
  });

  test('one recent failure demotes immediately', () => {
    // Trust is asymmetric: slow to earn, fast to lose, because the costs of
    // the two mistakes are not symmetric.
    const d = evaluate(proven({ failures: 1, lastFailureAt: clock - days(2) }), { now: clock });
    assert.equal(d.promote, false);
    assert.equal(d.demote, true);
    assert.match(d.reason, /failed within the last week/);
  });

  test('an old failure does not block a since-proven skill', () => {
    const d = evaluate(proven({ uses: 40, failures: 1, lastFailureAt: clock - days(120) }), { now: clock });
    assert.equal(d.promote, true);
  });

  test('a long-unused skill goes stale', () => {
    const d = evaluate(proven({ lastUsedAt: clock - days(200) }), { now: clock });
    assert.equal(d.promote, false);
    assert.equal(d.demote, true);
  });

  test('promotion produces a SCOPED, time-boxed standing approval', () => {
    // "This skill worked, so allow this tool anywhere forever" is a much larger
    // claim than the evidence supports.
    const sa = approvals();
    const res = applyPromotions([proven({ workspace: '/tmp/proj' })], sa, { now: clock });

    assert.equal(res.promoted.length, 1);
    const [grant] = sa.list();
    assert.equal(grant.workspace, '/tmp/proj');
    assert.ok(grant.expiresAt > clock, 'a track record goes stale, so the grant does too');
    assert.match(grant.reason, /^promoted:/);
  });

  test('promotion never grants something the tier forbids', () => {
    const sa = approvals();
    const res = applyPromotions([proven({ name: 'nuke', tool: 'delete_path', uses: 500 })], sa, { now: clock });
    assert.equal(res.promoted.length, 0);
    assert.deepEqual(sa.list(), []);
  });

  test('demotion revokes the grant it previously earned', () => {
    const sa = approvals();
    applyPromotions([proven()], sa, { now: clock });
    assert.equal(sa.list().length, 1);

    const res = applyPromotions([proven({ failures: 1, lastFailureAt: clock })], sa, { now: clock });
    assert.equal(res.demoted.length, 1);
    assert.deepEqual(sa.list(), []);
  });

  test('promoting twice is a no-op', () => {
    const sa = approvals();
    applyPromotions([proven()], sa, { now: clock });
    const res = applyPromotions([proven()], sa, { now: clock });
    assert.equal(res.promoted.length, 0);
    assert.equal(res.skipped[0].reason, 'already promoted');
    assert.equal(sa.list().length, 1);
  });

  test('dryRun changes nothing', () => {
    const sa = approvals();
    const res = applyPromotions([proven()], sa, { now: clock, dryRun: true });
    assert.equal(res.promoted.length, 1);
    assert.deepEqual(sa.list(), []);
  });

  test('the digest line reads like a person wrote it', () => {
    const text = renderPromotions({
      promoted: [{ skill: 'create-calendar-event' }],
      demoted: [{ skill: 'send-report', reason: 'failed within the last week' }],
    });
    assert.match(text, /Stopped asking about: create-calendar-event/);
    assert.match(text, /Asking again about: send-report/);
    assert.equal(renderPromotions({ promoted: [], demoted: [] }), '');
  });

  test('the promotion ceiling is T2', () => {
    assert.equal(PROMOTION.maxTier, 'T2');
  });
});

// ── 8.4 ─────────────────────────────────────────────────────────────────────

describe('the web client (8.4)', () => {
  test('it is one self-contained page with no external requests', () => {
    // A zero-dependency daemon serving a page that pulls a CDN script would
    // undo the whole posture — and this page can approve irreversible actions.
    assert.ok(!/src\s*=\s*["']https?:/i.test(WEB_CLIENT_HTML), 'no external scripts');
    assert.ok(!/href\s*=\s*["']https?:/i.test(WEB_CLIENT_HTML), 'no external stylesheets');
    assert.ok(!/<link\b/i.test(WEB_CLIENT_HTML));
  });

  test('the token is never baked into the page', () => {
    // It would end up in the browser cache and in any screenshot.
    assert.ok(!WEB_CLIENT_HTML.includes('Bearer sk'));
    assert.match(WEB_CLIENT_HTML, /URLSearchParams\(location\.search\)/,
      'the token must come from the URL at runtime');
  });

  test('it escapes everything it renders', () => {
    // Mission titles and event text are model-authored. Injecting them raw
    // into a page with approve buttons is the obvious hole.
    assert.match(WEB_CLIENT_HTML, /const esc =/);
    assert.match(WEB_CLIENT_HTML, /&amp;|&lt;/);
  });

  test('approve and deny disable together', () => {
    // A double-tap on a phone must not send both.
    assert.match(WEB_CLIENT_HTML, /querySelectorAll\('button'\)\.forEach\(b => \{ b\.disabled = true; \}\)/);
  });

  test('a disconnected daemon looks disconnected, not idle', () => {
    // An empty page is indistinguishable from "nothing is happening".
    assert.match(WEB_CLIENT_HTML, /disconnected/);
  });

  test('the URL carries the token for a phone to open', () => {
    assert.equal(
      webClientUrl({ host: '192.168.1.5', port: 5181, token: 'abc def' }),
      'http://192.168.1.5:5181/?token=abc%20def',
    );
  });

  test('the daemon serves it and gates everything else', async () => {
    const src = fs.readFileSync(new URL('../src/kernel/server.js', import.meta.url), 'utf-8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const shellIdx = code.indexOf("p === '/'");
    const authIdx = code.indexOf('_authorized(req, url)', shellIdx);
    assert.ok(shellIdx > 0 && authIdx > shellIdx,
      'only the HTML shell may precede the auth gate');
    assert.match(code, /Content-Security-Policy/);
  });
});
