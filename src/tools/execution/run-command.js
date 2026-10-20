import { spawnSync } from 'node:child_process';
import { resolvePosixShell, describeMissingShell, shellEnv } from './shell.js';
import path from 'node:path';
import config from '../../config.js';
import { getWorkspace, readCommandsRun, trackCommand } from '../../state.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'run_command',
    description: 'Execute a shell command in the workspace directory. Returns stdout + stderr.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        timeout: { type: 'integer', description: 'Timeout in ms (default: 30000)', default: 30000 },
        allowRepeat: { type: 'boolean', description: 'Set true to allow repeating the same command even if it was recently successful.', default: false },
        dryRun: { type: 'boolean', description: 'Validate and preview the command without executing it.', default: false },
      },
      required: ['command'],
    },
  },
};

function normalizeCommand(command) {
  return String(command || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^mkdir\s+-p\s+result\s*&&\s*/i, '');
}

function isSkippableDuplicateCandidate(command) {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;

  // Only dedupe composite/setup-style commands. Single verification commands
  // like `node ... list` or `node --test ...` must remain repeatable.
  return normalized.includes('&&')
    || normalized.includes('||')
    || normalized.includes('>')
    || normalized.includes('|')
    || /^mkdir\s+-p\b/i.test(normalized);
}

function wasRecentlySuccessful(command, lookback = 20) {
  if (!isSkippableDuplicateCandidate(command)) return false;
  const normalized = normalizeCommand(command);
  const history = readCommandsRun();
  const recent = history.slice(-lookback).reverse();
  return recent.some(entry =>
    Number(entry.exitCode) === 0 &&
    entry.skipped !== true &&
    entry.dedupStale !== true &&   // re-armed after a repair: allow re-run
    normalizeCommand(entry.command) === normalized
  );
}

function getLastCommandOutput(command, lookback = 20) {
  const normalized = normalizeCommand(command);
  const history = readCommandsRun();
  const recent = history.slice(-lookback).reverse();
  const match = recent.find(entry =>
    entry.skipped !== true &&
    normalizeCommand(entry.command) === normalized
  );
  return match ? String(match.outputSnippet || '').trim().slice(0, 200) : null;
}

// Default command allowlist. Extend via AGENT_ALLOWED_COMMANDS env var (comma-separated prefixes).
const DEFAULT_PREFIXES = [
  // JavaScript / Node.js
  'npm ', 'node ', 'npx ', 'yarn ', 'pnpm ', 'bun ', 'deno ', 'tsc ', 'jest ', 'mocha ', 'eslint ', 'prettier ',
  // Python
  'python', 'python3', 'pip ', 'pip3 ', 'pytest ', 'uv ',
  // Rust
  'cargo ', 'rustc ',
  // Go
  'go ',
  // Java / JVM
  'java ', 'javac ', 'mvn ', 'gradle ',
  // C / C++
  'make ', 'cmake ', 'gcc ', 'g++ ', 'cc ',
  // .NET
  'dotnet ',
  // Ruby
  'ruby ', 'bundle ', 'gem ', 'rake ',
  // Git
  'git ',
  // Docker
  'docker ', 'docker-compose ',
  // Shell utilities
  'cd ', 'cat ', 'ls ', 'find ', 'grep ', 'echo ', 'printf ', 'mkdir ', 'cp ', 'mv ', 'rm ',
  'bash ', 'sh ', 'pwd', 'sed ', 'head ', 'tail ', 'touch ', 'chmod ', 'chown ',
  'awk ', 'sort ', 'uniq ', 'wc ', 'diff ', 'tar ', 'zip ', 'unzip ',
  'which ', 'env ', 'test ', 'true', 'false', 'curl ', 'wget ',
  // System info / diagnostics
  'date', 'stat ', 'file ', 'uname ', 'hostname', 'whoami', 'id ',
  'df ', 'du ', 'free ', 'uptime', 'ps ', 'top ', 'lsof ',
  'type ', 'command ', 'kill ', 'nohup ', 'time ',
];

const ALLOWED_PREFIXES = (() => {
  const extra = process.env.AGENT_ALLOWED_COMMANDS;
  if (!extra) return DEFAULT_PREFIXES;
  const custom = extra.split(',').map(s => s.trim()).filter(Boolean);
  return [...DEFAULT_PREFIXES, ...custom];
})();

function normalizeSegment(segment) {
  let text = String(segment || '').trim();
  while (text.startsWith('(') && text.endsWith(')')) {
    text = text.slice(1, -1).trim();
  }
  text = text
    .replace(/\s+\d*>>?\s*[^&|;]+$/g, '')
    .replace(/\s+\d*>\s*&\d+\s*$/g, '')
    .trim();
  return text;
}

function splitCommandSegments(command) {
  const input = String(command || '');
  const segments = [];
  let current = '';
  let singleQuote = false;
  let doubleQuote = false;
  let escape = false;
  let parenDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escape = true;
      continue;
    }

    if (ch === "'" && !doubleQuote) {
      singleQuote = !singleQuote;
      current += ch;
      continue;
    }

    if (ch === '"' && !singleQuote) {
      doubleQuote = !doubleQuote;
      current += ch;
      continue;
    }

    if (!singleQuote && !doubleQuote) {
      // A raw newline (or carriage return) outside quotes is a command separator
      // for `sh -c`, so it MUST split segments here — otherwise the allowlist
      // would only validate the first line and `sh -c $'a\nrm -rf /'` would run
      // the rest unchecked. A trailing backslash before the newline was already
      // consumed by the escape handler above, so line continuations are safe.
      if (ch === '\n' || ch === '\r') {
        if (current.trim()) segments.push(normalizeSegment(current));
        current = '';
        continue;
      }
      if (ch === '(') {
        parenDepth++;
        current += ch;
        continue;
      }
      if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
        current += ch;
        continue;
      }

      const twoChar = `${ch}${next || ''}`;
      if (parenDepth === 0 && (twoChar === '&&' || twoChar === '||')) {
        if (current.trim()) segments.push(normalizeSegment(current));
        current = '';
        i++;
        continue;
      }
      if (parenDepth === 0 && (ch === ';' || ch === '|')) {
        if (current.trim()) segments.push(normalizeSegment(current));
        current = '';
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) segments.push(normalizeSegment(current));
  return segments.filter(Boolean);
}

// Block dangerous shell metacharacters that bypass prefix validation
const DANGEROUS_PATTERNS = [
  /`[^`]+`/,        // backtick command substitution
  /\$\(/,           // $() command substitution
  /[<>]\(/,         // process substitution <() >()
];

function hasDangerousShellSyntax(command) {
  // Check the raw command outside of single-quoted strings (where metacharacters are literal)
  const withoutSingleQuoted = command.replace(/'[^']*'/g, '');
  return DANGEROUS_PATTERNS.some(p => p.test(withoutSingleQuoted));
}

function isAllowedCommand(command) {
  if (hasDangerousShellSyntax(command)) return false;
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const cmd = normalizeSegment(segment).toLowerCase();
    return ALLOWED_PREFIXES.some((prefix) => cmd.startsWith(prefix));
  });
}

// Commands that mutate the filesystem at a path argument. Used by the optional
// path-confinement guard to decide which segments to inspect for escaping paths.
const DESTRUCTIVE_CMDS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'dd', 'tee', 'truncate', 'shred',
  'chmod', 'chown', 'mkdir', 'touch', 'ln',
]);

function resolvesOutsideWorkspace(token, workspace) {
  let p = token;
  if (p.startsWith('~')) return true; // home-relative — outside the workspace
  const abs = path.resolve(workspace, p);
  const rel = path.relative(workspace, abs);
  // Outside if the relative path climbs out (starts with ..) or is itself absolute
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

// Optional, opt-in (config.confinePaths) guard: block destructive commands or
// output redirects whose path arguments escape the workspace. Returns a reason
// string when the command should be blocked, or '' when it is safe/not applicable.
function pathConfinementViolation(command, workspace) {
  if (!config.confinePaths) return '';

  // Output redirects are stripped by normalizeSegment, so scan the RAW command.
  const redirectRe = /(?:^|[^0-9>])>>?\s*([^\s|&;<>]+)/g;
  let m;
  while ((m = redirectRe.exec(command)) !== null) {
    const target = m[1];
    if (/[\/~]/.test(target) && resolvesOutsideWorkspace(target, workspace)) {
      return `Blocked (path confinement): output redirect to "${target}" outside the workspace.`;
    }
  }

  // Destructive command path arguments use the normalized segments.
  for (const segment of splitCommandSegments(command)) {
    const tokens = normalizeSegment(segment).split(/\s+/).filter(Boolean);
    const head = (tokens[0] || '').toLowerCase();
    if (!DESTRUCTIVE_CMDS.has(head)) continue;
    for (const tok of tokens.slice(1)) {
      if (tok.startsWith('-')) continue;                 // flags
      if (!/[\/~]/.test(tok) && tok !== '..') continue;  // not path-like
      if (resolvesOutsideWorkspace(tok, workspace)) {
        return `Blocked (path confinement): "${head}" targets path "${tok}" outside the workspace.`;
      }
    }
  }
  return '';
}

/**
 * Kill a timed-out command and everything it started.
 *
 * `process.kill(-pid)` is a POSIX process-group signal and is not implemented
 * on Windows — it throws, the throw was swallowed, and every grandchild of a
 * timed-out command survived. `taskkill /T` is the equivalent that does exist.
 */
function killTree(pid) {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } catch { /* the tree is already gone, which is the desired state anyway */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
}

export function handler({ command, timeout, allowRepeat, dryRun }) {
  // Clamp the timeout to a hard ceiling so the model can't request an unbounded run.
  const requested = Number.isFinite(timeout) && timeout > 0 ? timeout : config.runCommandTimeoutMs;
  const timeoutMs = Math.min(requested, config.runCommandMaxTimeoutMs);
  if (!isAllowedCommand(command)) {
    return fail(`Blocked: command "${String(command || '').slice(0, 80)}" not in allowlist.`);
  }
  const confinement = pathConfinementViolation(command, getWorkspace());
  if (confinement) {
    trackCommand(command, 126, confinement, { skipped: false });
    return fail(confinement, { exitCode: 126 });
  }
  // Dry run: all safety checks have passed; preview without executing.
  if (dryRun) {
    return ok(`[dry-run] would run: ${normalizeCommand(command)}`, { dryRun: true });
  }
  if (!allowRepeat && wasRecentlySuccessful(command)) {
    const prevOutput = getLastCommandOutput(command);
    const msg = `Skipped duplicate command: ${command}${prevOutput ? `\n[Last result: ${prevOutput}]` : ''}`;
    trackCommand(command, 0, msg, { skipped: true });
    return ok(msg);
  }

  // The shell is resolved rather than assumed. `sh` is on PATH only when the
  // process was launched from a POSIX shell; started from PowerShell, from
  // Explorer, or as a detached daemon inheriting the system environment, it is
  // not, and every command used to fail with `spawn sh ENOENT` reported as a
  // bare "Exit code 1". Git for Windows ships sh.exe — it is just not on PATH.
  const { shell, tried } = resolvePosixShell();
  if (!shell) {
    // The message already names every path that was checked, which is what
    // makes an unusual Git install location obvious.
    const msg = describeMissingShell(tried);
    trackCommand(command, 127, msg, { skipped: false });
    return fail(msg, { exitCode: 127 });
  }

  // spawnSync with detached:true puts the shell in its own process group, so on
  // timeout we can SIGKILL the entire tree (-pid) — execSync only ever killed
  // the direct child, leaking grandchildren (e.g. `npm test` → node workers).
  const ret = spawnSync(shell, ['-c', command], {
    cwd: getWorkspace(),
    // The shell's own coreutils must be reachable, or only builtins work.
    env: shellEnv(process.env, shell),
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    killSignal: 'SIGKILL',
  });

  const stdout = ret.stdout || '';
  const stderr = ret.stderr || '';

  // Timeout: spawnSync sets error.code ETIMEDOUT and signals the child. Reap the
  // whole process group so no grandchild survives the terminated command.
  const timedOut = (ret.error && ret.error.code === 'ETIMEDOUT')
    || ret.signal === 'SIGKILL' || ret.signal === 'SIGTERM';
  if (timedOut) {
    if (ret.pid) killTree(ret.pid);
    const partial = (stdout + stderr).slice(0, 3000);
    const msg = `Command timed out after ${timeoutMs}ms and was terminated. Partial output:\n${partial}`;
    trackCommand(command, 124, msg, { skipped: false });
    return fail(msg, { exitCode: 124 });
  }

  // Spawn-level failure (shell missing, etc.) — surface as a generic error.
  if (ret.error) {
    const msg = `Exit code 1:\n${(stderr || ret.error.message).slice(0, 5000)}`;
    trackCommand(command, 1, msg, { skipped: false });
    return fail(msg, { exitCode: 1 });
  }

  const exitCode = Number.isInteger(ret.status) ? ret.status : 1;
  if (exitCode === 0) {
    // Preserve prior behavior: a successful command surfaces stdout only.
    const output = stdout;
    trackCommand(command, 0, output, { skipped: false });
    const lines = output.split('\n');
    if (lines.length > config.maxTerminalLines) {
      const kept = Math.floor(config.maxTerminalLines / 2);
      return ok([
        ...lines.slice(0, kept),
        `\n... [${lines.length - config.maxTerminalLines} lines omitted] ...\n`,
        ...lines.slice(-kept),
      ].join('\n'));
    }
    return ok(output || '(no output)');
  }

  const output = stdout + stderr;
  trackCommand(command, exitCode, output, { skipped: false });
  return fail(`Exit code ${exitCode}:\n${output.slice(0, 5000)}`, { exitCode });
}
