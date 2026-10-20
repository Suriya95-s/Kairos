// src/voice/tts.js
// Speaking, using what the operating system already has.
//
// Every desktop platform ships a speech synthesiser, and none of them need
// installing, downloading or configuring. Requiring a model just to say "done"
// would make voice output the one part of this that cannot be tried on a whim.
//
// Quality is mediocre and that is the correct trade: the replies here are one
// sentence long by design (see speakable.js), and a natural-sounding voice
// reading a sentence is not meaningfully better than a synthetic one reading
// the same sentence. Someone who wants better points `--tts` at their own
// engine.

import os from 'node:os';

/**
 * What each platform speaks with.
 *
 * Windows goes through PowerShell because System.Speech is a .NET assembly with
 * no command-line front end. The text is passed in the **environment**, not in
 * the command string: a reply containing a quote, a dollar sign or a backtick
 * would otherwise be interpreted as PowerShell rather than spoken, and replies
 * routinely contain all three.
 */
const VOICES = Object.freeze({
  win32: {
    command: 'powershell',
    args: () => ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Speech; ' +
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      '$s.Speak($env:KAIROS_SPEAK_TEXT)'],
    viaEnv: 'KAIROS_SPEAK_TEXT',
    install: 'built in to Windows',
  },
  darwin: {
    // `say` takes the text as an argument, and spawn without a shell passes it
    // through untouched — no quoting to get wrong.
    command: 'say',
    args: (text) => [text],
    install: 'built in to macOS',
  },
  linux: {
    command: 'spd-say',
    args: (text) => ['-w', text],
    install: 'apt install speech-dispatcher  (or: apt install espeak-ng)',
  },
});

/** The fallback when spd-say is absent, which it often is. */
const LINUX_ALTERNATE = { command: 'espeak-ng', args: (text) => [text], install: 'apt install espeak-ng' };

/** What this platform would use, without checking whether it is installed. */
export function systemVoice(platform = os.platform()) {
  return VOICES[platform] || null;
}

/**
 * Build a `tts` function for VoiceSession backed by the system voice.
 *
 * Aborting kills the process, which is what makes barge-in instant — there is
 * no buffer to drain and no callback to wait for.
 */
export function systemTts({ platform = os.platform(), spawnFn = null, voice = null } = {}) {
  const chosen = voice || systemVoice(platform);
  if (!chosen) throw new Error(`no system voice is known for platform "${platform}"`);

  return async (text, { signal } = {}) => {
    // Checked before spawning, not after. A barge-in that lands between the
    // decision to speak and the process starting must produce silence, and the
    // surest way to say nothing is to never start the synthesiser.
    if (signal?.aborted) {
      const err = new Error('interrupted'); err.name = 'AbortError'; throw err;
    }

    const { spawn } = spawnFn ? { spawn: spawnFn } : await import('node:child_process');
    return new Promise((resolve, reject) => {
      const env = chosen.viaEnv ? { ...process.env, [chosen.viaEnv]: String(text) } : process.env;
      let child;
      try {
        child = spawn(chosen.command, chosen.args(String(text)), { windowsHide: true, env });
      } catch (err) { return reject(err); }

      const onAbort = () => { try { child.kill(); } catch { /* already gone */ } };
      signal?.addEventListener?.('abort', onAbort, { once: true });

      let stderr = '';
      child.stderr?.on('data', d => { stderr += d; });
      child.on('error', (err) => {
        signal?.removeEventListener?.('abort', onAbort);
        reject(err);
      });
      child.on('exit', (code) => {
        signal?.removeEventListener?.('abort', onAbort);
        if (signal?.aborted) {
          // A barge-in is not a failure. VoiceSession distinguishes them by name.
          const err = new Error('interrupted'); err.name = 'AbortError'; return reject(err);
        }
        if (code !== 0) return reject(new Error(`speech synthesis exited ${code}: ${stderr.trim().slice(-200)}`));
        resolve();
      });
    });
  };
}

/**
 * Is the system voice actually usable? Probing by running it, for the same
 * reason detectRecorder does: present on PATH and able to run are different.
 */
export async function probeSystemTts({ platform = os.platform(), spawnFn = null, timeoutMs = 6000 } = {}) {
  const candidates = platform === 'linux'
    ? [VOICES.linux, LINUX_ALTERNATE]
    : [systemVoice(platform)].filter(Boolean);

  for (const candidate of candidates) {
    const ok = await canRun(candidate.command, spawnFn, timeoutMs);
    if (ok) return { ok: true, voice: candidate, command: candidate.command };
  }
  const first = candidates[0];
  return { ok: false, voice: null, command: first?.command || null, install: first?.install };
}

function canRun(command, spawnFn, timeoutMs = 6000) {
  return new Promise((resolve) => {
    (async () => {
      const { spawn } = spawnFn ? { spawn: spawnFn } : await import('node:child_process');
      let child;
      try {
        // `-?` is not universal, but every candidate here exits rather than
        // blocking when handed an argument it does not understand — which is
        // all that needs establishing.
        child = spawn(command, command === 'powershell' ? ['-NoProfile', '-Command', '$null'] : ['--version'],
          { windowsHide: true, stdio: 'ignore' });
      } catch { return resolve(false); }

      // Settle first, kill second, and guard both. Killing first makes the
      // answer depend on whether kill() happens to deliver 'exit' synchronously
      // — which would mean a probe that timed out could still report success.
      let settled = false;
      const finish = (ok) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };

      const timer = setTimeout(() => { finish(false); try { child.kill(); } catch {} }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      child.on('error', () => finish(false));
      child.on('exit', () => finish(true));
    })();
  });
}
