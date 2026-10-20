import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getWorkspace, trackFileWrite } from '../../state.js';
import { safePath } from '../utils/contract.js';
import { ok, fail } from '../utils/toolResult.js';

export const definition = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root' },
        content: { type: 'string', description: 'Full file content to write' },
        allowRepeat: { type: 'boolean', description: 'Set true to allow rewriting a file with identical content.', default: false },
        dryRun: { type: 'boolean', description: 'Preview without writing the file.', default: false },
      },
      required: ['path', 'content'],
    },
  },
};

// Track recent writes within this process session: relPath → { hash, count }
const _recentWrites = new Map();

function contentHash(str) {
  return crypto.createHash('sha1').update(str).digest('hex').slice(0, 16);
}

export function handler(args) {
  const relPath = args.path;
  // Accept common aliases the model may use instead of 'content'
  const content = args.content ?? args.text ?? args.data ?? args.body;
  if (content == null) {
    return fail('Error: content argument is required. Pass {"path": "...", "content": "..."}');
  }
  const str = String(content);
  const { abs, error } = safePath(relPath);
  if (error) return fail(error);

  if (args.dryRun) {
    const verb = fs.existsSync(abs) ? 'overwrite' : 'create';
    return ok(`[dry-run] would ${verb} ${relPath} (${str.length} chars)`, { dryRun: true });
  }

  // Detect duplicate writes: same path + same content written more than once.
  // The dedup map is process-global and not workspace-scoped, so we ONLY treat a
  // write as a duplicate when the file actually exists on disk with matching
  // content. This prevents a stale map entry from suppressing a legitimate write
  // in a different workspace/task (the file isn't there, so it's not a dup), and
  // is also more correct: an externally deleted/modified file gets rewritten.
  if (!args.allowRepeat) {
    const hash = contentHash(str);
    const prev = _recentWrites.get(relPath);
    const onDiskMatches = fs.existsSync(abs) && contentHash(fs.readFileSync(abs, 'utf-8')) === hash;
    if (prev && prev.hash === hash && onDiskMatches) {
      prev.count++;
      return ok(`Duplicate write detected: "${relPath}" was already written with identical content (${str.length} chars) in this session. This step is already DONE — do NOT repeat it. Move to the NEXT step in your plan (e.g. read_file to verify, edit_file to modify, or append results to report.md and continue to the next section).`);
    }
    _recentWrites.set(relPath, { hash, count: 1 });
  }

  const existedBefore = fs.existsSync(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, str, 'utf-8');
  trackFileWrite(relPath, { overwrite: existedBefore, forceRereadBeforeEdit: existedBefore });
  return ok(`File written: ${relPath} (${str.length} chars)`);
}
