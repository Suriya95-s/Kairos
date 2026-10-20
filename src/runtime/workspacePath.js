// src/runtime/workspacePath.js
// One workspace resolver for modules that predate AgentContext.
//
// Phase 1 left a known gap, recorded in PHASE_REPORT.md: `config._workspace` is
// a second source of truth for the workspace root. In a single-run process it
// stays coherent because `setWorkspace()` maintains both in lock-step. In the
// daemon it does not, and the reason is by design — an explicit AgentContext
// gets a *cloned* config so that mutating `ctx.config.model` cannot leak into a
// sibling mission. The clone means `config._workspace`, the module-level
// singleton these files import, is never updated.
//
// The bug that surfaced: the daemon injected a steering message for a mission,
// reported "passed that to the running mission", and wrote the file into its
// own working directory instead of the mission's. Nothing threw. The message
// was simply never delivered — the silent-degradation class again.
//
// Rather than migrate every legacy module at once (they are load-bearing for
// the running loop and heavily tested), they resolve through here. The context
// wins when there is one; the singleton remains the fallback for direct calls
// made outside any context, which is still how the CLI uses them.

import path from 'node:path';

import config from '../config.js';
import { currentContextOrNull } from './context.js';

/**
 * Resolve a workspace-relative path.
 * @param {string} rel
 * @returns {string} absolute path
 */
export function workspaceResolve(rel) {
  const ctx = currentContextOrNull();
  if (ctx) return ctx.resolve(rel);
  return path.resolve(config._workspace || process.cwd(), rel);
}

/** The workspace root itself, by the same precedence. */
export function workspaceRoot() {
  const ctx = currentContextOrNull();
  if (ctx) return ctx.workspace;
  return path.resolve(config._workspace || process.cwd());
}
