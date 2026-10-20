import fs from 'node:fs';
import path from 'node:path';
import { getWorkspace } from '../../state.js';

// ── Path Safety ──────────────────────────────────────────────────

/**
 * Resolve a relative path against the workspace and verify it stays inside —
 * after following symlinks. A purely lexical check is bypassable: a symlink
 * inside the workspace (e.g. `ln -s /etc ws/link`, `ln` is allowlisted) would
 * let read/write escape via `link/passwd`. We realpath the deepest existing
 * ancestor and re-check the prefix.
 * Returns { abs, error } — if error is set, the path is outside the workspace.
 */
export function safePath(relPath) {
  const workspace = getWorkspace();
  const abs = path.resolve(workspace, relPath);

  // Lexical check first (cheap, also handles the workspace root itself).
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    return { abs, error: `Security: path "${relPath}" resolves outside workspace boundary.` };
  }

  // Resolve symlinks. The target may not exist yet (a file being created), so
  // realpath the nearest existing ancestor and re-validate that.
  try {
    const realWorkspace = fs.realpathSync(workspace);
    let probe = abs;
    while (probe !== path.dirname(probe) && !fs.existsSync(probe)) {
      probe = path.dirname(probe);
    }
    const realProbe = fs.realpathSync(probe);
    if (realProbe !== realWorkspace && !realProbe.startsWith(realWorkspace + path.sep)) {
      return { abs, error: `Security: path "${relPath}" escapes the workspace via a symlink.` };
    }
  } catch {
    // realpath failure (race, permissions) — fall back to the lexical result.
  }

  return { abs, error: null };
}

function getRequiredArgs(definition) {
  return definition?.function?.parameters?.required || [];
}

export function normalizeToolArgs(toolName, rawArgs) {
  const args = { ...(rawArgs || {}) };

  // Common LLM alias mistakes for planning tool calls.
  if (toolName === 'think') {
    if (typeof args.content !== 'string' || !args.content.trim()) {
      if (typeof args.question === 'string' && args.question.trim()) args.content = args.question;
      else if (typeof args.thought === 'string' && args.thought.trim()) args.content = args.thought;
    }
    delete args.question;
    delete args.thought;
  }

  if (toolName === 'edit_file') {
    if (args.oldString === undefined) {
      if (typeof args.find === 'string') args.oldString = args.find;
      else if (typeof args.oldStr === 'string') args.oldString = args.oldStr;
      else if (typeof args.textToReplace === 'string') args.oldString = args.textToReplace;
      else if (typeof args.search === 'string') args.oldString = args.search;
      else if (typeof args.targetText === 'string') args.oldString = args.targetText;
    }
    if (args.newString === undefined) {
      if (typeof args.replace === 'string') args.newString = args.replace;
      else if (typeof args.newStr === 'string') args.newString = args.newStr;
      else if (typeof args.textToInsert === 'string') args.newString = args.textToInsert;
      else if (typeof args.replacement === 'string') args.newString = args.replacement;
      else if (typeof args.updatedText === 'string') args.newString = args.updatedText;
    }
    delete args.find;
    delete args.replace;
    delete args.oldStr;
    delete args.newStr;
    delete args.textToReplace;
    delete args.textToInsert;
    delete args.search;
    delete args.replacement;
    delete args.targetText;
    delete args.updatedText;
  }

  return args;
}

export function validateToolArgs(definition, args, toolName = '') {
  const required = getRequiredArgs(definition);
  const missing = required.filter((key) => {
    const v = args?.[key];
    if (v === undefined || v === null) return true;
    if (typeof v === 'string' && v.trim() === '') {
      // `think` may intentionally record an empty note in some flows/tests.
      if (toolName === 'think' && key === 'content') return false;
      // `write_file` content can legitimately be empty (e.g. __init__.py)
      if (toolName === 'write_file' && key === 'content') return false;
      return true;
    }
    return false;
  });
  return {
    ok: missing.length === 0,
    missing,
  };
}

// NOTE: isToolFailureResult (the old string-sniffing failure detector) was
// removed in Wave B. Tools now return a structured ToolResult (see
// src/tools/utils/toolResult.js) and the registry derives the error flag from
// `ok`, so success/failure no longer depends on matching substrings in output.
