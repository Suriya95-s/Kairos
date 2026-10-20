// tests/tui-voice-view.test.js
// The Voice view (page 6) and the plumbing that feeds it.
//
// Chain under test, offline end to end:
//   voice CLI → POST /api/voice → daemon.noteVoice → bus `voice` event
//     → daemonEvents adapter → foldVoiceEvent → renderVoice
//
// The B1 rule gets the adversarial test: only `verified: true` may move the
// daemon's last-verified-voice timestamp, because that timestamp raises
// arousal — and an unverified voice in a shared room is anyone.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Daemon } from '../src/kernel/daemon.js';
import { Bus } from '../src/kernel/bus.js';
import { adaptDaemonEvent } from '../apps/tui/src/client/daemonEvents.js';
import {
  foldVoiceEvent, waveform, voiceEventLine, renderVoice, VOICE_EVENT_CAP,
} from '../apps/tui/src/views/voice.js';
import { state, setState } from '../apps/tui/src/state.js';
import { stripAnsi } from '../apps/tui/src/render.js';

let tmpHome;
const savedHome = process.env.KAIROS_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-voiceview-'));
  process.env.KAIROS_HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.KAIROS_HOME;
  else process.env.KAIROS_HOME = savedHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function mkDaemon() {
  return new Daemon({ bus: new Bus({ dir: path.join(tmpHome, 'bus') }), timers: false, now: () => 1_000_000 });
}

// ── daemon.noteVoice ─────────────────────────────────────────────────────────

describe('daemon.noteVoice', () => {
  test('publishes a voice event onto the bus', () => {
    const d = mkDaemon();
    const seen = [];
    d.bus.subscribe((e) => { if (e.kind === 'voice') seen.push(e); });
    d.noteVoice({ phase: 'heard', text: 'status', score: 0.7, threshold: 0.3, verified: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].payload.phase, 'heard');
    assert.equal(seen[0].payload.score, 0.7);
    assert.equal(seen[0].payload.verified, true);
  });

  test('B1 RULE: only verified === true moves the presence timestamp', () => {
    const d = mkDaemon();
    assert.equal(d._lastVerifiedVoiceAt, null);

    d.noteVoice({ phase: 'heard', text: 'hello', score: 0.9 });               // no flag
    assert.equal(d._lastVerifiedVoiceAt, null, 'absent flag must not count');

    d.noteVoice({ phase: 'heard', verified: 'yes' });                          // truthy ≠ true
    assert.equal(d._lastVerifiedVoiceAt, null, 'a truthy non-boolean must not count');

    d.noteVoice({ phase: 'ignored', reason: 'unrecognized voice', verified: false });
    assert.equal(d._lastVerifiedVoiceAt, null, 'a rejected stranger must not count');

    d.noteVoice({ phase: 'heard', verified: true });
    assert.equal(d._lastVerifiedVoiceAt, 1_000_000, 'a verified match must count');
  });

  test('REGRESSION: brain events actually reach the bus (they were silently dropped)', async () => {
    // daemon._publish swallows every publish error, and bus.publish validates
    // kinds against a whitelist — so publishing an unregistered kind is not an
    // error anyone sees, it is events that silently do not exist. B1's `brain`
    // events shipped exactly that way and were discarded for a day. This test
    // pins the registration.
    const d = new Daemon({
      bus: new Bus({ dir: path.join(tmpHome, 'bus') }),
      timers: false,
      llmProbe: async () => true,
    });
    const brains = [];
    d.bus.subscribe('brain', (e) => brains.push(e.payload));
    await d.probeHealth();
    assert.equal(brains.length, 1, 'one health probe must publish one brain event');
    for (const dial of ['arousal', 'load', 'confidence']) {
      assert.ok(Number.isFinite(brains[0][dial]), `${dial} must be a number, got ${brains[0][dial]}`);
    }
  });

  test('hostile payloads are truncated and typed, not stored raw', () => {
    const d = mkDaemon();
    const seen = [];
    d.bus.subscribe((e) => { if (e.kind === 'voice') seen.push(e); });
    d.noteVoice({
      phase: 42, text: 'x'.repeat(10_000), score: 'NaNsense', threshold: Infinity,
      reason: 'y'.repeat(10_000), timing: 'not-an-object',
    });
    const p = seen[0].payload;
    assert.equal(typeof p.phase, 'string');
    assert.ok(p.text.length <= 500, `text must be capped, got ${p.text.length}`);
    assert.ok(p.reason.length <= 200);
    assert.equal(p.score, null, 'a non-finite score is null, not a string');
    assert.equal(p.threshold, null);
    assert.equal(p.timing, null);
  });
});

// ── adapter ──────────────────────────────────────────────────────────────────

describe('daemon event adapter', () => {
  test('voice bus events pass through with their payload intact', () => {
    const adapted = adaptDaemonEvent({ kind: 'voice', payload: { phase: 'heard', text: 'hi', score: 0.5 } });
    assert.equal(adapted.type, 'voice');
    assert.equal(adapted.phase, 'heard');
    assert.equal(adapted.score, 0.5);
  });

  test('brain bus events surface the three dials', () => {
    const adapted = adaptDaemonEvent({ kind: 'brain', payload: { arousal: 0.7, load: 0.2, confidence: 0.5 } });
    assert.equal(adapted.type, 'brain');
    assert.equal(adapted.arousal, 0.7);
  });
});

// ── foldVoiceEvent ───────────────────────────────────────────────────────────

describe('foldVoiceEvent', () => {
  const EMPTY = Object.freeze({
    events: [], speaking: false, speakingText: '', lastHeard: null, lastAnswer: null,
    brain: null, pipeline: null, pipelineAt: 0, animFrame: 0,
  });

  test('speaking / spoke toggle the animation state without polluting the feed', () => {
    let v = foldVoiceEvent(EMPTY, { phase: 'speaking', text: 'hello there' });
    assert.equal(v.speaking, true);
    assert.equal(v.speakingText, 'hello there');
    assert.equal(v.events.length, 0, 'speaking is a state, not an activity row');
    v = foldVoiceEvent(v, { phase: 'spoke' });
    assert.equal(v.speaking, false);
    assert.equal(v.speakingText, '');
  });

  test('heard / answer / ignored all land in the feed, newest first', () => {
    let v = foldVoiceEvent(EMPTY, { phase: 'heard', text: 'one' }, 1);
    v = foldVoiceEvent(v, { phase: 'answer', text: 'two' }, 2);
    v = foldVoiceEvent(v, { phase: 'ignored', reason: 'no wake word', text: 'three' }, 3);
    assert.deepEqual(v.events.map(e => e.phase), ['ignored', 'answer', 'heard']);
    assert.equal(v.lastHeard.text, 'one');
    assert.equal(v.lastAnswer.text, 'two');
  });

  test('the feed is a ring buffer, not a leak', () => {
    let v = EMPTY;
    for (let i = 0; i < VOICE_EVENT_CAP + 50; i++) v = foldVoiceEvent(v, { phase: 'heard', text: `t${i}` }, i);
    assert.equal(v.events.length, VOICE_EVENT_CAP);
    assert.equal(v.events[0].text, `t${VOICE_EVENT_CAP + 49}`, 'newest kept');
  });

  test('the input object is never mutated', () => {
    const before = { ...EMPTY, events: [] };
    foldVoiceEvent(before, { phase: 'speaking', text: 'x' });
    assert.equal(before.speaking, false);
    assert.equal(before.events.length, 0);
  });

  test('an unknown phase from a newer CLI still lands in the feed', () => {
    const v = foldVoiceEvent(EMPTY, { phase: 'barge-in', text: 'stop' }, 1);
    assert.equal(v.events.length, 1);
    assert.equal(v.events[0].phase, 'barge-in');
  });
});

// ── waveform ─────────────────────────────────────────────────────────────────

describe('the speaking waveform', () => {
  test('is deterministic in the frame index', () => {
    assert.equal(waveform(3, 20), waveform(3, 20));
    assert.notEqual(waveform(3, 20), waveform(4, 20), 'consecutive frames must differ or nothing moves');
  });

  test('is exactly the requested width and made only of bar glyphs', () => {
    const w = waveform(7, 24);
    assert.equal([...w].length, 24);
    assert.match(w, /^[▁▂▃▄▅▆▇]+$/);
  });

  test('frame 0 is valid — no NaN indexing on the first tick', () => {
    assert.match(waveform(0, 8), /^[▁▂▃▄▅▆▇]{8}$/);
  });
});

// ── rendering ────────────────────────────────────────────────────────────────

describe('renderVoice', () => {
  const W = 100, H = 24;
  let savedVoice, savedView;

  beforeEach(() => {
    savedVoice = state.voice;
    savedView = state.view;
  });
  afterEach(() => {
    setState({ voice: savedVoice, view: savedView });
  });

  const baseVoice = () => ({
    events: [], speaking: false, speakingText: '', lastHeard: null, lastAnswer: null,
    brain: null, pipeline: null, pipelineAt: 0, animFrame: 0,
  });

  test('empty state renders the how-to-start hint, exactly H lines', () => {
    setState({ voice: baseVoice() });
    const lines = renderVoice(W, H);
    assert.equal(lines.length, H);
    const text = stripAnsi(lines.join('\n'));
    assert.match(text, /VOICE/);
    assert.match(text, /listening/);
    assert.match(text, /kairos voice listen/);
    for (const l of lines) assert.ok(stripAnsi(l).length <= W, 'no line may overflow the terminal');
  });

  test('speaking state shows the waveform and the sentence being spoken', () => {
    setState({ voice: { ...baseVoice(), speaking: true, speakingText: 'Hello from Kairos', animFrame: 5 } });
    const text = stripAnsi(renderVoice(W, H).join('\n'));
    assert.match(text, /[▁▂▃▄▅▆▇]{8}/, 'the waveform must be visible while speaking');
    assert.match(text, /speaking/);
    assert.match(text, /Hello from Kairos/);
  });

  test('activity rows show scores, verdicts, and timing', () => {
    setState({
      voice: {
        ...baseVoice(),
        brain: { arousal: 0.8, load: 0.1, confidence: 0.5 },
        pipeline: { recorder: true, recorderName: 'ffmpeg', whisper: true, whisperModel: 'ggml-base.en.bin', speaker: true, voiceprint: true, threshold: 0.3, tts: true, ttsName: 'powershell', model: 'qwen36 (Qwen/Qwen3.6-35B-A3B-FP8)' },
        events: [
          { ts: 0, phase: 'answer', text: 'TCP is connection-oriented.' },
          { ts: 0, phase: 'heard', text: 'what is TCP', score: 0.72, threshold: 0.3, verified: true, timing: { totalMs: 9222 } },
          { ts: 0, phase: 'ignored', reason: 'unrecognized voice', score: 0.28, threshold: 0.3, verified: false },
          { ts: 0, phase: 'ignored', reason: 'no wake word', text: 'just chatting' },
        ],
      },
    });
    const text = stripAnsi(renderVoice(W, H).join('\n'));
    assert.match(text, /kairos: TCP is connection-oriented/);
    assert.match(text, /0\.72/, 'the accepted score must be visible');
    assert.match(text, /\[9\.2s\]/, 'timing must be visible');
    assert.match(text, /stranger/);
    assert.match(text, /no wake word: "just chatting"/);
    assert.match(text, /arousal 80%/);
    assert.match(text, /ffmpeg/);
    assert.match(text, /qwen36/);
  });

  test('a stranger line never shows the transcribed text — it was never transcribed', () => {
    const line = stripAnsi(voiceEventLine({ ts: 0, phase: 'ignored', reason: 'unrecognized voice', score: 0.28, text: '' }, 80));
    assert.match(line, /stranger/);
    assert.doesNotMatch(line, /undefined|null/);
  });
});
