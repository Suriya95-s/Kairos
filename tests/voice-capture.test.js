// tests/voice-capture.test.js
// Audio capture, tested without audio.
//
// A microphone is the worst possible test dependency: it needs hardware, a
// quiet room, a person, and it gives a different answer every time. So the
// design is arranged so that none of that is needed — the recorder is a
// spawned process (fakeable), the endpointer is a pure function of frame
// energies (feedable), and synthetic PCM is exact in a way a real room is not.
//
// What is deliberately NOT asserted: that a real microphone works. No test can
// prove that, and one that pretends to would be the most misleading file here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  rmsOfFrame, toDbfs, FrameSplitter, pcmToWav, synthPcm, BYTES_PER_SAMPLE, clippingOf,
} from '../src/voice/pcm.js';
import {
  Endpointer, RingBuffer, captureUtterance, detectRecorder, describeMissingRecorder,
  microphoneStt, BACKENDS, FRAME_BYTES, CAPTURE_FORMAT,
  parseDshowAudioDevices, resetDeviceCache,
} from '../src/voice/capture.js';
import { cleanTranscript, fileTranscriber, findWhisper } from '../src/voice/transcribe.js';

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }
  kill() { this.killed = true; return true; }
}

/** A recorder that plays `pcm` down stdout in `chunkSize` byte pieces. */
function fakeRecorder(pcm, { chunkSize = FRAME_BYTES, onSpawn = null, exitAfter = false, stderr = '' } = {}) {
  return (command, args, opts) => {
    const child = new FakeChild();
    child.spawnArgs = { command, args, opts };
    onSpawn?.(child);
    queueMicrotask(() => {
      for (let i = 0; i < pcm.length; i += chunkSize) {
        if (child.killed) return;
        child.stdout.emit('data', pcm.subarray(i, Math.min(i + chunkSize, pcm.length)));
      }
      if (child.killed) return;
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      if (exitAfter) child.emit('exit', exitAfter === true ? 0 : exitAfter);
    });
    return child;
  };
}

// What an open microphone in a quiet room actually delivers. Not zero: a capsule
// has self-noise, and the endpointer now distinguishes "quiet" from "no audio at
// all" because on real hardware those mean different things — the second is a
// device that has not started yet, and calibrating on it opens the gate onto the
// room. Fixtures that used digital zero were describing a device that cannot
// exist, and they hid that bug for the whole of 8.1.
const ROOM = 0.0006;

/** A quiet room, in bytes. */
function roomPcm(ms) { return synthPcm({ ms, amplitude: ROOM }); }

/** Room, then speech, then room — the shape of somebody saying something. */
function utteranceAudio({ leadMs = 200, speechMs = 300, tailMs = 200, amplitude = 0.5, room = ROOM } = {}) {
  return Buffer.concat([
    synthPcm({ ms: leadMs, amplitude: room }),
    synthPcm({ ms: speechMs, amplitude }),
    synthPcm({ ms: tailMs, amplitude: room }),
  ]);
}

/** Small, fast endpointer settings so tests describe frames rather than seconds. */
const FAST = {
  calibrateMs: 40,     // 2 frames
  silenceMs: 100,      // 5 frames
  maxWaitMs: 400,      // 20 frames
  prerollMs: 40,       // 2 frames
  onsetFrames: 2,
  maxUtteranceMs: 2000,
};

// ── PCM arithmetic ──────────────────────────────────────────────────────────

describe('pcm: energy', () => {
  test('silence is zero, a full-scale tone is about 0.707', () => {
    assert.equal(rmsOfFrame(synthPcm({ ms: 20, amplitude: 0 })), 0);
    // RMS of a sine is its amplitude over root two. If this drifts, every
    // threshold in the endpointer silently means something different.
    const loud = rmsOfFrame(synthPcm({ ms: 100, amplitude: 1 }));
    assert.ok(Math.abs(loud - 0.7071) < 0.01, `expected ~0.707, got ${loud}`);
  });

  test('half amplitude is half the energy', () => {
    const half = rmsOfFrame(synthPcm({ ms: 100, amplitude: 0.5 }));
    assert.ok(Math.abs(half - 0.3536) < 0.01, `got ${half}`);
  });

  test('an odd-length buffer does not throw or read past the end', () => {
    // A pipe hands over whatever arrived. Half a sample is normal, not an error.
    const odd = Buffer.concat([synthPcm({ ms: 20, amplitude: 0.5 }), Buffer.from([0x7f])]);
    assert.doesNotThrow(() => rmsOfFrame(odd));
    assert.ok(rmsOfFrame(odd) > 0);
  });

  test('an empty buffer is silence, not NaN', () => {
    assert.equal(rmsOfFrame(Buffer.alloc(0)), 0);
    assert.equal(rmsOfFrame(Buffer.alloc(1)), 0);
  });

  test('dBFS: full scale is 0, silence is -Infinity', () => {
    assert.equal(toDbfs(1), 0);
    assert.equal(toDbfs(0), -Infinity);
    assert.ok(toDbfs(0.5) < 0);
  });
});

describe('pcm: framing', () => {
  test('bytes survive being chopped at every awkward boundary', () => {
    // The bug this prevents: a chunk that ends mid-sample shifts every
    // subsequent read by one byte, which turns speech into noise. Nothing
    // throws — it just stops working.
    const source = synthPcm({ ms: 200, amplitude: 0.5 });
    for (const chunkSize of [1, 3, 7, 639, 641, 1000]) {
      const splitter = new FrameSplitter(FRAME_BYTES);
      const frames = [];
      for (let i = 0; i < source.length; i += chunkSize) {
        frames.push(...splitter.push(source.subarray(i, Math.min(i + chunkSize, source.length))));
      }
      const rebuilt = Buffer.concat(frames);
      const expected = source.subarray(0, source.length - (source.length % FRAME_BYTES));
      assert.deepEqual(rebuilt, expected, `chunk size ${chunkSize} corrupted the stream`);
    }
  });

  test('the carry is copied, so a reused source buffer cannot corrupt it', () => {
    // Node streams are free to reuse the memory behind a chunk after the
    // handler returns. Holding a subarray of it is a use-after-free in slow
    // motion, and it would show up as one crackling frame every few minutes.
    const splitter = new FrameSplitter(FRAME_BYTES);
    const chunk = Buffer.alloc(FRAME_BYTES + 10, 0x11);
    splitter.push(chunk);
    chunk.fill(0xff);                      // the stream recycles its buffer
    const next = splitter.push(Buffer.alloc(FRAME_BYTES, 0x22));
    assert.equal(next.length, 1);
    assert.equal(next[0][0], 0x11, 'the carried bytes were overwritten');
  });

  test('leftovers are held, not emitted, until they fill a frame', () => {
    const splitter = new FrameSplitter(FRAME_BYTES);
    assert.equal(splitter.push(Buffer.alloc(FRAME_BYTES - 2)).length, 0);
    assert.equal(splitter.pending, FRAME_BYTES - 2);
    assert.equal(splitter.push(Buffer.alloc(2)).length, 1);
    assert.equal(splitter.pending, 0);
  });

  test('flush zero-pads the tail, and only once', () => {
    const splitter = new FrameSplitter(FRAME_BYTES);
    splitter.push(Buffer.alloc(4, 0x7f));
    const tail = splitter.flush();
    assert.equal(tail.length, FRAME_BYTES);
    assert.equal(tail[4], 0, 'the pad must be silence');
    assert.equal(splitter.flush(), null);
  });

  test('a frame size that is not a whole sample is rejected at construction', () => {
    // Better to fail loudly here than to produce a permanently misaligned stream.
    assert.throws(() => new FrameSplitter(641), /whole number of samples/);
    assert.throws(() => new FrameSplitter(0), /positive integer/);
  });

  test('the frame constant really is 20ms of the declared format', () => {
    const expected = (CAPTURE_FORMAT.sampleRate / 1000) * 20 * BYTES_PER_SAMPLE;
    assert.equal(FRAME_BYTES, expected);
  });
});

describe('pcm: wav', () => {
  test('the header describes the audio that follows it', () => {
    const pcm = synthPcm({ ms: 100, amplitude: 0.3 });
    const wav = pcmToWav(pcm, { sampleRate: 16000, channels: 1, bitDepth: 16 });

    assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
    assert.equal(wav.subarray(12, 16).toString(), 'fmt ');
    assert.equal(wav.subarray(36, 40).toString(), 'data');

    assert.equal(wav.readUInt32LE(4), 36 + pcm.length, 'RIFF size');
    assert.equal(wav.readUInt16LE(20), 1, 'uncompressed PCM');
    assert.equal(wav.readUInt16LE(22), 1, 'channels');
    assert.equal(wav.readUInt32LE(24), 16000, 'sample rate');
    assert.equal(wav.readUInt32LE(28), 32000, 'byte rate');
    assert.equal(wav.readUInt16LE(32), 2, 'block align');
    assert.equal(wav.readUInt16LE(34), 16, 'bit depth');
    assert.equal(wav.readUInt32LE(40), pcm.length, 'data size');
    assert.equal(wav.length, 44 + pcm.length);
  });

  test('the samples are copied through untouched', () => {
    const pcm = synthPcm({ ms: 20, amplitude: 0.9 });
    assert.deepEqual(pcmToWav(pcm).subarray(44), pcm);
  });
});

describe('pcm: clipping', () => {
  test('clean audio reports no clipping, however loud it is', () => {
    // Half scale is loud. Loud is not clipped, and conflating them would make
    // the warning fire on every normal utterance until it was ignored.
    const clean = clippingOf(synthPcm({ ms: 200, amplitude: 0.5 }));
    assert.equal(clean.clipping, false);
    assert.equal(clean.clipped, 0);
    assert.ok(Math.abs(clean.peakSample - 0.5) < 0.01, `peak ${clean.peakSample}`);
  });

  test('a signal driven past full scale is detected', () => {
    // What --gain 3 did to a normally spoken sentence. RMS could not see it: the
    // frame energy of clipped speech simply looks high, so it sailed through the
    // endpointer and the plausibility ratio alike, and reached whisper as a
    // percussive noise transcribed "(popping)".
    const loud = clippingOf(synthPcm({ ms: 200, amplitude: 1 }));
    assert.equal(loud.clipping, true);
    assert.ok(loud.clipped > 0.01, `only ${loud.clipped} of samples at the rail`);
  });

  test('the measured fractions from real captures are recognised as clipping', () => {
    // Counted from the files that produced "(drumming)", "[MUSIC PLAYING]" and
    // "(popping)": 0.003%, 0.002% and 0.077% of samples at full scale. Small
    // fractions, and enough to ruin the transcript, because clipping destroys
    // the loudest part of speech — the part carrying the most information.
    const withRailSamples = (count) => {
      const pcm = synthPcm({ ms: 1000, amplitude: 0.3 });   // 16000 samples
      for (let i = 0; i < count; i++) pcm.writeInt16LE(32767, i * BYTES_PER_SAMPLE);
      return clippingOf(pcm);
    };
    // 0.002% of 16000 samples is well under one sample, so the smallest real
    // case is represented by the single sample it rounds to.
    assert.equal(withRailSamples(1).clipping, true);
    assert.equal(withRailSamples(12).clipping, true);
    assert.equal(withRailSamples(0).clipping, false);
  });

  test('an odd-length buffer does not throw', () => {
    // Chunk boundaries are not sample boundaries, and this is called on assembled
    // audio whose length has no guarantee attached.
    assert.equal(clippingOf(Buffer.from([0x01])).clipping, false);
    assert.equal(clippingOf(Buffer.alloc(0)).clipping, false);
  });
});

// ── Endpointing ─────────────────────────────────────────────────────────────

describe('endpointer: finding the sentence', () => {
  test('it measures the room before it judges anything', () => {
    const ep = new Endpointer({ ...FAST, frameMs: 20 });
    assert.equal(ep.state, 'calibrating');
    assert.equal(ep.push(0.01), 'preroll');
    assert.equal(ep.push(0.01), 'preroll');
    assert.equal(ep.state, 'waiting');
    // floor 0.01 × 3.5 — a room this noisy needs a higher bar than a quiet one.
    assert.ok(Math.abs(ep.threshold - 0.035) < 1e-9, `threshold ${ep.threshold}`);
  });

  test('a noisy room raises the bar; a quiet one does not drop it to zero', () => {
    // The whole reason the floor is measured rather than hard-coded.
    const noisy = new Endpointer({ ...FAST, calibrateMs: 40 });
    noisy.push(0.1); noisy.push(0.1);

    // A real quiet room, not a dead device: a microphone capsule idles well
    // above zero. Exactly-zero frames mean something else entirely and are
    // covered separately below.
    const quiet = new Endpointer({ ...FAST, calibrateMs: 40 });
    quiet.push(0.0006); quiet.push(0.0006);

    assert.ok(noisy.threshold > quiet.threshold);
    assert.equal(quiet.threshold, 0.004, 'a silent room still needs a floor, or noise is speech');
    // A level that is speech in a quiet room is just the room next door.
    assert.equal(quiet.push(0.05), 'preroll');   // below onset count, but over the gate
    assert.equal(noisy.push(0.05), 'preroll');
    quiet.push(0.05);
    assert.equal(quiet.state, 'speech');
    noisy.push(0.05);
    assert.equal(noisy.state, 'waiting', 'the noisy room must not have triggered');
  });

  test('a device that has not started yet is not mistaken for a silent room', () => {
    // Observed on real hardware: ffmpeg/dshow delivers exact zeros for a moment
    // after opening the device. Calibrating on those gives a noise floor of
    // zero, which pins the gate to its lower bound — below the actual room — so
    // the room opens the gate and nothing ever closes it. The recorded symptom
    // was a 15-second "utterance" containing no speech.
    const ep = new Endpointer({ ...FAST, calibrateMs: 60 });   // 3 real frames wanted
    ep.push(0); ep.push(0); ep.push(0); ep.push(0);
    assert.equal(ep.state, 'calibrating', 'zeros are not a measurement of anything');
    assert.equal(ep.deadFrames ?? ep.stats().deadFrames, 4);

    ep.push(0.011); ep.push(0.011); ep.push(0.011);
    assert.equal(ep.state, 'waiting');
    assert.ok(Math.abs(ep.noiseFloor - 0.011) < 1e-9, `floor ${ep.noiseFloor}`);
    // The number that actually mattered: 0.0385, not 0.004. Room noise at 0.011
    // now sits below the gate instead of sailing through it.
    assert.ok(ep.threshold > 0.03, `threshold ${ep.threshold}`);
    assert.equal(ep.push(0.011), 'preroll', 'the room must not read as speech');
  });

  test('clearing the gate is not the same as being a voice', () => {
    // Measured on real hardware. A sentence peaked at 11.7× the threshold; a
    // marginal noise that the gate let through peaked at 1.6× — and whisper,
    // handed two seconds of that, returned "Thank you very much." A transcriber
    // does not answer "nothing" when given nothing, so the judgement has to
    // happen before it is asked.
    const speech = calibrated();
    speech.push(0.5); speech.push(0.5); speech.push(0.5);
    assert.equal(speech.heardSpeech, true);
    assert.equal(speech.speechLikely, true);
    assert.ok(speech.stats().peakRatio > 3);

    const noise = calibrated();
    const marginal = noise.threshold * 1.6;
    noise.push(marginal); noise.push(marginal); noise.push(marginal);
    assert.equal(noise.heardSpeech, true, 'the gate did open — that is the point');
    assert.equal(noise.speechLikely, false, 'but it must not be transcribed');
  });

  test('the ratio sits in the gap the measurements actually left', () => {
    // Pinning the four real captures the default was chosen from, so that moving
    // the number has to be a decision rather than an accident. Decodable: 11.7×
    // and 13.2×. Not decodable at any gain: 1.6× and 3.35×.
    const verdictAt = (ratio) => {
      const ep = new Endpointer({ ...FAST });
      ep.push(0.0006); ep.push(0.0006);
      const level = ep.threshold * ratio;
      ep.push(level); ep.push(level); ep.push(level);
      return ep.speechLikely;
    };
    assert.equal(verdictAt(1.6), false, 'a door closing');
    assert.equal(verdictAt(3.35), false, 'produced "(speaking in foreign language)"');
    assert.equal(verdictAt(11.7), true, 'produced "Okay Rose, let\'s get this."');
    assert.equal(verdictAt(13.2), true, 'produced "Kaniyarou\'s status."');
  });

  test('the plausibility ratio is scale-invariant, so quiet speakers are still heard', () => {
    // The reason it is a ratio and not a level: the threshold scales with the
    // room, so somebody talking softly in a silent room clears it by just as
    // much as somebody talking normally in a noisy one. An absolute minimum
    // level would simply refuse to hear quiet people.
    const quiet = new Endpointer({ ...FAST });
    quiet.push(0.0006); quiet.push(0.0006);
    for (let i = 0; i < 3; i++) quiet.push(0.05);
    assert.equal(quiet.speechLikely, true, `ratio ${quiet.stats().peakRatio}`);
  });

  test('the ratio guard can be switched off', () => {
    const ep = new Endpointer({ ...FAST, minPeakRatio: 0 });
    ep.push(0.0006); ep.push(0.0006);
    const marginal = ep.threshold * 1.1;
    ep.push(marginal); ep.push(marginal); ep.push(marginal);
    assert.equal(ep.speechLikely, true);
  });

  test('a muted microphone still terminates rather than calibrating forever', () => {
    // The other half of the fix: zeros forever is a real state (muted, unplugged,
    // wrong device), and waiting for real audio that never comes would hang the
    // capture instead of reporting the problem.
    const ep = new Endpointer({ ...FAST, calibrateMs: 60, maxCalibrateMs: 100, maxWaitMs: 100 });
    let verdict;
    for (let i = 0; i < 40 && verdict !== 'done'; i++) verdict = ep.push(0);
    assert.equal(verdict, 'done');
    assert.equal(ep.reason, 'no-speech');
    assert.equal(ep.heardSpeech, false);
  });

  test('calibration uses the median, so one bang does not deafen it', () => {
    // A door closing during calibration would drag a mean far enough up that
    // the speech which follows never opens the gate at all.
    const ep = new Endpointer({ ...FAST, calibrateMs: 100 });   // 5 frames
    ep.push(0.01); ep.push(0.01); ep.push(0.9); ep.push(0.01); ep.push(0.01);
    assert.equal(ep.noiseFloor, 0.01);
  });

  test('one loud frame is a click, not speech', () => {
    const ep = calibrated({ onsetFrames: 3 });
    assert.equal(ep.push(0.5), 'preroll');
    assert.equal(ep.push(0.0), 'preroll');
    assert.equal(ep.state, 'waiting', 'a single spike must not open the microphone');
    ep.push(0.5); ep.push(0.5);
    assert.equal(ep.state, 'waiting');
    assert.equal(ep.push(0.5), 'keep');
    assert.equal(ep.state, 'speech');
  });

  test('trailing silence ends the utterance, and short gaps do not', () => {
    const ep = calibrated();
    ep.push(0.5); ep.push(0.5);                       // speech
    assert.equal(ep.state, 'speech');

    for (let i = 0; i < 4; i++) assert.equal(ep.push(0), 'keep');   // 4 < 5 frames
    assert.equal(ep.push(0.5), 'keep', 'a pause between words is not the end');
    assert.equal(ep.state, 'speech');

    for (let i = 0; i < 4; i++) ep.push(0);
    assert.equal(ep.push(0), 'done');
    assert.equal(ep.reason, 'endpoint');
  });

  test('a monologue is capped rather than recorded forever', () => {
    const ep = calibrated({ maxUtteranceMs: 200 });   // 10 frames
    let verdict;
    for (let i = 0; i < 20 && verdict !== 'done'; i++) verdict = ep.push(0.5);
    assert.equal(verdict, 'done');
    assert.equal(ep.reason, 'max-duration');
  });

  test('nobody speaking is reported as no-speech, not as an empty utterance', () => {
    const ep = calibrated({ maxWaitMs: 100 });        // 5 frames
    let verdict;
    for (let i = 0; i < 10 && verdict !== 'done'; i++) verdict = ep.push(0);
    assert.equal(verdict, 'done');
    assert.equal(ep.reason, 'no-speech');
    assert.equal(ep.heardSpeech, false);
  });

  test('once done it stays done', () => {
    const ep = calibrated({ maxWaitMs: 40 });
    ep.push(0); ep.push(0);
    assert.equal(ep.push(0.9), 'done', 'a finished capture must not restart');
    assert.equal(ep.reason, 'no-speech');
  });

  test('abort is recorded as a reason, not as an endpoint', () => {
    const ep = calibrated();
    ep.push(0.5); ep.push(0.5);
    ep.abort();
    assert.equal(ep.state, 'done');
    assert.equal(ep.reason, 'aborted');
    assert.equal(ep.heardSpeech, true, 'it still heard something before being cut off');
  });

  test('stats report what was decided and why', () => {
    const ep = calibrated();
    ep.push(0.5); ep.push(0.5);
    for (let i = 0; i < 5; i++) ep.push(0);
    const s = ep.stats();
    assert.equal(s.reason, 'endpoint');
    assert.equal(s.heardSpeech, true);
    assert.ok(s.peak >= 0.5);
    assert.ok(s.speechMs > 0);
    assert.ok(s.threshold > 0);
  });

  function calibrated(opts = {}) {
    const ep = new Endpointer({ ...FAST, ...opts });
    ep.push(ROOM); ep.push(ROOM);
    assert.equal(ep.state, 'waiting');
    return ep;
  }
});

describe('ring buffer', () => {
  test('it keeps the most recent N and forgets the rest', () => {
    const ring = new RingBuffer(2);
    ring.put('a'); ring.put('b'); ring.put('c');
    assert.deepEqual(ring.drain(), ['b', 'c']);
    assert.equal(ring.size, 0, 'draining empties it');
  });

  test('capacity zero keeps nothing at all', () => {
    // Preroll disabled must mean disabled — otherwise it is a recording of the
    // room that nobody asked for, growing for as long as the process lives.
    const ring = new RingBuffer(0);
    ring.put('a');
    assert.deepEqual(ring.drain(), []);
  });
});

// ── Capture, end to end, with a fake recorder ───────────────────────────────

describe('capture: the microphone path', () => {
  const backend = BACKENDS[0];

  test('it returns the speech and drops the leading silence', async () => {
    const audio = utteranceAudio({ leadMs: 400, speechMs: 300, tailMs: 200 });
    const { pcm, reason, stats } = await captureUtterance({
      backend, platform: 'linux', endpoint: { ...FAST, maxWaitMs: 2000 },
      spawnFn: fakeRecorder(audio),
    });

    assert.equal(reason, 'endpoint');
    assert.ok(pcm.length > 0);
    assert.ok(pcm.length < audio.length, 'the silence before the sentence must be discarded');
    assert.ok(rmsOfFrame(pcm) > stats.threshold, 'what came back must actually contain the speech');
    assert.equal(stats.heardSpeech, true);
  });

  test('preroll keeps the first consonant instead of clipping it', async () => {
    // Speech is only recognised a few frames after it starts, so without a
    // preroll every utterance loses its opening sound. Measured as a difference
    // rather than an absolute, because the absolute is an implementation detail.
    const audio = utteranceAudio({ leadMs: 200, speechMs: 200, tailMs: 200 });
    const withPre = await captureUtterance({
      backend, platform: 'linux', endpoint: { ...FAST, prerollMs: 40 }, spawnFn: fakeRecorder(audio),
    });
    const without = await captureUtterance({
      backend, platform: 'linux', endpoint: { ...FAST, prerollMs: 0 }, spawnFn: fakeRecorder(audio),
    });
    assert.equal(withPre.pcm.length - without.pcm.length, 2 * FRAME_BYTES);
  });

  test('awkward chunk sizes produce byte-identical audio', async () => {
    // The pipe does not deliver neat 20ms frames. If this diverges, the fault
    // is in the splitter and it would only ever show up as bad transcripts.
    const audio = utteranceAudio();
    const aligned = await captureUtterance({
      backend, platform: 'linux', endpoint: FAST, spawnFn: fakeRecorder(audio, { chunkSize: FRAME_BYTES }),
    });
    for (const chunkSize of [1, 337, 999, 4096]) {
      const odd = await captureUtterance({
        backend, platform: 'linux', endpoint: FAST, spawnFn: fakeRecorder(audio, { chunkSize }),
      });
      assert.deepEqual(odd.pcm, aligned.pcm, `chunk size ${chunkSize} changed the audio`);
    }
  });

  test('the recorder is killed once the sentence is over', async () => {
    // Otherwise the microphone stays open between utterances, and the "in use"
    // indicator stays lit while nothing is listening.
    let child;
    await captureUtterance({
      backend, platform: 'linux', endpoint: FAST,
      spawnFn: fakeRecorder(utteranceAudio(), { onSpawn: (c) => { child = c; } }),
    });
    assert.equal(child.killed, true);
  });

  test('silence times out as no-speech and keeps no audio', async () => {
    const { reason, stats, pcm } = await captureUtterance({
      backend, platform: 'linux', endpoint: { ...FAST, maxWaitMs: 200 },
      spawnFn: fakeRecorder(roomPcm(2000)),
    });
    assert.equal(reason, 'no-speech');
    assert.equal(stats.heardSpeech, false);
    assert.ok(pcm.length <= 2 * FRAME_BYTES, 'only the preroll may survive');
  });

  test('an abort mid-capture stops immediately', async () => {
    const controller = new AbortController();
    const audio = utteranceAudio({ leadMs: 100, speechMs: 4000, tailMs: 0 });
    const promise = captureUtterance({
      backend, platform: 'linux', endpoint: { ...FAST, maxUtteranceMs: 60000 }, signal: controller.signal,
      spawnFn: fakeRecorder(audio, { chunkSize: FRAME_BYTES }),
    });
    controller.abort();
    const { reason } = await promise;
    assert.equal(reason, 'aborted');
  });

  test('a signal that is already aborted never opens the microphone', async () => {
    const controller = new AbortController();
    controller.abort();
    let child;
    const { reason, pcm } = await captureUtterance({
      backend, platform: 'linux', endpoint: FAST, signal: controller.signal,
      spawnFn: fakeRecorder(utteranceAudio(), { onSpawn: (c) => { child = c; } }),
    });
    assert.equal(reason, 'aborted');
    assert.equal(pcm.length, 0);
    assert.equal(child.killed, true);
  });

  test('a recorder that dies reports its own error, not a generic one', async () => {
    // On Windows this is almost always "no such dshow device", and ffmpeg's
    // wording is far more useful than anything that could be invented here.
    await assert.rejects(
      captureUtterance({
        backend, platform: 'linux', endpoint: FAST,
        spawnFn: fakeRecorder(Buffer.alloc(0), {
          exitAfter: 1,
          stderr: 'Could not find audio only device with name [default]',
        }),
      }),
      (err) => {
        assert.equal(err.code, 'ERECORDER');
        assert.match(err.message, /exited 1/);
        assert.match(err.message, /Could not find audio only device/);
        return true;
      },
    );
  });

  test('a recorder that opens and then goes silent is reported, not waited on', async () => {
    // Found by this suite hanging its own harness. Every timeout in the
    // endpointer advances one frame at a time, so a recorder that produces *no
    // frames at all* trips none of them — the device is muted, or held by
    // another application, and the session waits forever for a sentence that
    // cannot arrive. A capture must always terminate.
    await assert.rejects(
      captureUtterance({
        backend, platform: 'linux', endpoint: FAST, stallMs: 60,
        spawnFn: () => new FakeChild(),      // opens, emits nothing, never exits
      }),
      (err) => {
        assert.equal(err.code, 'ESTALL');
        assert.match(err.message, /no audio for 60ms/);
        assert.match(err.message, /muted, in use by another application/);
        return true;
      },
    );
  });

  test('the stall clock resets on every chunk, so slow speech is not cut off', async () => {
    // A watchdog that measured total duration instead of the gap since the last
    // byte would kill long utterances — which is the opposite of the bug.
    const audio = utteranceAudio({ leadMs: 100, speechMs: 400, tailMs: 200 });
    const { reason } = await captureUtterance({
      backend, platform: 'linux', endpoint: FAST, stallMs: 80,
      spawnFn: (command, args, opts) => {
        const child = new FakeChild();
        let i = 0;
        const tick = () => {
          if (child.killed || i >= audio.length) return;
          child.stdout.emit('data', audio.subarray(i, i + FRAME_BYTES));
          i += FRAME_BYTES;
          setTimeout(tick, 10).unref?.();
        };
        setTimeout(tick, 10).unref?.();
        return child;
      },
    });
    assert.equal(reason, 'endpoint');
  });

  test('a spawn error propagates rather than hanging forever', async () => {
    await assert.rejects(
      captureUtterance({
        backend, platform: 'linux', endpoint: FAST,
        spawnFn: () => { const c = new FakeChild(); queueMicrotask(() => c.emit('error', new Error('EACCES'))); return c; },
      }),
      /EACCES/,
    );
  });

  test('a level meter that throws does not break the capture', async () => {
    const { reason } = await captureUtterance({
      backend, platform: 'linux', endpoint: FAST,
      onLevel: () => { throw new Error('the UI fell over'); },
      spawnFn: fakeRecorder(utteranceAudio()),
    });
    assert.equal(reason, 'endpoint', 'a broken meter must not cost the utterance');
  });

  test('the level meter sees the speech rise above the floor', async () => {
    const levels = [];
    await captureUtterance({
      backend, platform: 'linux', endpoint: FAST, onLevel: (l) => levels.push(l),
      spawnFn: fakeRecorder(utteranceAudio()),
    });
    assert.ok(levels.length > 5);
    assert.ok(Math.max(...levels) > 0.3, 'the tone should have registered');
    // The quiet part is quiet, not absent. Zero would mean the device was not
    // running, which the endpointer now treats as a different thing entirely.
    const min = Math.min(...levels);
    assert.ok(min > 0 && min < 0.01, `expected a room floor, got ${min}`);
  });

  test('clipping is reported alongside the endpointer stats', async () => {
    // It has to travel with the rest, because the caller decides what to say
    // about the capture and clipping is the one fault whose remedy the owner
    // has to apply themselves.
    const { stats } = await captureUtterance({
      backend, platform: 'linux', endpoint: FAST,
      spawnFn: fakeRecorder(utteranceAudio({ amplitude: 1 })),
    });
    assert.equal(stats.clipping, true);
    assert.ok(stats.clipped > 0);
    assert.ok(stats.peakSample >= 0.99, `peak ${stats.peakSample}`);
    assert.ok('threshold' in stats, 'the endpointer measurements must survive the merge');
  });

  test('the recorder is asked for exactly the format everything downstream assumes', async () => {
    let seen;
    await captureUtterance({
      backend, platform: 'win32', endpoint: FAST,
      // Named explicitly so this stays a test about the audio format, not
      // about device discovery.
      device: 'Microphone (Realtek)',
      spawnFn: fakeRecorder(utteranceAudio(), { onSpawn: (c) => { seen = c; } }),
    });
    const args = seen.spawnArgs.args.join(' ');
    assert.match(args, /-ar 16000/);
    assert.match(args, /-ac 1/);
    assert.match(args, /s16le/);
    assert.equal(seen.spawnArgs.opts.windowsHide, true, 'a console window must not flash up');
  });
});

// ── Backend selection ───────────────────────────────────────────────────────

describe('finding a recorder', () => {
  /** @param {Record<string, boolean>} available */
  function probeSpawn(available) {
    return (command) => {
      const child = new FakeChild();
      queueMicrotask(() => {
        if (available[command]) child.emit('exit', 0);
        else { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; child.emit('error', e); }
      });
      return child;
    };
  }

  test('the first working recorder wins', async () => {
    const { backend, tried } = await detectRecorder({
      platform: 'linux', spawnFn: probeSpawn({ rec: true, arecord: true }),
    });
    assert.equal(backend.name, 'sox');
    assert.equal(tried[0].name, 'ffmpeg');
    assert.equal(tried[0].ok, false);
    assert.equal(tried[0].reason, 'not installed');
  });

  test('a preference is honoured when it works', async () => {
    const { backend } = await detectRecorder({
      platform: 'linux', prefer: 'arecord', spawnFn: probeSpawn({ ffmpeg: true, arecord: true }),
    });
    assert.equal(backend.name, 'arecord');
  });

  test('a preference that is not installed falls through instead of failing', async () => {
    const { backend } = await detectRecorder({
      platform: 'linux', prefer: 'arecord', spawnFn: probeSpawn({ ffmpeg: true }),
    });
    assert.equal(backend.name, 'ffmpeg');
  });

  test('linux-only recorders are not offered on Windows', async () => {
    const { tried } = await detectRecorder({ platform: 'win32', spawnFn: probeSpawn({}) });
    assert.deepEqual(tried.map(t => t.name), ['ffmpeg', 'sox']);
  });

  test('a recorder that runs but exits non-zero still counts', async () => {
    // `rec --version` exits non-zero on some sox builds while working fine.
    const { backend } = await detectRecorder({
      platform: 'linux',
      spawnFn: (command) => {
        const child = new FakeChild();
        queueMicrotask(() => {
          if (command === 'rec') child.emit('exit', 2);
          else { const e = new Error('nope'); e.code = 'ENOENT'; child.emit('error', e); }
        });
        return child;
      },
    });
    assert.equal(backend.name, 'sox');
  });

  test('a recorder installed but not on PATH is still found', async () => {
    // Real case: `winget install ffmpeg` edits PATH, but a process that is
    // already running keeps the environment it started with — and the daemon
    // may have started weeks ago. "Not on PATH" would otherwise be reported as
    // "no microphone on this machine", which is a different and wrong answer.
    const installed = 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_x\\ffmpeg-9.0\\bin\\ffmpeg.exe';
    const { backend, tried } = await detectRecorder({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      existsFn: (p) => p === installed,
      spawnFn: (command) => {
        const child = new FakeChild();
        queueMicrotask(() => {
          if (command === installed) child.emit('exit', 0);
          else { const e = new Error('nope'); e.code = 'ENOENT'; child.emit('error', e); }
        });
        return child;
      },
      // The winget layout is a package directory containing a versioned
      // directory containing bin/, so the search has to walk one level down.
      readdirFn: (dir) => {
        if (dir.endsWith('Packages')) return ['Gyan.FFmpeg_x'];
        if (dir.endsWith('Gyan.FFmpeg_x')) return ['ffmpeg-9.0'];
        return [];
      },
    });

    assert.ok(backend, `not found; tried ${JSON.stringify(tried)}`);
    assert.equal(backend.command, installed);
    assert.equal(tried[0].reason, 'found off PATH', 'and it should say why it needed looking for');
  });

  test('a recorder that never answers the probe is not selected', async () => {
    // Same trap as the speech probe: the timeout kills the child, and if that
    // kill delivered 'exit' synchronously the exit handler would mark the
    // recorder usable — so a probe that timed out would select it, and the
    // failure would surface later, the first time somebody spoke.
    const { backend, tried } = await detectRecorder({
      platform: 'win32', probeMs: 50,
      spawnFn: () => {
        // Emits 'exit' the instant it is killed — the adversarial case. A real
        // process delivers it a tick later, which is why kill-then-settle
        // *looks* correct and passes with a lazier fake.
        const child = new FakeChild();
        child.kill = () => { child.killed = true; child.emit('exit', null); return true; };
        return child;
      },
    });
    assert.equal(backend, null);
    assert.equal(tried.every(t => t.reason === 'timed out'), true, JSON.stringify(tried));
  });

  test('nothing installed is a configuration problem with instructions', async () => {
    const { backend, tried } = await detectRecorder({ platform: 'win32', spawnFn: probeSpawn({}) });
    assert.equal(backend, null);

    const message = describeMissingRecorder(tried, 'win32');
    assert.match(message, /No audio recorder found/);
    assert.match(message, /ffmpeg/);
    assert.match(message, /winget install/, 'telling someone what is missing without how to get it is half an error');
    assert.doesNotMatch(message, /arecord/, 'do not suggest a linux-only tool on Windows');
  });

  test('captureUtterance surfaces the same guidance rather than a stack trace', async () => {
    await assert.rejects(
      captureUtterance({ platform: 'win32', spawnFn: probeSpawn({}) }),
      (err) => {
        assert.equal(err.code, 'ENORECORDER');
        assert.match(err.message, /winget install|brew install/);
        return true;
      },
    );
  });
});

// ── Choosing a microphone ───────────────────────────────────────────────────

describe('naming the device, which Windows requires', () => {
  // Windows has no `default` audio device that ffmpeg can be asked for by name.
  // `-i audio=default` fails outright, so a device must be discovered first.
  // Every other platform has a real default, which is why this is Windows-only.

  const MODERN = `
[in#0 @ 000001f9] "マイク (Realtek(R) Audio)" (audio)
[in#0 @ 000001f9] "HD Webcam" (video)
[in#0 @ 000001f9] "Headset (Bluetooth)" (audio)
`.trim();

  const OLDER = `
[dshow @ 0000] DirectShow video devices
[dshow @ 0000]  "HD Webcam"
[dshow @ 0000]     Alternative name "@device_pnp_\\\\?\\usb#vid_046d"
[dshow @ 0000] DirectShow audio devices
[dshow @ 0000]  "Microphone (Realtek Audio)"
[dshow @ 0000]     Alternative name "@device_cm_{33D9A762}\\wave"
`.trim();

  test('modern output: audio devices only, in order', () => {
    assert.deepEqual(parseDshowAudioDevices(MODERN),
      ['マイク (Realtek(R) Audio)', 'Headset (Bluetooth)']);
  });

  test('a non-ASCII device name survives intact', () => {
    // The microphone on the machine this was written on is called マイク. A
    // name mangled here produces "Could not find audio only device", which
    // reads like the microphone is missing rather than misspelled.
    assert.equal(parseDshowAudioDevices(MODERN)[0], 'マイク (Realtek(R) Audio)');
  });

  test('older sectioned output is understood too', () => {
    assert.deepEqual(parseDshowAudioDevices(OLDER), ['Microphone (Realtek Audio)']);
  });

  test('"Alternative name" is a device path, not a second microphone', () => {
    // Counting it would double every device and make the *path* the default.
    assert.equal(parseDshowAudioDevices(OLDER).length, 1);
  });

  test('video devices are never offered as microphones', () => {
    for (const text of [MODERN, OLDER]) {
      assert.ok(!parseDshowAudioDevices(text).some(d => /webcam/i.test(d)));
    }
  });

  test('no devices is an empty list, not a crash', () => {
    assert.deepEqual(parseDshowAudioDevices(''), []);
    assert.deepEqual(parseDshowAudioDevices('nothing here'), []);
  });

  test('capture names the discovered device instead of "default"', async () => {
    resetDeviceCache();
    let listCall = 0;
    let recordArgs = null;
    const spawnFn = (command, args, opts) => {
      if (args.includes('-list_devices')) {
        listCall++;
        const child = new FakeChild();
        queueMicrotask(() => { child.stderr.emit('data', Buffer.from(MODERN)); child.emit('exit', 1); });
        return child;
      }
      recordArgs = args;
      return fakeRecorder(utteranceAudio())(command, args, opts);
    };

    const { reason } = await captureUtterance({
      backend: BACKENDS[0], platform: 'win32', endpoint: FAST, spawnFn,
    });

    assert.equal(reason, 'endpoint');
    assert.equal(listCall, 1);
    assert.ok(recordArgs.includes('audio=マイク (Realtek(R) Audio)'),
      `expected the real device, got: ${recordArgs.join(' ')}`);
    assert.ok(!recordArgs.includes('audio=default'), '"default" is not a DirectShow device');
  });

  test('the device is resolved once, not on every utterance', async () => {
    // Enumerating costs about a second. Paying it per utterance would land
    // squarely in the wake-to-answer measurement.
    resetDeviceCache();
    let listCall = 0;
    const spawnFn = (command, args, opts) => {
      if (args.includes('-list_devices')) {
        listCall++;
        const child = new FakeChild();
        queueMicrotask(() => { child.stderr.emit('data', Buffer.from(MODERN)); child.emit('exit', 1); });
        return child;
      }
      return fakeRecorder(utteranceAudio())(command, args, opts);
    };

    for (let i = 0; i < 3; i++) {
      await captureUtterance({ backend: BACKENDS[0], platform: 'win32', endpoint: FAST, spawnFn });
    }
    assert.equal(listCall, 1);
  });

  test('an explicit --device is used as given, with no enumeration', async () => {
    resetDeviceCache();
    let listCall = 0;
    let recordArgs = null;
    const spawnFn = (command, args, opts) => {
      if (args.includes('-list_devices')) { listCall++; }
      recordArgs = args;
      return fakeRecorder(utteranceAudio())(command, args, opts);
    };

    await captureUtterance({
      backend: BACKENDS[0], platform: 'win32', device: 'Headset (Bluetooth)', endpoint: FAST, spawnFn,
    });
    assert.equal(listCall, 0, 'the user named a device; do not go looking');
    assert.ok(recordArgs.includes('audio=Headset (Bluetooth)'));
  });

  test('no microphone at all is a clear error, not a silent empty recording', async () => {
    resetDeviceCache();
    await assert.rejects(
      captureUtterance({
        backend: BACKENDS[0], platform: 'win32', endpoint: FAST,
        spawnFn: (command, args) => {
          const child = new FakeChild();
          if (args.includes('-list_devices')) {
            queueMicrotask(() => { child.stderr.emit('data', Buffer.from('no devices')); child.emit('exit', 1); });
          }
          return child;
        },
      }),
      (err) => {
        assert.equal(err.code, 'ENODEVICE');
        assert.match(err.message, /Windows sound settings/);
        return true;
      },
    );
  });

  test('non-Windows platforms never enumerate — they have a real default', async () => {
    let listCall = 0;
    const spawnFn = (command, args, opts) => {
      if (args.includes('-list_devices')) listCall++;
      return fakeRecorder(utteranceAudio())(command, args, opts);
    };
    await captureUtterance({ backend: BACKENDS[0], platform: 'linux', endpoint: FAST, spawnFn });
    assert.equal(listCall, 0);
  });
});

// ── The join to VoiceSession ────────────────────────────────────────────────

describe('microphoneStt', () => {
  const backend = BACKENDS[0];

  test('it records, then transcribes only what was said', async () => {
    let got = null;
    const stt = microphoneStt({
      backend, platform: 'linux', endpoint: FAST,
      spawnFn: fakeRecorder(utteranceAudio()),
      transcribe: async (pcm, format) => { got = { pcm, format }; return 'what time is it'; },
    });

    const result = await stt({});
    assert.equal(result.text, 'what time is it');
    assert.equal(result.confidence, 1);
    assert.ok(got.pcm.length > 0);
    assert.equal(got.format.sampleRate, 16000, 'the transcriber must be told the rate, not guess');
  });

  test('silence never reaches the transcriber', async () => {
    // The point of gating on energy: the room is not transcribed continuously.
    let called = 0;
    const stt = microphoneStt({
      backend, platform: 'linux', endpoint: { ...FAST, maxWaitMs: 200 },
      spawnFn: fakeRecorder(roomPcm(1000)),
      transcribe: async () => { called++; return 'hallucinated words'; },
    });

    const result = await stt({});
    assert.equal(called, 0, 'transcribing silence is how a model invents an instruction');
    assert.equal(result.text, '');
    assert.equal(result.confidence, 0);
  });

  test('onAudio sees exactly the bytes the transcriber sees', async () => {
    // Diagnostics for the one question that cannot be reasoned about: when a
    // transcript is wrong, was the recording bad or the decode bad?
    let kept = null;
    let given = null;
    const stt = microphoneStt({
      backend, platform: 'linux', endpoint: FAST,
      spawnFn: fakeRecorder(utteranceAudio()),
      onAudio: (pcm, format, stats) => { kept = { pcm, format, stats }; },
      transcribe: async (pcm) => { given = pcm; return 'status'; },
    });

    await stt({});
    assert.ok(kept, 'onAudio was never called');
    assert.equal(kept.pcm, given, 'a copy would let the two diverge, which defeats the purpose');
    assert.equal(kept.format.sampleRate, 16000);
    assert.ok(kept.stats.speechMs > 0);
  });

  test('a silent capture keeps nothing — the room is not written to disk', async () => {
    let calls = 0;
    const stt = microphoneStt({
      backend, platform: 'linux', endpoint: { ...FAST, maxWaitMs: 200 },
      spawnFn: fakeRecorder(roomPcm(1000)),
      onAudio: () => { calls++; },
      transcribe: async () => 'unreachable',
    });

    await stt({});
    assert.equal(calls, 0);
  });

  test('a noise that cleared the gate is never transcribed', async () => {
    // The whole failure chain in one test: gate opens on a noise, transcriber is
    // asked what it was, transcriber invents a fluent sentence, router acts on
    // it. Cutting it at the second link is the only place a defence exists.
    let asked = 0;
    let kept = null;
    const stt = microphoneStt({
      backend, platform: 'linux', endpoint: FAST,
      // Loud enough to open a gate calibrated on near-silence, nowhere near
      // loud enough to be a voice.
      spawnFn: fakeRecorder(utteranceAudio({ amplitude: 0.008 })),
      onAudio: (pcm, format, stats) => { kept = stats; },
      transcribe: async () => { asked++; return 'Thank you very much.'; },
    });

    const result = await stt({});
    assert.equal(asked, 0, 'a transcriber given a noise does not answer "nothing"');
    assert.equal(result.text, '');
    assert.equal(result.confidence, 0);
    assert.ok(kept, 'a rejected capture is still offered for inspection — it is the interesting one');
    assert.equal(kept.speechLikely, false);
  });

  test('a throwing onAudio does not break listening', async () => {
    // A full disk must not stop the assistant from hearing you.
    const stt = microphoneStt({
      backend, platform: 'linux', endpoint: FAST,
      spawnFn: fakeRecorder(utteranceAudio()),
      onAudio: () => { throw new Error('ENOSPC'); },
      transcribe: async () => 'status',
    });
    assert.equal((await stt({})).text, 'status');
  });

  test('a cancelled capture raises AbortError, which VoiceSession understands', async () => {
    const controller = new AbortController();
    const stt = microphoneStt({
      backend, platform: 'linux', endpoint: { ...FAST, maxUtteranceMs: 60000 },
      spawnFn: fakeRecorder(utteranceAudio({ speechMs: 4000, tailMs: 0 })),
      transcribe: async () => 'should not get here',
    });
    const promise = stt({ signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, (err) => err.name === 'AbortError');
  });

  test('a transcriber may return an object with its own confidence', async () => {
    const stt = microphoneStt({
      backend, platform: 'linux', endpoint: FAST, spawnFn: fakeRecorder(utteranceAudio()),
      transcribe: async () => ({ text: '  maybe this  ', confidence: 0.3 }),
    });
    const result = await stt({});
    assert.equal(result.text, 'maybe this');
    assert.equal(result.confidence, 0.3, 'a low score must survive to VoiceSession, which rejects on it');
  });

  test('it refuses to be constructed without a transcriber', () => {
    assert.throws(() => microphoneStt({}), /transcribe/);
  });
});

// ── Transcript hygiene ──────────────────────────────────────────────────────

describe('transcripts', () => {
  test('non-speech annotations are removed, not routed', () => {
    // Whisper emits these when it hears something that is not words. Passing
    // them on means asking the router for the intent of a gust of wind — and a
    // confident classifier will find one.
    assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
    assert.equal(cleanTranscript('  [Music]  '), '');
    assert.equal(cleanTranscript('(wind blowing)'), '');
    assert.equal(cleanTranscript('[_TT_170] check the build'), 'check the build');
    assert.equal(cleanTranscript('what time is it'), 'what time is it');
  });

  test('ordinary parenthesised speech is kept', () => {
    assert.equal(cleanTranscript('deploy it (the staging one)'), 'deploy it (the staging one)');
  });

  test('annotations longer than the shape rule are still removed', () => {
    // Observed live: quiet or clipped input makes whisper decide the speaker is
    // not speaking English, and it says so — in four words, which the ≤3-word
    // shape rule lets through. It reached the router, which then asked what
    // "(speaking in foreign language)" meant.
    assert.equal(cleanTranscript('(speaking in foreign language)'), '');
    assert.equal(cleanTranscript('(speaking in foreign language) (speaking in foreign language)'), '');
    assert.equal(cleanTranscript('(background noise and chatter) status'), 'status');
    assert.equal(cleanTranscript('(unintelligible speech here) status'), 'status');
    assert.equal(cleanTranscript('(inaudible)'), '');
  });

  test('speech that merely resembles an annotation survives', () => {
    // The anchors have to be tight or the cure is worse: deleting half an
    // instruction is a bigger failure than passing one annotation through.
    assert.equal(
      cleanTranscript('deploy it (speaking of which, check prod)'),
      'deploy it (speaking of which, check prod)',
    );
    assert.equal(cleanTranscript('mute it (no audible difference)'), 'mute it (no audible difference)');
  });

  test('whitespace is normalised so the router sees one shape', () => {
    assert.equal(cleanTranscript('\n  run   the\ttests \n'), 'run the tests');
  });

  test('an installed whisper.cpp is found without being told where', async () => {
    // Third time this pattern was needed: the shell, the recorder, and now the
    // transcriber. On Windows *installed* and *on PATH* are different things,
    // and the daemon inherits whatever environment it started with.
    const files = new Set([
      'C:\\Users\\x\\AppData\\Local\\whisper.cpp\\Release\\whisper-cli.exe',
      'C:\\Users\\x\\AppData\\Local\\whisper.cpp\\models',
    ]);
    const found = findWhisper({
      env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      existsFn: (p) => files.has(p),
      readdirFn: () => ['ggml-base.en.bin'],
    });
    assert.ok(found, 'the binary was not found');
    assert.match(found.command, /whisper-cli\.exe$/);
    assert.match(found.model, /ggml-base\.en\.bin$/);
  });

  test('an English model is preferred over a multilingual one', () => {
    // `.en` models are faster and more accurate for English, which is what the
    // wake word and the command grammar both assume.
    const found = findWhisper({
      env: { LOCALAPPDATA: 'C:\\L' },
      existsFn: (p) => p.endsWith('whisper-cli.exe') || p.endsWith('models'),
      readdirFn: () => ['ggml-large-v3.bin', 'ggml-base.en.bin'],
    });
    assert.match(found.model, /\.en\.bin$/);
  });

  test('a binary with no model reports the binary, not a false negative', () => {
    // The distinction matters: "no transcriber" and "transcriber but no model"
    // need different instructions.
    const found = findWhisper({
      env: { LOCALAPPDATA: 'C:\\L' },
      existsFn: (p) => p.endsWith('whisper-cli.exe'),
      readdirFn: () => [],
    });
    assert.ok(found.command);
    assert.equal(found.model, null);
  });

  test('nothing installed returns null rather than a guess', () => {
    assert.equal(findWhisper({ env: {}, existsFn: () => false, readdirFn: () => [] }), null);
  });

  test('the audio file is deleted even when transcription fails', async () => {
    // A crash must not leave recordings of somebody's room on disk.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-stt-test-'));
    try {
      const transcribe = fileTranscriber({
        command: 'whatever', tmpDir,
        spawnFn: (command, args) => {
          const child = new FakeChild();
          // The WAV must exist at the moment the transcriber is invoked...
          const wav = args.find(a => a.endsWith('.wav'));
          assert.ok(fs.existsSync(wav), 'the transcriber was given a path to nothing');
          assert.equal(fs.readFileSync(wav).subarray(0, 4).toString(), 'RIFF');
          queueMicrotask(() => { child.stderr.emit('data', 'model missing'); child.emit('exit', 3); });
          return child;
        },
      });

      await assert.rejects(transcribe(synthPcm({ ms: 50, amplitude: 0.4 }), CAPTURE_FORMAT), /exited 3/);
      // ...and be gone afterwards.
      assert.deepEqual(fs.readdirSync(tmpDir), [], 'audio was left behind after a failure');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('a successful transcription also cleans up', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-stt-test-'));
    try {
      const transcribe = fileTranscriber({
        command: 'whatever', tmpDir,
        spawnFn: () => {
          const child = new FakeChild();
          queueMicrotask(() => { child.stdout.emit('data', ' hello there \n'); child.emit('exit', 0); });
          return child;
        },
      });
      const result = await transcribe(synthPcm({ ms: 50, amplitude: 0.4 }), CAPTURE_FORMAT);
      assert.equal(result.text, 'hello there');
      assert.deepEqual(fs.readdirSync(tmpDir), []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Calibrating while the user is already talking ───────────────────────────
//
// The failure this guards against, observed live against the real microphone:
// in a continuous listen loop the recorder reopens the instant the previous
// utterance ends, and the user — mid-thought — speaks straight into the 300ms
// calibration window. Most of those frames are then speech, so a MEDIAN floor
// is a speech-level floor, and the gate ends up above the very voice it exists
// to detect.
//
// Real numbers from that session: gate 0.0062 on a clean open, 0.1143 when
// talked over (18x), and genuine speech at peak 0.2463 rejected as "only
// 2.15x over the gate". Ninety existing tests passed throughout, because every
// fixture politely calibrated on silence first.

describe('endpointer: the user is already talking when the microphone opens', () => {
  /** Ten frames: `speechFrames` of voice, the rest inter-word gaps at room level. */
  function talkedOver(ep, { speechFrames, level = 0.3, room = ROOM, total = 10 }) {
    for (let i = 0; i < total; i++) ep.push(i < speechFrames ? level : room);
    return ep;
  }

  test('a window that is mostly speech still yields a room-level floor', () => {
    const ep = talkedOver(new Endpointer({ ...FAST, calibrateMs: 200, frameMs: 20 }), { speechFrames: 7 });
    assert.equal(ep.state, 'waiting', 'calibration should have completed');
    assert.ok(
      ep.threshold <= 0.01,
      `the gate must stay near the room, not the voice — got ${ep.threshold}`,
    );
  });

  test('and the speech that follows still clears that gate', () => {
    const ep = talkedOver(new Endpointer({ ...FAST, calibrateMs: 200, frameMs: 20 }), { speechFrames: 7 });
    // Three consecutive loud frames is the onset condition.
    ep.push(0.3); ep.push(0.3);
    assert.equal(ep.push(0.3), 'keep', 'speech after a talked-over calibration must be detected');
    assert.equal(ep.state, 'speech');
  });

  test('the regression it replaces: a median floor would gate the voice out', () => {
    // Same audio, median behaviour. This is what shipped, and what failed live.
    const median = talkedOver(
      new Endpointer({ ...FAST, calibrateMs: 200, frameMs: 20, noisePercentile: 0.5 }),
      { speechFrames: 7 },
    );
    assert.ok(median.threshold > 0.5, `median floor gates at ${median.threshold} — above normal speech`);
    // Proving the fix is not cosmetic: the same input, two settings, opposite outcomes.
    const low = talkedOver(new Endpointer({ ...FAST, calibrateMs: 200, frameMs: 20 }), { speechFrames: 7 });
    assert.ok(low.threshold < median.threshold / 10);
  });

  test('a clean open is unaffected — a quiet room still floors at floorFloor', () => {
    const ep = new Endpointer({ ...FAST, calibrateMs: 200, frameMs: 20 });
    for (let i = 0; i < 10; i++) ep.push(ROOM);
    assert.equal(ep.threshold, 0.004, 'unchanged from the median behaviour for an honest window');
  });

  test('a genuinely noisy room still raises the bar', () => {
    // The low percentile must not throw away real, sustained room noise —
    // otherwise every fan and air conditioner becomes speech.
    const ep = new Endpointer({ ...FAST, calibrateMs: 200, frameMs: 20 });
    for (let i = 0; i < 10; i++) ep.push(0.02);
    assert.ok(ep.threshold > 0.004, `a noisy room must raise the gate, got ${ep.threshold}`);
    assert.ok(Math.abs(ep.threshold - 0.07) < 1e-9, `0.02 x 3.5, got ${ep.threshold}`);
  });

  test('a door slam during calibration is still ignored', () => {
    // The property the median was chosen for in the first place; a lower
    // percentile only strengthens it.
    const ep = new Endpointer({ ...FAST, calibrateMs: 200, frameMs: 20 });
    ep.push(0.9);
    for (let i = 0; i < 9; i++) ep.push(ROOM);
    assert.equal(ep.threshold, 0.004, 'one loud transient must not set the floor');
  });

  test('the percentile is clamped to a valid quantile', () => {
    for (const p of [-5, 0, 0.5, 1, 99]) {
      const ep = new Endpointer({ ...FAST, calibrateMs: 200, frameMs: 20, noisePercentile: p });
      for (let i = 0; i < 10; i++) ep.push(ROOM);
      assert.ok(Number.isFinite(ep.threshold), `percentile ${p} produced ${ep.threshold}`);
      assert.ok(ep.threshold >= 0.004);
    }
  });
});
