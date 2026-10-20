// src/voice/verify.js
// Speaker verification: does this voice belong to the owner? (8.6)
//
// The owner asked for an assistant that wakes for their voice alone, in a room
// where other people talk. The wake word is the first identity check — today's
// live data showed it rejecting 29 ambient utterances without one false accept
// — but a wake word is knowledge, not identity: anyone who knows it has it.
// This layer compares the *voice* against an enrolled voiceprint.
//
// The engine is sherpa-onnx's speaker-embedding model, reached the same way
// whisper.cpp and ffmpeg are reached: an external tool discovered on disk, so
// the repo itself stays zero-dependency. The addon lives in its own directory
// with its own node_modules; Kairos spawns a helper script that loads it from
// there. If none of that is installed, voice still works — verification is a
// gate the owner adds, not a wall that arrives by default.
//
// One honest limit, stated where it can be read: this stops bystanders and
// background voices. It does not stop a recording of the owner played back at
// the microphone. For a personal assistant that is the right threat model.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { home } from '../kernel/paths.js';
import { pcmToWav } from './pcm.js';

/** Where the enrolled voiceprint lives. Local file, owner's home, no cloud. */
export function voiceprintFile({ env = process.env } = {}) {
  return env.KAIROS_VOICEPRINT || path.join(home(), 'voice', 'voiceprint.json');
}

/**
 * Find an installed speaker-embedding engine without being told where it is.
 *
 * Fourth appearance of this pattern (shell, recorder, transcriber, now this),
 * and the reasoning has not changed: on Windows, *installed* and *reachable
 * from a daemon's inherited environment* are different things.
 *
 * @returns {{lib: string, model: string}|null}
 */
export function findSpeakerEngine({ env = process.env, existsFn = null, readdirFn = null } = {}) {
  const exists = existsFn || ((p) => fs.existsSync(p));
  const readdir = readdirFn || ((d) => { try { return fs.readdirSync(d); } catch { return []; } });

  const roots = [
    env.KAIROS_SPEAKER_HOME,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'sherpa-onnx') : null,
    env.USERPROFILE ? path.join(env.USERPROFILE, 'sherpa-onnx') : null,
    '/usr/local/share/sherpa-onnx',
    '/opt/sherpa-onnx',
  ].filter(Boolean);

  for (const root of roots) {
    // The addon must actually be installed, not just the directory existing —
    // reporting a half-finished install as a working engine would fail at the
    // first real utterance instead of at `voice check`.
    const lib = path.join(root, 'node');
    if (!exists(path.join(lib, 'node_modules', 'sherpa-onnx-node'))) continue;

    const model = env.KAIROS_SPEAKER_MODEL || findModel(path.join(root, 'models'), exists, readdir);
    if (!model) continue;
    return { lib, model };
  }
  return null;
}

/** First .onnx under the models directory — there is usually exactly one. */
function findModel(dir, exists, readdir) {
  if (!exists(dir)) return null;
  const onnx = readdir(dir).filter(f => f.endsWith('.onnx')).sort();
  return onnx.length ? path.join(dir, onnx[0]) : null;
}

/**
 * Extract speaker embeddings from WAV files via the helper script.
 *
 * @param {string[]} wavs absolute paths
 * @returns {Promise<number[][]>} one embedding per input, same order
 */
export async function embeddingsOfFiles(wavs, {
  engine, spawnFn = null, nodeBin = process.execPath, helper = null, timeoutMs = 30000,
} = {}) {
  if (!engine?.lib || !engine?.model) throw new Error('embeddingsOfFiles needs an engine {lib, model}');
  // fileURLToPath, never url.pathname: a path with `~` or a space in it comes
  // back percent-encoded from .pathname, and the helper "does not exist".
  const script = helper || path.join(path.dirname(fileURLToPath(import.meta.url)), 'embed-helper.mjs');

  const args = [script, '--lib', engine.lib, '--model', engine.model, ...wavs];
  const out = await run(nodeBin, args, spawnFn, timeoutMs);

  let rows;
  try { rows = JSON.parse(out.replace(/^﻿/, '')); } catch {
    throw new Error(`speaker engine returned unparseable output: ${out.slice(0, 200)}`);
  }
  if (!Array.isArray(rows) || rows.length !== wavs.length) {
    throw new Error(`speaker engine returned ${rows?.length ?? 0} embeddings for ${wavs.length} files`);
  }
  return rows.map(r => r.embedding);
}

/** Extract one embedding from raw PCM, via a temp file that is always removed. */
export async function embeddingOfPcm(pcm, format, opts = {}) {
  const dir = fs.mkdtempSync(path.join(opts.tmpDir || os.tmpdir(), 'kairos-spk-'));
  const wav = path.join(dir, 'utterance.wav');
  try {
    fs.writeFileSync(wav, pcmToWav(pcm, format));
    const [embedding] = await embeddingsOfFiles([wav], opts);
    return embedding;
  } finally {
    // Same rule as transcription: a failed check must not leave audio on disk.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Cosine similarity — the standard score for speaker embeddings. */
export function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/** Element-wise mean. Enrollment averages several utterances into one print. */
export function averageEmbedding(embeddings) {
  if (!embeddings?.length) throw new Error('averageEmbedding needs at least one embedding');
  const out = new Array(embeddings[0].length).fill(0);
  for (const e of embeddings) {
    if (e.length !== out.length) throw new Error('embeddings disagree on dimension');
    for (let i = 0; i < e.length; i++) out[i] += e[i];
  }
  return out.map(v => v / embeddings.length);
}

/**
 * Per-sample agreement, and which samples are dragging the print down.
 *
 * This exists because `selfSimilarity` below is the *minimum* pairwise score,
 * which means one bad sample sets the threshold for all of them — and the more
 * samples you enroll, the more likely one of them is bad. Enrolling eight
 * samples without this is strictly worse than enrolling three: 28 pairs give
 * the minimum 28 chances to be low, and a low minimum means a *permissive*
 * gate. That is the opposite of what more data should buy.
 *
 * A sample is an outlier when it agrees with the others markedly less than a
 * typical sample does (`median - margin`) AND is weak in absolute terms. Both
 * conditions are required: in a genuinely consistent enrollment the spread is
 * tiny, and relative-only would start discarding perfectly good samples for
 * being 0.02 below their siblings.
 *
 * @param {number[][]} embeddings
 * @param {object} [opts]
 * @param {number} [opts.margin]     how far below the median counts as adrift
 * @param {number} [opts.floor]      absolute agreement below which a sample is weak
 * @param {number} [opts.maxDropRatio] never discard more than this fraction
 * @returns {{agreement:number[], median:number, outliers:number[], keep:number[]}}
 */
export function analyzeSamples(embeddings, { margin = 0.15, floor = 0.45, maxDropRatio = 0.25 } = {}) {
  const n = embeddings.length;
  if (n < 3) {
    // With two samples each one *is* the other's only evidence; there is no
    // majority to be an outlier from.
    return { agreement: embeddings.map(() => 1), median: 1, outliers: [], keep: embeddings.map((_, i) => i) };
  }

  const agreement = embeddings.map((e, i) => {
    let sum = 0;
    for (let j = 0; j < n; j++) if (j !== i) sum += cosineSimilarity(e, embeddings[j]);
    return round(sum / (n - 1));
  });

  const sorted = [...agreement].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : round((sorted[mid - 1] + sorted[mid]) / 2);

  // Worst first, so the cap discards the most damaging samples.
  const candidates = agreement
    .map((score, index) => ({ score, index }))
    .filter(s => s.score < median - margin && s.score < floor)
    .sort((a, b) => a.score - b.score);

  const maxDrop = Math.floor(n * maxDropRatio);
  const outliers = candidates.slice(0, maxDrop).map(s => s.index).sort((a, b) => a - b);
  const keep = agreement.map((_, i) => i).filter(i => !outliers.includes(i));
  return { agreement, median, outliers, keep };
}

/**
 * Build a voiceprint from enrollment embeddings.
 *
 * The threshold is derived from the enrollment's own consistency rather than
 * hard-coded: measured on this machine, the same voice in a noisy room scored
 * 0.28–0.46 against itself while clean same-voice audio scored higher, so a
 * fixed number is wrong on somebody's hardware whichever number is picked.
 * The floor of 0.25 exists because below it the print separates nothing.
 */
export function buildVoiceprint(embeddings, { model = null, now = () => new Date().toISOString() } = {}) {
  const sims = [];
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) sims.push(cosineSimilarity(embeddings[i], embeddings[j]));
  }
  const minSelf = sims.length ? Math.min(...sims) : null;
  return {
    version: 1,
    createdAt: now(),
    model: model ? path.basename(model) : null,
    samples: embeddings.length,
    embedding: averageEmbedding(embeddings),
    selfSimilarity: minSelf,
    // A stranger should score below this; the owner, above it. Set from the
    // weakest self-match with margin, clamped to a sane band.
    threshold: minSelf === null ? 0.4 : Math.min(0.6, Math.max(0.25, round(minSelf - 0.08))),
  };
}

export function saveVoiceprint(print, { file = null, env = process.env } = {}) {
  const target = file || voiceprintFile({ env });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(print, null, 2));
  return target;
}

export function loadVoiceprint({ file = null, env = process.env } = {}) {
  const target = file || voiceprintFile({ env });
  try {
    const print = JSON.parse(fs.readFileSync(target, 'utf8'));
    return print?.embedding?.length ? print : null;
  } catch { return null; }
}

/**
 * The gate itself: pcm in, {score, match} out.
 *
 * @param {object} opts
 * @param {object} opts.engine     from findSpeakerEngine
 * @param {object} opts.voiceprint from loadVoiceprint
 * @param {number} [opts.threshold] override the enrolled threshold
 */
export function speakerVerifier({ engine, voiceprint, threshold = null, spawnFn = null, tmpDir = null, nodeBin = undefined, helper = null }) {
  if (!engine) throw new Error('speakerVerifier needs an engine');
  if (!voiceprint?.embedding?.length) throw new Error('speakerVerifier needs an enrolled voiceprint');
  const bar = threshold ?? voiceprint.threshold ?? 0.4;

  return async (pcm, format = {}) => {
    const embedding = await embeddingOfPcm(pcm, format, { engine, spawnFn, tmpDir, nodeBin, helper });
    const score = round(cosineSimilarity(embedding, voiceprint.embedding));
    return { score, threshold: bar, match: score >= bar };
  };
}

/** Explain what is missing, in install-command form. */
export function describeMissingSpeakerEngine() {
  return [
    'Speaker verification needs sherpa-onnx (a local embedding model — nothing leaves the machine):',
    '  1. npm install sherpa-onnx-node   (in %LOCALAPPDATA%\\sherpa-onnx\\node — its own directory, not this repo)',
    '  2. put a speaker model at %LOCALAPPDATA%\\sherpa-onnx\\models\\, e.g. wespeaker_en_voxceleb_CAM++.onnx',
    '     from https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models',
    '  3. kairos voice enroll',
  ].join('\n');
}

function round(n) { return Math.round(n * 10000) / 10000; }

function run(command, args, spawnFn, timeoutMs) {
  return new Promise((resolve, reject) => {
    (async () => {
      const { spawn } = spawnFn ? { spawn: spawnFn } : await import('node:child_process');
      let child;
      try {
        child = spawn(command, args, { windowsHide: true });
      } catch (e) { return reject(e); }

      let out = '', errText = '', settled = false;
      const finish = (fn, val) => { if (!settled) { settled = true; clearTimeout(timer); fn(val); } };
      // An embedding model that hangs must not hang listening with it.
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish(reject, new Error(`speaker engine timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      child.stdout?.on('data', d => { out += d; });
      child.stderr?.on('data', d => { errText += d; });
      child.on('error', e => finish(reject, e));
      child.on('exit', (code) => {
        if (code !== 0) return finish(reject, new Error(`speaker engine exited ${code}: ${errText.trim().slice(-300)}`));
        finish(resolve, out);
      });
    })();
  });
}
