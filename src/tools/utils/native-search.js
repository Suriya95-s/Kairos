import fs from 'node:fs';
import path from 'node:path';

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob) {
  const normalized = String(glob || '*').replace(/\\/g, '/');
  const GLOBSTAR_DIR = '__GLOBSTAR_DIR__';
  const GLOBSTAR = '__GLOBSTAR__';

  let expr = normalized
    .replace(/\*\*\//g, GLOBSTAR_DIR)
    .replace(/\*\*/g, GLOBSTAR);

  expr = escapeRegex(expr)
    .replace(new RegExp(escapeRegex(GLOBSTAR_DIR), 'g'), '(?:.*/)?')
    .replace(new RegExp(escapeRegex(GLOBSTAR), 'g'), '.*')
    .replace(/\\\*/g, '[^/]*')
    .replace(/\\\?/g, '[^/]');

  return new RegExp(`^${expr}$`);
}

// Directories that are pure noise for code/content search and can be enormous
// (dependency trees, VCS internals). Skipping them keeps search fast and on-topic
// — walking node_modules previously dominated every search on a real project.
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walkFiles(rootDir, out, relPrefix = '', stats = null) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(rootDir, relPrefix), { withFileTypes: true });
  } catch {
    // Unreadable directory (EACCES, etc.) — skip it rather than aborting the
    // whole walk, and record that something was skipped.
    if (stats) stats.skipped++;
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const rel = path.posix.join(relPrefix.replace(/\\/g, '/'), entry.name).replace(/^\/+/, '');
    if (entry.isDirectory()) {
      walkFiles(rootDir, out, rel, stats);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

export function globFiles(dir, pattern = '*', maxResults = 300, stats = null) {
  const files = [];
  walkFiles(dir, files, '', stats);
  const regexp = globToRegExp(pattern || '*');
  return files.filter((rel) => regexp.test(rel)).slice(0, maxResults);
}

export function searchInDirectory(dir, query, opts = {}) {
  const {
    maxResults = 50,
    filePattern = '*',
    caseSensitive = false,
  } = opts;

  const results = [];
  const stats = { skipped: 0 };
  const files = globFiles(dir, filePattern, 20000, stats);
  const regexFlags = caseSensitive ? 'g' : 'gi';
  let regex = null;
  try {
    regex = new RegExp(String(query), regexFlags);
  } catch {
    regex = new RegExp(escapeRegex(String(query)), regexFlags);
  }

  for (const rel of files) {
    if (results.length >= maxResults) break;
    const abs = path.join(dir, rel);
    let content = '';
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      stats.skipped++;
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        results.push({
          file: rel,
          line: i + 1,
          text: lines[i],
        });
        if (results.length >= maxResults) break;
      }
    }
  }

  // Attach the unreadable-file/dir tally without changing the array contract
  // (callers iterate the results; search_files surfaces this count to the model).
  results.skipped = stats.skipped;
  return results;
}
