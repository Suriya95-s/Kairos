import fs from 'node:fs';
import { safePath } from '../utils/contract.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'create_dir',
    description: 'Create a directory (and any missing parent directories) inside the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root' },
        dryRun: { type: 'boolean', description: 'Preview without creating the directory.', default: false },
      },
      required: ['path'],
    },
  },
};

export function handler(args) {
  const { abs, error } = safePath(args.path);
  if (error) return fail(error);
  if (args.dryRun) return ok(`[dry-run] would create directory: ${args.path}`, { dryRun: true });
  fs.mkdirSync(abs, { recursive: true });
  return ok(`Directory created: ${args.path}`);
}
