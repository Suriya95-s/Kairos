// advanced-agent-loop/src/state.js
// File-based state management — the filesystem IS the state machine.
// All state is markdown/JSON on disk. Crash-safe, human-readable, resumable.
// Now includes identity layer bootstrapping, skills dir, and focus chain.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';
import logger from './logger.js';
import {
  getLmmaSeedFiles,
  getLmmaBankFileMap,
  getDefaultActiveRoute,
  getDefaultWorkingMemoryPacket,
  getDefaultRetrievalCache,
  getDefaultImportanceMap,
} from './lmma/defaults.js';

// Phase 1 (de-globalization): the workspace root and the file-tracking cache
// now live on an AgentContext rather than in module-level `let`s. The exported
// API is unchanged — these functions operate on the AMBIENT context, so every
// existing caller behaves exactly as before, while the daemon can drive
// isolated contexts concurrently. See src/runtime/context.js.
import { currentContext } from './runtime/context.js';

/**
 * The context this module operates on: the running mission's context when
 * inside runWithContext(), otherwise the ambient one. Because every path
 * helper below funnels through here, all ~50 exports became context-aware
 * without a signature change — and, critically, without call sites that can
 * silently forget to pass `ctx`.
 */
function ctx() {
  return currentContext();
}

export function setWorkspace(dir) {
  // ctx.setWorkspace keeps config._workspace in lock-step (the HITL queues and
  // learning modules resolve against it, not against this module's root — a
  // mismatch previously made `agent approve --workspace X` write to cwd, so the
  // agent never saw the response and approvals auto-denied on timeout), and it
  // invalidates workspace-scoped slots such as the file-tracking cache. Serving
  // a previous workspace's writes from memory was the source of the flaky
  // completionGuard / hasFileModifications failures.
  ctx().setWorkspace(dir);
}

export function getWorkspace() {
  return ctx().workspace;
}

function resolve(relativePath) {
  return ctx().resolve(relativePath);
}

/**
 * Phase 1.5 — where this run's checkpoint lives.
 *
 * A mission context gets its own directory so siblings sharing one workspace
 * (the conductor dispatching specialists in parallel) cannot clobber each
 * other. That is what `_ephemeralCheckpoint` used to paper over by refusing to
 * write at all — which bought safety at the cost of making parallel specialists
 * unresumable.
 *
 * Without a missionId the legacy `.agent/checkpoint.json` is used unchanged, so
 * `--resume` on an existing workspace, the TUI, and `lmma/benchmark.js` all keep
 * working against the path they already know.
 *
 * @returns {string} workspace-relative path
 */
export function checkpointRelPath() {
  const missionId = ctx().missionId;
  if (!missionId) return config.checkpointFile;
  return `${config.agentDir}/missions/${sanitizeMissionId(missionId)}/checkpoint.json`;
}

/**
 * Mission ids reach the filesystem, so constrain them to one safe path segment.
 *
 * Replacing separators is not sufficient on its own: an id of "." or ".." (or
 * "...") survives a charset filter intact and is still a meaningful path
 * segment, so `.agent/missions/../checkpoint.json` would escape the mission
 * directory entirely. Dot-only names are therefore rejected outright.
 */
function sanitizeMissionId(id) {
  const cleaned = String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  if (!cleaned || /^\.+$/.test(cleaned)) return 'unnamed';
  return cleaned;
}

// ── Init ───────────────────────────────────────────────────────

/** Create the full .agent/ directory structure. Non-destructive (skips existing files). */
export function initAgentDir() {
  const dirs = [
    config.agentDir,
    config.memoryDir,
    config.skillsDir,
    config.lmmaDir,
    config.lmmaBanksDir,
    config.rwkvDir,
    config.rmtDir,
    config.rmtSummariesDir,
    config.trainingDir,
    config.learningDir,
    config.reflectionsDir,
    config.hitlDir,
    config.hitlPendingDir,
    config.hitlResponsesDir,
    config.hitlClarifyDir,
    config.hitlSteerDir,
  ];
  for (const d of dirs) {
    fs.mkdirSync(resolve(d), { recursive: true });
  }

  // Create empty files only if they don't exist
  const defaults = {
    [config.taskFile]: '',
    [config.planFile]: '# Plan\n\n_No plan yet._\n',
    [config.progressFile]: '# Progress Log\n\n',
    [config.contextSummaryFile]: '',
    [config.checkpointFile]: JSON.stringify({
      step: 0,
      phase: 'init',
      workingMemory: [],
      compactionCount: 0,
      skillsCreated: 0,
      memoriesSaved: 0,
      bank_focus: 'project',
      active_route: ['project'],
      active_ontology_tags: [],
      rwkv_state_hash: 'sha256:none',
      lmma_packet_version: 2,
    }, null, 2),
    [config.filesTouchedFile]: JSON.stringify({ reads: {}, writes: {}, freshness: {} }, null, 2),
    [config.commandsRunFile]: JSON.stringify([], null, 2),
    [config.recoveryEventsFile]: JSON.stringify([], null, 2),
    [config.learningsFile]: '# Learnings\n\n',
    [config.focusChainFile]: '# Focus Chain\n\n_Human-editable: add items here to steer the agent._\n\n- [ ] (no focus items set)\n',
    [config.rwkvStateFile]: '',
    [config.rwkvMetaFile]: JSON.stringify({
      version: 1,
      stateHash: 'sha256:none',
      controllerAvailable: false,
      lastUpdatedAt: '',
      lastControllerReason: 'not_initialized',
      fallbackCount: 0,
    }, null, 2),
    [config.trainingTracesFile]: '',
    [config.trainingAcceptedFile]: '',
    [config.trainingRejectedFile]: '',
    [config.trainingMergeDecisionsFile]: '',
  };

  for (const [relPath, content] of Object.entries(defaults)) {
    const abs = resolve(relPath);
    if (!fs.existsSync(abs)) {
      fs.writeFileSync(abs, content, 'utf-8');
    }
  }

  for (const [relPath, content] of Object.entries(getLmmaSeedFiles())) {
    const abs = resolve(relPath);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf-8');
    }
  }
}

// ── Read Helpers ───────────────────────────────────────────────

export function readText(relPath) {
  const abs = resolve(relPath);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf-8');
}

export function readJSON(relPath) {
  const text = readText(relPath);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function normalizeFilesTouchedShape(data) {
  return {
    reads: data?.reads && typeof data.reads === 'object' ? data.reads : {},
    writes: data?.writes && typeof data.writes === 'object' ? data.writes : {},
    freshness: data?.freshness && typeof data.freshness === 'object' ? data.freshness : {},
  };
}

export function readTask()           { return readText(config.taskFile); }
export function readPlan()           { return readText(config.planFile); }
export function readProgress()       { return readText(config.progressFile); }

function sanitizeContextSummary(text) {
  const original = String(text || '');
  if (!original) return original;

  let summary = original.replace(/<\/?think>/gi, '');
  const contaminationPatterns = [
    /The user wants me to produce .*summary/i,
    /Let me (analyze|construct|merge|re-read).*(summary|context)/i,
    /Looking at the context, I can see(?::|\s)/i,
    /I'?m at step \d+/i,
    /Let me think about what'?s happening/i,
    /Current state from runtime anchor/i,
    /Let me create a compact summary/i,
    /Key observations:/i,
    /New Steps to Summarize/i,
    /Previous Summary/i,
  ];

  if (contaminationPatterns.some((pattern) => pattern.test(summary))) {
    const lines = summary.split('\n');
    const cleaned = [];
    let skippingNarrative = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^##\s+/.test(trimmed) || /^<!--.*-->$/.test(trimmed)) {
        skippingNarrative = false;
        cleaned.push(line);
        continue;
      }

      if (contaminationPatterns.some((pattern) => pattern.test(trimmed))) {
        skippingNarrative = true;
        continue;
      }

      if (skippingNarrative) {
        if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed) || /^Step\s+\d+:/i.test(trimmed)) continue;
        if (/^Current state/i.test(trimmed) || /^Let me /i.test(trimmed) || /^Looking at /i.test(trimmed)) continue;
        if (trimmed === '') continue;
      }

      cleaned.push(line);
    }

    summary = cleaned.join('\n').trim();
  }

  return summary;
}

export function readContextSummary() { return sanitizeContextSummary(readText(config.contextSummaryFile)); }
export function readCheckpoint()     { return readJSON(checkpointRelPath()); }
export function readFilesTouched()   { return normalizeFilesTouchedShape(readJSON(config.filesTouchedFile)); }
/**
 * Same, but for an explicitly named workspace rather than the active context.
 * Needed by callers that are handed a workspace as a parameter — most of all
 * the daemon, where the caller's context and the mission's workspace are
 * different directories and resolving against the wrong one is silent.
 */
export function readFilesTouchedAt(workspace) {
  if (!workspace) return readFilesTouched();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(workspace, config.filesTouchedFile), 'utf-8'));
  } catch { raw = null; }
  return normalizeFilesTouchedShape(raw);
}
export function readCommandsRun()    { return readJSON(config.commandsRunFile) || []; }
export function readRecoveryEvents() { return readJSON(config.recoveryEventsFile) || []; }
export function readLearnings()      { return readText(config.learningsFile); }
export function readFocusChain()     { return readText(config.focusChainFile); }
export function readLmmaJSON(relPath, fallback = null) {
  const value = readJSON(relPath);
  return value === null ? fallback : value;
}
export function readLmmaText(relPath) { return readText(relPath); }
export function readLmmaActiveRoute() {
  return readLmmaJSON(config.lmmaActiveRouteFile, getDefaultActiveRoute());
}
export function readLmmaWorkingMemory() {
  return readLmmaJSON(config.lmmaWorkingMemoryFile, getDefaultWorkingMemoryPacket());
}
export function readLmmaRetrievalCache() {
  return readLmmaJSON(config.lmmaRetrievalCacheFile, getDefaultRetrievalCache());
}
export function readLmmaImportance() {
  return readLmmaJSON(config.lmmaImportanceFile, getDefaultImportanceMap());
}
export function readRwkvMeta() {
  return readJSON(config.rwkvMetaFile) || {
    version: 1,
    stateHash: 'sha256:none',
    controllerAvailable: false,
    lastUpdatedAt: '',
    lastControllerReason: 'not_initialized',
    fallbackCount: 0,
  };
}
export function readRwkvStateBuffer() {
  const abs = resolve(config.rwkvStateFile);
  if (!fs.existsSync(abs)) return Buffer.alloc(0);
  return fs.readFileSync(abs);
}
export function readLmmaRouteTraces() {
  const text = readText(config.lmmaRouteTracesFile).trim();
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}
export function readLmmaBank(bankName) {
  const relPath = getLmmaBankFileMap()[bankName];
  if (!relPath) return [];
  const text = readText(relPath).trim();
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

// ── Write Helpers ──────────────────────────────────────────────

export function writeText(relPath, content) {
  const abs = resolve(relPath);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  } catch (err) {
    logger.error(`[state] writeText failed (${relPath}): ${err.message}`);
    throw err;
  }
}

/** Atomic JSON write: write to .tmp then rename, preventing partial-write corruption. */
export function writeJSON(relPath, data) {
  const abs = resolve(relPath);
  const tmp = abs + '.tmp';
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, abs);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    logger.error(`[state] writeJSON failed (${relPath}): ${err.message}`);
    throw err;
  }
}

export function writeTask(content)           { writeText(config.taskFile, content); }
export function writePlan(content)           { writeText(config.planFile, content); }
export function writeProgress(content)       { writeText(config.progressFile, content); }
export function writeContextSummary(content) { writeText(config.contextSummaryFile, content); }
export function writeCheckpoint(data) {
  const rel = checkpointRelPath();
  // Mission checkpoints live in a nested dir that initAgentDir() did not create
  // (the mission id is only known once a run starts), so ensure it here.
  fs.mkdirSync(path.dirname(resolve(rel)), { recursive: true });
  writeJSON(rel, data);
}
export function writeFilesTouched(data)      { writeJSON(config.filesTouchedFile, data); }
export function writeCommandsRun(data)       { writeJSON(config.commandsRunFile, data); }
export function writeRecoveryEvents(data)    { writeJSON(config.recoveryEventsFile, data); }
export function writeLearnings(content)      { writeText(config.learningsFile, content); }
export function writeLmmaJSON(relPath, data) { writeJSON(relPath, data); }
export function writeLmmaText(relPath, content) { writeText(relPath, content); }
export function writeLmmaActiveRoute(data) { writeLmmaJSON(config.lmmaActiveRouteFile, data); }
export function writeLmmaWorkingMemory(data) { writeLmmaJSON(config.lmmaWorkingMemoryFile, data); }
export function writeLmmaRetrievalCache(data) { writeLmmaJSON(config.lmmaRetrievalCacheFile, data); }
export function writeLmmaImportance(data) { writeLmmaJSON(config.lmmaImportanceFile, data); }
export function writeRwkvMeta(data) { writeJSON(config.rwkvMetaFile, data); }
export function writeRwkvStateBuffer(buffer) {
  const abs = resolve(config.rwkvStateFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
}
export function appendLmmaRouteTrace(entry) {
  const abs = resolve(config.lmmaRouteTracesFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(entry) + '\n', 'utf-8');
}
export function writeLmmaBank(bankName, entries) {
  const relPath = getLmmaBankFileMap()[bankName];
  if (!relPath) return;
  writeText(relPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''));
}
export function appendLmmaBankEntry(bankName, entry) {
  const relPath = getLmmaBankFileMap()[bankName];
  if (!relPath) return;
  const abs = resolve(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(entry) + '\n', 'utf-8');
}
export function appendTrainingTrace(entry, accepted = null) {
  const relPath = accepted === true
    ? config.trainingAcceptedFile
    : accepted === false
      ? config.trainingRejectedFile
      : config.trainingTracesFile;
  const abs = resolve(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(entry) + '\n', 'utf-8');
}
export function appendTrainingMergeDecision(entry) {
  const abs = resolve(config.trainingMergeDecisionsFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(entry) + '\n', 'utf-8');
}
export function getStateHash(buffer = readRwkvStateBuffer()) {
  if (!buffer || buffer.length === 0) return 'sha256:none';
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

// ── Append Helpers ─────────────────────────────────────────────

const PROGRESS_MAX_BYTES = 200_000; // 200KB — rotate beyond this

export function appendProgress(entry) {
  const abs = resolve(config.progressFile);
  try {
    // Inject wall-clock timestamp into step headers for auditability
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const stamped = entry.replace(/(^|\n)(## Step \d+)/, `$1$2 [${now}]`);

    // Rotate when file exceeds size limit to prevent unbounded growth
    if (fs.existsSync(abs) && fs.statSync(abs).size > PROGRESS_MAX_BYTES) {
      const archiveName = config.progressFile.replace('.md', `-${Date.now()}.md`);
      fs.renameSync(abs, resolve(archiveName));
      fs.writeFileSync(abs, `# Progress Log (previous: ${path.basename(archiveName)})\n\n`, 'utf-8');
    }

    fs.appendFileSync(abs, stamped + '\n', 'utf-8');
  } catch (err) {
    logger.error(`[state] appendProgress failed: ${err.message}`);
  }
}

const LEARNINGS_MAX_BYTES = 50_000; // 50KB — rotate beyond this

export function appendLearning(note) {
  const abs = resolve(config.learningsFile);
  try {
    // Rotate when file exceeds size limit (same pattern as appendProgress)
    if (fs.existsSync(abs) && fs.statSync(abs).size > LEARNINGS_MAX_BYTES) {
      const archiveName = config.learningsFile.replace('.md', `-${Date.now()}.md`);
      fs.renameSync(abs, resolve(archiveName));
      fs.writeFileSync(abs, '# Learnings\n\n', 'utf-8');
    }
    fs.appendFileSync(abs, `- ${note}\n`, 'utf-8');
  } catch (err) {
    logger.error(`[state] appendLearning failed: ${err.message}`);
  }
  // Also persist through memory-store so learnings survive compaction context loss.
  process.nextTick(async () => {
    try {
      const mod = await import('./memory-store.js');
      mod.saveMemory(note, 'experience', ['learning']);
    } catch {}
  });
}

// ── File Tracking (in-memory cache to avoid O(n) read+write per touch) ──────

// Workspace-scoped: dropped automatically when the context's workspace changes,
// so a cache built against the old root can never serve the new one.
const FILES_TOUCHED_SLOT = 'state:filesTouched';

function filesTouchedSlot() {
  return ctx().slot(
    FILES_TOUCHED_SLOT,
    () => ({ cache: null, dirty: false }),
    { workspaceScoped: true }
  );
}

function getFilesTouchedCache() {
  const slot = filesTouchedSlot();
  if (!slot.cache) {
    slot.cache = normalizeFilesTouchedShape(readFilesTouched());
  }
  return slot.cache;
}

/** Flush the in-memory file-tracking cache to disk. Called by saveCheckpoint(). */
export function flushFilesTouched() {
  const slot = filesTouchedSlot();
  if (slot.dirty && slot.cache) {
    try {
      writeFilesTouched(slot.cache);
      slot.dirty = false;
    } catch (err) {
      logger.error(`[state] flushFilesTouched failed: ${err.message}`);
    }
  }
}

/** Restore in-memory file tracking cache from disk (used on resume). */
export function restoreFilesTracking() {
  const slot = filesTouchedSlot();
  slot.cache = normalizeFilesTouchedShape(readFilesTouched());
  slot.dirty = false;
}

function hashText(content) {
  return crypto.createHash('sha1').update(String(content || ''), 'utf-8').digest('hex');
}

function hashFile(absPath) {
  try {
    return hashText(fs.readFileSync(absPath, 'utf-8'));
  } catch {
    return '';
  }
}

function getCurrentTrackingStep() {
  return Number(_commandTrackingContext?.step || 0);
}

function ensureFreshnessEntry(tracked, filePath) {
  if (!tracked.freshness[filePath]) {
    tracked.freshness[filePath] = {
      path: filePath,
      lastReadStep: 0,
      lastWriteStep: 0,
      lastReadHash: '',
      lastWriteHash: '',
      lastKnownHash: '',
      lastErrorStep: 0,
      requiresRereadBeforeEdit: false,
      staleSummaryClaims: false,
      lastReadStartLine: 0,
      lastReadEndLine: 0,
      lastWriteWasOverwrite: false,
      staleReason: '',
    };
  }
  return tracked.freshness[filePath];
}

export function trackFileRead(filePath, meta = {}) {
  const tracked = getFilesTouchedCache();
  const abs = resolve(filePath);
  const now = Date.now();
  const freshness = ensureFreshnessEntry(tracked, filePath);
  const fileHash = hashFile(abs);

  tracked.reads[filePath] = {
    lastRead: now,
    count: (tracked.reads[filePath]?.count || 0) + 1,
    lastReadStep: Number(meta.step || getCurrentTrackingStep()),
    lastReadHash: fileHash,
    lastReadStartLine: Number(meta.startLine || 0),
    lastReadEndLine: Number(meta.endLine || 0),
  };

  freshness.lastReadStep = Number(meta.step || getCurrentTrackingStep());
  freshness.lastReadHash = fileHash;
  freshness.lastKnownHash = fileHash || freshness.lastKnownHash;
  freshness.lastReadStartLine = Number(meta.startLine || 0);
  freshness.lastReadEndLine = Number(meta.endLine || 0);
  freshness.requiresRereadBeforeEdit = false;
  freshness.staleReason = '';
  filesTouchedSlot().dirty = true;
}

export function trackFileWrite(filePath, meta = {}) {
  const tracked = getFilesTouchedCache();
  const abs = resolve(filePath);
  const now = Date.now();
  const freshness = ensureFreshnessEntry(tracked, filePath);
  const fileHash = hashFile(abs);
  const wasOverwrite = meta.overwrite === true;

  tracked.writes[filePath] = {
    lastWrite: now,
    count: (tracked.writes[filePath]?.count || 0) + 1,
    lastWriteStep: Number(meta.step || getCurrentTrackingStep()),
    lastWriteHash: fileHash,
    lastWriteWasOverwrite: wasOverwrite,
  };

  freshness.lastWriteStep = Number(meta.step || getCurrentTrackingStep());
  freshness.lastWriteHash = fileHash;
  freshness.lastKnownHash = fileHash || freshness.lastKnownHash;
  freshness.lastWriteWasOverwrite = wasOverwrite;
  freshness.requiresRereadBeforeEdit = wasOverwrite || meta.forceRereadBeforeEdit === true;
  freshness.staleSummaryClaims = wasOverwrite || freshness.staleSummaryClaims;
  freshness.staleReason = freshness.requiresRereadBeforeEdit
    ? 'File changed after the last trusted read. Re-read current on-disk contents before editing again.'
    : '';
  filesTouchedSlot().dirty = true;
}

export function markFileRequiresReread(filePath, reason = '', meta = {}) {
  const tracked = getFilesTouchedCache();
  const freshness = ensureFreshnessEntry(tracked, filePath);
  freshness.lastErrorStep = Number(meta.step || getCurrentTrackingStep());
  freshness.requiresRereadBeforeEdit = true;
  freshness.staleSummaryClaims = true;
  freshness.staleReason = reason || freshness.staleReason || 'Re-read the file before editing again.';
  filesTouchedSlot().dirty = true;
}

export function getFileFreshnessStatus(filePath) {
  const tracked = normalizeFilesTouchedShape(readFilesTouched());
  const freshness = tracked.freshness[filePath] || {
    path: filePath,
    lastReadStep: 0,
    lastWriteStep: 0,
    lastReadHash: '',
    lastWriteHash: '',
    lastKnownHash: '',
    lastErrorStep: 0,
    requiresRereadBeforeEdit: false,
    staleSummaryClaims: false,
    staleReason: '',
  };
  const abs = resolve(filePath);
  const currentHash = fs.existsSync(abs) ? hashFile(abs) : '';
  const externallyChanged = Boolean(
    currentHash
    && freshness.lastKnownHash
    && currentHash !== freshness.lastKnownHash
  );
  const stale = freshness.requiresRereadBeforeEdit || externallyChanged;
  return {
    ...freshness,
    currentHash,
    externallyChanged,
    stale,
    reason: externallyChanged
      ? 'File changed since the last tracked read/write. Re-read current on-disk contents before editing.'
      : (freshness.staleReason || ''),
  };
}

// ── Command Tracking ───────────────────────────────────────────

let _commandTrackingContext = {
  stage: '',
  step: 0,
  retryCount: 0,
};

export function setCommandTrackingContext(context = {}) {
  _commandTrackingContext = {
    stage: context.stage || '',
    step: Number(context.step || 0),
    retryCount: Number(context.retryCount || 0),
  };
}

export function trackCommand(cmd, exitCode, outputSnippet, meta = {}) {
  const commands = readCommandsRun();
  const touched = readFilesTouched();
  const now = Date.now();
  const relatedFileChanges = Object.entries(touched.writes || {})
    .filter(([, info]) => now - Number(info.lastWrite || 0) < 10_000)
    .map(([filePath]) => filePath);
  const outputDigest = String(outputSnippet || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  commands.push({
    command: cmd,
    exitCode,
    skipped: meta.skipped === true,
    success: Number(exitCode) === 0 && meta.skipped !== true,
    stage: meta.stage || _commandTrackingContext.stage || '',
    step: Number(meta.step || _commandTrackingContext.step || 0),
    retryCount: Number(meta.retryCount ?? _commandTrackingContext.retryCount ?? 0),
    executedAt: new Date().toISOString(),
    outputSnippet: (outputSnippet || '').slice(0, 500),
    outputDigest,
    relatedFileChanges,
    timestamp: now,
  });
  // Keep last 100 commands
  if (commands.length > 100) commands.splice(0, commands.length - 100);
  writeCommandsRun(commands);
}

/** Clear the command dedup history so previously-skipped commands can run again.
 *  Call this after a finish rejection so the agent can re-run verification commands
 *  as fresh evidence without hitting the duplicate guard.
 */
export function clearCommandDedup() {
  // Re-arm command dedup WITHOUT destroying verification evidence. commands-run.json
  // serves double duty: dedup history (run-command.js) and required-command
  // evidence (stages.js). Wiping it re-blocked the very stage whose repair just
  // succeeded. Instead, mark existing entries `dedupStale` so wasRecentlySuccessful
  // ignores them (a repaired composite command may re-run as fresh evidence),
  // while commandEvidenceSatisfied still counts their successful exit codes.
  const history = readCommandsRun();
  writeCommandsRun(history.map((e) => ({ ...e, dedupStale: true })));
}

export function trackRecoveryEvent(type, trigger, correctiveAction, meta = {}) {
  const events = readRecoveryEvents();
  events.push({
    type,
    trigger,
    correctiveAction,
    target: meta.target || '',
    stage: meta.stage || '',
    step: Number(meta.step || 0),
    timestamp: new Date().toISOString(),
  });
  if (events.length > 100) events.splice(0, events.length - 100);
  writeRecoveryEvents(events);
}

// ── Checkpoint ─────────────────────────────────────────────────

/**
 * Save full checkpoint state.
 * @param {Object} state - { step, phase, currentSubtask, workingMemory, totalCharsUsed, consecutiveErrors }
 */
// Cached MCP server state — updated by the connection manager via setMcpServerStates().
// Avoids making saveCheckpoint async (which would break all call sites).
let _mcpServerStates = [];

/** Called by the MCP connection manager after each health update. */
export function setMcpServerStates(states) {
  _mcpServerStates = Array.isArray(states) ? states : [];
}

export function saveCheckpoint(state) {
  flushFilesTouched(); // batch-write file tracking instead of per-touch I/O
  writeCheckpoint({
    ...state,
    mcp_servers: _mcpServerStates.length > 0 ? _mcpServerStates : (state.mcp_servers ?? []),
    savedAt: new Date().toISOString(),
  });
}

/**
 * Load checkpoint or return default.
 */
export function loadCheckpoint() {
  return readCheckpoint() || {
    step: 0,
    phase: 'init',
    currentSubtask: null,
    workingMemory: [],
    totalCharsUsed: 0,
    consecutiveErrors: 0,
    bank_focus: 'project',
    active_route: ['project'],
    active_ontology_tags: [],
    rwkv_state_hash: 'sha256:none',
    lmma_packet_version: 2,
  };
}

/**
 * Pre-populate LMMA banks with task context and MEMORY.md on session start.
 * Seeds the 'project' bank so the agent has orientation from step 1.
 * Only seeds if the project bank is currently empty (idempotent on resume).
 *
 * @param {string} task - The task description for this session.
 * @param {string} memoryMd - Contents of MEMORY.md (may be empty).
 */
export function seedLmmaBanksFromContext(task, memoryMd = '') {
  const existing = readLmmaBank('project');
  if (existing.length > 0) return; // already seeded — resume mode

  const now = new Date().toISOString();

  if (task && task.trim()) {
    appendLmmaBankEntry('project', {
      memory_id: `seed-task-${now}`,
      content: `Task: ${task.slice(0, 500)}`,
      importance: 1.0,
      tags: ['task', 'seed', 'orientation'],
      created_at: now,
    });
  }

  if (memoryMd && memoryMd.trim()) {
    // Chunk MEMORY.md into ≤400-char segments so retrieval is granular
    const lines = memoryMd.split(/\r?\n/);
    let chunk = [];
    let chunkIdx = 0;
    for (const line of lines) {
      chunk.push(line);
      if (chunk.join('\n').length >= 400) {
        appendLmmaBankEntry('project', {
          memory_id: `seed-memory-${chunkIdx}-${now}`,
          content: chunk.join('\n').trim(),
          importance: 0.7,
          tags: ['memory', 'seed', 'long-term'],
          created_at: now,
        });
        chunk = [];
        chunkIdx++;
      }
    }
    if (chunk.length > 0 && chunk.join('\n').trim()) {
      appendLmmaBankEntry('project', {
        memory_id: `seed-memory-${chunkIdx}-${now}`,
        content: chunk.join('\n').trim(),
        importance: 0.7,
        tags: ['memory', 'seed', 'long-term'],
        created_at: now,
      });
    }
  }
}
