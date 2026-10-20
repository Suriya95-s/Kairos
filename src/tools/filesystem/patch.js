import { execSync } from 'node:child_process';
import { getWorkspace } from '../../state.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'patch',
    description: 'Apply a unified diff patch to the workspace using `patch` command.',
    parameters: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'Unified diff text to apply' },
        dryRun: { type: 'boolean', description: 'Validate the patch (patch --dry-run) without applying it.', default: false },
      },
      required: ['diff'],
    },
  },
};

export function handler({ diff, dryRun }) {
  const text = String(diff || '');
  if (!text.trim()) return fail('PATCH_ERROR_INVALID_DIFF: empty diff.');
  if (!text.startsWith('---') && !text.startsWith('diff ')) {
    return fail('PATCH_ERROR_INVALID_DIFF: expected unified diff header (--- / diff).');
  }
  // Block absolute paths in diffs to prevent writes outside workspace
  if (/^[+-]{3}\s+\/[^\s]/m.test(text)) {
    return fail('PATCH_ERROR_INVALID_DIFF: absolute paths not allowed in diffs. Use relative paths only.');
  }
  // Block `../` traversal in any --- / +++ header target. `patch -p1` strips the
  // leading path component, so `--- a/../../etc/x` would still escape the
  // workspace. Validate every header path after stripping the a/ or b/ prefix.
  for (const m of text.matchAll(/^[+-]{3}\s+(\S+)/gm)) {
    let target = m[1];
    if (target === '/dev/null') continue;
    target = target.replace(/^[ab]\//, '');                 // strip patch -p1 prefix
    const normalized = target.split(/[\\/]/);
    if (normalized.includes('..')) {
      return fail('PATCH_ERROR_INVALID_DIFF: parent-directory ("..") segments are not allowed in diff paths.');
    }
  }
  try {
    execSync(`patch -p1${dryRun ? ' --dry-run' : ''}`, {
      cwd: getWorkspace(),
      input: text,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return ok(dryRun ? '[dry-run] patch applies cleanly' : 'Patch applied', dryRun ? { dryRun: true } : {});
  } catch (err) {
    return fail(`Patch error: ${err.message}`);
  }
}
