// tests/helpers/python.js
// Resolve a working Python interpreter for tests that actually execute Python.
//
// Why this exists: `python3` does not exist on stock Windows — the name resolves
// to a Microsoft Store alias stub that prints an install message and exits
// non-zero. Tests that hardcoded `python3` therefore failed on Windows only.
//
// Resolution order: AGENT_TEST_PYTHON override → python3 → python → py.
// Returns null when no interpreter is available, so suites can skip honestly
// rather than fail on a machine that simply has no Python.

import { execFileSync } from 'node:child_process';

function works(bin) {
  try {
    // --version writes to stdout on 3.4+; a Store-alias stub exits non-zero.
    const out = execFileSync(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      encoding: 'utf-8',
    });
    return /^Python \d/.test(String(out).trim());
  } catch {
    return false;
  }
}

let _resolved;

/**
 * @returns {string|null} interpreter name usable as a run_command prefix, or null
 */
export function pythonBin() {
  if (_resolved !== undefined) return _resolved;
  const candidates = [process.env.AGENT_TEST_PYTHON, 'python3', 'python', 'py'].filter(Boolean);
  _resolved = candidates.find(works) ?? null;
  return _resolved;
}

/** True when a Python interpreter is available on this machine. */
export function hasPython() {
  return pythonBin() !== null;
}
