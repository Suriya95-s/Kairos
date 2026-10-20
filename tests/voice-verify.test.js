// tests/voice-verify.test.js
// Speaker verification (8.6): the assistant obeys one voice.
//
// The engine itself — sherpa-onnx's embedding model — is not under test here,
// any more than whisper.cpp is. What is under test is everything Kairos wraps
// around it: discovery, enrollment arithmetic, the gate's decision, and the
// property that matters most in a noisy room — a stranger's words are never
// transcribed at all.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import {
  findSpeakerEngine, cosineSimilarity, averageEmbedding, buildVoiceprint,
  speakerVerifier, saveVoiceprint, loadVoiceprint, embeddingsOfFiles,
  analyzeSamples,
} from '../src/voice/verify.js';
import { microphoneStt, BACKENDS } from '../src/voice/capture.js';
import { synthPcm } from '../src/voice/pcm.js';
import { VoiceSession } from '../src/voice/session.js';

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
  kill() { this.emit('exit', null); return true; }
}

/** A speaker engine that emits `embedding` for every wav it is handed. */
function fakeEngineSpawn(embedding, { exitCode = 0, stderr = '' } = {}) {
  return (command, args) => {
    const child = new FakeChild();
    queueMicrotask(() => {
      const wavs = args.filter(a => a.endsWith('.wav'));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.stdout.emit('data', Buffer.from(JSON.stringify(
        wavs.map(w => ({ file: w, embedding })),
      )));
      child.emit('exit', exitCode);
    });
    return child;
  };
}

const ENGINE = { lib: 'C:\\fake\\sherpa\\node', model: 'C:\\fake\\sherpa\\models\\campp.onnx' };

// Orthogonal-ish embeddings for “different voices”.
const OWNER = [1, 0, 0.5, 0.2];
const STRANGER = [0, 1, -0.5, 0.1];

// ── Discovery ───────────────────────────────────────────────────────────────

describe('speaker engine discovery', () => {
  test('an installed engine is found without being told where', () => {
    const files = new Set([
      'C:\\Users\\x\\AppData\\Local\\sherpa-onnx\\node\\node_modules\\sherpa-onnx-node',
      'C:\\Users\\x\\AppData\\Local\\sherpa-onnx\\models',
    ]);
    const found = findSpeakerEngine({
      env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      existsFn: (p) => files.has(p),
      readdirFn: () => ['wespeaker_en_voxceleb_CAM++.onnx'],
    });
    assert.ok(found, 'should have been discovered');
    assert.match(found.lib, /sherpa-onnx[\\/]node$/);
    assert.match(found.model, /CAM\+\+\.onnx$/);
  });

  test('a directory without the addon is not an engine', () => {
    // The directory existing is what a half-finished `npm install` leaves.
    // Reporting that as working would fail at the first utterance instead of
    // at `voice check`.
    const found = findSpeakerEngine({
      env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      existsFn: (p) => p === 'C:\\Users\\x\\AppData\\Local\\sherpa-onnx\\node',
      readdirFn: () => [],
    });
    assert.equal(found, null);
  });

  test('an engine with no model is not an engine', () => {
    const files = new Set([
      'C:\\Users\\x\\AppData\\Local\\sherpa-onnx\\node\\node_modules\\sherpa-onnx-node',
    ]);
    const found = findSpeakerEngine({
      env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      existsFn: (p) => files.has(p),
      readdirFn: () => [],
    });
    assert.equal(found, null);
  });

  test('nothing installed returns null rather than a guess', () => {
    assert.equal(findSpeakerEngine({ env: {}, existsFn: () => false, readdirFn: () => [] }), null);
  });
});

// ── Arithmetic ──────────────────────────────────────────────────────────────

describe('voiceprint arithmetic', () => {
  test('cosine similarity behaves like cosine similarity', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
    // Degenerate inputs must not divide by zero or throw mid-listen.
    assert.equal(cosineSimilarity([], [1]), 0);
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
    assert.equal(cosineSimilarity(null, [1]), 0);
  });

  test('averaging keeps the dimension and refuses mismatched ones', () => {
    assert.deepEqual(averageEmbedding([[1, 3], [3, 5]]), [2, 4]);
    assert.throws(() => averageEmbedding([[1, 2], [1, 2, 3]]), /dimension/);
    assert.throws(() => averageEmbedding([]), /at least one/);
  });

  test('the threshold comes from the enrollment, not from a constant', () => {
    // Similar samples → confident print → firmer threshold. Scattered samples
    // → weaker threshold, and a warning upstream. Measured on this machine:
    // the same voice scored 0.28–0.46 against itself across noisy captures,
    // so any fixed number is wrong for somebody.
    const tight = buildVoiceprint([[1, 0, 0], [0.98, 0.05, 0], [0.99, 0.02, 0.01]]);
    const loose = buildVoiceprint([[1, 0, 0], [0.5, 0.7, 0.2], [0.4, 0.6, 0.6]]);
    assert.ok(tight.threshold > loose.threshold, `${tight.threshold} vs ${loose.threshold}`);
    assert.ok(tight.threshold <= 0.6, 'clamped above');
    assert.ok(loose.threshold >= 0.25, 'clamped below');
  });

  test('a single-sample enrollment still produces a usable print', () => {
    const print = buildVoiceprint([OWNER]);
    assert.equal(print.selfSimilarity, null);
    assert.equal(print.threshold, 0.4, 'no self-evidence → the default');
    assert.deepEqual(print.embedding, OWNER);
  });
});

// ── Persistence ─────────────────────────────────────────────────────────────

describe('voiceprint persistence', () => {
  test('round-trips through disk, and absence is null rather than a throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-vp-'));
    const file = path.join(dir, 'voiceprint.json');
    try {
      assert.equal(loadVoiceprint({ file }), null);
      const print = buildVoiceprint([OWNER, OWNER.map(v => v * 1.01)]);
      saveVoiceprint(print, { file });
      const back = loadVoiceprint({ file });
      assert.deepEqual(back.embedding, print.embedding);
      assert.equal(back.threshold, print.threshold);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a corrupt file is null, not a crash at listen time', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-vp-'));
    const file = path.join(dir, 'voiceprint.json');
    try {
      fs.writeFileSync(file, '{not json');
      assert.equal(loadVoiceprint({ file }), null);
      fs.writeFileSync(file, JSON.stringify({ version: 1, embedding: [] }));
      assert.equal(loadVoiceprint({ file }), null, 'an empty embedding matches nobody and must not pretend to');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The gate ────────────────────────────────────────────────────────────────

describe('speakerVerifier', () => {
  const print = buildVoiceprint([OWNER]);

  test('the owner matches, a stranger does not', async () => {
    const asOwner = speakerVerifier({ engine: ENGINE, voiceprint: print, spawnFn: fakeEngineSpawn(OWNER) });
    const owner = await asOwner(synthPcm({ ms: 500, amplitude: 0.3 }), { sampleRate: 16000 });
    assert.equal(owner.match, true);
    assert.ok(owner.score > 0.99, `score ${owner.score}`);

    const asStranger = speakerVerifier({ engine: ENGINE, voiceprint: print, spawnFn: fakeEngineSpawn(STRANGER) });
    const stranger = await asStranger(synthPcm({ ms: 500, amplitude: 0.3 }), { sampleRate: 16000 });
    assert.equal(stranger.match, false);
    assert.ok(stranger.score < print.threshold, `score ${stranger.score}`);
  });

  test('the decision carries its numbers, because thresholds get tuned', async () => {
    const verify = speakerVerifier({ engine: ENGINE, voiceprint: print, threshold: 0.9, spawnFn: fakeEngineSpawn(OWNER) });
    const res = await verify(synthPcm({ ms: 200, amplitude: 0.3 }), { sampleRate: 16000 });
    assert.equal(res.threshold, 0.9, 'an explicit threshold overrides the enrolled one');
    assert.ok('score' in res);
  });

  test('an engine that fails is an error, not a silent allow', async () => {
    const verify = speakerVerifier({
      engine: ENGINE, voiceprint: print,
      spawnFn: fakeEngineSpawn(OWNER, { exitCode: 3, stderr: 'cannot load sherpa-onnx-node' }),
    });
    await assert.rejects(
      () => verify(synthPcm({ ms: 200, amplitude: 0.3 }), { sampleRate: 16000 }),
      /exited 3/,
    );
  });

  test('missing prerequisites fail at construction, not at first utterance', () => {
    assert.throws(() => speakerVerifier({ engine: null, voiceprint: print }), /engine/);
    assert.throws(() => speakerVerifier({ engine: ENGINE, voiceprint: null }), /voiceprint/);
    assert.throws(() => speakerVerifier({ engine: ENGINE, voiceprint: { embedding: [] } }), /voiceprint/);
  });
});

// ── Integration: the property the whole feature exists for ─────────────────

describe('verification in the capture path', () => {
  const backend = BACKENDS[0];
  const FAST = { calibrateMs: 40, silenceMs: 100, maxWaitMs: 400, prerollMs: 40, onsetFrames: 2, maxUtteranceMs: 2000 };
  const ROOM = 0.0006;

  function speechAudio() {
    return Buffer.concat([
      synthPcm({ ms: 200, amplitude: ROOM }),
      synthPcm({ ms: 300, amplitude: 0.5 }),
      synthPcm({ ms: 200, amplitude: ROOM }),
    ]);
  }

  function fakeRecorder(pcm) {
    return () => {
      const child = new FakeChild();
      queueMicrotask(() => {
        for (let i = 0; i < pcm.length; i += 640) child.stdout.emit('data', pcm.subarray(i, i + 640));
      });
      return child;
    };
  }

  test("a stranger's words are never transcribed at all", async () => {
    // The privacy floor, and the reason verification runs before whisper: in a
    // room of other people's conversations, those conversations never become
    // text on this machine.
    let transcribed = 0;
    const stt = microphoneStt({
      backend, platform: 'linux', endpoint: FAST,
      spawnFn: fakeRecorder(speechAudio()),
      verify: async () => ({ score: 0.12, threshold: 0.4, match: false }),
      transcribe: async () => { transcribed++; return 'their private words'; },
    });

    const result = await stt({});
    assert.equal(transcribed, 0, 'rejection must happen before transcription, not after');
    assert.equal(result.text, '');
    assert.equal(result.rejected, 'speaker');
    assert.equal(result.stats.speaker.score, 0.12, 'the score travels out for the UI to explain');
  });

  test('the owner passes through and the score is kept', async () => {
    const stt = microphoneStt({
      backend, platform: 'linux', endpoint: FAST,
      spawnFn: fakeRecorder(speechAudio()),
      verify: async () => ({ score: 0.71, threshold: 0.4, match: true }),
      transcribe: async () => 'kairos, status',
    });
    const result = await stt({});
    assert.equal(result.text, 'kairos, status');
    assert.equal(result.stats.speaker.score, 0.71);
  });

  test('no verifier configured means no gate — verification is opt-in', async () => {
    const stt = microphoneStt({
      backend, platform: 'linux', endpoint: FAST,
      spawnFn: fakeRecorder(speechAudio()),
      transcribe: async () => 'kairos, status',
    });
    assert.equal((await stt({})).text, 'kairos, status');
  });

  test('the session reports an unrecognized voice as its own outcome', async () => {
    // Not "nothing heard" — the owner locked out by their own threshold needs
    // to see the score, or the only remaining diagnosis is "it is broken".
    const session = new VoiceSession({
      wakeWord: 'kairos',
      stt: async () => ({ text: '', confidence: 0, rejected: 'speaker', stats: { speaker: { score: 0.31, threshold: 0.4, match: false } } }),
      onUtterance: async () => '',
    });
    const res = await session.beginListening();
    assert.equal(res.ignored, 'unrecognized voice');
    assert.equal(res.speaker.score, 0.31);
  });
});

// ── The helper contract ─────────────────────────────────────────────────────

describe('embeddingsOfFiles', () => {
  test('BOM and stray stderr do not break parsing', async () => {
    const spawn = (command, args) => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('onnxruntime warning: cpu only\n'));
        const wavs = args.filter(a => a.endsWith('.wav'));
        child.stdout.emit('data', Buffer.from('\uFEFF' + JSON.stringify(wavs.map(w => ({ file: w, embedding: OWNER })))));
        child.emit('exit', 0);
      });
      return child;
    };
    const rows = await embeddingsOfFiles(['a.wav', 'b.wav'], { engine: ENGINE, spawnFn: spawn });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], OWNER);
  });

  test('a count mismatch is an error, not a misalignment', async () => {
    // Two files in, one embedding out, silently zipped — that would enroll the
    // wrong audio as the owner's voice. Loudly refusing is the only safe shape.
    const spawn = fakeEngineSpawn(OWNER);
    const short = (command, args) => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify([{ file: 'a.wav', embedding: OWNER }])));
        child.emit('exit', 0);
      });
      return child;
    };
    await assert.rejects(
      () => embeddingsOfFiles(['a.wav', 'b.wav'], { engine: ENGINE, spawnFn: short }),
      /1 embeddings for 2 files/,
    );
    assert.ok(spawn, 'unused fake kept for symmetry');
  });
});

// ── Enrollment outlier detection ─────────────────────────────────────────────
//
// This exists because `selfSimilarity` is the MINIMUM pairwise score, so one
// bad recording sets the threshold for every other one — and the more samples
// you enroll, the more chances the minimum has to be low. A low minimum means a
// PERMISSIVE gate, so without this, enrolling eight samples is strictly worse
// than enrolling three. Proven on real audio: an 8-sample enrollment scored one
// take at 0.332 against a median of ~0.68; discarding it is what made the other
// seven usable.

/** A 2-D unit vector at `angle` radians. Cosine similarity is then cos(a-b). */
const at = (angle) => [Math.cos(angle), Math.sin(angle)];

describe('analyzeSamples — which recordings disagree with the rest', () => {
  test('a consistent set has no outliers', () => {
    const tight = [at(0), at(0.05), at(0.1), at(0.15)];
    const { outliers, keep } = analyzeSamples(tight);
    assert.deepEqual(outliers, []);
    assert.deepEqual(keep, [0, 1, 2, 3]);
  });

  test('one recording that disagrees with the rest is found and excluded', () => {
    const samples = [at(0), at(0.05), at(0.1), at(1.3), at(0.15)];
    const { outliers, keep, agreement } = analyzeSamples(samples);
    assert.deepEqual(outliers, [3], `expected index 3 to be the outlier, agreement was ${agreement}`);
    assert.deepEqual(keep, [0, 1, 2, 4]);
    assert.ok(agreement[3] < agreement[0], 'the outlier must score below a good sample');
  });

  test('fewer than three samples can have no outlier — there is no majority to differ from', () => {
    for (const n of [0, 1, 2]) {
      const samples = Array.from({ length: n }, (_, i) => at(i * 1.2));
      const { outliers, keep } = analyzeSamples(samples);
      assert.deepEqual(outliers, [], `${n} samples must yield no outliers`);
      assert.equal(keep.length, n);
    }
  });

  test('a uniformly mediocre set is not "improved" by discarding one of them', () => {
    // Everything agrees weakly and equally. Relative-only detection would pick
    // a victim here; requiring an absolute floor as well means it does not.
    const spread = [at(0), at(0.7), at(1.4)];
    const { outliers } = analyzeSamples(spread);
    assert.deepEqual(outliers, [], 'no sample is adrift when they are all equally far apart');
  });

  test('a merely less-typical sample is kept — being below the median is not enough', () => {
    // Four tight samples plus one that is genuinely the same voice, just less
    // typical: it agrees at ~0.75 against a median of ~0.93. The relative test
    // alone flags it; the absolute floor is what saves it. Discarding real
    // evidence because it is not the *most* representative recording throws
    // away exactly the natural variation the print should cover.
    const samples = [at(0), at(0.05), at(0.1), at(0.15), at(0.8)];
    const { outliers, agreement, median } = analyzeSamples(samples);
    assert.ok(agreement[4] < median - 0.15,
      `setup check: ${agreement[4]} must be more than 0.15 below the median ${median}`);
    assert.ok(agreement[4] > 0.45, 'setup check: it must still be strong in absolute terms');
    assert.deepEqual(outliers, [], 'a strong-but-atypical sample must be kept');
  });

  test('a tight cluster low in absolute terms keeps every sample', () => {
    const { outliers } = analyzeSamples([at(0), at(0.02), at(0.04)], { floor: 0.99 });
    assert.deepEqual(outliers, [], 'being uniformly below the floor is not being an outlier');
  });

  test('never discards more than a quarter of the enrollment', () => {
    // Five tight samples plus three mutually dissimilar ones. All three qualify
    // as outliers; the cap allows two. Discarding half an enrollment because it
    // disagrees with itself is fitting the noise, not removing it.
    const samples = [
      [1, 0, 0, 0], [1, 0.02, 0, 0], [1, 0.04, 0, 0], [1, 0.01, 0, 0], [1, 0.03, 0, 0],
      [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
    ];
    const { outliers, keep } = analyzeSamples(samples);
    assert.equal(outliers.length, 2, `cap is floor(8 * 0.25) = 2, got ${outliers.length}`);
    assert.equal(keep.length, 6);
    for (const i of outliers) assert.ok(i >= 5, `only the dissimilar samples may be dropped, got index ${i}`);
  });

  test('the worst offenders are the ones discarded when the cap bites', () => {
    const samples = [at(0), at(0.05), at(0.1), at(0.15), at(1.2), at(2.6)];
    const { outliers, agreement } = analyzeSamples(samples);
    if (outliers.length) {
      const worst = agreement.indexOf(Math.min(...agreement));
      assert.ok(outliers.includes(worst), 'the single worst sample must always be among those dropped');
    }
  });

  test('keep and outliers always partition the samples exactly once', () => {
    const samples = [at(0), at(0.05), at(0.1), at(1.3), at(0.15), at(2.9)];
    const { outliers, keep } = analyzeSamples(samples);
    const union = [...keep, ...outliers].sort((a, b) => a - b);
    assert.deepEqual(union, [0, 1, 2, 3, 4, 5]);
    assert.equal(new Set(union).size, union.length, 'no index may appear twice');
  });

  test('agreement is reported per sample, in similarity units', () => {
    const { agreement, median } = analyzeSamples([at(0), at(0.05), at(0.1)]);
    assert.equal(agreement.length, 3);
    for (const score of agreement) {
      assert.ok(score > 0.9 && score <= 1, `a tight cluster should agree near 1, got ${score}`);
    }
    assert.ok(median > 0.9 && median <= 1);
  });

  test('discarding the outlier raises the resulting threshold, which is the whole point', () => {
    const samples = [at(0), at(0.05), at(0.1), at(1.3), at(0.15)];
    const withAll = buildVoiceprint(samples);
    const { keep } = analyzeSamples(samples);
    const withoutOutlier = buildVoiceprint(keep.map(i => samples[i]));
    assert.ok(
      withoutOutlier.threshold > withAll.threshold,
      `dropping the outlier must tighten the gate: ${withAll.threshold} -> ${withoutOutlier.threshold}`,
    );
    assert.ok(withoutOutlier.selfSimilarity > withAll.selfSimilarity);
  });
});
