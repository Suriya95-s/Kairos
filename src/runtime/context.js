// src/runtime/context.js
// AgentContext — the unit of isolation for a single agent run.
//
// WHY THIS EXISTS
// ---------------
// Kairos was built as a one-run-per-process CLI, so runtime state lives in
// module-level globals: `state.js` holds `workspaceRoot`, `config._workspace`
// shadows it for 14 more modules, and caches/counters/handles are memoized per
// module rather than per run. That is correct for a CLI and fatal for a daemon:
// two concurrent sessions would share one workspace, one cost counter, one
// files-touched cache, one palace handle.
//
// This module introduces an explicit context WITHOUT a big-bang rewrite. The
// migration contract is:
//
//   1. Every context owns its workspace, its config, and its per-run state.
//   2. There is one AMBIENT context whose `config` IS the imported singleton,
//      so the ~45 modules doing `import config from './config.js'` keep
//      observing exactly what they observe today. Nothing breaks on day one.
//   3. Modules migrate one at a time from module-level `let` to
//      `ctx.slot(key, factory)`. A migrated module works identically under the
//      ambient context and becomes isolation-safe under an explicit one.
//   4. When every module is migrated, the ambient context becomes an
//      implementation detail of the CLI and the daemon stops using it.
//
// See JARVIS_EVOLUTION_PLAN.md — Phase 1.

import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import baseConfig from '../config.js';

let _seq = 0;

// Implicit per-run context propagation.
//
// The alternative — threading `ctx` through every state.js signature and call
// site — is ~50 signatures and hundreds of call sites, where each one missed is
// a SILENT fall-back to ambient (exactly the half-migration bug that the
// palace absPath() slip demonstrated). AsyncLocalStorage gives the same
// isolation guarantee structurally: anything running inside runWithContext(),
// including across await boundaries, resolves to that run's context without
// the caller knowing it exists.
//
// Caveat, deliberate: callbacks registered OUTSIDE a run — `process.on('exit')`
// handlers in particular — have no store and correctly fall back to ambient.
const _als = new AsyncLocalStorage();

/**
 * A single agent run's isolated runtime state.
 *
 * Holds the workspace root, a config view, and a keyed registry of per-run
 * service state (caches, counters, handles) created lazily via `slot()`.
 */
export class AgentContext {
  /**
   * @param {object}  [opts]
   * @param {string}  [opts.workspace]  workspace root (default: process.cwd())
   * @param {object}  [opts.config]     config overrides, or the singleton itself
   * @param {string}  [opts.id]         stable id for logs/telemetry
   * @param {string}  [opts.missionId]  when set, state is stored under
   *                                    `.agent/missions/<missionId>/` so
   *                                    siblings sharing a workspace cannot
   *                                    clobber each other's checkpoints
   * @param {boolean} [opts.daemonMode] when true, the loop must not install
   *                                    process-level signal/exit handlers —
   *                                    the host owns process lifecycle
   * @param {boolean} [opts.ambient]    internal — marks the process-wide context
   */
  constructor({ workspace, config, id, missionId = null, daemonMode = false, ambient = false } = {}) {
    this.id = id || `ctx-${++_seq}`;
    this.ambient = ambient;
    this.missionId = missionId;
    this.daemonMode = daemonMode;

    // The ambient context uses the config singleton BY REFERENCE so that
    // modules importing it directly stay coherent. Explicit contexts get an
    // isolated shallow clone: mutating `ctx.config.model` must not leak into a
    // sibling run (this is exactly the Wave D-1 hazard the conductor works
    // around today with explicit model/maxSteps parameters).
    if (ambient) {
      this.config = baseConfig;
      if (config) Object.assign(this.config, config);
    } else {
      this.config = { ...baseConfig, ...(config || {}) };
    }

    /** @type {AgentContext|null} set by child(); owns shared workspace slots */
    this._parent = null;
    /** @type {Map<string, unknown>} lazily-created per-context service state */
    this._slots = new Map();
    /** @type {Array<() => void>} disposers registered by slots */
    this._disposers = [];
    this._disposed = false;

    this.setWorkspace(workspace || process.cwd());
  }

  // ── Workspace ─────────────────────────────────────────────────────────────

  /** @returns {string} absolute workspace root */
  get workspace() {
    return this._workspace;
  }

  /**
   * Point this context at a workspace. Invalidates every workspace-scoped slot,
   * because a cache keyed to the old root would serve the wrong files — the
   * exact class of bug that made `setWorkspace()` flaky across tests.
   * @param {string} dir
   */
  setWorkspace(dir) {
    const next = path.resolve(dir);
    const changed = this._workspace !== undefined && this._workspace !== next;
    this._workspace = next;

    // Keep the config view in lock-step. HITL queues, learning modules and otel
    // resolve paths against `config._workspace`, not against state.js's root.
    this.config._workspace = next;

    if (changed) this.invalidateWorkspaceSlots();
  }

  /**
   * Resolve a workspace-relative path.
   * @param {string} relativePath
   * @returns {string}
   */
  resolve(relativePath) {
    return path.join(this._workspace, relativePath);
  }

  // ── Per-context service state ─────────────────────────────────────────────

  /**
   * Get-or-create per-context state under `key`.
   *
   * This is the migration seam: a module replaces its module-level `let _cache`
   * with `ctx.slot('mymodule:cache', () => ({...}))` and immediately becomes
   * safe under concurrent contexts, with no change to its callers.
   *
   * @template T
   * @param {string} key                       unique, namespaced (e.g. 'state:filesTouched')
   * @param {() => T} factory                  called once per context
   * @param {object}  [opts]
   * @param {boolean} [opts.workspaceScoped]   drop this slot when the workspace changes
   * @param {(value: T) => void} [opts.dispose] cleanup on ctx.dispose()
   * @returns {T}
   */
  slot(key, factory, { workspaceScoped = false, dispose } = {}) {
    if (this._disposed) throw new Error(`AgentContext ${this.id} is disposed`);

    // Sibling missions in the SAME workspace must share workspace state.
    // Concretely: two specialists dispatched in parallel by the conductor each
    // track file writes, and saveCheckpoint() flushes that cache — with
    // isolated caches they would race and the last flush would erase the
    // other's tracking. Run state (cost, traces) is NOT workspace-scoped and
    // stays isolated, which is what makes per-specialist accounting correct.
    // The parent owns the slot, so the parent also owns its disposer.
    if (workspaceScoped && this._parent && !this._parent.disposed &&
        this._parent.workspace === this._workspace) {
      return this._parent.slot(key, factory, { workspaceScoped, dispose });
    }

    if (this._slots.has(key)) return this._slots.get(key);

    const value = factory();
    this._slots.set(key, value);
    if (workspaceScoped) {
      (this._workspaceScopedKeys ??= new Set()).add(key);
    }
    if (dispose) {
      this._disposers.push(() => dispose(value));
    }
    return value;
  }

  /** True when `key` has been materialized. */
  hasSlot(key) {
    return this._slots.has(key);
  }

  /** Drop a single slot (next `slot()` call re-creates it). */
  clearSlot(key) {
    this._slots.delete(key);
    this._workspaceScopedKeys?.delete(key);
  }

  /** Drop every slot registered as workspace-scoped. */
  invalidateWorkspaceSlots() {
    if (!this._workspaceScopedKeys) return;
    for (const key of this._workspaceScopedKeys) this._slots.delete(key);
    this._workspaceScopedKeys.clear();
  }

  /**
   * Derive a sibling run that shares this context's workspace and config but
   * has its own identity and its own run state.
   *
   * This is how the conductor dispatches specialists: each needs a distinct
   * `missionId` (so checkpoints land in separate files) and its own cost/trace
   * accounting, while continuing to share the workspace state its siblings are
   * concurrently mutating. Mutating `missionId` on the shared parent instead
   * would race between parallel siblings.
   *
   * @param {{ missionId?: string, id?: string, config?: object }} [overrides]
   * @returns {AgentContext}
   */
  child(overrides = {}) {
    if (this._disposed) throw new Error(`AgentContext ${this.id} is disposed`);
    const kid = new AgentContext({
      workspace:  this._workspace,
      config:     { ...this.config, ...(overrides.config || {}) },
      id:         overrides.id || `${this.id}/child-${++_seq}`,
      missionId:  overrides.missionId ?? this.missionId,
      daemonMode: this.daemonMode,
    });
    kid._parent = this;
    return kid;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Release handles (DB connections, timers, child processes) held by slots.
   * Disposers run in reverse registration order; one throwing disposer must not
   * strand the rest, so failures are collected and reported together.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const errors = [];
    for (const fn of this._disposers.reverse()) {
      try { fn(); } catch (err) { errors.push(err); }
    }
    this._disposers = [];
    this._slots.clear();
    this._workspaceScopedKeys?.clear();
    if (errors.length) {
      throw new AggregateError(errors, `AgentContext ${this.id}: ${errors.length} disposer(s) failed`);
    }
  }

  get disposed() {
    return this._disposed;
  }
}

// ── Ambient context ─────────────────────────────────────────────────────────
//
// The process-wide default. Every not-yet-migrated call site resolves here, so
// current single-run behavior is bit-for-bit unchanged. The daemon (Phase 3)
// creates explicit contexts per mission and never relies on this.

/** @type {AgentContext|null} */
let _ambient = null;

/** The process-wide default context, created on first use. */
export function getAmbientContext() {
  if (!_ambient) {
    _ambient = new AgentContext({ id: 'ctx-ambient', ambient: true, workspace: process.cwd() });
  }
  return _ambient;
}

/**
 * Create an isolated context. Use this for missions; never for the CLI default.
 * @param {{ workspace?: string, config?: object, id?: string }} [opts]
 * @returns {AgentContext}
 */
export function createContext(opts = {}) {
  return new AgentContext({ ...opts, ambient: false });
}

/**
 * Reset the ambient context. Tests only — production code has exactly one.
 * @returns {AgentContext} the fresh ambient context
 */
export function resetAmbientContext() {
  if (_ambient && !_ambient.disposed) {
    try { _ambient.dispose(); } catch { /* best effort in teardown */ }
  }
  _ambient = null;
  return getAmbientContext();
}

/**
 * The context for the currently-executing run: the AsyncLocalStorage store if
 * we are inside runWithContext(), otherwise the ambient context.
 * @returns {AgentContext}
 */
export function currentContext() {
  return _als.getStore() ?? getAmbientContext();
}

/** The active run's context, or null when not inside runWithContext(). */
export function currentContextOrNull() {
  return _als.getStore() ?? null;
}

/**
 * Resolve the context to use: an explicit one when provided, else whatever the
 * current run established, else ambient. Migrated modules call this so they
 * accept an optional `ctx` argument without forcing every caller to pass one.
 * @param {AgentContext} [ctx]
 * @returns {AgentContext}
 */
export function resolveContext(ctx) {
  return ctx instanceof AgentContext ? ctx : currentContext();
}

/**
 * Run `fn` with `ctx` as the implicit context for everything it touches,
 * including across await boundaries and nested calls.
 *
 * Nested runWithContext() calls with a different context are legitimate (the
 * conductor dispatching a specialist into its own workspace); the inner scope
 * simply shadows the outer for its duration.
 *
 * @template T
 * @param {AgentContext} ctx
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithContext(ctx, fn) {
  if (!(ctx instanceof AgentContext)) {
    throw new TypeError('runWithContext requires an AgentContext');
  }
  return _als.run(ctx, fn);
}

export default {
  AgentContext,
  createContext,
  getAmbientContext,
  resetAmbientContext,
  resolveContext,
  currentContext,
  currentContextOrNull,
  runWithContext,
};
