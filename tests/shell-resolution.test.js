// tests/shell-resolution.test.js
// Finding a POSIX shell on a platform that does not ship one.
//
// This exists because of a bug that was invisible from a developer machine and
// fatal on a deployed one: `spawnSync('sh', …)` finds `sh` only when the
// process was launched from a POSIX shell. Started from PowerShell, from
// Explorer, or **as a detached daemon inheriting the system environment**,
// there is no `sh` on PATH, and every command the agent ran failed with
// `spawn sh ENOENT` — surfaced to the model as a bare "Exit code 1", which
// reads as "your command was wrong" rather than "nothing can run here".
//
// The second bug is the one worth reading carefully: on Windows, `bash` on PATH
// is usually the **WSL launcher**, and selecting it would run commands inside a
// Linux VM whose filesystem this workspace is not on.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePosixShell, resetShellCache, describeMissingShell,
  shellPathAdditions, shellEnv,
} from '../src/tools/execution/shell.js';

beforeEach(() => resetShellCache());

/** An env with none of the Windows roots, so only what a test adds is found. */
const BARE_WIN_ENV = { SystemRoot: 'C:\\Windows' };

describe('the shell actually used on this machine', () => {
  test('one is found, and it runs POSIX syntax', () => {
    // Not asserting *which*: that legitimately differs between machines. What
    // must hold is that one was found and that it is a real shell — the probe
    // requires `sh -c 'exit 7'` to exit 7, so a stub that exits 0 for anything
    // cannot pass.
    const { shell, tried } = resolvePosixShell();
    assert.ok(shell, `no POSIX shell found; tried:\n${tried.join('\n')}`);
  });

  test('the answer is cached, because it cannot change mid-process', () => {
    const first = resolvePosixShell();
    const second = resolvePosixShell();
    assert.equal(first, second, 'the same object should come back, not a re-resolution');
  });

  test('sh and bash are resolved and cached independently', () => {
    const sh = resolvePosixShell({ prefer: 'sh' });
    const bash = resolvePosixShell({ prefer: 'bash' });
    assert.ok(sh.shell);
    assert.ok(bash.shell);
    assert.notEqual(sh, bash, 'one cache slot for both would return the wrong shell');
  });

  test('resolution is fast enough to sit in front of every command', () => {
    // It used to take ~5s, because probing bare `bash` on Windows spawns the
    // WSL launcher and waits for it. Every process pays this once, so a slow
    // resolution is a slow first command, every time.
    resetShellCache();
    const started = process.hrtime.bigint();
    resolvePosixShell();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 3000, `shell resolution took ${Math.round(ms)}ms`);
  });
});

describe('an explicit override wins', () => {
  test('KAIROS_SHELL is tried before anything else', () => {
    const real = resolvePosixShell().shell;
    resetShellCache();
    const { shell, tried } = resolvePosixShell({ env: { ...process.env, KAIROS_SHELL: real } });
    assert.equal(shell, real);
    assert.equal(tried[0], real, 'the override must be first, not merely present');
  });

  test('an override that does not work falls through rather than failing', () => {
    // Otherwise a stale setting in someone's profile bricks the agent.
    resetShellCache();
    const { shell } = resolvePosixShell({
      env: { ...process.env, KAIROS_SHELL: 'C:\\nope\\not-a-shell.exe' },
    });
    assert.ok(shell, 'a bad override must not prevent finding a real shell');
    assert.doesNotMatch(shell, /not-a-shell/);
  });
});

describe('the WSL trap', () => {
  // The important tests in this file. On Windows, `where bash` finds
  // System32\bash.exe or the WindowsApps alias — both launch a Linux VM. A
  // command approved by the allowlist and the path-confinement check for
  // C:\work\project would run against a filesystem where that path does not
  // exist, so the checks would have been performed against something the
  // command never touched.

  test('a WSL launcher is never selected, even when it works', () => {
    let spawned = 0;
    const result = resolvePosixShell({
      platform: 'win32',
      env: BARE_WIN_ENV,
      // Everything "works" — including the WSL stub. Only the exclusion by
      // location can keep it out.
      ...withFakes({
        where: { bash: ['C:\\Windows\\System32\\bash.exe'], sh: [] },
        onProbe: () => { spawned++; return 7; },
      }),
    });
    assert.equal(result.shell, null, 'the WSL launcher must not be chosen');
    assert.equal(spawned, 0, 'and it must not even be executed to find that out');
  });

  test('both spellings of the launcher are excluded', () => {
    for (const stub of [
      'C:\\Windows\\System32\\bash.exe',
      'C:\\Users\\someone\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
      'C:\\Windows\\System32\\wsl.exe',
    ]) {
      const { shell } = resolvePosixShell({
        platform: 'win32', env: BARE_WIN_ENV, refresh: true,
        ...withFakes({ where: { sh: [stub], bash: [stub] }, onProbe: () => 7 }),
      });
      assert.equal(shell, null, `${stub} was selected`);
      resetShellCache();
    }
  });

  test('a real Git shell is chosen over a WSL launcher on the same PATH', () => {
    const git = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
    const { shell } = resolvePosixShell({
      platform: 'win32', prefer: 'bash', env: BARE_WIN_ENV,
      ...withFakes({
        where: { bash: ['C:\\Windows\\System32\\bash.exe', git], sh: [] },
        onProbe: () => 7,
      }),
    });
    assert.equal(shell, git);
  });
});

describe('a shell that exists but does not work is not selected', () => {
  test('a stub that exits 0 for any argument is rejected', () => {
    // The probe asks for `exit 7` specifically. A wrapper that swallows its
    // arguments and succeeds would otherwise look like a working shell, and
    // every command would silently "succeed" while doing nothing.
    const { shell } = resolvePosixShell({
      platform: 'win32', env: BARE_WIN_ENV,
      ...withFakes({ where: { sh: ['C:\\fake\\sh.exe'], bash: [] }, onProbe: () => 0 }),
    });
    assert.equal(shell, null);
  });

  test('a path that is not on disk is rejected without spawning it', () => {
    let spawned = 0;
    const { shell } = resolvePosixShell({
      platform: 'win32', env: BARE_WIN_ENV,
      ...withFakes({
        where: { sh: ['C:\\gone\\sh.exe'], bash: [] },
        exists: () => false,
        onProbe: () => { spawned++; return 7; },
      }),
    });
    assert.equal(shell, null);
    assert.equal(spawned, 0);
  });
});

describe('the shell brings its own tools', () => {
  // Finding sh.exe is only half the job. Git for Windows keeps the coreutils in
  // `Git\usr\bin`, and none of it is on PATH unless the process was launched
  // from Git Bash. Without this the resolved shell can run `echo` — a builtin —
  // and almost nothing else: `mkdir -p x && echo ok` fails with
  // "mkdir: command not found", which reads as a bad command rather than a
  // missing toolchain. That is a worse failure than not finding a shell at all,
  // because it looks like the agent wrote something wrong.

  const GIT_SH = 'C:\\Program Files\\Git\\usr\\bin\\sh.exe';

  test('the coreutils directory is added for a Git shell', () => {
    const added = shellPathAdditions(GIT_SH, { platform: 'win32', existsFn: () => true });
    assert.ok(added.includes('C:\\Program Files\\Git\\usr\\bin'), added.join(' | '));
  });

  test('usr\\bin is added even when the shell was found in bin', () => {
    // `Git\bin\sh.exe` is a wrapper; the tools still live one directory over.
    const added = shellPathAdditions('C:\\Program Files\\Git\\bin\\sh.exe',
      { platform: 'win32', existsFn: () => true });
    assert.ok(added.includes('C:\\Program Files\\Git\\usr\\bin'), added.join(' | '));
  });

  test('directories that do not exist are not added', () => {
    const added = shellPathAdditions(GIT_SH, {
      platform: 'win32',
      existsFn: (p) => p === 'C:\\Program Files\\Git\\usr\\bin',
    });
    assert.deepEqual(added, ['C:\\Program Files\\Git\\usr\\bin']);
  });

  test('POSIX platforms are left alone — the tools are already on PATH', () => {
    assert.deepEqual(shellPathAdditions('/bin/sh', { platform: 'linux' }), []);
  });

  test('the shell tools go in front, so POSIX find beats System32 find.exe', () => {
    // `find.exe` and `sort.exe` in System32 are Windows programs with the same
    // names and different behaviour. A script that gets those instead fails in
    // a way that is very hard to read.
    const env = shellEnv({ Path: 'C:\\Windows\\System32' }, GIT_SH,
      { platform: 'win32', existsFn: () => true });
    const parts = env.Path.split(';');
    assert.ok(parts.indexOf('C:\\Program Files\\Git\\usr\\bin') < parts.indexOf('C:\\Windows\\System32'));
  });

  test('the existing PATH is kept, and its key casing is preserved', () => {
    // Windows spells it `Path`. Adding a second `PATH` key alongside it makes
    // the environment block ambiguous.
    const env = shellEnv({ Path: 'C:\\Windows\\System32', OTHER: 'x' }, GIT_SH,
      { platform: 'win32', existsFn: () => true });
    assert.ok(!('PATH' in env), 'a duplicate PATH key was added');
    assert.match(env.Path, /System32/);
    assert.equal(env.OTHER, 'x', 'the rest of the environment must survive');
  });

  test('a directory already on PATH is not duplicated', () => {
    const env = shellEnv({ Path: `C:\\Program Files\\Git\\usr\\bin;C:\\Windows` }, GIT_SH,
      { platform: 'win32', existsFn: () => true });
    const count = env.Path.split(';').filter(p => p === 'C:\\Program Files\\Git\\usr\\bin').length;
    assert.equal(count, 1);
  });

  test('nothing to add means the env is returned untouched', () => {
    const base = { PATH: '/usr/bin' };
    assert.equal(shellEnv(base, '/bin/sh', { platform: 'linux' }), base);
  });
});

describe('when there is no shell at all', () => {
  test('the message says how to get one and what was checked', () => {
    const { shell, tried } = resolvePosixShell({
      platform: 'win32', env: BARE_WIN_ENV,
      ...withFakes({ where: { sh: [], bash: [] }, onProbe: () => 1 }),
    });
    assert.equal(shell, null);

    const message = describeMissingShell(tried, 'win32');
    assert.match(message, /No POSIX shell found/);
    assert.match(message, /winget install --id Git\.Git/, 'saying what is broken without how to fix it is half an error');
    assert.match(message, /KAIROS_SHELL/, 'the override must be discoverable');
  });

  test('the POSIX message does not tell a Linux user to install Git for Windows', () => {
    const message = describeMissingShell(['sh', '/bin/sh'], 'linux');
    assert.doesNotMatch(message, /winget/);
    assert.match(message, /\/bin\/sh/);
  });
});

/**
 * Fake `where` and fake process spawning.
 *
 * Injected through the same option surface the production code uses, so the
 * suite never depends on what happens to be installed on the machine running
 * it — which is exactly the variable that made the original bug invisible.
 */
function withFakes({ where = {}, onProbe = () => 1, exists = () => true }) {
  return {
    spawnSyncFn: (command, args) => {
      if (command === 'where') {
        const hits = where[args[0]] || [];
        return { status: hits.length ? 0 : 1, stdout: hits.join('\r\n') };
      }
      return { status: onProbe(command), error: undefined };
    },
    existsFn: exists,
  };
}
