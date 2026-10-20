// src/voice/transcribe.js
// Turning captured audio into words, locally.
//
// The plan's privacy default is that audio does not leave the machine, and that
// is a default worth defending in code rather than in a README: a microphone is
// the one input a person cannot audit after the fact. So what is provided here
// wraps a *local* binary. A cloud transcriber is a few lines to write, and is
// deliberately left as something the owner of the machine writes themselves.
//
// The awkward part is the file. Capture produces a stream; transcribers take a
// path. So the audio is written to a temp file, transcribed, and deleted —
// including when the transcriber fails, which is the case that leaves a
// directory full of recordings of somebody's living room if it is forgotten.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pcmToWav } from './pcm.js';

/**
 * Find an installed whisper.cpp without being told where it is.
 *
 * Third time this pattern has been needed (the shell, the recorder, now the
 * transcriber): on Windows, *installed* and *on PATH* are different things, and
 * a daemon inherits whatever environment it started with. Requiring `--stt` to
 * be spelled out when the binary is sitting in a well-known directory is how a
 * working install gets reported as a missing one.
 *
 * @returns {{command: string, model: string|null}|null}
 */
export function findWhisper({ env = process.env, existsFn = null, readdirFn = null } = {}) {
  const exists = existsFn || ((p) => fs.existsSync(p));
  const readdir = readdirFn || ((d) => {
    try { return fs.readdirSync(d); } catch { return []; }
  });

  const roots = [
    env.KAIROS_WHISPER_HOME,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'whisper.cpp') : null,
    env.ProgramFiles ? path.join(env.ProgramFiles, 'whisper.cpp') : null,
    env.USERPROFILE ? path.join(env.USERPROFILE, 'whisper.cpp') : null,
    '/usr/local/share/whisper.cpp',
    '/opt/whisper.cpp',
  ].filter(Boolean);

  const names = process.platform === 'win32'
    ? ['whisper-cli.exe', 'main.exe']
    : ['whisper-cli', 'main'];

  for (const root of roots) {
    // Release/ is where the official Windows zip puts the binaries; build/bin
    // is where a source build puts them.
    for (const sub of ['', 'Release', 'bin', path.join('build', 'bin')]) {
      for (const name of names) {
        const candidate = path.join(root, sub, name);
        if (!exists(candidate)) continue;
        return { command: candidate, model: findModel(root, exists, readdir) };
      }
    }
  }
  return null;
}

/** The largest .bin under models/ — English-only models are preferred. */
function findModel(root, exists, readdir) {
  const dir = path.join(root, 'models');
  if (!exists(dir)) return null;
  const bins = readdir(dir).filter(f => f.endsWith('.bin'));
  if (!bins.length) return null;
  // `.en` models are both faster and more accurate for English, which is what
  // the wake word and the command grammar assume.
  const english = bins.filter(f => /\.en\.bin$/.test(f));
  return path.join(dir, (english[0] || bins[0]));
}

/**
 * Transcribe with whisper.cpp (or anything sharing its command shape).
 *
 * @param {object} opts
 * @param {string} opts.command   path to the whisper binary
 * @param {string} opts.model     path to the .bin model
 * @param {string[]} [opts.extraArgs]
 * @param {string} [opts.tmpDir]
 * @returns {(pcm: Buffer, format: object) => Promise<{text: string, confidence: number}>}
 */
export function whisperCppTranscriber({
  command, model, extraArgs = [], tmpDir = null, spawnFn = null, language = 'en',
  prompt = null,
}) {
  if (!command) throw new Error('whisperCppTranscriber needs a command');

  return async (pcm, format = {}) => {
    const dir = fs.mkdtempSync(path.join(tmpDir || os.tmpdir(), 'kairos-stt-'));
    const wav = path.join(dir, 'utterance.wav');

    try {
      fs.writeFileSync(wav, pcmToWav(pcm, format));
      const args = [
        ...(model ? ['-m', model] : []),
        '-f', wav,
        '-l', language,
        '-nt',        // no timestamps — this is a command, not a subtitle track
        '-np',        // no progress spam on stderr
        // Bias decoding toward words the model has no reason to expect. The
        // wake word is a proper noun — "Kairos" is not in ordinary English —
        // and on a short utterance there is no surrounding context to recover
        // it from, so whisper confidently emits a fluent sentence that was
        // never said. Seeding the vocabulary is the documented remedy.
        ...(prompt ? ['--prompt', String(prompt)] : []),
        ...extraArgs,
      ];
      const out = await run(command, args, spawnFn);
      return { text: cleanTranscript(out), confidence: 1 };
    } finally {
      // Always. A failed transcription must not leave audio on disk.
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
}

/**
 * Transcribe with an arbitrary command that takes a WAV path.
 *
 * `{}` in the argument list is replaced with the temp file's path — enough of a
 * template language for this, and one that cannot be got wrong.
 */
export function fileTranscriber({ command, args = ['{}'], parse = null, tmpDir = null, spawnFn = null }) {
  if (!command) throw new Error('fileTranscriber needs a command');

  return async (pcm, format = {}) => {
    const dir = fs.mkdtempSync(path.join(tmpDir || os.tmpdir(), 'kairos-stt-'));
    const wav = path.join(dir, 'utterance.wav');
    try {
      fs.writeFileSync(wav, pcmToWav(pcm, format));
      const out = await run(command, args.map(a => (a === '{}' ? wav : a.replace('{}', wav))), spawnFn);
      if (parse) return parse(out);
      return { text: cleanTranscript(out), confidence: 1 };
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
}

/**
 * Tidy a transcript.
 *
 * whisper emits bracketed non-speech annotations — `[BLANK_AUDIO]`, `(wind
 * blowing)`, `[Music]` — when it hears something that is not words. Passing
 * those through means the router is asked to classify the intent of a gust of
 * wind, and a confident classifier will find one.
 */
const KNOWN_ANNOTATIONS = [
  /^speak(?:s|ing) (?:in|a|foreign|non-english)\b/i,
  /\bforeign language\b/i,
  /^(?:music|applause|laughter|silence|beep|static|noise|humming|whirring)\b/i,
  /^(?:in)?audible\b/i,
  /^(?:unintelligible|indistinct|incomprehensible)\b/i,
  /^background (?:noise|music|chatter|conversation)\b/i,
  /^no (?:audio|speech|sound|voice)\b/i,
  /^blank (?:audio|tape)\b/i,
  /^clears? (?:his |her |their )?throat\b/i,
];

export function cleanTranscript(raw) {
  let s = String(raw || '');
  s = s.replace(/\[[^\]]*\]/g, ' ');

  // Some annotations are longer than the shape rule below tolerates —
  // "(speaking in foreign language)" is four words, and whisper reaches for it
  // whenever the input is quiet, clipped, or accented. Those are named
  // explicitly rather than inferred, and each is anchored tightly enough that
  // ordinary speech does not collide with it: "(speaking of which, …)" is not
  // "(speaking in Spanish)".
  s = s.replace(/\(([^)]{1,60})\)/g, (match, inner) => (
    KNOWN_ANNOTATIONS.some(re => re.test(inner.trim())) ? ' ' : match
  ));

  // Parenthesised text is the awkward case, because ordinary speech uses
  // parentheses too. The rule is deliberately narrow — at most three words, and
  // either a single capitalised word or a phrase ending in a present participle
  // — because the two mistakes are not equally bad. Letting an annotation
  // through costs one clarifying question; deleting "(the staging one)" from an
  // instruction changes what gets deployed.
  s = s.replace(/\(([^)]{1,40})\)/g, (match, inner) => {
    const words = inner.trim().split(/\s+/);
    if (words.length > 3) return match;
    const last = words[words.length - 1];
    if (words.length > 1) return /ing$/i.test(last) ? ' ' : match;
    return /^[A-Z][a-z]+$|^[A-Z]+$|ing$|^laughs?$|^sighs?$/.test(last) ? ' ' : match;
  });

  s = s.replace(/\s+/g, ' ').trim();
  // A transcript that was *only* an annotation is silence, not an utterance.
  return /[a-z0-9]/i.test(s) ? s : '';
}

function run(command, args, spawnFn) {
  return new Promise((resolve, reject) => {
    (async () => {
      const { spawn } = spawnFn ? { spawn: spawnFn } : await import('node:child_process');
      let child;
      try {
        child = spawn(command, args, { windowsHide: true });
      } catch (err) { return reject(err); }

      let out = '';
      let err = '';
      child.stdout?.on('data', d => { out += d; });
      child.stderr?.on('data', d => { err += d; });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) return reject(new Error(`transcriber exited ${code}: ${err.trim().slice(-300)}`));
        resolve(out);
      });
    })();
  });
}
