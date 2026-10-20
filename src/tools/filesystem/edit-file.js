import fs from 'node:fs';
import path from 'node:path';
import { getWorkspace, trackFileWrite } from '../../state.js';
import { safePath } from '../utils/contract.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'edit_file',
    description: 'Replace an exact string in a file with a new string. The old string must match exactly (including whitespace).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root' },
        oldString: { type: 'string', description: 'Exact text to find (must match uniquely)' },
        newString: { type: 'string', description: 'Replacement text' },
        dryRun: { type: 'boolean', description: 'Preview the replacement without writing.', default: false },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
};

export function handler({ path: relPath, oldString, newString, dryRun }) {
  const { abs, error } = safePath(relPath);
  if (error) return fail(error);
  if (!fs.existsSync(abs)) return fail(`EDIT_ERROR_FILE_NOT_FOUND: File not found: ${relPath}`);

  const content = fs.readFileSync(abs, 'utf-8');
  const occurrences = content.split(oldString).length - 1;

  if (occurrences === 0) {
    return fail(`EDIT_ERROR_STRING_NOT_FOUND: String not found in ${relPath}. Re-read the file and match exact whitespace/indentation before retrying.`);
  }
  if (occurrences > 1) {
    return fail(`EDIT_ERROR_NOT_UNIQUE: String found ${occurrences} times in ${relPath}. Must match exactly once. Add more context.`);
  }

  if (dryRun) {
    const preview = [`[dry-run] would replace 1 occurrence in ${relPath}:`]
      .concat(oldString.split('\n').map((l) => `- ${l}`))
      .concat(newString.split('\n').map((l) => `+ ${l}`))
      .join('\n');
    return ok(preview, { dryRun: true });
  }

  // Use a replacer FUNCTION so `$&`, `$\``, `$'`, `$1`, `$$` inside newString are
  // inserted literally. String.replace treats those as special patterns, which
  // silently corrupts any replacement text containing a `$` (e.g. shell vars,
  // regex snippets, template literals).
  const updated = content.replace(oldString, () => newString);
  fs.writeFileSync(abs, updated, 'utf-8');
  trackFileWrite(relPath, { overwrite: true, forceRereadBeforeEdit: true });
  return ok(`File edited: ${relPath} (1 replacement made)`);
}
