import fs from 'node:fs';
import path from 'node:path';
import { safePath } from '../utils/contract.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'move_path',
    description: 'Move or rename a file or directory within the workspace.',
    parameters: {
      type: 'object',
      properties: {
        src:  { type: 'string', description: 'Source path (relative to workspace root)' },
        dest: { type: 'string', description: 'Destination path (relative to workspace root)' },
        dryRun: { type: 'boolean', description: 'Preview without moving.', default: false },
      },
      required: ['src', 'dest'],
    },
  },
};

export function handler(args) {
  const { abs: srcAbs, error: srcErr } = safePath(args.src);
  if (srcErr) return fail(srcErr);
  const { abs: destAbs, error: destErr } = safePath(args.dest);
  if (destErr) return fail(destErr);

  if (!fs.existsSync(srcAbs)) return fail(`File not found: ${args.src}`);
  if (args.dryRun) return ok(`[dry-run] would move: ${args.src} → ${args.dest}`, { dryRun: true });
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.renameSync(srcAbs, destAbs);
  return ok(`Moved: ${args.src} → ${args.dest}`);
}
