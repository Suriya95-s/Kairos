import fs from 'node:fs';
import path from 'node:path';
import { getWorkspace } from '../../state.js';
import { safePath } from '../utils/contract.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'list_dir',
    description: 'List files and directories at the given path. Directories end with /.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root (default: ".")', default: '.' },
      },
      required: [],
    },
  },
};

export function handler({ path: relPath }) {
  const { abs, error } = safePath(relPath || '.');
  if (error) return fail(error);
  if (!fs.existsSync(abs)) return fail(`Directory not found: ${relPath || '.'}`);

  const entries = fs.readdirSync(abs, { withFileTypes: true });
  return ok(entries
    .map(e => e.isDirectory() ? `${e.name}/` : e.name)
    .sort()
    .join('\n'));
}
