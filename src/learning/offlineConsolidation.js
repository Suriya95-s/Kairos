// src/learning/offlineConsolidation.js
// Offline background consolidation — runs between sessions, never in-loop.
// Orchestrates: palace decay, skill grading, skill consolidation.
// Can be invoked via: node src/learning/offlineConsolidation.js <workspace>
// Task 5.3

import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { resolveContext } from '../runtime/context.js';
import { workspaceResolve } from '../runtime/workspacePath.js';
import { gradeAllSkills } from './skillGrader.js';
import { consolidate as consolidateSkills } from './skillConsolidator.js';

function resolve(rel) {
  return workspaceResolve(rel);
}

function log(msg) {
  process.stderr.write(`[offline-consolidation] ${msg}\n`);
}

/**
 * Run a full offline consolidation pass.
 * @param {object} opts
 * @param {boolean} [opts.skipPalace]   — skip palace decay (e.g., palace disabled)
 * @param {boolean} [opts.skipSkills]   — skip skill grading + consolidation
 * @param {boolean} [opts.dryRun]       — report plan without modifying files
 * @returns {Promise<object>} summary of what was done
 */
export async function runOfflineConsolidation({ skipPalace = false, skipSkills = false, dryRun = false } = {}) {
  const summary = {
    timestamp: new Date().toISOString(),
    palace: null,
    skillGrades: null,
    skillMerges: null,
    dryRun,
  };

  // ── 1. Palace decay (CEI consolidate) ────────────────────────────────────
  if (!skipPalace && config.palaceEnabled) {
    try {
      const { getPalaceSession } = await import('../palace/session.js');
      const { consolidate: palaceConsolidate } = await import('../palace/consolidation.js');
      const sess = getPalaceSession();
      if (sess) {
        const result = await palaceConsolidate(sess.store);
        summary.palace = result;
        log(`Palace: archived=${result?.archived ?? 0} events, pruned=${result?.pruned ?? 0} links`);
      } else {
        log('Palace: no active session — skipped');
        summary.palace = { skipped: true, reason: 'no active session' };
      }
    } catch (err) {
      log(`Palace consolidation failed: ${err.message}`);
      summary.palace = { error: err.message };
    }
  } else {
    summary.palace = { skipped: true, reason: skipPalace ? 'skipPalace=true' : 'palace disabled' };
  }

  // ── 2. Skill grading ──────────────────────────────────────────────────────
  if (!skipSkills) {
    try {
      const grades = gradeAllSkills();
      summary.skillGrades = { count: grades.length, grades };
      log(`Skills graded: ${grades.length} skills — ${grades.filter(g => g.grade === 'A').length} A, ${grades.filter(g => g.grade === 'D').length} D`);
    } catch (err) {
      log(`Skill grading failed: ${err.message}`);
      summary.skillGrades = { error: err.message };
    }

    // ── 3. Skill consolidation ────────────────────────────────────────────
    try {
      const merges = consolidateSkills(dryRun);
      summary.skillMerges = { count: merges.length, merges };
      if (merges.length > 0) {
        log(`Skills consolidated: ${merges.length} merge(s)${dryRun ? ' (dry-run)' : ''}`);
      } else {
        log('Skills: no near-duplicate pairs found');
      }
    } catch (err) {
      log(`Skill consolidation failed: ${err.message}`);
      summary.skillMerges = { error: err.message };
    }
  } else {
    summary.skillGrades = { skipped: true };
    summary.skillMerges = { skipped: true };
  }

  // ── 4. Persist summary ────────────────────────────────────────────────────
  if (!dryRun) {
    try {
      fs.mkdirSync(resolve(config.learningDir), { recursive: true });
      const logFile = resolve(path.join(config.learningDir, 'consolidation-log.jsonl'));
      fs.appendFileSync(logFile, JSON.stringify(summary) + '\n');
    } catch { /* non-critical */ }
  }

  return summary;
}

// ── CLI entry-point ───────────────────────────────────────────────────────────
// node src/learning/offlineConsolidation.js [workspace] [--dry-run] [--skip-palace] [--skip-skills]
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('offlineConsolidation.js')) {
  const args = process.argv.slice(2);
  const workspace = args.find(a => !a.startsWith('--')) || process.cwd();
  const dryRun = args.includes('--dry-run');
  const skipPalace = args.includes('--skip-palace');
  const skipSkills = args.includes('--skip-skills');

  // The context setter keeps config._workspace in lock-step AND invalidates
  // workspace-scoped slots — a bare `config._workspace =` does neither half.
  const ctx = resolveContext();
  ctx.setWorkspace(workspace);
  log(`Starting offline consolidation for: ${ctx.workspace}${dryRun ? ' [dry-run]' : ''}`);

  runOfflineConsolidation({ skipPalace, skipSkills, dryRun }).then(summary => {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }).catch(err => {
    log(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
