// src/voice/embed-helper.mjs
// Spawned by verify.js to extract speaker embeddings. Runs in its own process
// so the sherpa-onnx native addon — which lives in ITS OWN directory with its
// own node_modules, not in this repo — never loads into the daemon. The repo
// stays zero-dependency; this file only builds a bridge at spawn time.
//
// Usage: node embed-helper.mjs --lib <dir-with-node_modules> --model <model.onnx> <a.wav> [b.wav ...]
// Output: JSON [{file, embedding: number[]}] on stdout. Anything else is an error.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at !== -1 ? args[at + 1] : null;
};
const lib = flag('--lib');
const model = flag('--model');
const wavs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--lib' && args[i - 1] !== '--model');

if (!lib || !model || !wavs.length) {
  console.error('usage: node embed-helper.mjs --lib <dir> --model <model.onnx> <wav> [wav ...]');
  process.exit(2);
}

// Resolve the addon from the isolated install, wherever this script lives.
const require = createRequire(path.join(lib, 'package.json'));
let sherpa;
try {
  sherpa = require('sherpa-onnx-node');
} catch (e) {
  console.error(`cannot load sherpa-onnx-node from ${lib}: ${e.message}`);
  process.exit(3);
}

const extractor = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: 2 });

/** Minimal WAV reader for the canonical files Kairos writes: mono s16le. */
function readWavPcm(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${file}: not a WAV`);
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  if (channels !== 1) throw new Error(`${file}: expected mono, got ${channels} channels`);
  const pcm = buf.subarray(44);
  const samples = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate };
}

const out = [];
for (const wav of wavs) {
  const { samples, sampleRate } = readWavPcm(wav);
  const stream = extractor.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  out.push({ file: wav, embedding: Array.from(extractor.compute(stream)) });
}
process.stdout.write(JSON.stringify(out));
