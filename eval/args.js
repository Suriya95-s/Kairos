// eval/args.js — shared, testable CLI flag parsing for the eval harnesses.
//
// indexOf(name) returns -1 when a flag is absent, and args[-1 + 1] === args[0]
// would silently turn the positional file argument into a flag value (the bug
// that made every benchmark run time out instantly). These helpers guard the
// index and validate numbers.

/** Return the value following `name`, or `def` if the flag is absent/valueless. */
export function getFlag(args, name, def) {
  const i = args.indexOf(name);
  return (i >= 0 && i + 1 < args.length) ? args[i + 1] : def;
}

/** Parse an integer flag, falling back to `def` on absent/non-finite values. */
export function getIntFlag(args, name, def, { min = -Infinity } = {}) {
  const raw = getFlag(args, name, undefined);
  if (raw === undefined) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : def;
}

/**
 * First positional argument (e.g. the tasks/instances file), skipping flags AND
 * the value that follows a flag. Handles both `file --max 5` and `--max 5 file`.
 * (The eval harnesses use only value-taking `--flags`, so a token immediately
 * after a flag is its value, never a positional.)
 */
export function positional(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) continue;             // a flag
    if (i > 0 && args[i - 1].startsWith('--')) continue; // that flag's value
    return args[i];
  }
  return null;
}
