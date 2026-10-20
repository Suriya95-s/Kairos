// tests/voice-and-channel.test.js
// Phase 7 tail (7.4 MCP gating, 7.5 approval channel) and Phase 8
// (8.1 STT + wake word, 8.2 TTS + barge-in, 8.3 speakable rendering,
//  8.4 the phone surface).
//
// No engine, no service and no network is exercised here. Every adapter is
// injected, which is also the shipping posture: nothing is bundled, because
// what runs on someone's microphone is their decision.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Any completion the stubbed fetch answers gets metered into ~/.kairos/usage —
// spend into a throwaway home, never the owner's real ledger.
process.env.KAIROS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-voicech-'));

import { ApprovalChannel, channelFromConfig, CHANNELS } from '../src/trust/channel.js';
import {
  toSpeakable, truncateAtSentence, speakMissionEvent, shouldSpeakMissionEvent,
  speakApproval, SPEAKABLE_LIMIT,
} from '../src/voice/speakable.js';
import { VoiceSession, VOICE_STATES, commandLineStt, commandLineTts } from '../src/voice/session.js';
import { Bus } from '../src/kernel/bus.js';

/**
 * Wait for a condition rather than for a fixed delay.
 *
 * A `setTimeout(20)` before asserting on a state transition is a flake waiting
 * to happen: under full-suite load the transition can take longer, and the test
 * then fails for a reason unrelated to what it is testing.
 */
async function until(predicate, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, stepMs));
  }
  throw new Error('condition was never met');
}

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-voice-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

// ── 7.5 ─────────────────────────────────────────────────────────────────────

describe('the approval channel (7.5)', () => {
  test('an approval goes on the bus as urgency:now', async () => {
    // Someone is blocked waiting, and the answer defaults to DENY if nobody
    // comes. This is the one notification etiquette must not queue.
    const bus = new Bus({ journal: false });
    const seen = [];
    bus.subscribe('approval', e => seen.push(e));
    const ch = new ApprovalChannel({ enabled: ['bus'], bus });

    await ch.deliver({ id: 'a-1', tool: 'mail__send_email', tier: 'T2', reason: 'sends mail', expiresAt: 0 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].urgency, 'now');
    assert.equal(seen[0].payload.action, 'approval_requested');
  });

  test('action links carry the daemon token, or are not offered at all', async () => {
    // A button that does not work is worse than no button.
    const bus = new Bus({ journal: false });
    const withAuth = new ApprovalChannel({ enabled: ['bus'], bus, baseUrl: 'http://127.0.0.1:5181', token: 'tok' });
    const r1 = await withAuth.deliver({ id: 'a-1', tool: 'x', tier: 'T2', reason: 'r', expiresAt: 0 });
    assert.equal(r1.request.actionable, true);
    assert.match(r1.request.approveUrl, /\/api\/approve\/a-1\?token=tok$/);
    assert.match(r1.request.denyUrl, /\/api\/deny\/a-1/);

    const noAuth = new ApprovalChannel({ enabled: ['bus'], bus });
    const r2 = await noAuth.deliver({ id: 'a-2', tool: 'x', tier: 'T2', reason: 'r', expiresAt: 0 });
    assert.equal(r2.request.actionable, false);
    assert.equal(r2.request.approveUrl, undefined);
  });

  test('the links point at the SAME queue the TUI writes to', () => {
    // One queue, several front doors. A second approval path could diverge
    // from the first, and then two surfaces disagree about what was approved.
    const ch = new ApprovalChannel({ enabled: [], baseUrl: 'http://127.0.0.1:5181', token: 't' });
    const req = ch._withActions({ id: 'a-9' });
    assert.match(req.approveUrl, /\/api\/approve\//);
    assert.match(req.denyUrl, /\/api\/deny\//);
  });

  test('one failing channel does not stop the others', async () => {
    // The cost of a missed approval is silent denial-by-timeout.
    const bus = new Bus({ journal: false });
    const ch = new ApprovalChannel({ enabled: ['bus', 'webhook'], bus });  // no webhook url
    const res = await ch.deliver({ id: 'a-1', tool: 'x', tier: 'T2', reason: 'r', expiresAt: 0 });
    assert.deepEqual(res.delivered, ['bus']);
    assert.deepEqual(res.failed, ['webhook']);
    assert.equal(ch.status().recentFailures.length, 1);
  });

  test('a webhook sends a summary, not raw arguments', async () => {
    // This leaves the machine. Arguments can carry file contents and paths.
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; };
    try {
      const ch = new ApprovalChannel({ enabled: ['webhook'], webhookUrl: 'https://example.test/hook' });
      await ch.deliver({
        id: 'a-1', tool: 'mail__send_email', tier: 'T2', reason: 'sends mail',
        args: { body: 'confidential contents' }, expiresAt: 0,
      });
      assert.equal(calls.length, 1);
      assert.ok(!JSON.stringify(calls[0].body).includes('confidential contents'));
      assert.match(calls[0].body.summary, /mail__send_email/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('nothing leaves the machine by default', () => {
    // Turning on a channel that leaves the machine is a decision about what
    // gets sent where, so it is opt-in.
    const ch = channelFromConfig({ env: {} });
    assert.deepEqual(ch.enabled, ['bus']);

    const withHook = channelFromConfig({ env: { KAIROS_APPROVAL_WEBHOOK: 'https://x.test' } });
    assert.ok(withHook.enabled.includes('webhook'));
  });

  test('an unknown channel name is rejected rather than silently ignored', () => {
    const ch = new ApprovalChannel({ enabled: ['bus', 'telepathy'] });
    assert.deepEqual(ch.enabled, ['bus']);
    assert.ok(CHANNELS.includes('webhook'));
  });
});

// ── 8.3 ─────────────────────────────────────────────────────────────────────

describe('speakable rendering (8.3)', () => {
  test('markdown emphasis is spoken as words, not punctuation', () => {
    // "asterisk asterisk important asterisk asterisk" is the default failure.
    const s = toSpeakable('This is **important** and _urgent_.');
    assert.equal(s, 'This is important and urgent.');
    assert.ok(!s.includes('*'));
  });

  test('a code block is announced, not recited', () => {
    const s = toSpeakable('Here you go:\n```js\nconst x = 1;\n```\nThat is it.');
    assert.match(s, /code block on screen/);
    assert.ok(!s.includes('const x'));
  });

  test('a long path becomes its filename', () => {
    const s = toSpeakable('I edited src/kernel/missions.js for you.');
    assert.match(s, /missions\.js/);
    assert.ok(!s.includes('src/kernel'));
  });

  test('links are spoken as their text', () => {
    assert.equal(toSpeakable('See [the docs](https://example.com/a/b) for more.'), 'See the docs for more.');
    assert.match(toSpeakable('Try https://example.com/very/long/url now'), /a link/);
  });

  test('bullets become clauses', () => {
    const s = toSpeakable('Done:\n- wrote the parser\n- added tests');
    assert.ok(!s.includes('-'));
    assert.match(s, /wrote the parser/);
  });

  test('a table is announced rather than recited', () => {
    const s = toSpeakable('| a | b |\n| - | - |\n| 1 | 2 |');
    assert.match(s, /table on screen/);
  });

  test('spoken answers are shorter than written ones — a listener cannot skim', () => {
    const long = 'This is a sentence. '.repeat(80);
    const s = toSpeakable(long);
    assert.ok(s.length <= SPEAKABLE_LIMIT + 40, `spoken length ${s.length}`);
    assert.match(s, /more on screen/);
  });

  test('truncation lands on a sentence boundary, never mid-word', () => {
    // Stopping mid-sentence sounds like a crash.
    const s = truncateAtSentence('One. Two. Three. Four. Five.', 14);
    assert.match(s, /^One\. Two\./);
    assert.ok(!/\w$/.test(s.replace(/ There's more on screen\.$/, '')));
  });

  test('empty input renders as nothing to say', () => {
    assert.equal(toSpeakable(''), '');
    assert.equal(toSpeakable(null), '');
    assert.equal(toSpeakable('   \n  '), '');
  });

  test('mission STEPS are never spoken', () => {
    // The difference between a colleague and someone reading their keystrokes.
    assert.equal(shouldSpeakMissionEvent({ action: 'step', step: 47 }), false);
    assert.equal(speakMissionEvent({ action: 'step', step: 47 }), '');
  });

  test('mission milestones are spoken, and phrased usefully', () => {
    assert.match(speakMissionEvent({ action: 'running', title: 'refactor auth' }), /Starting: refactor auth/);
    assert.match(speakMissionEvent({ action: 'ended', exitReason: 'completed', title: 'refactor auth' }), /Finished/);
    assert.match(speakMissionEvent({ action: 'ended', exitReason: 'max_steps', title: 'x' }), /ran out of steps/);
    assert.match(speakMissionEvent({ action: 'ended', exitReason: 'interrupted', title: 'x' }), /pick up where it left off/);
    assert.match(speakMissionEvent({ action: 'blocked', title: 'x', blockedReason: 'workspace locked' }), /waiting/);
  });

  test('an approval is spoken plainly, with the tier translated', () => {
    // Being misheard here has consequences, so the risk is stated in English.
    const t3 = speakApproval({ tool: 'shop__purchase', tier: 'T3', reason: 'spends money' });
    assert.match(t3, /cannot be undone/);
    assert.match(t3, /shop purchase/, 'the tool name is humanised, not read as an identifier');
    assert.match(t3, /Say approve or deny/);
    assert.ok(!t3.includes('T3'), 'a tier code means nothing spoken aloud');

    assert.match(speakApproval({ tool: 'x', tier: 'T2', reason: 'r' }), /outside this machine/);
  });
});

// ── 8.1 / 8.2 ───────────────────────────────────────────────────────────────

describe('the voice session (8.1, 8.2)', () => {
  function makeSession(overrides = {}) {
    return new VoiceSession({
      stt: async () => ({ text: 'what is a monad?', confidence: 0.9 }),
      tts: async () => {},
      onUtterance: async () => 'A monoid in the category of endofunctors.',
      ...overrides,
    });
  }

  test('a spoken utterance reaches the router as an ORDINARY utterance event', async () => {
    // The design constraint: the router must not know voice exists.
    const bus = new Bus({ journal: false });
    const seen = [];
    bus.subscribe('utterance', e => seen.push(e));
    const v = makeSession({ bus, sessionId: 's-1' });

    await v.beginListening();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'utterance', 'not a special voice event type');
    assert.equal(seen[0].source, 'user.voice', 'only the source distinguishes it');
    assert.equal(seen[0].payload.text, 'what is a monad?');
  });

  test('the reply is spoken, rendered speakable', async () => {
    const spoken = [];
    const v = makeSession({
      tts: async (text) => { spoken.push(text); },
      onUtterance: async () => 'I edited **src/kernel/missions.js** for you.',
    });
    await v.beginListening();
    assert.equal(spoken.length, 1);
    assert.ok(!spoken[0].includes('**'));
    assert.match(spoken[0], /missions\.js/);
  });

  test('barge-in stops speech immediately and synchronously', async () => {
    // "Stop talking" that takes a tick is a system that talks over you.
    let aborted = false;
    const v = makeSession({
      tts: (text, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
        setTimeout(resolve, 10_000);
      }),
    });

    const speaking = v.speak('a very long answer');
    await until(() => v.state === 'speaking');

    assert.equal(v.bargeIn(), true);
    assert.equal(aborted, true, 'the abort must land before bargeIn() returns');
    assert.equal(v.state, 'idle', 'and the state must already have moved');

    const res = await speaking;
    assert.equal(res.interrupted, true);
    assert.equal(v.bargeIns, 1);
  });

  test('speaking while spoken to: listening barges in first, then captures', async () => {
    const order = [];
    const v = makeSession({
      tts: (text, { signal }) => new Promise((_res, rej) => {
        signal.addEventListener('abort', () => { order.push('stopped speaking'); const e = new Error('a'); e.name = 'AbortError'; rej(e); });
      }),
      stt: async () => { order.push('started listening'); return { text: 'stop', confidence: 1 }; },
      onUtterance: async () => '',
    });

    v.speak('a long answer').catch(() => {});
    await until(() => v.state === 'speaking');
    await v.beginListening();

    assert.deepEqual(order, ['stopped speaking', 'started listening'],
      'it must stop talking BEFORE it starts listening');
  });

  test('barge-in when not speaking is a no-op', () => {
    const v = makeSession();
    assert.equal(v.bargeIn(), false);
    assert.equal(v.bargeIns, 0);
  });

  test('a low-confidence transcript is refused, not acted on', async () => {
    // Acting on a misheard instruction is how voice does something nobody
    // asked for.
    let routed = false;
    const spoken = [];
    const v = makeSession({
      stt: async () => ({ text: 'delete everything', confidence: 0.2 }),
      onUtterance: async () => { routed = true; return 'ok'; },
      tts: async (t) => { spoken.push(t); },
    });
    const res = await v.beginListening();
    assert.equal(routed, false, 'a mumble must not become a command');
    assert.equal(res.ignored, 'low confidence');
    assert.match(spoken[0], /didn't catch that/);
  });

  test('the wake word is required when configured, and stripped when present', async () => {
    let heard = null;
    const v = new VoiceSession({
      wakeWord: 'kairos',
      stt: async () => ({ text: 'Kairos, what is a monad?', confidence: 1 }),
      onUtterance: async (t) => { heard = t; return ''; },
    });
    await v.beginListening();
    assert.equal(heard, 'what is a monad?', 'the wake word is not part of the request');
  });

  test('a sentence that merely mentions the name is not a command', async () => {
    // Matching the wake word anywhere would make every mention a command.
    let routed = false;
    const v = new VoiceSession({
      wakeWord: 'kairos',
      stt: async () => ({ text: 'I was telling Bob about kairos yesterday', confidence: 1 }),
      onUtterance: async () => { routed = true; return ''; },
    });
    const res = await v.beginListening();
    assert.equal(routed, false);
    assert.equal(res.ignored, 'no wake word');
    assert.equal(v.state, 'waiting', 'and it goes back to waiting, not idle');
  });

  test('the wake word survives however the transcriber spells it', async () => {
    // Found in live use. A wake word is a proper noun — the hardest thing for a
    // speech model to get right, because it has no dictionary entry and a short
    // utterance gives no context to recover it from. Real whisper output for
    // "Kairos, status" included "Kyros" and "Chiros".
    //
    // Seeding the decoder with the word was tried first and measured *worse*:
    // priming with "Kairos, " turned a previously correct transcript into
    // "Kyros". Biasing toward an unknown proper noun makes the model more
    // creative near it. So the variance is absorbed on the matching side.
    for (const heardAs of ['Kairos, status', 'Kyros, status', 'Chiros, status', "Cairo's status"]) {
      let routed = null;
      const v = new VoiceSession({
        wakeWord: 'kairos',
        stt: async () => ({ text: heardAs, confidence: 1 }),
        onUtterance: async (t) => { routed = t; return ''; },
      });
      await v.beginListening();
      assert.equal(routed, 'status', `"${heardAs}" should have woken it`);
    }
  });

  test('the wake word survives being split into two words', async () => {
    // Measured, not imagined: asked to say "Kairos, …" into a real microphone,
    // whisper returned "Okay Rose, let's get this." It does not only misspell an
    // unknown proper noun, it re-segments it into dictionary words that sound
    // like it — and a matcher that compares one token at a time cannot see that
    // at all, however generous its budget.
    for (const heardAs of ['Okay Rose, status', 'okay rose status', 'OK Rose, status']) {
      let routed = null;
      const v = new VoiceSession({
        wakeWord: 'kairos',
        stt: async () => ({ text: heardAs, confidence: 1 }),
        onUtterance: async (t) => { routed = t; return ''; },
      });
      await v.beginListening();
      assert.equal(routed, 'status', `"${heardAs}" should have woken it`);
    }
  });

  test('every rendering a real transcriber produced is accepted', async () => {
    // The full set from live runs against one microphone. Four spellings of one
    // spoken word, and in every case the command after it was transcribed
    // correctly — which is why matching moved to sound. Spelling-based aliases
    // were one behind reality on every single run.
    const observed = [
      'Kairos, status',
      'Kyros, status',
      'Chiros, status',
      "Cairo's status",
      "Okay Rose, status",
      "Kaniyarou's status",
    ];
    for (const heardAs of observed) {
      let routed = null;
      const v = new VoiceSession({
        wakeWord: 'kairos',
        stt: async () => ({ text: heardAs, confidence: 1 }),
        onUtterance: async (t) => { routed = t; return ''; },
      });
      await v.beginListening();
      assert.equal(routed, 'status', `"${heardAs}" should have woken it`);
    }
  });

  test('the wake word must be a whole word, not a prefix of a longer one', async () => {
    // Found by the test above rather than in the field, but only just. A bare
    // substring search consumed six letters of "Kairose" and routed the request
    // as "e status".
    let routed = null;
    const v = new VoiceSession({
      wakeWord: 'kairos',
      stt: async () => ({ text: 'Kairosity is not a word, status', confidence: 1 }),
      onUtterance: async (t) => { routed = t; return ''; },
    });
    const res = await v.beginListening();
    assert.equal(routed, null, 'a longer word that merely starts the same is not the wake word');
    assert.equal(res.ignored, 'no wake word');

    // The possessive is a rendering, not a request. "Kairos's status" is not an
    // instruction to do "s status".
    let possessive = null;
    const p = new VoiceSession({
      wakeWord: 'kairos',
      stt: async () => ({ text: "Kairos's status", confidence: 1 }),
      onUtterance: async (t) => { possessive = t; return ''; },
    });
    await p.beginListening();
    assert.equal(possessive, 'status');
  });

  test('a spelling nobody has seen yet is accepted if it sounds right', async () => {
    // The point of matching by sound rather than by list. Every entry in the
    // alias table was added *after* a run failed; these are not in it, and the
    // whole reason the previous approach was abandoned is that the next run
    // always produced something new. If this test only passed because of the
    // alias table it would be testing nothing.
    for (const heardAs of ['Kyrose, status', 'Kairose status', 'Connie Rose, status', 'Kanyarus status']) {
      let routed = null;
      const v = new VoiceSession({
        wakeWord: 'kairos',
        stt: async () => ({ text: heardAs, confidence: 1 }),
        onUtterance: async (t) => { routed = t; return ''; },
      });
      await v.beginListening();
      assert.equal(routed, 'status', `"${heardAs}" sounds like the wake word`);
    }
  });

  test('the homophones it accepts are named, not discovered later', async () => {
    // Matching by sound has a cost and it should be written down rather than
    // found in the field. "kairos" reduces to k-r-s, and so do these. An
    // utterance beginning with one of them wakes the assistant.
    for (const collides of ['cross', 'course', 'cars', 'curse', 'chorus']) {
      let routed = null;
      const v = new VoiceSession({
        wakeWord: 'kairos',
        stt: async () => ({ text: `${collides} the build`, confidence: 1 }),
        onUtterance: async (t) => { routed = t; return ''; },
      });
      await v.beginListening();
      assert.equal(routed, 'the build', `"${collides}" is a known homophone of the wake word`);
    }
  });

  test('the aliases are a list of observations, not a wider budget', async () => {
    // The tempting fix was tolerance 3, which is half of a six-letter word —
    // enough for "across", "chorus" and "various" to become the wake word. So
    // the slack stays at 2 and the known renderings are named instead. These are
    // within three edits of "kairos" and must still be ignored.
    for (const notIt of ['across the board, deploy', 'various things are failing', 'a curious thing happened']) {
      let routed = false;
      const v = new VoiceSession({
        wakeWord: 'kairos',
        stt: async () => ({ text: notIt, confidence: 1 }),
        onUtterance: async () => { routed = true; return ''; },
      });
      const res = await v.beginListening();
      assert.equal(routed, false, `"${notIt}" must not wake it`);
      assert.equal(res.ignored, 'no wake word');
    }
  });

  test('a custom wake word gets no aliases it did not ask for', async () => {
    // The alias list is per-word and empirical. A different wake word has no
    // observations behind it, so it gets exact matching plus the distance
    // budget — and must not inherit somebody else's mis-hearings.
    let routed = null;
    const v = new VoiceSession({
      wakeWord: 'jarvis',
      stt: async () => ({ text: 'Okay Rose, status', confidence: 1 }),
      onUtterance: async (t) => { routed = t; return ''; },
    });
    const res = await v.beginListening();
    assert.equal(routed, null);
    assert.equal(res.ignored, 'no wake word');

    const named = new VoiceSession({
      wakeWord: 'jarvis', wakeAliases: ['java is', 'jarvo'],
      stt: async () => ({ text: 'Java is, status', confidence: 1 }),
      onUtterance: async (t) => { routed = t; return ''; },
    });
    await named.beginListening();
    assert.equal(routed, 'status', 'an explicit alias list must be honoured');
  });

  test('tolerance does not turn similar words into the wake word', async () => {
    // The gate has to stay a gate. If everything within two edits woke it, a
    // conversation in the room would start issuing commands.
    for (const notIt of ['the chorus was loud', 'carols at christmas', 'I think we need that.']) {
      let routed = false;
      const v = new VoiceSession({
        wakeWord: 'kairos',
        stt: async () => ({ text: notIt, confidence: 1 }),
        onUtterance: async () => { routed = true; return ''; },
      });
      const res = await v.beginListening();
      assert.equal(routed, false, `"${notIt}" must not wake it`);
      assert.equal(res.ignored, 'no wake word');
    }
  });

  test('an approximate match still only counts at the start', async () => {
    // The property that makes a wake word useful at all: mentioning it in the
    // middle of a sentence is not an instruction.
    let routed = false;
    const v = new VoiceSession({
      wakeWord: 'kairos',
      stt: async () => ({ text: 'I was telling Bob about Kyros yesterday', confidence: 1 }),
      onUtterance: async () => { routed = true; return ''; },
    });
    const res = await v.beginListening();
    assert.equal(routed, false);
    assert.equal(res.ignored, 'no wake word');
  });

  test('tolerance can be switched off for an exact-match wake word', async () => {
    let routed = false;
    const v = new VoiceSession({
      wakeWord: 'kairos', wakeTolerance: 0,
      stt: async () => ({ text: 'Kyros, status', confidence: 1 }),
      onUtterance: async () => { routed = true; return ''; },
    });
    await v.beginListening();
    assert.equal(routed, false);
  });

  test('with no wake word configured, everything captured is a command', async () => {
    let routed = false;
    const v = makeSession({ onUtterance: async () => { routed = true; return ''; } });
    await v.beginListening();
    assert.equal(routed, true);
  });

  test('silence is ignored', async () => {
    const v = makeSession({ stt: async () => ({ text: '   ', confidence: 1 }) });
    const res = await v.beginListening();
    assert.equal(res.ignored, 'nothing heard');
    assert.equal(v.state, 'idle');
  });

  test('cancelling a capture aborts it cleanly', async () => {
    const v = makeSession({
      stt: ({ signal }) => new Promise((_r, rej) => {
        signal.addEventListener('abort', () => { const e = new Error('a'); e.name = 'AbortError'; rej(e); });
      }),
    });
    const listening = v.beginListening();
    await until(() => v.state === 'listening');
    assert.equal(v.cancelListening(), true);
    assert.equal((await listening).cancelled, true);
  });

  test('a missing engine is reported, not crashed on', async () => {
    const noStt = new VoiceSession({});
    await assert.rejects(() => noStt.beginListening(), /no speech-to-text engine/);

    const noTts = new VoiceSession({ tts: null });
    assert.equal((await noTts.speak('hello')).skipped, 'no tts engine');
  });

  test('an error from the router does not wedge the session', async () => {
    const v = makeSession({ onUtterance: async () => { throw new Error('router exploded'); } });
    const res = await v.beginListening();
    assert.match(res.error, /router exploded/);
    assert.equal(v.state, 'idle', 'and it is ready for the next utterance');
  });

  test('every state transition is a declared state', async () => {
    const v = makeSession();
    await v.beginListening();
    for (const t of v.history) {
      assert.ok(VOICE_STATES.includes(t.to), `unknown state ${t.to}`);
    }
    assert.throws(() => v._setState('vibing'), /invalid voice state/);
  });

  test('a bus failure never breaks the voice surface', async () => {
    const v = makeSession({ bus: { publish() { throw new Error('bus down'); } } });
    const res = await v.beginListening();
    assert.equal(res.text, 'what is a monad?');
  });
});

describe('command-line engine adapters', () => {
  /** A fake spawn: an EventEmitter with stdout/stderr and a scripted exit. */
  function fakeSpawn({ stdout = '', code = 0, hang = false } = {}) {
    return () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = () => { child.killed = true; child.emit('exit', null); };
      if (!hang) {
        setImmediate(() => {
          if (stdout) child.stdout.emit('data', stdout);
          child.emit('exit', code);
        });
      }
      return child;
    };
  }

  test('an STT engine\'s stdout becomes a transcript', async () => {
    const stt = commandLineStt({ command: 'whisper', spawnFn: fakeSpawn({ stdout: 'hello world\n' }) });
    assert.deepEqual(await stt({}), { text: 'hello world', confidence: 1 });
  });

  test('a custom parser can supply confidence', async () => {
    const stt = commandLineStt({
      command: 'whisper',
      spawnFn: fakeSpawn({ stdout: '{"text":"hi","confidence":0.42}' }),
      parse: (out) => JSON.parse(out),
    });
    assert.equal((await stt({})).confidence, 0.42);
  });

  test('a non-zero exit is an error, not an empty transcript', async () => {
    // An empty transcript would read as silence and be quietly ignored.
    const stt = commandLineStt({ command: 'whisper', spawnFn: fakeSpawn({ code: 3 }) });
    await assert.rejects(() => stt({}), /stt exited 3/);
  });

  test('aborting a TTS process IS barge-in', async () => {
    const controller = new AbortController();
    const tts = commandLineTts({ command: 'say', spawnFn: fakeSpawn({ hang: true }) });
    const speaking = tts('hello', { signal: controller.signal });
    setImmediate(() => controller.abort());
    await assert.rejects(() => speaking, (err) => { assert.equal(err.name, 'AbortError'); return true; });
  });
});
