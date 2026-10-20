import fs from 'node:fs';
import { safePath } from '../utils/contract.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'delete_path',
    description: 'Delete a file or directory inside the workspace. Directories are removed recursively. Requires explicit confirmation for non-empty directories.',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Relative path from workspace root' },
        confirm: { type: 'boolean', description: 'Must be true to delete a non-empty directory' },
        dryRun:  { type: 'boolean', description: 'Preview without deleting.', default: false },
      },
      required: ['path'],
    },
  },
};

export function handler(args) {
  const { abs, error } = safePath(args.path);
  if (error) return fail(error);

  if (!fs.existsSync(abs)) return fail(`Security: path not found: ${args.path}`);

  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(abs);
    if (entries.length > 0 && !args.confirm) {
      return fail(`Security: "${args.path}" is a non-empty directory. Pass confirm=true to delete it and all contents.`);
    }
    if (args.dryRun) return ok(`[dry-run] would delete directory (${entries.length} entries): ${args.path}`, { dryRun: true });
    fs.rmSync(abs, { recursive: true, force: true });
    return ok(`Directory deleted: ${args.path}`);
  }

  if (args.dryRun) return ok(`[dry-run] would delete file: ${args.path}`, { dryRun: true });
  fs.unlinkSync(abs);
  return ok(`File deleted: ${args.path}`);
}
