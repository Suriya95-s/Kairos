// tests/voice-tts.test.js
// Speaking, and the two ways it goes wrong.
//
// The first is quoting. A reply is arbitrary text — it contains quotes, dollar
// signs, ampersands and backticks as a matter of routine — and Windows speech
// goes through a PowerShell command string, which treats every one of those as
// syntax. Passing the text as an argument would mean a reply that mentions
// `$HOME` speaks the wrong thing at best.
//
// The second is barge-in. Stopping must be indistinguishable from stopping
// instantly, and must not be reported as a failure.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { systemTts, probeSystemTts, systemVoice } from '../src/voice/tts.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }
  kill() { this.killed = true; this.emit('exit', null); return true; }
}

/** Captures how the synthesiser was invoked, and lets the test end the call. */
function recordingSpawn({ exitCode = 0, stderr = '', autoExit = true } = {}) {
  const calls = [];
  const spawnFn = (command, args, opts) => {
    const child = new FakeChild();
    calls.push({ command, args, opts, child });
    if (autoExit) {
      queueMicrotask(() => {
        if (child.killed) return;
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('exit', exitCode);
      });
    }
    return child;
  };
  return { calls, spawnFn };
}

const HOSTILE = 'He said "deploy $HOME" & it cost 100% — done; `backtick` \'quoted\'';

describe('which voice each platform uses', () => {
  test('every supported platform has one, and it needs no install on desktop', () => {
    assert.equal(systemVoice('win32').command, 'powershell');
    assert.equal(systemVoice('darwin').command, 'say');
    assert.equal(systemVoice('linux').command, 'spd-say');
    assert.equal(systemVoice('aix'), null);
  });

  test('an unknown platform fails at construction, not mid-sentence', () => {
    assert.throws(() => systemTts({ platform: 'aix' }), /no system voice/);
  });
});

describe('the text never becomes code', () => {
  test('Windows passes the reply in the environment, not in the command string', async () => {
    // The whole reason this design exists. If the text appeared in argv it
    // would be parsed by PowerShell, and `$HOME` would be expanded, `&` would
    // be a command separator, and a quote would end the script.
    const { calls, spawnFn } = recordingSpawn();
    await systemTts({ platform: 'win32', spawnFn })(HOSTILE);

    const { args, opts } = calls[0];
    assert.equal(calls[0].command, 'powershell');
    assert.equal(opts.env.KAIROS_SPEAK_TEXT, HOSTILE, 'the text must arrive intact');
    for (const arg of args) {
      assert.doesNotMatch(arg, /deploy|backtick|100%/, `the reply leaked into argv: ${arg}`);
    }
    assert.ok(args.some(a => a.includes('$env:KAIROS_SPEAK_TEXT')), 'the script must read it back');
  });

  test('Windows speech is non-interactive and profile-free', async () => {
    // A PowerShell profile that prints a banner, or prompts, would hang the
    // reply forever — and the daemon has no console to answer a prompt on.
    const { calls, spawnFn } = recordingSpawn();
    await systemTts({ platform: 'win32', spawnFn })('hello');
    assert.ok(calls[0].args.includes('-NoProfile'));
    assert.ok(calls[0].args.includes('-NonInteractive'));
    assert.equal(calls[0].opts.windowsHide, true);
  });

  test('macOS and Linux pass the text as one argument, which spawn does not parse', async () => {
    for (const [platform, expected] of [['darwin', 'say'], ['linux', 'spd-say']]) {
      const { calls, spawnFn } = recordingSpawn();
      await systemTts({ platform, spawnFn })(HOSTILE);
      assert.equal(calls[0].command, expected);
      assert.ok(calls[0].args.includes(HOSTILE), `${platform} must pass the text verbatim`);
      // No shell is involved, so a single argv element is safe as-is.
      assert.notEqual(calls[0].opts.shell, true, 'a shell would reintroduce every quoting problem');
    }
  });

  test('non-string replies do not crash the synthesiser', async () => {
    const { calls, spawnFn } = recordingSpawn();
    await systemTts({ platform: 'darwin', spawnFn })(42);
    assert.ok(calls[0].args.includes('42'));
  });
});

describe('barge-in', () => {
  test('aborting kills the process and reports AbortError, not a failure', async () => {
    // VoiceSession distinguishes these by name: an AbortError is an
    // interruption, anything else is an error worth telling the user about.
    const { calls, spawnFn } = recordingSpawn({ autoExit: false });
    const controller = new AbortController();
    const promise = systemTts({ platform: 'darwin', spawnFn })('a long sentence', { signal: controller.signal });

    await Promise.resolve();
    controller.abort();

    await assert.rejects(promise, (err) => {
      assert.equal(err.name, 'AbortError', 'a barge-in must not look like a crash');
      return true;
    });
    assert.equal(calls[0].child.killed, true, 'stopping must actually stop it');
  });

  test('a signal already aborted never starts the synthesiser at all', async () => {
    // Spawning and then killing would leave a window in which a syllable can
    // escape. The surest way to say nothing is to not start.
    const { calls, spawnFn } = recordingSpawn({ autoExit: false });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      systemTts({ platform: 'darwin', spawnFn })('should not be heard', { signal: controller.signal }),
      (err) => err.name === 'AbortError',
    );
    assert.equal(calls.length, 0, 'nothing should have been spawned');
  });
});

describe('failures are reported with the engine\'s own words', () => {
  test('a non-zero exit includes stderr', async () => {
    const { spawnFn } = recordingSpawn({ exitCode: 1, stderr: 'no voices are installed' });
    await assert.rejects(
      systemTts({ platform: 'darwin', spawnFn })('hello'),
      /exited 1.*no voices are installed/s,
    );
  });

  test('a missing binary propagates rather than resolving silently', async () => {
    // Resolving would mean the system believed it had spoken. Silence that
    // reports success is the worst outcome available.
    const spawnFn = () => {
      const child = new FakeChild();
      queueMicrotask(() => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; child.emit('error', e); });
      return child;
    };
    await assert.rejects(systemTts({ platform: 'darwin', spawnFn })('hello'), /ENOENT/);
  });
});

describe('probing for a usable voice', () => {
  function probeSpawn(available) {
    return (command) => {
      const child = new FakeChild();
      queueMicrotask(() => {
        if (available.includes(command)) child.emit('exit', 0);
        else { const e = new Error('nope'); e.code = 'ENOENT'; child.emit('error', e); }
      });
      return child;
    };
  }

  test('Linux falls back to espeak-ng when speech-dispatcher is absent', async () => {
    // spd-say is the better option and the less commonly installed one.
    const result = await probeSystemTts({ platform: 'linux', spawnFn: probeSpawn(['espeak-ng']) });
    assert.equal(result.ok, true);
    assert.equal(result.command, 'espeak-ng');
  });

  test('it prefers speech-dispatcher when both are present', async () => {
    const result = await probeSystemTts({ platform: 'linux', spawnFn: probeSpawn(['spd-say', 'espeak-ng']) });
    assert.equal(result.command, 'spd-say');
  });

  test('nothing usable reports an install hint rather than just false', async () => {
    const result = await probeSystemTts({ platform: 'linux', spawnFn: probeSpawn([]) });
    assert.equal(result.ok, false);
    assert.match(result.install, /apt install/);
  });

  test('the probe never speaks', async () => {
    // Probing by saying something aloud would make `voice check` announce
    // itself in a quiet room.
    const { calls, spawnFn } = recordingSpawn();
    await probeSystemTts({ platform: 'darwin', spawnFn });
    for (const call of calls) {
      assert.ok(!call.args.some(a => /hello|test|check/i.test(a)), `the probe tried to say something: ${call.args}`);
    }
  });

  test('a probe that hangs times out as unusable, not as usable', async () => {
    // The subtle half: the timeout kills the child, and if that kill delivered
    // 'exit' synchronously the exit handler would report success — a probe that
    // timed out would say the voice works. It must settle before it kills.
    const result = await probeSystemTts({
      platform: 'darwin',
      timeoutMs: 50,
      spawnFn: () => new FakeChild(),   // never exits, never errors on its own
    });
    assert.equal(result.ok, false);
  });
});
