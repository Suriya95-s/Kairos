// src/tools/execution/shell.js
// Finding a POSIX shell, on a platform that does not ship one.
//
// Every command this agent runs is written in POSIX shell — `&&`, single
// quotes, `$(...)`, globs — and is checked for safety by an allowlist and a
// path-confinement pass that both assume that tokenization. So the shell is not
// an implementation detail that can be swapped for whatever the platform has.
//
// The bug this exists to fix: `spawnSync('sh', …)` resolves `sh` from PATH, and
// on Windows PATH contains `sh` only when the process was launched from Git
// Bash. Launched from PowerShell, from Explorer, or — the case that matters —
// **as a detached daemon inheriting the system environment**, there is no `sh`,
// and every command failed with `spawn sh ENOENT` reported as a generic
// "Exit code 1". Git for Windows ships a perfectly good `sh.exe`; it is simply
// not on PATH. So look for it.
//
// What is deliberately NOT done: falling back to `cmd.exe` or PowerShell. They
// would run *something* for most commands, which is worse than running nothing,
// because the allowlist and the path-confinement check were both validated
// against POSIX quoting. A command that is safe under `sh` is not automatically
// safe under a shell that parses `^`, `%VAR%` and embedded quotes differently.
// If no POSIX shell exists, that is reported as a missing dependency.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Resolved once per process, per preferred shell — each costs a spawn. */
const cache = new Map();

/**
 * Candidate shells, most-preferred first.
 *
 * The bare name comes first so that on Linux, macOS, and a Git Bash session the
 * answer is the normal one and nothing below is ever consulted.
 */
function candidates(env, platform, prefer, spawn) {
  const explicit = env.KAIROS_SHELL || env.AGENT_SHELL;
  const list = [];

  if (explicit) list.push(explicit);
  // `sh` is the contract; `bash` is only preferred when a caller says its
  // commands may use bashisms, and even then sh remains the fallback.
  const names = prefer === 'bash' ? ['bash', 'sh'] : ['sh', 'bash'];

  if (platform === 'win32') {
    // Bare names are resolved through `where`, never by spawning them.
    //
    // Two reasons, and the second is the serious one. Windows ships
    // `System32\bash.exe`, which is the **WSL launcher** — spawning it to see
    // whether it works hangs for as long as the probe allows, and if a distro
    // is installed it succeeds. A shell inside WSL has a different filesystem
    // namespace (`/mnt/c/...`), so a command that the allowlist and the
    // path-confinement check both approved for this workspace would run
    // against a path that means something else entirely. It must never be
    // selected, so it is excluded by location rather than discovered by luck.
    for (const name of names) {
      for (const hit of windowsPathLookup(name, spawn)) {
        if (!isWslStub(hit)) list.push(hit);
      }
    }
  } else {
    list.push(...names);
  }

  if (platform === 'win32') {
    // Git for Windows. `usr/bin` holds the real shells; `bin/` holds wrappers
    // that also work, kept as a second chance because some installs lack one.
    const roots = [
      env.ProgramFiles,
      env.ProgramW6432,
      env['ProgramFiles(x86)'],
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : null,
    ].filter(Boolean);

    for (const root of roots) {
      for (const name of names) {
        list.push(path.join(root, 'Git', 'usr', 'bin', `${name}.exe`));
        list.push(path.join(root, 'Git', 'bin', `${name}.exe`));
      }
    }

    // Last resort: ask where git itself is and walk to its sibling shell. This
    // catches installs in non-standard locations, which are common enough on
    // machines where somebody chose the install directory.
    const fromGit = gitInstallRoot(spawn);
    if (fromGit) {
      for (const name of names) {
        list.push(path.join(fromGit, 'usr', 'bin', `${name}.exe`));
        list.push(path.join(fromGit, 'bin', `${name}.exe`));
      }
    }
  } else {
    for (const name of names) list.push(`/bin/${name}`);
  }

  // De-duplicate, preserving order.
  return [...new Set(list)];
}

/** Absolute paths PATH would resolve a bare name to. Fast, and it never runs it. */
function windowsPathLookup(name, spawn) {
  try {
    const found = spawn('where', [name], { encoding: 'utf-8', windowsHide: true, timeout: 5000 });
    if (found.status !== 0) return [];
    return String(found.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * A WSL launcher, which is not a shell for *this* machine's filesystem.
 *
 * Matched by location, in two places, because Windows ships it in both:
 *   - `System32\bash.exe` — the classic launcher.
 *   - `WindowsApps\bash.exe` — the Store app-execution alias, a reparse point
 *     that is what `where bash` actually finds first on a modern install.
 *
 * Both start a shell inside a Linux VM with its own filesystem namespace, where
 * this workspace is reachable only as `/mnt/c/...`. Every path in a command was
 * checked for confinement against the Windows path, so running it there means
 * the checks were performed against a path the command never used. A real POSIX
 * shell arrives with Git, MSYS2 or Cygwin and lives nowhere near either folder.
 */
function isWslStub(candidate) {
  return /[\\/](?:System32|WindowsApps)[\\/](?:bash|wsl|sh)\.exe$/i.test(candidate);
}

/** Where Git for Windows lives, derived from wherever `git` is on PATH. */
function gitInstallRoot(spawn) {
  try {
    const found = spawn('where', ['git'], { encoding: 'utf-8', windowsHide: true, timeout: 5000 });
    const first = String(found.stdout || '').split(/\r?\n/).find(Boolean);
    if (!first) return null;
    // …\Git\cmd\git.exe or …\Git\bin\git.exe — the root is two levels up.
    return path.dirname(path.dirname(first.trim()));
  } catch {
    return null;
  }
}

/**
 * Is this candidate a working POSIX shell?
 *
 * Tested by running something, not by checking that the file exists: a path
 * that exists but cannot execute (a broken install, a wrong-architecture
 * binary, a zero-byte stub from an interrupted download) would otherwise be
 * selected and then fail on the first real command.
 */
function works(candidate, spawn, exists) {
  // An absolute path that is not there at all can be rejected without a spawn.
  if (path.isAbsolute(candidate) && !exists(candidate)) return false;
  if (isWslStub(candidate)) return false;
  try {
    const probe = spawn(candidate, ['-c', 'exit 7'], {
      encoding: 'utf-8', windowsHide: true, timeout: 5000, stdio: 'ignore',
    });
    // Exit 7 specifically, so that a stub which exits 0 for any argument, or a
    // shell that failed to parse `-c`, is not mistaken for a working shell.
    return !probe.error && probe.status === 7;
  } catch {
    return false;
  }
}

/**
 * The POSIX shell to run commands with, or null if the machine has none.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {string} [opts.platform]
 * @param {boolean} [opts.refresh] re-resolve instead of using the cached answer
 * @returns {{shell: string|null, tried: string[]}}
 */
export function resolvePosixShell({
  env = process.env, platform = process.platform, refresh = false, prefer = 'sh',
  spawnSyncFn = null, existsFn = null,
} = {}) {
  // Injected dependencies mean a test result, not this machine's result, so it
  // must never be cached — and must never be served *from* the cache either.
  const injected = !!(spawnSyncFn || existsFn);
  if (!injected && !refresh && cache.has(prefer)) return cache.get(prefer);

  const spawn = spawnSyncFn || spawnSync;
  const exists = existsFn || ((p) => fs.existsSync(p));

  const tried = [];
  let result = { shell: null, tried };
  for (const candidate of candidates(env, platform, prefer, spawn)) {
    tried.push(candidate);
    if (works(candidate, spawn, exists)) { result = { shell: candidate, tried }; break; }
  }

  if (!injected) cache.set(prefer, result);
  return result;
}

/** Forget the resolved shell. For tests, and for anything that changes PATH. */
export function resetShellCache() { cache.clear(); }

/**
 * The directories a resolved shell needs on PATH to be useful.
 *
 * Finding `sh.exe` is only half the job. Git for Windows keeps the shell in
 * `Git\usr\bin` along with `mkdir`, `grep`, `sed` and the rest of the
 * coreutils — and none of that is on PATH unless the process was launched from
 * Git Bash. Without this, a resolved shell can run `echo` (a builtin) and
 * essentially nothing else: `mkdir -p x && echo ok` fails with
 * "mkdir: command not found", which looks like a broken command rather than a
 * missing toolchain.
 *
 * @returns {string[]} existing directories, most-specific first
 */
export function shellPathAdditions(shell, { platform = process.platform, existsFn = null } = {}) {
  if (platform !== 'win32' || !shell || !path.isAbsolute(shell)) return [];
  const exists = existsFn || ((p) => fs.existsSync(p));

  const dir = path.dirname(shell);
  const out = [dir];

  // Git for Windows layout. The shell may be found in usr\bin or bin, but the
  // coreutils are always in usr\bin, and mingw64\bin holds the rest.
  const gitRoot = /^(.*[\\/]Git)[\\/](?:usr[\\/]bin|bin|mingw64[\\/]bin)$/i.exec(dir)?.[1];
  if (gitRoot) {
    out.push(path.join(gitRoot, 'usr', 'bin'));
    out.push(path.join(gitRoot, 'mingw64', 'bin'));
    out.push(path.join(gitRoot, 'bin'));
  }

  return [...new Set(out)].filter(exists);
}

/**
 * A copy of `env` with the shell's own tools reachable.
 *
 * The existing PATH key is reused rather than assumed: Windows spells it
 * `Path`, and adding a second `PATH` key to an environment block that already
 * has `Path` is ambiguous at best.
 */
export function shellEnv(baseEnv, shell, { platform = process.platform, existsFn = null } = {}) {
  const additions = shellPathAdditions(shell, { platform, existsFn });
  if (!additions.length) return baseEnv;

  const key = Object.keys(baseEnv).find(k => k.toLowerCase() === 'path') || 'PATH';
  const existing = baseEnv[key] ? String(baseEnv[key]).split(path.delimiter) : [];
  // Prepended, so the shell's own coreutils win over any same-named Windows
  // executable — `find.exe` and `sort.exe` in System32 are not the POSIX ones,
  // and a script that gets those instead behaves subtly and confusingly wrong.
  const merged = [...additions, ...existing.filter(p => !additions.includes(p))];

  return { ...baseEnv, [key]: merged.join(path.delimiter) };
}

/**
 * What to tell someone whose machine has no POSIX shell.
 *
 * Naming the paths that were checked matters more than it looks: the usual
 * cause is Git installed somewhere unusual, and seeing the four places that
 * were searched is what makes that obvious.
 */
export function describeMissingShell(tried, platform = process.platform) {
  const lines = ['No POSIX shell found. Commands are written in shell syntax and cannot be run without one.'];
  if (platform === 'win32') {
    lines.push('');
    lines.push('  Install Git for Windows, which includes sh.exe:');
    lines.push('    winget install --id Git.Git -e');
    lines.push('  Or point KAIROS_SHELL at an existing one:');
    lines.push('    set KAIROS_SHELL=C:\\Program Files\\Git\\usr\\bin\\sh.exe');
  } else {
    lines.push('  Expected /bin/sh to exist. Set KAIROS_SHELL to override.');
  }
  lines.push('');
  lines.push(`  Checked: ${tried.join(', ')}`);
  return lines.join('\n');
}
