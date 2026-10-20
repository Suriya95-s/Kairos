import fs from 'node:fs';
import path from 'node:path';
import { safePath } from '../utils/contract.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'copy_path',
    description: 'Copy a file or directory to a new location within the workspace.',
    parameters: {
      type: 'object',
      properties: {
        src:  { type: 'string', description: 'Source path (relative to workspace root)' },
        dest: { type: 'string', description: 'Destination path (relative to workspace root)' },
        dryRun: { type: 'boolean', description: 'Preview without copying.', default: false },
      },
      required: ['src', 'dest'],
    },
  },
};

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

export function handler(args) {
  const { abs: srcAbs, error: srcErr } = safePath(args.src);
  if (srcErr) return fail(srcErr);
  const { abs: destAbs, error: destErr } = safePath(args.dest);
  if (destErr) return fail(destErr);

  if (!fs.existsSync(srcAbs)) return fail(`File not found: ${args.src}`);
  if (args.dryRun) return ok(`[dry-run] would copy: ${args.src} → ${args.dest}`, { dryRun: true });
  copyRecursive(srcAbs, destAbs);
  return ok(`Copied: ${args.src} → ${args.dest}`);
}
