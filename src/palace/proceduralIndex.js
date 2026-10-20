// src/palace/proceduralIndex.js
// Procedural recipe extractor — learns "how to do X" from repeated successes.
// After 3 similar successful actions, a recipe is auto-created in .agent/palace/procedures.jsonl.

import fs   from 'node:fs';
import path from 'node:path';
import { resolveContext } from '../runtime/context.js';

const REL_PATH = '.agent/palace/procedures.jsonl';
const AUTO_RECIPE_THRESHOLD = 3; // successes before recipe is recorded

/** @typedef {{ id: string, name: string, trigger: string, steps: string[], successCount: number, createdAt: number, lastUsed: number }} Recipe */

// Resolve against the PASSED context — see the matching note in semanticGraph.js.
function absPath(ctx) {
  return resolveContext(ctx).resolve(REL_PATH);
}

// Phase 1.3: the success accumulator and recipe cache were module-level while
// their backing file is workspace-relative, so a second workspace inherited the
// first one's in-flight successes and cached recipes. Both are now
// workspace-scoped per-context state.
const SLOT = 'palace:procedural';

function store(ctx) {
  return resolveContext(ctx).slot(
    SLOT,
    /** @returns {{ successLog: Map<string, object[]>, recipes: object[]|null }} */
    () => ({ successLog: new Map(), recipes: null }),
    { workspaceScoped: true }
  );
}

function loadRecipes(ctx) {
  const s = store(ctx);
  if (s.recipes) return s.recipes;
  const abs = absPath(ctx);
  if (!fs.existsSync(abs)) { s.recipes = []; return s.recipes; }
  s.recipes = fs.readFileSync(abs, 'utf-8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  return s.recipes;
}

function appendRecipe(recipe, ctx) {
  const abs = absPath(ctx);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(recipe) + '\n', 'utf-8');
}

/**
 * Record a successful action. If this trigger has succeeded ≥ threshold times,
 * auto-create or update a recipe.
 *
 * @param {{ tool: string, args: object, result: string, domain: string }} action
 */
export function recordSuccess({ tool, args, result, domain = '' }, ctx) {
  // Normalize a trigger key from the action
  const trigger = normalizeTrigger(tool, args);
  if (!trigger) return;

  const s = store(ctx);
  const log = s.successLog.get(trigger) ?? [];
  log.push({ tool, args, result: result.slice(0, 200), domain, ts: Date.now() / 1000 });
  s.successLog.set(trigger, log);

  if (log.length >= AUTO_RECIPE_THRESHOLD) {
    ensureRecipe(trigger, log, ctx);
  }
}

function normalizeTrigger(tool, args) {
  if (tool === 'run_command' && args?.command) {
    // Normalize: strip output paths, keep the command verb
    const cmd = String(args.command).split(' ')[0];
    return `run:${cmd}`;
  }
  if (tool === 'write_file' && args?.path) {
    const ext = path.extname(args.path);
    return `write:${ext}`;
  }
  if (tool === 'edit_file') return 'edit:file';
  return null;
}

function ensureRecipe(trigger, log, ctx) {
  const recipes = loadRecipes(ctx);
  const existing = recipes.find(r => r.trigger === trigger);
  if (existing) {
    existing.successCount++;
    existing.lastUsed = Date.now() / 1000;
    return;
  }

  const steps = log.slice(-AUTO_RECIPE_THRESHOLD).map(e =>
    `${e.tool}: ${JSON.stringify(e.args).slice(0, 100)}`
  );

  const recipe = {
    id:           `recipe-${trigger}-${Date.now()}`,
    name:         `Auto-recipe for ${trigger}`,
    trigger,
    steps,
    successCount: log.length,
    createdAt:    Date.now() / 1000,
    lastUsed:     Date.now() / 1000,
  };

  recipes.push(recipe);
  appendRecipe(recipe, ctx);
}

/**
 * Find recipes that match a given trigger or task description.
 * @param {string} query
 * @returns {Recipe[]}
 */
export function findRecipes(query, ctx) {
  const recipes = loadRecipes(ctx);
  const q = query.toLowerCase();
  return recipes.filter(r =>
    r.trigger.toLowerCase().includes(q) ||
    r.name.toLowerCase().includes(q) ||
    r.steps.some(s => s.toLowerCase().includes(q))
  );
}

/** Return all known recipes. */
export function getAllRecipes(ctx) { return loadRecipes(ctx); }

/** Flush in-memory cache (for testing). */
export function flush(ctx) {
  const s = store(ctx);
  s.recipes = null;
  s.successLog.clear();
}
