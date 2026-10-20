// src/voice/cli.js
// The voice surface, made runnable (8.1 / 8.2 / 8.4).
//
// Everything voice needed existed except a way to start it, which meant the
// wake-to-answer criterion could not be measured and the whole surface could
// not be tried. This is that entry point.
//
// `voice check` exists because the first run will fail on most machines — no
// recorder, no transcriber — and the difference between a tool that says
// "spawn ENOENT" and one that says which of four things is missing and how to
// install each is the difference between a feature people use and one they
// conclude is broken.

import fs from 'node:fs';
import path from 'node:path';

import { BRAND } from '../kernel/paths.js';
import { pcmToWav } from './pcm.js';
import { DaemonClient } from '../kernel/client.js';
import { VoiceSession } from './session.js';
import { detectRecorder, describeMissingRecorder, microphoneStt, listAudioDevices, captureUtterance, BACKENDS } from './capture.js';
import { whisperCppTranscriber, fileTranscriber, findWhisper } from './transcribe.js';
import { systemTts, probeSystemTts, systemVoice } from './tts.js';
import {
  findSpeakerEngine, describeMissingSpeakerEngine, speakerVerifier, loadVoiceprint,
  saveVoiceprint, buildVoiceprint, embeddingsOfFiles, cosineSimilarity, voiceprintFile,
  analyzeSamples,
} from './verify.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`${s}\n`);

/** Where each setting comes from, in precedence order: flag, then environment. */
function resolveConfig(flags) {
  // An installed whisper.cpp is discovered rather than demanded. Explicit flags
  // and environment still win — discovery is the fallback, not an override.
  const found = (flags.stt || process.env.KAIROS_STT_COMMAND) ? null : findWhisper();
  return {
    sttCommand: flags.stt || process.env.KAIROS_STT_COMMAND || found?.command || null,
    sttModel: flags.model || process.env.KAIROS_STT_MODEL || found?.model || null,
    sttDiscovered: !!found,
    device: flags.device || process.env.KAIROS_AUDIO_DEVICE || null,
    wakeWord: flags['no-wake'] ? null : (flags.wake || process.env.KAIROS_WAKE_WORD || BRAND.toLowerCase()),
    ttsCommand: flags.tts || process.env.KAIROS_TTS_COMMAND || null,
  };
}

/**
 * Report what is present and what is missing, and say nothing that is not
 * actually known. Each line is a fact that was checked by running something.
 */
export async function cmdVoiceCheck(flags = {}) {
  const config = resolveConfig(flags);
  let ready = true;

  out(`${BRAND} voice — readiness\n`);

  // 1. Microphone.
  const { backend, tried } = await detectRecorder({ prefer: flags.recorder || null });
  if (backend) {
    out(`  microphone   ● ${path.basename(backend.command)}`);
    // Naming the device matters on Windows, where there is no default and the
    // wrong one is a silent failure — it records, and hears nothing.
    const devices = await listAudioDevices({ backend });
    if (devices.length) {
      out(`     device: ${devices[0]}${devices.length > 1 ? `  (+${devices.length - 1} more, --device to pick)` : ''}`);
    } else if (process.platform === 'win32') {
      ready = false;
      out('     ○ no audio input device — check Windows sound settings');
    }
  } else {
    ready = false;
    out('  microphone   ○ none');
    out(indent(describeMissingRecorder(tried).split('\n').slice(1).join('\n'), 2));
  }

  // 2. Transcription. Nothing is bundled, so this is configuration, not detection.
  if (config.sttCommand) {
    out(`  transcriber  ● ${path.basename(config.sttCommand)}${config.sttDiscovered ? ' (found automatically)' : ''}`);
    if (config.sttModel) out(`     model: ${path.basename(config.sttModel)}`);
    else {
      ready = false;
      out('     ○ no model — whisper.cpp needs a .bin, e.g. ggml-base.en.bin');
    }
  } else {
    ready = false;
    out('  transcriber  ○ not configured');
    out('     Point --stt at a local engine, e.g. whisper.cpp:');
    out(`       ${BRAND} voice listen --stt whisper-cli --model ggml-base.en.bin`);
    out('     Or set KAIROS_STT_COMMAND / KAIROS_STT_MODEL.');
  }

  // 3. Speech. This one usually needs nothing installed.
  if (config.ttsCommand) {
    out(`  speech       ● ${config.ttsCommand} (yours)`);
  } else {
    const probe = await probeSystemTts();
    if (probe.ok) out(`  speech       ● ${probe.command} (built in)`);
    else {
      // Not fatal: replies are still printed. Say so rather than blocking.
      out(`  speech       ○ ${probe.command || 'none'} — replies will be printed, not spoken`);
      if (probe.install) out(`     ${probe.install}`);
    }
  }

  // 4. Speaker verification — optional, so its absence is a note, not a fault.
  {
    const engine = findSpeakerEngine();
    const print = loadVoiceprint();
    if (engine && print) {
      out(`  speaker id   ● enrolled ${print.createdAt?.slice(0, 10) ?? ''} (threshold ${print.threshold})`);
    } else if (engine) {
      out(`  speaker id   ○ engine installed, nobody enrolled — ${BRAND} voice enroll`);
    } else {
      out('  speaker id   ○ not installed — voice works for anyone who says the wake word');
    }
  }

  // 5. The daemon, which is what actually answers.
  try {
    const status = await new DaemonClient().status();
    out(`  daemon       ● ${status.health}`);
  } catch {
    ready = false;
    out('  daemon       ○ not running');
    out(`     ${BRAND} start`);
  }

  out();
  out(config.wakeWord ? `  wake word    "${config.wakeWord}"` : '  wake word    disabled — every utterance is routed');
  out();
  out(ready ? `Ready. Run: ${BRAND} voice listen` : 'Not ready — see the items marked ○ above.');
  return ready ? 0 : 1;
}

/** Build the transcriber the flags describe, or explain why one cannot be built. */
function buildTranscriber(config) {
  if (!config.sttCommand) {
    const e = new Error(
      'No transcriber configured. Voice needs a local speech-to-text engine.\n' +
      `  ${BRAND} voice listen --stt whisper-cli --model ggml-base.en.bin\n` +
      `Run "${BRAND} voice check" to see everything that is missing.`);
    e.code = 'ENOSTT';
    throw e;
  }
  // A model path implies whisper.cpp's argument shape; without one, the command
  // is treated as an opaque thing that takes a WAV path.
  return config.sttModel
    // No `prompt` seeding. It was tried, and measured: priming whisper with
    // "Kairos, " turned a correct transcript of "Kairos" into "Kyros". Biasing
    // the decoder toward a proper noun it does not know makes it *more*
    // creative near that word, not less. The wake word is made robust on the
    // matching side instead, which is where the variance actually lands.
    ? whisperCppTranscriber({ command: config.sttCommand, model: config.sttModel })
    : fileTranscriber({ command: config.sttCommand });
}

/**
 * Listen until interrupted.
 *
 * The loop is deliberately sequential: capture, transcribe, answer, speak, and
 * only then listen again. Overlapping them would mean transcribing the system's
 * own voice, which is how an assistant ends up talking to itself.
 */
export async function cmdVoiceListen(flags = {}) {
  const config = resolveConfig(flags);

  const { backend, tried } = await detectRecorder({ prefer: flags.recorder || null });
  if (!backend) { err(describeMissingRecorder(tried)); return 1; }

  let transcribe;
  try { transcribe = buildTranscriber(config); }
  catch (e) { err(e.message); return 1; }

  // `let`, not `const`: the daemon's port and token change on every restart,
  // and a listener that reads them once is silently orphaned by the first
  // restart — it keeps hearing perfectly and answering nobody, which from the
  // owner's side is "it stopped replying". On a failed call we re-discover
  // from the run files and retry once; the session id is dropped too, because
  // it belonged to the daemon that died.
  let client = new DaemonClient();
  const reconnect = () => { client = new DaemonClient(); sessionId = null; return client; };
  try { await client.status(); }
  catch { err(`${BRAND} is not running. Start it with: ${BRAND} start`); return 1; }

  // Voice telemetry for attached surfaces (the TUI's Voice view). Strictly
  // fire-and-forget: the microphone loop must never wait on, or die from,
  // a display channel.
  const tell = (payload) => {
    client.request('POST', '/api/voice', { body: payload, timeoutMs: 3000 })
      .catch(() => {
        // One retry against freshly discovered run files — the common cause is
        // a daemon restart, and rediscovery is exactly the fix. Still silent
        // on a second failure: telemetry never gets to break the microphone.
        try {
          reconnect().request('POST', '/api/voice', { body: payload, timeoutMs: 3000 }).catch(() => {});
        } catch { /* not running at all */ }
      });
  };

  // Speech is optional. A missing synthesiser must not stop the surface working
  // — the reply is printed instead, which is degraded, not broken.
  let speak = null;
  if (config.ttsCommand) {
    speak = systemTts({ voice: { command: config.ttsCommand, args: (t) => [t] } });
  } else {
    const probe = await probeSystemTts();
    if (probe.ok) speak = systemTts({ voice: probe.voice });
    else err(`(no speech synthesiser — replies will be printed. ${BRAND} voice check explains.)`);
  }

  // Bracket every spoken reply so the Voice view can animate while the
  // synthesiser is actually talking, and stop when it stops — `finally`,
  // because an animation that survives a TTS crash never stops.
  if (speak) {
    const speakRaw = speak;
    speak = async (text) => {
      tell({ phase: 'speaking', text: String(text || '') });
      try { return await speakRaw(text); }
      finally { tell({ phase: 'spoke' }); }
    };
  }

  const timing = !!flags.timing;
  // Amplifying at capture was tried and measured harmful: at 3× a normally
  // spoken sentence clipped, and clipped speech transcribes as "(drumming)".
  // The flag stays for a microphone that genuinely runs quiet, but the default
  // is to leave the signal alone.
  const gainFlag = flags.gain ? parseFloat(flags.gain) : 1;
  let sessionId = null;
  let marks = null;

  // Speaker verification: on when a voiceprint is enrolled AND the engine is
  // installed; off otherwise, and *sayable* either way. A silent gate is the
  // one thing this must never be — a threshold quietly eating the owner's own
  // commands would read as a broken microphone.
  let verify = null;
  if (!flags['no-verify']) {
    const voiceprint = loadVoiceprint();
    const engine = findSpeakerEngine();
    if (voiceprint && engine) {
      verify = speakerVerifier({
        engine, voiceprint,
        threshold: flags['verify-threshold'] ? parseFloat(flags['verify-threshold']) : null,
      });
      out(`  (speaker verification on — enrolled ${voiceprint.createdAt?.slice(0, 10) ?? 'earlier'},`
        + ` threshold ${flags['verify-threshold'] || voiceprint.threshold}. --no-verify to disable.)`);
    } else if (voiceprint && !engine) {
      err('  (voiceprint enrolled but the speaker engine is missing — verification is OFF)');
      err(indent(describeMissingSpeakerEngine(), 3));
    }
  }

  // The measurements from the last capture, kept so that a rejected one can
  // explain itself. Not knowing *why* nothing was heard cost four rounds of
  // guessing at gain settings when the answer was in numbers nobody printed.
  let lastStats = null;
  const keepDir = flags.keep ? path.resolve(String(flags.keep)) : null;
  let keepSeq = 0;
  const onAudio = (pcm, format, stats) => {
    lastStats = stats;
    // --keep writes the utterance to disk. Diagnostic, opt-in, and announced:
    // when a transcript is wrong, the only way to tell a bad recording from a
    // bad decode is to listen to what was recorded.
    if (!keepDir) return;
    const file = path.join(keepDir, `utterance-${++keepSeq}.wav`);
    fs.mkdirSync(keepDir, { recursive: true });
    fs.writeFileSync(file, pcmToWav(pcm, format));
    const seconds = pcm.length / ((format.sampleRate || 16000) * 2);
    out(`  (kept ${file} — ${seconds.toFixed(2)}s, ${stats?.speechMs ?? '?'}ms speech,`
      + ` peak ${stats?.peak ?? '?'}, floor ${stats?.noiseFloor ?? '?'}, threshold ${stats?.threshold ?? '?'})`);
  };

  const session = new VoiceSession({
    wakeWord: config.wakeWord,
    minConfidence: flags.confidence ? parseFloat(flags.confidence) : 0.5,
    stt: microphoneStt({
      backend, transcribe, device: config.device,
      gain: gainFlag,
      onAudio,
      verify,
      endpoint: {
        silenceMs: flags.silence ? parseInt(flags.silence, 10) : 800,
        maxWaitMs: 60 * 60 * 1000,   // the outer loop owns "nobody is here", not the endpointer
      },
      onLevel: (level, state) => {
        if (state === 'speech' && !marks?.speechSeen) marks.speechSeen = now();
        // The recorder takes a noticeable moment to start delivering audio —
        // about 3s for ffmpeg/dshow on Windows, because it has to open the
        // device and negotiate a format. Printing "Listening" before that is a
        // lie the user pays for: they speak into a dead window, nothing is
        // captured, and the assistant appears not to have heard them. So
        // readiness is announced when audio actually starts arriving.
        if (!marks.armed) {
          marks.armed = now();
          process.stdout.write('  ● listening — go ahead\n');
        }
      },
    }),
    tts: speak,
    onUtterance: async (text) => {
      if (marks) marks.dispatched = now();
      let res;
      try {
        res = await client.say({ text, sessionId, workspace: process.cwd() });
      } catch {
        // The daemon was restarted under us. The user already spoke — losing
        // their words to a stale port number is the worst possible answer, so
        // rediscover and give it one more try before reporting an error.
        res = await reconnect().say({ text, sessionId, workspace: process.cwd() });
      }
      if (res.sessionId) sessionId = res.sessionId;
      if (marks) marks.answered = now();
      out(`  ${BRAND}: ${res.text || '(started a mission)'}`);
      tell({ phase: 'answer', text: res.text || '(started a mission)' });
      return res.text || '';
    },
  });

  // Deliberately "opening", not "listening" — the microphone is not capturing
  // yet, and saying otherwise is how an utterance gets lost before it starts.
  out(config.wakeWord
    ? `Opening the microphone. Then say "${config.wakeWord}, …". Ctrl-C to stop.`
    : 'Opening the microphone — no wake word, every utterance is routed. Ctrl-C to stop.');

  let running = true;
  const stop = () => {
    if (!running) process.exit(130);   // a second Ctrl-C means now, not politely
    running = false;
    out('\nStopping…');
    session.cancelListening();
    session.bargeIn();
  };
  process.on('SIGINT', stop);

  let consecutiveErrors = 0;
  while (running) {
    marks = { started: now(), armed: null, speechSeen: null, dispatched: null, answered: null };
    lastStats = null;
    let result;
    try {
      result = await session.beginListening({ reason: 'wake-word' });
    } catch (e) {
      // A recorder that cannot start will fail identically every time, so
      // retrying forever would be an infinite loop printing the same line.
      if (++consecutiveErrors >= 3) { err(`\n${e.message}\n\nGiving up after 3 identical failures.`); return 1; }
      err(`  (${e.message})`);
      continue;
    }
    consecutiveErrors = 0;

    // Reported whatever the outcome, including a successful one — a transcript
    // decoded from clipped audio is not trustworthy just because words came back.
    if (lastStats?.clipping) {
      // Not toFixed(3): the measured real-world fractions (0.002%) round to
      // "0.000%", which reads as "did not clip" directly under a clip warning.
      const pct = (lastStats.clipped * 100).toPrecision(2);
      out(`  ⚠ the input clipped — ${pct}% of samples hit full scale (peak ${lastStats.peakSample}).`);
      out('   Clipped speech is percussive, and a transcriber reports it as drumming or music.');
      out(gainFlag > 1
        ? `   Lower --gain (currently ${gainFlag}) or speak a little further from the microphone.`
        : '   Reduce the microphone level in Windows sound settings, or move back slightly.');
    }

    // The score prints on success too, not just on rejection. During the
    // impostor test a clipped shout passed the speaker gate invisibly and was
    // only caught by the wake word — an accept you cannot see is an accept you
    // cannot judge.
    if (lastStats?.speaker) {
      out(`  (voice score ${lastStats.speaker.score} — ${lastStats.speaker.match ? 'accepted' : 'refused'}, threshold ${lastStats.speaker.threshold})`);
    }

    if (result?.text && !result.ignored) out(`  you: ${result.text}`);
    // Silence used to exit without a word, which is indistinguishable from a
    // crash. Whatever happened, say what happened.
    else if (result?.ignored) {
      out(`  (${result.ignored}${result.text ? `: "${result.text}"` : ''})`);
      if (result.ignored === 'nothing heard' && lastStats && !lastStats.speechLikely) {
        // Distinguishing "the microphone heard nothing" from "the microphone
        // heard something that was not a voice". They have different fixes, and
        // conflating them is how a level problem gets diagnosed as a bug.
        out(`   something was recorded, but it does not look like speech —`
          + ` peak ${lastStats.peak} against a gate of ${lastStats.threshold}, only ${lastStats.peakRatio}× over.`);
        out('   A voice usually clears the gate by 10× or more. Try speaking closer to the');
        out('   microphone, or raise the input level in Windows sound settings.');
      } else if (result.ignored === 'nothing heard' && lastStats) {
        // Something was recorded and transcribed, and no words came back. That
        // is a third outcome, and reporting it as "nothing reached the
        // microphone" sends the owner to check a device that is working.
        out(`   recorded ${(lastStats.speechMs / 1000).toFixed(1)}s and transcribed it, but no words came back`
          + ` (peak ${lastStats.peak}, ${lastStats.peakRatio}× over the gate).`);
        out('   Usually too quiet or too far away: below a certain level the microphone\'s own');
        out('   noise drowns the voice, and amplifying it afterwards adds nothing back.');
      } else if (result.ignored === 'nothing heard') {
        out('   nothing reached the microphone. Check the input level in Windows sound settings,');
        out(`   or run "${BRAND} voice check" to confirm the device.`);
      } else if (result.ignored === 'no wake word') {
        out(`   heard you, but it did not start with "${config.wakeWord}". Use --no-wake to drop the requirement.`);
      } else if (result.ignored === 'unrecognized voice') {
        // The one rejection that must always carry its number: a threshold set
        // slightly too high locks the owner out of their own assistant, and
        // without the score there is nothing to tune.
        const s = result.speaker;
        out(`   a voice, but not the enrolled one — score ${s?.score ?? '?'} against threshold ${s?.threshold ?? '?'}.`);
        out(`   If that was you: --verify-threshold ${s ? Math.max(0.2, s.score - 0.02).toFixed(2) : '<lower>'} to loosen,`);
        out(`   ${BRAND} voice enroll to re-enroll, or --no-verify to bypass.`);
      }
    } else if (result?.error) {
      err(`  (error: ${result.error})`);
    }
    if (timing && marks.answered) reportTiming(marks);

    // One summary event per turn for attached surfaces. `verified` is strict:
    // only a speaker-gate MATCH counts, because the daemon raises B1 arousal on
    // it — an unverified voice must never look like the owner being present.
    const speaker = lastStats?.speaker ?? result?.speaker ?? null;
    tell({
      phase: result?.text && !result.ignored ? 'heard' : 'ignored',
      text: result?.text || '',
      reason: result?.ignored || '',
      score: speaker?.score ?? null,
      threshold: speaker?.threshold ?? null,
      verified: speaker?.match === true,
      timing: marks.answered ? {
        captureMs: marks.dispatched && marks.armed ? marks.dispatched - marks.armed : null,
        answerMs: marks.dispatched ? marks.answered - marks.dispatched : null,
        totalMs: marks.armed ? marks.answered - marks.armed : null,
      } : null,
    });
    if (flags.once) break;
  }

  return 0;
}

/**
 * Enroll the owner's voice: record a few sentences, average their embeddings,
 * save the voiceprint. From then on `voice listen` obeys that voice alone.
 *
 * The sentences are chosen, not random: each is long enough to carry voice
 * character (~3s), and different enough from the others that the average is a
 * voice rather than a sentence. Enrollment in a *quiet moment* matters more
 * than the sentences do — an enrolled roomful of chatter verifies the room.
 */
export async function cmdVoiceEnroll(flags = {}, positional = []) {
  const engine = findSpeakerEngine();
  if (!engine) { err(describeMissingSpeakerEngine()); return 1; }

  const fromFiles = positional.filter(p => p.endsWith('.wav'));
  let embeddings;

  if (fromFiles.length) {
    // Enrolling from existing recordings — mostly for testing the pipeline.
    // Real enrollment should be live: the files on disk are usually the noisy
    // failures that got kept, which is exactly the wrong thing to enroll.
    out(`Enrolling from ${fromFiles.length} file(s)…`);
    embeddings = await embeddingsOfFiles(fromFiles.map(f => path.resolve(f)), { engine });
  } else {
    const { backend, tried } = await detectRecorder({ prefer: flags.recorder || null });
    if (!backend) { err(describeMissingRecorder(tried)); return 1; }

    // Eight, not three. The embedding is an average, so more samples is a
    // better estimate of the voice — but only because `analyzeSamples` below
    // discards the ones that disagree; without that, more samples would lower
    // the threshold rather than sharpen it. Chosen for phonetic spread, and the
    // last few deliberately sit in the register commands are actually given in.
    const phrases = [
      'My voice is my key, and this assistant answers to me alone.',
      'The quick brown fox jumps over the lazy dog near the riverbank.',
      'Kairos, from now on, listen for me and nobody else in this room.',
      'Please check the build status and tell me if anything failed overnight.',
      'She sells sea shells, but the shore was quiet and the weather stayed warm.',
      'Open the project folder, run the tests, and summarize what went wrong.',
      'Five or six large jugs of water were shipped from the village last August.',
      'Remind me at eight tomorrow morning to review the notes before the meeting.',
    ];
    out(`Enrolling your voice. ${phrases.length} sentences, in a QUIET moment — background`);
    out('voices become part of the print and weaken it.');
    out('Speak normally, at the distance you actually sit. Louder is not better —');
    out('clipped speech makes a worse print than quiet speech does.\n');

    embeddings = [];
    const config = resolveConfig(flags);
    for (let i = 0; i < phrases.length; i++) {
      out(`  ${i + 1}/${phrases.length}: say —  "${phrases[i]}"`);
      let announced = false;
      const { pcm, reason, stats, format } = await captureUtterance({
        backend, device: config.device,
        endpoint: { silenceMs: 1000, maxWaitMs: 30000 },
        // The recorder takes ~3s to actually open. Without this line the first
        // sentence gets clipped mid-word — which is exactly what happened on
        // the first real enrollment: 1.1s of noise enrolled as "the owner".
        onLevel: () => { if (!announced) { announced = true; out('   ● listening — speak now'); } },
      });
      if (reason === 'no-speech' || !stats.heardSpeech) {
        err('   heard nothing — try again.');
        i--; continue;
      }
      // Enrollment must be *stricter* than listening, not looser: a capture the
      // listen path would reject as not-speech must never become the voiceprint
      // that all future captures are compared against.
      if (!stats.speechLikely) {
        err(`   that did not sound like a voice (peak ${stats.peak}, only ${stats.peakRatio}× over the gate) — try again, closer.`);
        i--; continue;
      }
      if (stats.speechMs < 1500) {
        err(`   too short (${(stats.speechMs / 1000).toFixed(1)}s) — say the whole sentence.`);
        i--; continue;
      }
      const { embeddingOfPcm } = await import('./verify.js');
      embeddings.push(await embeddingOfPcm(pcm, format, { engine }));
      out(`   ✓ captured ${(stats.speechMs / 1000).toFixed(1)}s (peak ${stats.peak})`);
    }
  }

  // Which samples agree with the rest, and which are poison. Last enrollment
  // produced a single number (0.151) with no way to see where it came from;
  // per-sample agreement makes a bad capture visible instead of silently
  // setting the threshold for everything.
  const analysis = analyzeSamples(embeddings);
  if (embeddings.length >= 3) {
    out('');
    out('Sample agreement (how much each recording sounds like the others):');
    analysis.agreement.forEach((score, i) => {
      const dropped = analysis.outliers.includes(i);
      const bar = '█'.repeat(Math.max(0, Math.round(score * 20)));
      out(`  ${String(i + 1).padStart(2)}. ${score.toFixed(3)} ${bar}${dropped ? '   ← discarded (disagrees with the rest)' : ''}`);
    });
  }

  let used = embeddings;
  if (analysis.outliers.length) {
    used = analysis.keep.map(i => embeddings[i]);
    out('');
    out(`Discarding ${analysis.outliers.length} of ${embeddings.length} samples before building the print.`);
    out('One recording that disagrees would otherwise set the threshold for all of them.');
  }

  const print = buildVoiceprint(used, { model: engine.model });
  const file = saveVoiceprint(print);

  out('');
  out(`Voiceprint saved: ${file}`);
  out(`  samples: ${print.samples}   self-similarity: ${print.selfSimilarity?.toFixed(3) ?? 'n/a (one sample)'}`);
  out(`  threshold: ${print.threshold}  (override per run: --verify-threshold)`);
  if (print.selfSimilarity !== null && print.selfSimilarity < 0.4) {
    out('  ⚠ low self-similarity — the samples disagree about your voice. A noisy');
    out('    room or very short answers usually cause this. Re-enrolling somewhere');
    out('    quiet will make the gate much more reliable.');
  }
  out(`\nDone. ${BRAND} voice listen now verifies the speaker. --no-verify bypasses.`);
  return 0;
}

/**
 * Report the wake-to-answer breakdown.
 *
 * Split by stage because the total on its own is not actionable — a slow turn
 * is nearly always one of these three, and which one decides whether the fix is
 * a smaller model, a shorter silence window, or the router.
 */
function reportTiming(marks) {
  const endpointed = marks.dispatched;   // capture finished and transcription done
  const total = marks.answered - (marks.speechSeen ?? marks.started);
  const parts = [
    `capture+transcribe ${ms(endpointed - (marks.speechSeen ?? marks.started))}`,
    `answer ${ms(marks.answered - endpointed)}`,
  ];
  const verdict = total < 3000 ? 'within the 3s target' : 'OVER the 3s target';
  out(`  [${parts.join('  ·  ')}  ·  total ${ms(total)} — ${verdict}]`);
}

const now = () => Number(process.hrtime.bigint() / 1000000n);
const ms = (n) => `${Math.round(n)}ms`;
const indent = (text, n) => text.split('\n').map(l => ' '.repeat(n) + l).join('\n');

/** Dispatch for the `voice` verb. */
export async function cmdVoice(positional = [], flags = {}) {
  const sub = positional[0] || 'check';
  switch (sub) {
    case 'check':  return await cmdVoiceCheck(flags);
    case 'listen': return await cmdVoiceListen(flags);
    case 'enroll': return await cmdVoiceEnroll(flags, positional.slice(1));
    case 'devices': {
      const { backend } = await detectRecorder();
      if (!backend) { err('No recorder installed.'); return 1; }
      out(`Recorder: ${backend.command}`);

      const devices = await listAudioDevices({ backend });
      if (devices.length) {
        out('\nMicrophones:');
        devices.forEach((d, i) => out(`  ${i === 0 ? '*' : ' '} ${d}`));
        out('\n* is used by default. Pass another with --device "name".');
        return 0;
      }
      // Enumeration only works for ffmpeg on Windows. Everywhere else the
      // recorder has a real default device, so there is nothing to choose.
      out(process.platform === 'win32'
        ? 'No audio input devices found. Check Windows sound settings.'
        : 'This recorder uses the system default device. Override with --device.');
      return process.platform === 'win32' ? 1 : 0;
    }
    default:
      err(`Unknown: ${BRAND} voice ${sub}\nTry: check | listen | enroll | devices`);
      return 2;
  }
}

export { BACKENDS, systemVoice };
