// src/trust/ledger.js
// The actuation ledger (7.3): one place where every consequential action is
// written down, and — where one exists — how to take it back.
//
// Two jobs that belong together:
//
//   **Audit.** Every T1+ action, with who asked, what was done, why it was
//   allowed, and how it turned out. One ledger, not one per subsystem: the
//   question a person actually asks is "what has this thing done today", and
//   answering it by correlating four log files is the same as not answering it.
//
//   **Undo.** A T2 action is *reversible* by definition, which is only true if
//   somebody wrote down how. The recipe is recorded at the moment of the action,
//   when the ids and paths are in hand — reconstructing "which calendar event
//   was that" an hour later is exactly the reconstruction that fails.
//
// Honesty about limits is deliberate throughout. `undo()` is best-effort and
// says so: some actions have no recipe, some recipes go stale, and a ledger
// that implies otherwise would encourage exactly the carelessness it exists to
// prevent. An action with no recipe is recorded as `irreversible: true` at write
// time rather than discovered at undo time, so the honest answer is available
// *before* the user relies on being able to take it back.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { dir as kernelDir } from '../kernel/paths.js';
import { classify, tierRank, atLeast } from './tiers.js';
import { redactTrace } from '../learning/redactor.js';

/** Where an action came from. */
export const ACTORS = Object.freeze(['mission', 'reflex', 'user', 'system']);

/** How the action was permitted. */
export const GRANTS = Object.freeze(['tier', 'policy', 'standing', 'approved', 'denied', 'timeout']);

// ── Undo recipes ────────────────────────────────────────────────────────────
// A recipe describes the inverse of an action in terms recorded at the time.
// `null` means genuinely irreversible — recorded honestly rather than guessed.

const UNDO_RECIPES = Object.freeze({
  write_file: (args, result) => (
    // Only reversible when we captured what was there before. A write to a new
    // file undoes to a delete; a write over an existing one needs its content,
    // and if the caller did not supply it we say so instead of pretending.
    result?.previousContent !== undefined
      ? { kind: 'restore_file', path: args.path, content: result.previousContent }
      : result?.created
        ? { kind: 'delete_file', path: args.path }
        : null
  ),
  edit_file: (args, result) => (
    result?.previousContent !== undefined
      ? { kind: 'restore_file', path: args.path, content: result.previousContent }
      : null
  ),
  create_dir: (args) => ({ kind: 'remove_dir_if_empty', path: args.path }),
  move_path: (args) => ({ kind: 'move_path', from: args.to, to: args.from }),
  copy_path: (args) => ({ kind: 'delete_file', path: args.to }),
  save_memory: (args, result) => (
    result?.memoryId != null ? { kind: 'forget_memory', id: result.memoryId } : null
  ),
});

/** MCP undo recipes, by verb. External systems, so these are advisory. */
function mcpUndoRecipe(tool, args, result) {
  const t = tool.toLowerCase();
  const id = result?.id ?? result?.eventId ?? result?.messageId ?? null;
  if (!id) return null;

  const server = tool.split('__')[0];
  if (/create|add|schedule|book|invite/.test(t)) {
    return { kind: 'mcp_call', tool: `${server}__delete`, args: { id }, advisory: true };
  }
  if (/send|email|message/.test(t)) {
    // A sent message cannot be unsent. Recalling a draft is the most that is
    // ever available, and claiming more would be a lie with consequences.
    return { kind: 'manual', note: `A message was sent (id ${id}). It cannot be recalled — reply or follow up instead.`, irreversible: true };
  }
  return null;
}

export class ActuationLedger {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dirPath]  default ~/.<brand>/audit
   * @param {function} [opts.now]
   * @param {object} [opts.bus]
   */
  constructor({ dirPath = null, now = Date.now, bus = null, newId = null } = {}) {
    this._dirPath = dirPath;
    this._now = now;
    this._bus = bus;
    this._newId = newId || (() => `act-${randomUUID().slice(0, 8)}`);
  }

  get dirPath() { return this._dirPath || path.join(kernelDir('logs'), 'audit'); }
  get ledgerPath() { return path.join(this.dirPath, 'actuation.jsonl'); }

  /**
   * Record an action.
   *
   * Called for every T1+ call, allowed or refused — a denial is exactly as much
   * a part of the record as an approval, and a ledger that only lists successes
   * cannot answer "did it try to do anything it should not have".
   *
   * @returns {object} the ledger entry
   */
  record({
    tool, args = {}, result = null, actor = 'mission', missionId = null, sessionId = null,
    grant = 'tier', why = '', outcome = 'ok', error = null, tier = null,
  }) {
    const resolved = tier || classify(tool, args).tier;
    const recipe = this._recipeFor(tool, args, result, outcome);

    const entry = {
      id: this._newId(),
      ts: this._now(),
      tool,
      tier: resolved,
      actor,
      missionId,
      sessionId,
      // who / what / why / outcome — the four columns the AC asks for.
      grant,
      why: why || '',
      outcome,
      error: error ? String(error).slice(0, 500) : null,
      // Redacted like everything else that gets written down: an audit trail
      // is a wonderful place to accidentally archive an API key forever.
      args: redactTrace(truncateArgs(args)),
      undo: recipe,
      irreversible: recipe === null || recipe?.irreversible === true,
      undoneAt: null,
    };

    this._append(entry);
    this._publish(entry);
    return entry;
  }

  _recipeFor(tool, args, result, outcome) {
    // Nothing happened, so there is nothing to reverse.
    if (outcome !== 'ok') return { kind: 'none', note: 'action did not take effect' };
    try {
      if (tool.includes('__')) return mcpUndoRecipe(tool, args, result);
      const build = UNDO_RECIPES[tool];
      return build ? build(args, result || {}) : null;
    } catch {
      return null;
    }
  }

  _append(entry) {
    try {
      fs.mkdirSync(this.dirPath, { recursive: true });
      fs.appendFileSync(this.ledgerPath, JSON.stringify(entry) + '\n');
    } catch {
      // A ledger that cannot write must not stop the action it is describing —
      // but this is the one failure worth shouting about, because from here on
      // the record is incomplete.
      process.stderr.write(`[trust] AUDIT WRITE FAILED for ${entry.tool} — the ledger is now incomplete\n`);
    }
  }

  _publish(entry) {
    if (!this._bus) return;
    try {
      this._bus.publish({
        source: 'system',
        kind: 'approval',
        sessionId: entry.sessionId,
        urgency: atLeast(entry.tier, 'T3') ? 'soon' : 'whenever',
        payload: {
          action: 'actuation',
          id: entry.id, tool: entry.tool, tier: entry.tier,
          grant: entry.grant, outcome: entry.outcome, irreversible: entry.irreversible,
        },
      });
    } catch { /* the ledger is the record; the bus is a convenience */ }
  }

  /** Read the ledger back, newest last. */
  read({ limit = null, tier = null, since = null, outcome = null } = {}) {
    let text;
    try { text = fs.readFileSync(this.ledgerPath, 'utf-8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (tier && !atLeast(e.tier, tier)) continue;
      if (since && e.ts < since) continue;
      if (outcome && e.outcome !== outcome) continue;
      out.push(e);
    }
    return limit ? out.slice(-limit) : out;
  }

  get(id) { return this.read().find(e => e.id === id) || null; }

  /**
   * Has this entry already been reversed?
   *
   * Must be derived from the reversal records, not from a flag on the original.
   * The ledger is append-only, so the original is never edited — an
   * `undoneAt` field on it would stay null forever and the "already undone"
   * guard would never fire. Undoing a `move_path` twice shuffles a file back
   * and forth; re-issuing an MCP delete could hit something else entirely.
   */
  isUndone(id) {
    return this.read().some(e => e.undoOf === id);
  }

  /** Entries that could still be undone, newest first. */
  undoable({ limit = 20 } = {}) {
    return this.read()
      .filter(e => e.outcome === 'ok' && !e.irreversible && e.undo && !this.isUndone(e.id))
      .slice(-limit)
      .reverse();
  }

  /**
   * Attempt to reverse an action. Best-effort, and says which.
   *
   * @param {string} id
   * @param {object} [opts]
   * @param {function} [opts.execTool] async (tool, args) => result
   * @returns {Promise<{ok: boolean, reason: string, manual?: string}>}
   */
  async undo(id, { execTool = null } = {}) {
    const entry = this.get(id);
    if (!entry) return { ok: false, reason: `no ledger entry ${id}` };
    if (this.isUndone(id)) return { ok: false, reason: 'already undone' };
    if (entry.irreversible || !entry.undo) {
      return {
        ok: false,
        reason: `${entry.tool} cannot be undone`,
        manual: entry.undo?.note || null,
      };
    }

    const recipe = entry.undo;
    try {
      switch (recipe.kind) {
        case 'restore_file':
          fs.writeFileSync(recipe.path, recipe.content, 'utf-8');
          break;
        case 'delete_file':
          fs.rmSync(recipe.path, { force: true });
          break;
        case 'remove_dir_if_empty':
          // `rmdir` and not `rm -rf`: undoing a mkdir must never delete work
          // that was created inside it afterwards.
          try { fs.rmdirSync(recipe.path); } catch { return { ok: false, reason: 'directory is not empty — not removing it' }; }
          break;
        case 'move_path':
          fs.renameSync(recipe.from, recipe.to);
          break;
        case 'mcp_call':
          if (!execTool) return { ok: false, reason: 'no tool executor available to run the reversal' };
          await execTool(recipe.tool, recipe.args);
          break;
        case 'manual':
          return { ok: false, reason: 'this needs a person', manual: recipe.note };
        default:
          return { ok: false, reason: `unknown undo recipe "${recipe.kind}"` };
      }
    } catch (err) {
      return { ok: false, reason: `undo failed: ${err.message}` };
    }

    this._markUndone(entry.id);
    return { ok: true, reason: `reversed ${entry.tool}` };
  }

  /**
   * Append-only: the reversal is a new line, not an edit.
   * Rewriting history in an audit ledger defeats the purpose of having one.
   */
  _markUndone(id) {
    try {
      fs.appendFileSync(this.ledgerPath, JSON.stringify({
        id: this._newId(), ts: this._now(), tool: '__undo__', tier: 'T1',
        actor: 'user', grant: 'approved', outcome: 'ok',
        why: `reversal of ${id}`, undoOf: id, args: {}, undo: null, irreversible: true,
      }) + '\n');
    } catch { /* already reported by _append's own failure path */ }
  }

  /** A day's activity, summarised for a person. */
  summary({ since = null } = {}) {
    const entries = this.read({ since }).filter(e => e.tool !== '__undo__');
    const byTier = {};
    const byOutcome = {};
    for (const e of entries) {
      byTier[e.tier] = (byTier[e.tier] || 0) + 1;
      byOutcome[e.outcome] = (byOutcome[e.outcome] || 0) + 1;
    }
    return {
      total: entries.length,
      byTier,
      byOutcome,
      irreversible: entries.filter(e => e.irreversible && e.outcome === 'ok').length,
      external: entries.filter(e => tierRank(e.tier) >= tierRank('T2')).length,
    };
  }
}

function truncateArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    out[k] = typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}… [${v.length} chars]` : v;
  }
  return out;
}

let _ledger = null;
export function getActuationLedger(opts) {
  if (!_ledger) _ledger = new ActuationLedger(opts);
  return _ledger;
}
export function resetActuationLedger() { _ledger = null; }
