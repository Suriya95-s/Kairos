// src/voice/capture.js
// Microphone capture (8.1 / 8.2) — the half of voice that was missing.
//
// `commandLineStt` in session.js runs a transcriber and reads its stdout, which
// silently assumed that something else had already produced audio. Nothing had.
// This is that something: it opens the microphone, decides when the person
// started and stopped talking, and hands a finished utterance to a transcriber.
//
// Two decisions shape the file.
//
// **No recorder is bundled.** Node cannot open a microphone without a native
// addon, and this project is zero-dependency on purpose. So capture shells out
// to a recorder the machine already has — ffmpeg, sox/rec, or arecord — and each
// is described by data rather than by a branch, so adding a fourth is a table
// entry. When none is present, that is reported as a *configuration* problem
// with install hints, not as a crash.
//
// **Endpointing is energy-based, and separate from transcription.** The wake
// word in 8.2 is matched against a transcript, which taken literally means
// transcribing the room continuously — every silence, every unrelated
// conversation, forever. Gating on audio level first means the transcriber only
// ever sees speech, which is cheaper, quieter, and considerably less invasive.
//
// The endpointer is a pure state machine over frame energies, so all of its
// behaviour is testable without a microphone in the room.

import fs from 'node:fs';
import path from 'node:path';
import { rmsOfFrame, FrameSplitter, BYTES_PER_SAMPLE, clippingOf } from './pcm.js';

/** The format every backend is asked to produce, and every consumer assumes. */
export const CAPTURE_FORMAT = Object.freeze({
  sampleRate: 16000,   // what Whisper-class models want; resampling later is loss
  channels: 1,
  bitDepth: 16,        // signed little-endian
});

/** 20ms of audio. Small enough to endpoint responsively, big enough to be stable. */
export const FRAME_MS = 20;

export const FRAME_BYTES =
  (CAPTURE_FORMAT.sampleRate / 1000) * FRAME_MS * BYTES_PER_SAMPLE * CAPTURE_FORMAT.channels;

// ── Backends ────────────────────────────────────────────────────────────────
//
// Each entry knows how to ask one recorder for raw signed-16-bit little-endian
// mono PCM on stdout. Raw, not WAV: a WAV header declares a length up front,
// which a stream that ends when the person stops talking does not know.

/**
 * @typedef {object} Backend
 * @property {string} name
 * @property {string} command
 * @property {(opts: object) => string[]} args
 * @property {string[]} probeArgs   cheap "are you installed" invocation
 * @property {string} install       what to tell someone who hasn't got it
 * @property {string[]} platforms   process.platform values this entry suits
 */

/** @type {Backend[]} */
export const BACKENDS = Object.freeze([
  {
    name: 'ffmpeg',
    command: 'ffmpeg',
    platforms: ['win32', 'darwin', 'linux'],
    probeArgs: ['-version'],
    install: 'winget install Gyan.FFmpeg  (or: brew install ffmpeg / apt install ffmpeg)',
    args: ({ device, platform = process.platform, gain = 1 }) => {
      // ffmpeg needs to be told which OS audio API to use; there is no portable
      // spelling of "the default microphone".
      const input = platform === 'win32'
        ? ['-f', 'dshow', '-i', `audio=${device || 'default'}`]
        : platform === 'darwin'
          ? ['-f', 'avfoundation', '-i', `:${device || '0'}`]
          : ['-f', 'alsa', '-i', device || 'default'];
      return [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        ...input,
        '-ac', String(CAPTURE_FORMAT.channels),
        '-ar', String(CAPTURE_FORMAT.sampleRate),
        // Many laptop microphones run 15-20dB quieter than a transcriber wants.
        // Amplifying here rather than asking the user to change a Windows
        // setting keeps a working default on hardware we do not control.
        ...(gain && gain !== 1 ? ['-af', `volume=${gain}`] : []),
        '-f', 's16le', '-acodec', 'pcm_s16le',
        'pipe:1',
      ];
    },
  },
  {
    name: 'sox',
    command: 'rec',
    platforms: ['win32', 'darwin', 'linux'],
    probeArgs: ['--version'],
    install: 'brew install sox  (or: apt install sox / choco install sox)',
    args: () => [
      '-q',
      '-c', String(CAPTURE_FORMAT.channels),
      '-r', String(CAPTURE_FORMAT.sampleRate),
      '-b', String(CAPTURE_FORMAT.bitDepth),
      '-e', 'signed-integer',
      '-t', 'raw',
      '-',
    ],
  },
  {
    name: 'arecord',
    command: 'arecord',
    platforms: ['linux'],
    probeArgs: ['--version'],
    install: 'apt install alsa-utils',
    args: ({ device }) => [
      '-q',
      '-D', device || 'default',
      '-f', 'S16_LE',
      '-c', String(CAPTURE_FORMAT.channels),
      '-r', String(CAPTURE_FORMAT.sampleRate),
      '-t', 'raw',
    ],
  },
]);

/**
 * Find a usable recorder.
 *
 * Probing by *running* each candidate rather than by looking at PATH: a command
 * that exists but cannot execute (wrong architecture, broken install, a shim
 * that needs a licence accepted) would otherwise be selected and then fail at
 * the worst possible moment, which is the first time somebody speaks.
 *
 * @returns {Promise<{backend: Backend|null, tried: Array<{name: string, ok: boolean, reason?: string}>}>}
 */
export async function detectRecorder({
  platform = process.platform, prefer = null, spawnFn = null, probeMs = 4000,
  env = process.env, existsFn = null, readdirFn = null,
} = {}) {
  // Injectable so the suite never depends on what happens to be installed on
  // the machine running it — which is the whole reason this path exists.
  const exists = existsFn || ((p) => fs.existsSync(p));
  const readdir = readdirFn || safeReadDir;
  const candidates = BACKENDS.filter(b => b.platforms.includes(platform));
  const ordered = prefer
    ? [...candidates.filter(b => b.name === prefer), ...candidates.filter(b => b.name !== prefer)]
    : candidates;

  const tried = [];
  for (const backend of ordered) {
    const result = await probe(backend, spawnFn, probeMs);
    tried.push({ name: backend.name, ok: result.ok, reason: result.reason });
    if (result.ok) return { backend, tried };

    // Not on PATH is not the same as not installed. A package manager that
    // edits PATH does not change it for processes that are already running —
    // and the daemon in particular inherits whatever environment it was
    // started with, possibly weeks ago. So look where installers actually put
    // things before concluding the machine has no microphone.
    const found = await probeKnownLocations(backend, platform, env, spawnFn, probeMs, exists, readdir);
    if (found) {
      tried[tried.length - 1] = { name: backend.name, ok: true, reason: 'found off PATH' };
      return { backend: { ...backend, command: found }, tried };
    }
  }
  return { backend: null, tried };
}

/** Places a recorder may be installed without being on PATH. */
function knownLocations(backend, platform, env, readdir) {
  if (platform !== 'win32') return [];
  const out = [];
  const exe = `${backend.command}.exe`;

  // winget unpacks into a versioned directory, so the leaf is listed rather
  // than named — the version changes with every upgrade.
  const wingetRoot = env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    : null;
  if (wingetRoot) {
    for (const pkgDir of readdir(wingetRoot)) {
      const pkg = path.join(wingetRoot, pkgDir);
      out.push(path.join(pkg, 'bin', exe));
      for (const inner of readdir(pkg)) out.push(path.join(pkg, inner, 'bin', exe));
    }
  }

  for (const root of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean)) {
    out.push(path.join(root, backend.command, 'bin', exe));
    out.push(path.join(root, backend.command, exe));
    if (backend.name === 'sox') out.push(path.join(root, 'sox', exe));
  }
  if (env.ChocolateyInstall) out.push(path.join(env.ChocolateyInstall, 'bin', exe));

  return out;
}

function safeReadDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

async function probeKnownLocations(backend, platform, env, spawnFn, probeMs, existsFn, readdir) {
  for (const candidate of knownLocations(backend, platform, env, readdir)) {
    if (!existsFn(candidate)) continue;
    const result = await probe({ ...backend, command: candidate }, spawnFn, probeMs);
    if (result.ok) return candidate;
  }
  return null;
}

function probe(backend, spawnFn, probeMs = 4000) {
  return new Promise((resolve) => {
    let child;
    const started = async () => {
      const { spawn } = spawnFn ? { spawn: spawnFn } : await import('node:child_process');
      try {
        child = spawn(backend.command, backend.probeArgs, { windowsHide: true, stdio: 'ignore' });
      } catch (err) {
        return resolve({ ok: false, reason: err?.message || 'spawn failed' });
      }
      // A probe that hangs is a probe that never answers. Recorders answer
      // `--version` immediately or they are not usable interactively anyway.
      //
      // Settle before killing, and guard it: killing first would make the
      // verdict depend on whether kill() delivers 'exit' synchronously, and a
      // probe that timed out could then report the recorder as working.
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ ok: false, reason: 'timed out' });
        try { child.kill(); } catch { /* already gone */ }
      }, probeMs);
      if (typeof timer.unref === 'function') timer.unref();

      child.on('error', (err) => {
        finish({ ok: false, reason: err?.code === 'ENOENT' ? 'not installed' : (err?.message || 'error') });
      });
      child.on('exit', (code) => {
        // sox's `rec --version` exits non-zero on some builds while being
        // perfectly functional, so "it ran at all" is the bar.
        finish({ ok: true, reason: code === 0 ? undefined : `exited ${code}` });
      });
    };
    started();
  });
}

/**
 * The microphones DirectShow can see, most-default first.
 *
 * Windows has no "default microphone" that ffmpeg can be asked for by name —
 * `-i audio=default` fails with "Could not find audio only device". Every
 * other platform has a real default (`:0`, `default`), so this is the one place
 * where a device must be discovered before anything can be recorded.
 *
 * @returns {Promise<string[]>}
 */
export async function listAudioDevices({ backend, platform = process.platform, spawnFn = null, timeoutMs = 8000 } = {}) {
  if (platform !== 'win32' || backend?.name !== 'ffmpeg') return [];

  const { spawn } = spawnFn ? { spawn: spawnFn } : await import('node:child_process');
  const text = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(backend.command, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
        { windowsHide: true });
    } catch { return resolve(''); }

    let buffer = '';
    // ffmpeg prints the device list to stderr and then exits non-zero, because
    // "dummy" is not a real input. That is the documented way to ask.
    child.stdout?.on('data', d => { buffer += d; });
    child.stderr?.on('data', d => { buffer += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(buffer); }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('exit', () => { clearTimeout(timer); resolve(buffer); });
  });

  return parseDshowAudioDevices(text);
}

/**
 * Pull microphone names out of ffmpeg's device listing.
 *
 * Two output shapes are handled because ffmpeg changed it: modern builds tag
 * each line `(audio)`, older ones group devices under a
 * "DirectShow audio devices" heading. Names are quoted and may contain
 * anything at all — including non-ASCII, which is the common case on a
 * localized Windows install.
 */
export function parseDshowAudioDevices(text) {
  const lines = String(text || '').split(/\r?\n/);
  const tagged = [];
  for (const line of lines) {
    if (!/\(audio\)/i.test(line)) continue;
    const name = line.match(/"([^"]+)"/);
    if (name) tagged.push(name[1]);
  }
  if (tagged.length) return dedupe(tagged);

  // Older layout: everything quoted between the audio heading and the next one.
  const out = [];
  let inAudio = false;
  for (const line of lines) {
    if (/DirectShow audio devices/i.test(line)) { inAudio = true; continue; }
    if (/DirectShow video devices/i.test(line)) { inAudio = false; continue; }
    // The "Alternative name" line is a device path for the entry above it, not
    // a second device — counting it would double every microphone.
    if (!inAudio || /Alternative name/i.test(line)) continue;
    const name = line.match(/"([^"]+)"/);
    if (name) out.push(name[1]);
  }
  return dedupe(out);
}

function dedupe(list) { return [...new Set(list)]; }

/** Resolved default microphone, per recorder binary. Enumerating is not cheap. */
const defaultDeviceCache = new Map();

/** Forget the resolved microphone — for tests, and if the hardware changes. */
export function resetDeviceCache() { defaultDeviceCache.clear(); }

/** A human-readable explanation of why there is no microphone available. */
export function describeMissingRecorder(tried, platform = process.platform) {
  const lines = ['No audio recorder found. Voice capture needs one of these on PATH:'];
  for (const backend of BACKENDS.filter(b => b.platforms.includes(platform))) {
    const attempt = tried?.find(t => t.name === backend.name);
    const why = attempt?.reason ? ` — ${attempt.reason}` : '';
    lines.push(`  ${backend.command.padEnd(9)}${why}`);
    lines.push(`    ${backend.install}`);
  }
  return lines.join('\n');
}

// ── Endpointing ─────────────────────────────────────────────────────────────

/** Why a capture stopped. */
export const END_REASONS = Object.freeze(['endpoint', 'max-duration', 'no-speech', 'aborted', 'error']);

/**
 * Decides where an utterance begins and ends, from frame energies alone.
 *
 * A fixed energy threshold does not survive contact with reality — a laptop fan,
 * an air conditioner and a quiet room are three different noise floors, and one
 * constant cannot serve all three. So the floor is measured from the room for
 * the first few hundred milliseconds and the gate is set relative to it.
 *
 * Pure and synchronous: feed it numbers, ask it what it thinks. No audio, no
 * timers, no I/O — which is why its edge cases are testable at all.
 */
export class Endpointer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.frameMs]         duration one frame represents
   * @param {number} [opts.calibrateMs]     how long to measure the room first
   * @param {number} [opts.silenceMs]       trailing silence that ends an utterance
   * @param {number} [opts.maxUtteranceMs]  hard cap on one utterance
   * @param {number} [opts.maxWaitMs]       give up if nobody speaks
   * @param {number} [opts.prerollMs]       audio kept from *before* speech began
   * @param {number} [opts.openRatio]       gate opens at floor × this
   * @param {number} [opts.floorFloor]      lower bound on the gate, for silent rooms
   * @param {number} [opts.onsetFrames]     consecutive loud frames that mean "speech"
   * @param {number} [opts.deadLevel]       at or below this, a frame is not audio
   * @param {number} [opts.maxCalibrateMs]  give up waiting for real audio
   */
  constructor({
    frameMs = FRAME_MS,
    calibrateMs = 300,
    silenceMs = 800,
    maxUtteranceMs = 15000,
    maxWaitMs = 10000,
    prerollMs = 300,
    openRatio = 3.5,
    floorFloor = 0.004,
    onsetFrames = 3,
    // −80 dBFS. Below the self-noise of any real microphone — consumer capsules
    // idle around −70 to −60 dBFS — so a frame this quiet is not a quiet room,
    // it is a device that has not started yet.
    deadLevel = 0.0001,
    maxCalibrateMs = 3000,
    // How far an utterance's peak must clear the gate to be believed.
    //
    // Tuned on four captures from one real microphone, which is a small sample
    // and worth saying so. The two whisper could decode measured 11.7× and 13.2×
    // over the threshold; the two it could not measured 1.6× and 3.35×, and
    // amplifying those by a further 8× produced not words but *different*
    // hallucinations ("I think we're in the caroten of the day") — below some
    // level the capsule's own noise dominates and gain adds no information. Six
    // sits in the middle of a wide gap. If it ever rejects a real utterance the
    // gap was narrower than it looked, and this is the number to lower.
    //
    // A ratio rather than an absolute level, because it is scale-invariant: a
    // quiet speaker in a quiet room has a low threshold too, so their ratio
    // stays high and they are still heard.
    minPeakRatio = 6,
    // Which quantile of the calibration window counts as "the room". See
    // _finishCalibration for why this is not 0.5.
    noisePercentile = 0.2,
  } = {}) {
    this.frameMs = frameMs;
    this.calibrateFrames = Math.max(1, Math.round(calibrateMs / frameMs));
    this.silenceFrames = Math.max(1, Math.round(silenceMs / frameMs));
    this.maxFrames = Math.max(1, Math.round(maxUtteranceMs / frameMs));
    this.maxWaitFrames = Math.max(1, Math.round(maxWaitMs / frameMs));
    this.prerollFrames = Math.max(0, Math.round(prerollMs / frameMs));
    this.openRatio = openRatio;
    this.floorFloor = floorFloor;
    this.onsetFrames = Math.max(1, onsetFrames);
    this.deadLevel = deadLevel;
    this.minPeakRatio = minPeakRatio;
    this.noisePercentile = Math.min(1, Math.max(0, noisePercentile));
    this.maxCalibrateFrames = Math.max(this.calibrateFrames, Math.round(maxCalibrateMs / frameMs));

    this.state = 'calibrating';   // calibrating → waiting → speech → done
    this.threshold = floorFloor;
    this.noiseFloor = 0;
    this.reason = null;

    this._calibration = [];
    this._deadFrames = 0;
    this._calibrateFramesSeen = 0;
    this._loudRun = 0;
    this._silentRun = 0;
    this._speechFrames = 0;
    this._waitedFrames = 0;
    this._peak = 0;
  }

  /**
   * Feed one frame's energy.
   *
   * @param {number} level normalized RMS, 0..1
   * @returns {'skip'|'preroll'|'keep'|'done'} what to do with the frame's audio
   */
  push(level) {
    if (this.state === 'done') return 'done';
    if (level > this._peak) this._peak = level;

    if (this.state === 'calibrating') {
      this._calibrateFramesSeen++;
      // Digital silence is not a measurement of the room. A capture device that
      // has just been opened delivers exact zeros for a moment while it starts,
      // and averaging those in gives a noise floor of zero — which pins the gate
      // to `floorFloor`, opens it on the room itself, and then never closes it.
      // The observed symptom is a fifteen-second "utterance" of nothing, handed
      // to a transcriber that duly reports hearing no speech. So dead frames are
      // counted and discarded rather than measured.
      if (level <= this.deadLevel) this._deadFrames++;
      else this._calibration.push(level);

      // But a microphone that is muted or unplugged delivers zeros forever, and
      // calibration must not wait forever for it. Giving up here lands in
      // `waiting`, where `maxWaitMs` ends the capture with 'no-speech' — the
      // right answer, arrived at by a path that terminates.
      if (this._calibration.length >= this.calibrateFrames
          || this._calibrateFramesSeen >= this.maxCalibrateFrames) this._finishCalibration();
      // Calibration audio is still buffered as preroll: someone who starts
      // talking the instant the microphone opens must not lose their first word.
      return 'preroll';
    }

    if (this.state === 'waiting') {
      this._waitedFrames++;
      if (level >= this.threshold) {
        this._loudRun++;
        if (this._loudRun >= this.onsetFrames) {
          this.state = 'speech';
          this._speechFrames = this._loudRun;
          this._silentRun = 0;
          return 'keep';
        }
      } else {
        this._loudRun = 0;
      }
      if (this._waitedFrames >= this.maxWaitFrames) return this._finish('no-speech');
      return 'preroll';
    }

    // state === 'speech'
    this._speechFrames++;
    if (level >= this.threshold) this._silentRun = 0;
    else this._silentRun++;

    if (this._silentRun >= this.silenceFrames) return this._finish('endpoint');
    if (this._speechFrames >= this.maxFrames) return this._finish('max-duration');
    return 'keep';
  }

  _finishCalibration() {
    // A LOW PERCENTILE, not the median, and certainly not the mean.
    //
    // The median survives a door closing during calibration. It does not
    // survive the user *already talking* when the microphone opens, which is
    // the normal case in a continuous listen loop: one utterance ends, the
    // recorder reopens, and someone mid-thought speaks straight into the 300ms
    // calibration window. Then most of those frames are speech, the median is
    // speech, and the gate ends up above the very voice it exists to detect.
    // Measured live: 0.0062 on a clean open versus 0.1143 on a talked-over one
    // — 18x — and real speech at peak 0.2463 was discarded as "only 2.15x over
    // the gate".
    //
    // Speech is not continuous at frame resolution; there are gaps between
    // words and low-energy frames within them. A low percentile finds those
    // gaps and lands near the true room floor even when most of the window is
    // voice.
    //
    // The errors are not symmetric, which is what settles it. Too high and the
    // user's speech is silently discarded — the failure being fixed here, and
    // one that looks from the outside like the assistant ignoring them. Too low
    // and the gate opens early on room noise, costing a little preroll before
    // the peak-ratio plausibility check catches it downstream. Prefer the
    // recoverable failure.
    const sorted = [...this._calibration].sort((a, b) => a - b);
    const idx = Math.max(0, Math.floor((sorted.length - 1) * this.noisePercentile));
    this.noiseFloor = sorted[idx] ?? 0;
    this.threshold = Math.max(this.noiseFloor * this.openRatio, this.floorFloor);
    this.state = 'waiting';
  }

  _finish(reason) {
    this.state = 'done';
    this.reason = reason;
    return 'done';
  }

  /** Stop early — an abort, or a barge-in from the other direction. */
  abort() {
    if (this.state !== 'done') this._finish('aborted');
  }

  /** True once speech was detected, whatever ended the capture. */
  get heardSpeech() { return this._speechFrames > 0; }

  /**
   * Whether what was captured looks like a voice rather than a noise.
   *
   * The gate answers "is this louder than the room", which is the right question
   * for *when* to start recording and the wrong one for *whether to transcribe*.
   * A chair, a door, a breath all clear the gate briefly, and a transcriber
   * handed two seconds of that does not return nothing — it returns "Thank you
   * very much." Confidently. There is no downstream defence against a fluent
   * sentence that was never said, so the check belongs here.
   */
  get speechLikely() {
    if (!this.heardSpeech) return false;
    if (this.minPeakRatio <= 0) return true;
    return this._peak >= this.threshold * this.minPeakRatio;
  }

  stats() {
    return {
      reason: this.reason,
      noiseFloor: round(this.noiseFloor),
      threshold: round(this.threshold),
      peak: round(this._peak),
      speechMs: this._speechFrames * this.frameMs,
      heardSpeech: this.heardSpeech,
      speechLikely: this.speechLikely,
      peakRatio: this.threshold > 0 ? round(this._peak / this.threshold) : 0,
      // Surfaced because it was invisible: a floor of zero and a threshold at
      // its lower bound look like a calibrated endpointer until you know how
      // many of the frames it calibrated on carried no audio at all.
      deadFrames: this._deadFrames,
    };
  }
}

function round(n) { return Math.round(n * 10000) / 10000; }

// ── Capture ─────────────────────────────────────────────────────────────────

/**
 * Open the microphone, wait for a sentence, close it. Resolves with the PCM.
 *
 * The recorder is stopped as soon as the endpointer is satisfied, so the
 * microphone is not held open between utterances — on most systems that is what
 * turns the "in use" indicator off, and a light that stays on when nobody is
 * listening is a promise being broken.
 *
 * @param {object} [opts]
 * @param {Backend} [opts.backend]     from detectRecorder(); detected if absent
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.endpoint]     Endpointer options
 * @param {(level:number, state:string)=>void} [opts.onLevel] for a UI meter
 * @returns {Promise<{pcm: Buffer, reason: string, stats: object, format: object}>}
 */
export async function captureUtterance({
  backend = null,
  device = null,
  signal = null,
  endpoint = {},
  onLevel = null,
  spawnFn = null,
  platform = process.platform,
  stallMs = 5000,
  gain = 1,
} = {}) {
  let chosen = backend;
  if (!chosen) {
    const found = await detectRecorder({ platform, spawnFn });
    if (!found.backend) {
      const err = new Error(describeMissingRecorder(found.tried, platform));
      err.code = 'ENORECORDER';
      throw err;
    }
    chosen = found.backend;
  }

  // Windows has no nameable default microphone, so one must be chosen before
  // anything can be recorded. Resolved once and remembered: enumerating costs
  // about a second, and doing it per utterance would show up as latency in the
  // one measurement that matters.
  let chosenDevice = device;
  if (!chosenDevice && platform === 'win32' && chosen.name === 'ffmpeg') {
    chosenDevice = defaultDeviceCache.get(chosen.command) ?? null;
    if (chosenDevice === null) {
      const devices = await listAudioDevices({ backend: chosen, platform, spawnFn });
      chosenDevice = devices[0] || null;
      defaultDeviceCache.set(chosen.command, chosenDevice);
    }
    if (!chosenDevice) {
      const err = new Error(
        'No microphone found. ffmpeg is installed but DirectShow reports no audio input device.\n' +
        'Check that a microphone is connected and enabled in Windows sound settings, then:\n' +
        `  ${chosen.command} -list_devices true -f dshow -i dummy`);
      err.code = 'ENODEVICE';
      throw err;
    }
  }

  const { spawn } = spawnFn ? { spawn: spawnFn } : await import('node:child_process');
  const endpointer = new Endpointer(endpoint);
  const splitter = new FrameSplitter(FRAME_BYTES);
  const preroll = new RingBuffer(endpointer.prerollFrames);
  const kept = [];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(chosen.command, chosen.args({ device: chosenDevice, platform, gain }), { windowsHide: true });
    } catch (err) {
      return reject(err);
    }

    let settled = false;
    let stderr = '';
    let stallTimer = null;

    // Every timeout in the endpointer advances one frame at a time, so all of
    // them depend on audio actually arriving. A recorder that opens the device
    // and then produces nothing — muted at the driver, device held by another
    // application, a backend waiting on a permission prompt nobody can see —
    // trips none of them, and the session waits for a sentence that will never
    // come. This is the only clock here that runs on wall time.
    const armStall = () => {
      if (!stallMs) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        const err = new Error(
          `recorder "${chosen.command}" produced no audio for ${stallMs}ms — ` +
          'the microphone may be muted, in use by another application, or awaiting permission' +
          (stderr.trim() ? `:\n${stderr.trim()}` : ''));
        err.code = 'ESTALL';
        fail(err);
      }, stallMs);
      if (typeof stallTimer.unref === 'function') stallTimer.unref();
    };

    const cleanup = () => {
      clearTimeout(stallTimer);
      signal?.removeEventListener?.('abort', onAbort);
      try { child.stdout?.removeAllListeners('data'); } catch { /* gone */ }
      try { child.kill(); } catch { /* already exited */ }
    };

    const done = (reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Preroll first, then the frames from speech onward. Without this the
      // recording begins after the onset frames have already been consumed,
      // which clips the leading consonant off every single utterance.
      const pcm = Buffer.concat([...preroll.drain(), ...kept]);
      // Clipping is measured on the assembled samples rather than on frame
      // energy, because frame energy cannot see it: a clipped frame's RMS looks
      // merely loud. It has to be measured somewhere, though — clipped speech is
      // percussive, and whisper handed it reports "(drumming)" and "(popping)"
      // with total confidence, which reads as a broken microphone rather than as
      // too much gain.
      resolve({
        pcm,
        reason,
        stats: { ...endpointer.stats(), ...clippingOf(pcm) },
        format: { ...CAPTURE_FORMAT },
      });
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      endpointer.abort();
      done('aborted');
    };
    if (signal?.aborted) { try { child.kill(); } catch {} return done('aborted'); }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    armStall();

    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      armStall();
      for (const frame of splitter.push(chunk)) {
        const level = rmsOfFrame(frame);
        const verdict = endpointer.push(level);
        if (onLevel) { try { onLevel(level, endpointer.state); } catch { /* a meter must not break capture */ } }

        if (verdict === 'preroll') preroll.put(frame);
        else if (verdict === 'keep') kept.push(frame);
        else if (verdict === 'done') return done(endpointer.reason);
      }
    });

    child.stderr?.on('data', (d) => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-2000); });
    child.on('error', (err) => fail(err));
    child.on('exit', (code) => {
      if (settled) return;
      // The recorder died before an endpoint. On Windows this is nearly always
      // "no dshow device by that name", so its own words are worth more than
      // anything that could be written here.
      const err = new Error(
        `recorder "${chosen.command}" exited ${code} before an utterance completed` +
        (stderr.trim() ? `:\n${stderr.trim()}` : ''));
      err.code = 'ERECORDER';
      fail(err);
    });
  });
}

/**
 * A ring of the most recent N frames.
 *
 * Bounded on purpose: a preroll buffer that grows is a recording of the room
 * that nobody asked for, kept for as long as the process lives.
 */
export class RingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(0, capacity);
    this._items = [];
  }

  put(item) {
    if (this.capacity === 0) return;
    this._items.push(item);
    if (this._items.length > this.capacity) this._items.shift();
  }

  /** Take everything and forget it. */
  drain() {
    const out = this._items;
    this._items = [];
    return out;
  }

  get size() { return this._items.length; }
}

/**
 * Build an `stt` function for VoiceSession that records first, then transcribes.
 *
 * This is the join that was missing: VoiceSession asks for a transcript, this
 * opens the microphone, finds the sentence, and passes only that to whatever
 * does the transcribing.
 *
 * @param {object} opts
 * @param {(pcm: Buffer, format: object) => Promise<{text: string, confidence?: number}|string>} opts.transcribe
 */
export function microphoneStt({
  transcribe, backend = null, device = null, endpoint = {}, onLevel = null,
  spawnFn = null, stallMs = 5000, platform = process.platform, gain = 1,
  onAudio = null, verify = null,
} = {}) {
  if (typeof transcribe !== 'function') throw new Error('microphoneStt needs a transcribe function');

  let cached = backend;
  return async ({ signal } = {}) => {
    if (!cached) {
      const found = await detectRecorder({ spawnFn, platform });
      if (!found.backend) {
        const err = new Error(describeMissingRecorder(found.tried));
        err.code = 'ENORECORDER';
        throw err;
      }
      cached = found.backend;
    }

    const { pcm, reason, stats, format } = await captureUtterance({
      backend: cached, device, signal, endpoint, onLevel, spawnFn, stallMs, platform, gain,
    });

    if (reason === 'aborted') {
      const err = new Error('listening cancelled');
      err.name = 'AbortError';
      throw err;
    }
    // Nothing was said. Returning empty text rather than throwing keeps this on
    // VoiceSession's "nothing heard" path, which stays quiet — an assistant that
    // announces every silence is unusable in a room with people in it.
    if (reason === 'no-speech' || !stats.heardSpeech) return { text: '', confidence: 0, stats };

    // Handing out the exact bytes the transcriber is about to see. When a
    // transcript is wrong there are two suspects — what was captured and what
    // was decoded — and no amount of reasoning separates them. This is off by
    // default: it writes a recording of a room to disk, which is not something
    // to do quietly. Called before the plausibility check below, because the
    // captures worth inspecting are precisely the ones that get rejected.
    if (onAudio) { try { onAudio(pcm, format, stats); } catch { /* diagnostics must not break listening */ } }

    // Something was recorded, but it does not carry the dynamic range of a
    // voice. Reported as silence rather than as an error: the caller's quiet
    // "nothing heard" path is the correct response to a door closing.
    if (!stats.speechLikely) return { text: '', confidence: 0, stats };

    // Speaker verification runs BEFORE transcription, deliberately. In a room
    // full of other people's speech this is a privacy floor as much as a gate:
    // words that are not the owner's are never turned into text at all. It also
    // means a stranger cannot spend the owner's compute — the embedding check
    // is far cheaper than whisper.
    if (verify) {
      const speaker = await verify(pcm, format);
      if (!speaker.match) {
        return { text: '', confidence: 0, stats: { ...stats, speaker }, rejected: 'speaker' };
      }
      stats.speaker = speaker;
    }

    const result = await transcribe(pcm, format);
    if (typeof result === 'string') return { text: result.trim(), confidence: 1, stats };
    return { text: String(result?.text || '').trim(), confidence: result?.confidence ?? 1, stats };
  };
}
