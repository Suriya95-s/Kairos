// advanced-agent-loop/src/memory-store.js
// Persistent Memory Store — Retain/Recall/Reflect architecture.
//
// Inspired by OpenClaw's memory system and V2 research:
// - Daily memory logs: .agent/memory/YYYY-MM-DD.md
// - Curated MEMORY.md at workspace root (agent-maintained)
// - Text-based memory search across all memory files
// - Memory types: world (facts), experience (what happened), opinion (preferences)
// - Pre-compaction flush: save critical context before memory destruction
//
// The filesystem IS the memory backend. No database needed.
// Text search via grep is fast enough for single-workspace memory.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';
import { getWorkspace } from './state.js';
import { searchInDirectory } from './tools/utils/native-search.js';

// ── Types ──────────────────────────────────────────────────────

/**
 * @typedef {'world'|'experience'|'opinion'|'decision'|'gotcha'} MemoryType
 */

/**
 * @typedef {Object} MemoryEntry
 * @property {string} content — The memory text
 * @property {MemoryType} type — Category
 * @property {string[]} tags — Searchable tags
 * @property {number} confidence — 0-1 for opinions, always 1 for facts
 * @property {string} timestamp — ISO string
 */

// ── Daily Log ──────────────────────────────────────────────────

/**
 * Get today's date string for the daily log filename.
 */
function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Get the path to today's memory log.
 */
function dailyLogPath() {
  return path.join(getWorkspace(), config.agentDir, 'memory', `${today()}.md`);
}

/**
 * Append an entry to today's daily memory log.
 * This is the primary "write it down" mechanism.
 *
 * @param {string} content — What to remember
 * @param {MemoryType} type — Category tag
 * @param {string[]} tags — Additional searchable tags
 */
export function saveMemory(content, type = 'experience', tags = []) {
  try {
    const logPath = dailyLogPath();
    const memDir = path.dirname(logPath);
    if (!fs.existsSync(memDir)) {
      fs.mkdirSync(memDir, { recursive: true });
    }

    // Create header if new file
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, `# Memory Log — ${today()}\n\n`, 'utf-8');
    }

    const existing = fs.readFileSync(logPath, 'utf-8');
    const tail = existing.slice(-2000);
    if (tail.includes(String(content || '').slice(0, 100))) {
      return 'Memory already saved (deduplicated).';
    }

    // Full ISO timestamp (date + time) so entries are unambiguous across midnight / multi-day runs
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
    const entry = `### ${timestamp} — ${type}${tagStr}\n${content}\n\n`;

    fs.appendFileSync(logPath, entry, 'utf-8');
    return `Memory saved to ${today()}.md (${type})`;
  } catch (err) {
    console.error(`[memory-store] saveMemory failed: ${err.message}`);
    return `Memory save failed: ${err.message}`;
  }
}

// ── Recall (Search) ────────────────────────────────────────────

/**
 * Search across all memory files for a query string.
 * Uses grep for fast text search across the memory directory + MEMORY.md.
 *
 * @param {string} query — Search text (regex supported)
 * @param {Object} opts
 * @param {number} opts.maxResults — Max matches to return
 * @param {MemoryType} opts.type — Filter by memory type
 * @returns {string} Formatted search results
 */
export function searchMemory(query, opts = {}) {
  const { maxResults = 20, type } = opts;
  const workspace = getWorkspace();

  // Gather a generous candidate pool from every source, then rank — so the
  // best matches surface rather than just whatever grep happened to hit first.
  const poolCap = Math.max(60, maxResults * 5);
  const candidates = [];

  const memDir = path.join(workspace, config.agentDir, 'memory');
  if (fs.existsSync(memDir)) {
    for (const r of searchInDirectory(memDir, query, { maxResults: poolCap, filePattern: '*.md' })) {
      const source = /learnings\.md$/.test(r.file) ? 'Learnings' : 'Daily Logs';
      candidates.push({ ...r, source, prefix: config.agentDir + '/memory' });
    }
  }

  const memoryFile = path.join(workspace, config.memoryFile);
  if (fs.existsSync(memoryFile)) {
    for (const r of searchInDirectory(workspace, query, { maxResults: poolCap, filePattern: config.memoryFile })) {
      candidates.push({ ...r, source: 'MEMORY.md', prefix: '.' });
    }
  }

  if (candidates.length === 0) {
    return `No memories found matching "${query}".`;
  }

  const terms = String(query).toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
  let ranked = candidates
    .map((c) => ({ ...c, score: scoreMemoryMatch(c, terms, query) }))
    .sort((a, b) => b.score - a.score);

  // Optional type filter (world | experience | opinion | decision | gotcha)
  if (type) {
    ranked = ranked.filter((c) => c.text.toLowerCase().includes(String(type).toLowerCase()));
    if (ranked.length === 0) {
      return `No memories found matching "${query}" with type "${type}".`;
    }
  }

  const top = ranked.slice(0, maxResults);
  const lines = top.map((c) => {
    const loc = `${path.posix.join(c.prefix.replace(/\\/g, '/'), c.file)}:${c.line}`;
    return `[${c.source}] ${loc}\n  ${c.text.trim()}`;
  });
  return `## Memory Search — "${query}" (top ${top.length} of ${ranked.length} matches, ranked)\n${lines.join('\n')}`;
}

/**
 * Relevance score for a single memory match line.
 * Combines term-frequency, exact-phrase, recency (newer daily logs and curated
 * files rank higher) and memory-type weighting (gotchas/decisions are high value).
 */
function scoreMemoryMatch(match, terms, query) {
  const text = String(match.text || '').toLowerCase();
  let score = 0;

  // Term frequency
  for (const term of terms) {
    let idx = text.indexOf(term);
    while (idx !== -1) {
      score += 1;
      idx = text.indexOf(term, idx + term.length);
    }
  }
  // Exact-phrase bonus
  if (query && text.includes(String(query).toLowerCase())) score += 3;

  // Recency / source weighting
  const dateMatch = /(\d{4})-(\d{2})-(\d{2})\.md$/.exec(match.file || '');
  if (dateMatch) {
    const fileTime = Date.parse(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00Z`);
    const todayTime = Date.parse(`${today()}T00:00:00Z`);
    const daysAgo = Math.max(0, Math.round((todayTime - fileTime) / 86400000));
    score += Math.max(0, 2 - daysAgo * 0.1); // today ≈ +2, fades over ~3 weeks
  } else {
    // MEMORY.md / learnings.md are curated — give a steady relevance floor
    score += 1.5;
  }

  // Memory-type weighting (the type tag appears in the entry header line)
  if (/—\s*gotcha\b/.test(text) || text.includes('error')) score += 1.5;
  else if (/—\s*decision\b/.test(text)) score += 1.2;
  else if (/—\s*(world|experience)\b/.test(text)) score += 0.5;

  return score;
}

// ── Semantic Recall (embedding-backed, lexical fallback) ───────

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function embedCachePath() {
  return path.join(getWorkspace(), config.agentDir, 'memory', 'embeddings.json');
}
function loadEmbedCache() {
  try {
    const p = embedCachePath();
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  } catch { return {}; }
}
function saveEmbedCache(cache) {
  try {
    const p = embedCachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Bound the cache so it can't grow without limit (keep most recent ~2000).
    const keys = Object.keys(cache);
    if (keys.length > 2000) {
      const trimmed = {};
      for (const k of keys.slice(-2000)) trimmed[k] = cache[k];
      cache = trimmed;
    }
    fs.writeFileSync(p, JSON.stringify(cache));
  } catch { /* non-critical */ }
}

/** Collect daily-log + MEMORY.md entries as discrete chunks for semantic ranking. */
function collectMemoryEntries() {
  const workspace = getWorkspace();
  const entries = [];
  const memDir = path.join(workspace, config.agentDir, 'memory');
  if (fs.existsSync(memDir)) {
    for (const file of fs.readdirSync(memDir)) {
      if (!/\.md$/.test(file)) continue;
      try {
        const content = fs.readFileSync(path.join(memDir, file), 'utf-8');
        for (const block of content.split(/(?=^### )/m)) {
          const text = block.trim();
          if (text.startsWith('### ') && text.length > 8) {
            entries.push({ source: file, text: text.slice(0, 1200) });
          }
        }
      } catch { /* skip unreadable */ }
    }
  }
  return entries;
}

/**
 * Semantic search over persistent memory. Uses the LLM /embeddings endpoint
 * (cached per entry by content hash) and cosine similarity; falls back to the
 * lexical ranked searchMemory() when embeddings are unavailable.
 *
 * @param {string} query
 * @param {{maxResults?: number}} opts
 * @returns {Promise<string>}
 */
export async function semanticSearchMemory(query, opts = {}) {
  const { maxResults = 12 } = opts;
  const entries = collectMemoryEntries();
  if (entries.length === 0) return `No memories to search for "${query}".`;

  const { embed } = await import('./llm.js');
  const cache = loadEmbedCache();

  // Embed the query + any entries not already cached.
  const hashes = entries.map((e) => crypto.createHash('sha1').update(e.text).digest('hex'));
  const missingIdx = hashes.map((h, i) => (cache[h] ? -1 : i)).filter((i) => i >= 0);

  const queryVecArr = await embed(query);
  if (!queryVecArr) {
    // Embeddings unavailable → graceful lexical fallback.
    return `(semantic unavailable — lexical results)\n${searchMemory(query, { maxResults })}`;
  }
  const queryVec = queryVecArr[0];

  if (missingIdx.length > 0) {
    const vecs = await embed(missingIdx.map((i) => entries[i].text));
    if (vecs) {
      missingIdx.forEach((i, k) => { cache[hashes[i]] = vecs[k]; });
      saveEmbedCache(cache);
    } else {
      return `(semantic partial-failure — lexical results)\n${searchMemory(query, { maxResults })}`;
    }
  }

  const ranked = entries
    .map((e, i) => ({ ...e, score: cache[hashes[i]] ? cosine(queryVec, cache[hashes[i]]) : 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  const lines = ranked.map((e) => {
    const head = e.text.split('\n')[0].replace(/^###\s*/, '');
    const body = e.text.split('\n').slice(1).join(' ').trim().slice(0, 160);
    return `[${(e.score).toFixed(3)}] ${e.source} — ${head}\n  ${body}`;
  });
  return `## Semantic Memory Search — "${query}" (top ${ranked.length}, embedding-ranked)\n${lines.join('\n')}`;
}

// ── Reflect (Memory Maintenance) ───────────────────────────────

/**
 * Get a summary of all memory files for context injection.
 * Used during context assembly to give the agent awareness of what it knows.
 *
 * @returns {string} Formatted memory summary
 */
export function getMemorySummary() {
  const workspace = getWorkspace();
  const memDir = path.join(workspace, config.agentDir, 'memory');
  const sections = [];

  // Count daily logs
  if (fs.existsSync(memDir)) {
    const logs = fs.readdirSync(memDir).filter(f =>
      f.match(/^\d{4}-\d{2}-\d{2}\.md$/)
    );
    if (logs.length > 0) {
      sections.push(`📅 ${logs.length} daily log(s): ${logs.slice(-3).join(', ')}`);

      // Show today's log entries count
      const todayLog = path.join(memDir, `${today()}.md`);
      if (fs.existsSync(todayLog)) {
        const content = fs.readFileSync(todayLog, 'utf-8');
        const entryCount = (content.match(/^### /gm) || []).length;
        sections.push(`  Today: ${entryCount} entries`);
      }
    }
  }

  // Check MEMORY.md
  const memoryFile = path.join(workspace, config.memoryFile);
  if (fs.existsSync(memoryFile)) {
    const content = fs.readFileSync(memoryFile, 'utf-8');
    const lineCount = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.includes('(none')).length;
    sections.push(`📚 MEMORY.md: ${lineCount} content lines`);
  }

  return sections.length > 0 ? sections.join('\n') : 'No persistent memories yet.';
}

/**
 * Get recent memories from today's log (for context injection).
 * Returns the last N entries from today.
 *
 * @param {number} maxEntries — Max entries to return
 * @returns {string} Formatted recent memories
 */
export function getRecentMemories(maxEntries = 5) {
  const logPath = dailyLogPath();
  if (!fs.existsSync(logPath)) return '';

  const content = fs.readFileSync(logPath, 'utf-8');
  // Split by entry headers (### HH:MM:SS — type)
  const entries = content.split(/(?=^### )/m).filter(e => e.startsWith('### '));

  if (entries.length === 0) return '';

  const recent = entries.slice(-maxEntries);
  return `## Today's Memories (${recent.length} of ${entries.length})\n${recent.join('\n')}`;
}

// ── Pre-Compaction Flush ───────────────────────────────────────

/**
 * Extract important facts from the working memory entries before compaction.
 * Called by the compaction system to auto-save critical context.
 *
 * @param {Array<{step:number, action:string, args:Object, result:string, error:boolean}>} entries
 * @returns {string[]} Array of memory entries to save
 */
// Durable-record detail budget. The daily log is the agent's long-term record,
// so failed-command output and error tracebacks are preserved at this fuller
// length (vs. the ~200-char working-memory display) before the entries are
// trimmed out of the window during compaction. This is the fix for pre-summary
// truncation loss: high-value debugging detail survives in the flush.
const FLUSH_DETAIL_CHARS = 2000;

export function extractMemoriesFromEntries(entries) {
  const memories = [];

  for (const entry of entries) {
    // Save file discoveries
    if (entry.action === 'read_file' && !entry.error && entry.args?.path) {
      const lineCount = (entry.result || '').split('\n').length;
      if (lineCount > 20) {
        memories.push({
          content: `Read ${entry.args.path} (${lineCount} lines) — file exists and was examined`,
          type: 'world',
          tags: ['file', entry.args.path],
        });
      }
    }

    // Save command outcomes. Failed commands keep their full output (tracebacks,
    // assertion diffs) up to FLUSH_DETAIL_CHARS so the durable record is
    // debuggable after the entry leaves the working window; successes stay terse.
    if (entry.action === 'run_command' && entry.args?.command) {
      const cmd = entry.args.command.slice(0, 100);
      const status = entry.error ? 'FAILED' : 'succeeded';
      memories.push({
        content: `Command \`${cmd}\` ${status}${entry.error ? ': ' + (entry.result || '').slice(0, FLUSH_DETAIL_CHARS) : ''}`,
        type: 'experience',
        tags: ['command', status],
      });
    }

    // Save write operations
    if (entry.action === 'write_file' && !entry.error && entry.args?.path) {
      memories.push({
        content: `Created/wrote ${entry.args.path}`,
        type: 'world',
        tags: ['file', 'write', entry.args.path],
      });
    }

    // Save edit operations
    if (entry.action === 'edit_file' && !entry.error && entry.args?.path) {
      memories.push({
        content: `Edited ${entry.args.path}`,
        type: 'world',
        tags: ['file', 'edit', entry.args.path],
      });
    }

    // Save learnings
    if (entry.action === 'add_learning' && entry.args?.note) {
      memories.push({
        content: entry.args.note,
        type: 'decision',
        tags: ['learning'],
      });
    }

    // Save plan updates (planning/decision events — durable across compaction)
    if (entry.action === 'update_plan' && !entry.error && entry.args?.content) {
      // Extract just the first 200 chars of plan content as a decision record
      const planSnippet = String(entry.args.content).slice(0, 200).replace(/\n+/g, ' ');
      memories.push({
        content: `Plan updated at step ${entry.step}: ${planSnippet}`,
        type: 'decision',
        tags: ['plan', 'update_plan'],
      });
    }

    // Save skill creation (durable: skills persist but creation context should survive compaction)
    if (entry.action === 'create_skill' && !entry.error && entry.args?.name) {
      const desc = entry.args.description ? ` — ${String(entry.args.description).slice(0, 150)}` : '';
      memories.push({
        content: `Created skill "${entry.args.name}"${desc}`,
        type: 'decision',
        tags: ['skill', 'create_skill', entry.args.name],
      });
    }

    // Save errors as gotchas — preserve the full error/traceback up to
    // FLUSH_DETAIL_CHARS so unresolved failures remain diagnosable later.
    if (entry.error && entry.action !== 'parse_error') {
      memories.push({
        content: `Error in ${entry.action}: ${(entry.result || '').slice(0, FLUSH_DETAIL_CHARS)}`,
        type: 'gotcha',
        tags: ['error', entry.action],
      });
    }
  }

  return memories;
}

/**
 * Perform the pre-compaction memory flush.
 * Automatically saves critical context from working memory to daily log.
 *
 * @param {Array} oldEntries — Working memory entries about to be compacted
 * @returns {number} Number of memories saved
 */
export function flushMemories(oldEntries) {
  const memories = extractMemoriesFromEntries(oldEntries);
  let count = 0;

  for (const mem of memories) {
    saveMemory(mem.content, mem.type, mem.tags);
    count++;
  }

  if (count > 0) {
    saveMemory(
      `Pre-compaction flush: saved ${count} memories from steps being compacted.`,
      'experience',
      ['compaction', 'flush']
    );
  }

  return count;
}

// ── Heartbeat Memory Check ─────────────────────────────────────

/**
 * Periodic memory maintenance during the agent loop.
 * Called every N steps to ensure important context is persisted.
 *
 * @param {number} step — Current step number
 * @param {string} currentTask — What the agent is working on
 */
export function heartbeatMemoryCheck(step, currentTask) {
  if (step % config.memoryHeartbeatInterval !== 0) return;

  saveMemory(
    `Heartbeat at step ${step}: working on "${currentTask?.slice(0, 100) || 'unknown task'}"`,
    'experience',
    ['heartbeat', `step-${step}`]
  );

  // Rotate old daily logs on every heartbeat (cheap: only deletes, no reads)
  rotateDailyLogs(14);
}

// Entry headers worth preserving past rotation: high-signal memory types.
// `### <timestamp> — <type> [tags]` is the daily-log entry header format.
const HIGH_VALUE_TYPE_RE = /^###\s.*—\s*(gotcha|decision)\b/i;
const ARCHIVE_FILE = 'archive.md';
const ARCHIVE_MAX_BYTES = 512 * 1024; // cap the archive so it can't grow without bound

/**
 * Extract the high-value entries (gotchas, decisions) from a daily-log file so
 * they survive rotation. Returns the concatenated entry blocks (may be empty).
 */
function extractHighValueEntries(content) {
  const entries = content.split(/(?=^### )/m).filter(e => e.startsWith('### '));
  return entries.filter(e => HIGH_VALUE_TYPE_RE.test(e.split('\n')[0]));
}

/**
 * Rotate daily memory logs older than maxDays. Importance-aware: before deleting
 * an old log, its gotcha/decision entries are appended to a durable archive.md
 * (capped at ARCHIVE_MAX_BYTES) so hard-won learnings are never silently lost.
 */
function rotateDailyLogs(maxDays = 14) {
  try {
    const workspace = getWorkspace();
    const memDir = path.join(workspace, config.agentDir, 'memory');
    if (!fs.existsSync(memDir)) return;

    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    const archivePath = path.join(memDir, ARCHIVE_FILE);

    for (const file of fs.readdirSync(memDir)) {
      if (!file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) continue;
      const filePath = path.join(memDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs >= cutoff) continue;

      // Archive high-value entries before deleting the log.
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const keep = extractHighValueEntries(content);
        if (keep.length > 0) {
          const header = `\n## Archived from ${file} (rotated ${new Date().toISOString().slice(0, 10)})\n`;
          fs.appendFileSync(archivePath, header + keep.join('\n'), 'utf-8');
        }
      } catch { /* archiving is best-effort */ }

      fs.unlinkSync(filePath);
    }

    // Cap the archive: keep the most recent half if it exceeds the limit.
    if (fs.existsSync(archivePath) && fs.statSync(archivePath).size > ARCHIVE_MAX_BYTES) {
      const text = fs.readFileSync(archivePath, 'utf-8');
      fs.writeFileSync(archivePath, '# Memory Archive (truncated)\n' + text.slice(-Math.floor(ARCHIVE_MAX_BYTES / 2)), 'utf-8');
    }
  } catch {
    // Non-critical — rotation failure should never interrupt the agent
  }
}
