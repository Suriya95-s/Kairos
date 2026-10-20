// src/hitl/gateway.js
// HITL Gateway — determines when agent actions need human approval, blocks until
// approved/denied or timeout, and persists pause/resume state.
// Tasks 4.2 (detection), 4.3 (block+wait+timeout), 4.12 (pause/resume),
//       4.14 (audit log), 4.15 (episodic writes).

import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { workspaceResolve } from '../runtime/workspacePath.js';
import { enqueue, writeResponse, getResponse, removeRequest } from './approvalQueue.js';
import { notify } from './notifier.js';
import { isMcpToolName, getMcpToolEntry } from '../mcp/registry.js';
import { classify as classifyTier, tierGate, atLeast as atLeastTier, tierRank as tierRankOf } from '../trust/tiers.js';
import { getStandingApprovals } from '../trust/approvals.js';
import { getIntegrationRegistry } from '../trust/integrations.js';

// Resolves through the AgentContext when one is active (the daemon runs each
// mission inside its own), falling back to the config singleton for direct CLI
// calls. See src/runtime/workspacePath.js for why this indirection exists.
function resolve(rel) {
  return workspaceResolve(rel);
}

// ── Destructive patterns that always require approval ─────────────────────────
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /rm\s+-[rf]/,
  /rmdir/,
  /DROP\s+TABLE/i,
  /DROP\s+DATABASE/i,
  /TRUNCATE\s+TABLE/i,
  /DELETE\s+FROM/i,
  /format\s+[A-Z]:/i,
  /mkfs/,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
  /shred\s/,
  /wipefs/,
];

const DESTRUCTIVE_TOOLS = new Set(['delete_file', 'run_command']);

/**
 * Load the policy from hitl-policy.json (or return empty if not found).
 */
function loadPolicy() {
  const policyFile = resolve(config.hitlPolicyFile);
  if (!fs.existsSync(policyFile)) return { rules: [] };
  try { return JSON.parse(fs.readFileSync(policyFile, 'utf-8')); }
  catch { return { rules: [] }; }
}

/**
 * Determine whether a tool call requires human approval.
 * Returns { required: bool, reason: string }
 */
export function checkRequiresApproval(tool, args, ctx = {}) {
  // ── 0. Is this capability even switched on? (7.4) ─────────────────
  // Before everything else, including the T3 short-circuit. A blocked
  // capability is DENIED, not queued for approval: asking is how a
  // half-configured email integration gets approved by someone who assumes the
  // system knows what it is doing. There is deliberately no approval prompt
  // that can advance a stage.
  const stageCheck = checkIntegrationStage(tool);
  if (!stageCheck.allowed) {
    return {
      required: true,
      blocked: true,
      tier: classifyTier(tool, args).tier,
      reason: stageCheck.reason,
      grant: 'blocked',
      capability: stageCheck.capability,
      needsStage: stageCheck.needsStage,
    };
  }

  // ── 1. Tier ──────────────────────────────────────────────────────
  // The tier is the floor. Everything below can raise the requirement or
  // satisfy it, but nothing can lower the tier itself.
  // A registered tier (assigned when the MCP server connected) wins over
  // re-deriving one from the name: registration is where a server's own
  // declaration was reconciled against the inferred tier, and redoing that
  // here could disagree with what the registry recorded.
  const registered = isMcpToolName(tool) ? getMcpToolEntry(tool)?.tier : null;
  const derived = classifyTier(tool, args);
  const tier = registered && tierRankOf(registered) > tierRankOf(derived.tier) ? registered : derived.tier;
  const tierReason = tier === registered ? 'registered at connection time' : derived.reason;
  const base = tierGate(tier);

  // ── 2. T3 short-circuits every possible "yes" ────────────────────
  // Checked BEFORE policy, before standing approvals, before an MCP server's
  // own autoApprove flag. Irreversible actions are confirmed every time, and
  // there is deliberately no configuration that turns that off — a single
  // bypass path would be the whole guarantee.
  if (atLeastTier(tier, 'T3')) {
    return { required: true, tier, reason: `${tier}: ${tierReason}`, grant: 'tier' };
  }

  // ── 3. Policy overrides ──────────────────────────────────────────
  const policy = loadPolicy();
  for (const rule of (policy.rules || [])) {
    if (rule.tool && rule.tool !== tool) continue;
    if (rule.command && tool === 'run_command') {
      const cmd = String(args?.command || '');
      if (!cmd.includes(rule.command)) continue;
    }
    if (rule.path && tool !== 'run_command') {
      const p = String(args?.path || '');
      if (!p.startsWith(rule.path)) continue;
    }
    if (rule.require_approval) {
      return { required: true, tier, reason: rule.reason || `Policy: ${rule.tool || tool}`, grant: 'policy' };
    }
    if (rule.auto_approve) {
      // Reachable only for T0–T2, because T3 returned above. A policy file can
      // reduce friction; it cannot remove the irreversibility gate.
      return { required: false, tier, reason: 'policy auto_approve', grant: 'policy' };
    }
  }

  // ── 4. Standing approvals (7.2) ──────────────────────────────────
  if (base.required) {
    try {
      const standing = findStandingApproval(tool, args, ctx);
      if (standing) {
        return { required: false, tier, reason: `standing approval ${standing.id}`, grant: 'standing', standingId: standing.id };
      }
    } catch {
      // A broken approvals store must fail CLOSED: if we cannot tell whether
      // permission was granted, we ask.
    }
  }

  // ── 5. MCP autoApprove — a request, not a decision ───────────────
  // A server declaring its own tools safe is third-party code rating its own
  // danger. Honoured only up to T1; anything with an external effect still
  // needs a human or a standing approval, both of which are recorded.
  if (isMcpToolName(tool) && !base.required) {
    return { required: false, tier, reason: `${tier}: ${tierReason}`, grant: 'tier' };
  }
  if (isMcpToolName(tool)) {
    const entry = getMcpToolEntry(tool);
    if (entry?.autoApprove && !atLeastTier(tier, 'T2')) {
      return { required: false, tier, reason: 'mcp autoApprove (T0/T1 only)', grant: 'policy' };
    }
    return { required: true, tier, reason: `MCP tool "${tool}" (${tier}) requires approval`, grant: 'tier' };
  }

  return {
    required: base.required,
    tier,
    reason: base.required ? `${tier}: ${tierReason}` : '',
    grant: 'tier',
  };
}

/**
 * Consult the integration stage registry.
 *
 * Fails CLOSED for managed capabilities: if the registry cannot be read we
 * cannot tell whether email sending was enabled, and the safe answer to that
 * question is no. Unmanaged tools are unaffected — this layer has no opinion
 * on those, and the tier gate governs them.
 */
function checkIntegrationStage(tool) {
  try {
    return getIntegrationRegistry().check(tool);
  } catch {
    const managed = String(tool || '').includes('__');
    return managed
      ? { allowed: false, capability: null, stage: 'unknown', reason: 'integration registry unreadable — failing closed' }
      : { allowed: true, capability: null, stage: 'n/a', reason: 'not a managed integration' };
  }
}

/**
 * Find a live standing approval. Split out so the lookup can be stubbed and so
 * a failure here is visibly a failure to *find* permission, never to grant it.
 */
function findStandingApproval(tool, args, ctx) {
  const approvals = getStandingApprovals();
  const match = approvals.find(tool, args, { workspace: ctx.workspace ?? null });
  if (match) approvals.recordUse(match.id);
  return match;
}

/**
 * Request human approval for a tool call.
 * Blocks until approved/denied or timeout (default deny on timeout per Q5).
 * @param {string} tool
 * @param {object} args
 * @param {string} thought — agent's rationale
 * @returns {Promise<{approved: boolean, reason: string}>}
 */
export async function requestApproval(tool, args, thought = '') {
  const decision = checkRequiresApproval(tool, args);
  const { required, reason } = decision;
  if (!required) return { approved: true, reason: 'not required' };

  // A blocked capability is refused here and now, and is NEVER enqueued — so
  // there is no pending request for any client to approve. That is the point:
  // the only way through is an explicit stage change by a person.
  if (decision.blocked) {
    appendAudit({
      type: 'capability_blocked',
      tool,
      args: _sanitizeArgs(args),
      capability: decision.capability ?? null,
      needsStage: decision.needsStage ?? null,
      reason,
    });
    const how = decision.needsStage && decision.capability
      ? ` (enable with: kairosd integrations set ${decision.capability} ${decision.needsStage})`
      : '';
    return { approved: false, blocked: true, reason: reason + how };
  }

  const timeoutMs = config.hitlTimeoutMs;
  const id = enqueue(tool, args, reason, timeoutMs);

  // Fire notifiers (non-blocking — failures are caught)
  try {
    await notify({
      type: 'approval_requested',
      id,
      tool,
      args,
      reason,
      thought: thought.slice(0, 200),
      timeoutMs,
    });
  } catch { /* notifier failure must not block the gate */ }

  // Emit event for SSE Live View
  emitEvent({ type: 'approval_requested', id, tool, args: _sanitizeArgs(args), reason, timestamp: Date.now() });

  // Block until response or timeout
  const deadline = Date.now() + timeoutMs;
  const pollMs = config.hitlPollIntervalMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    const resp = getResponse(id);
    if (resp) {
      removeRequest(id);
      const result = { approved: resp.approved, reason: resp.reason || (resp.approved ? 'approved' : 'denied') };
      appendAudit({ type: 'approval_response', id, tool, args: _sanitizeArgs(args), ...result });
      emitEvent({ type: 'approval_response', id, tool, ...result, timestamp: Date.now() });
      // Task 4.15: write episodic event with who="user"
      _writeEpisodicHitlEvent({ type: 'approval', id, tool, approved: result.approved, reason: result.reason });
      return result;
    }
  }

  // Timeout — deny per Q5
  removeRequest(id);
  const timeoutResult = { approved: false, reason: `Timeout after ${timeoutMs / 1000}s — auto-denied` };
  appendAudit({ type: 'approval_timeout', id, tool, args: _sanitizeArgs(args), ...timeoutResult });
  emitEvent({ type: 'approval_timeout', id, tool, ...timeoutResult, timestamp: Date.now() });
  _writeEpisodicHitlEvent({ type: 'approval_timeout', id, tool, approved: false, reason: timeoutResult.reason });
  return timeoutResult;
}

// ── Pause / Resume (Task 4.12) ────────────────────────────────────────────────

function pauseFile() {
  return resolve(path.join(config.hitlDir, 'paused'));
}

export function pause() {
  fs.mkdirSync(resolve(config.hitlDir), { recursive: true });
  fs.writeFileSync(pauseFile(), String(Date.now()));
  appendAudit({ type: 'paused', timestamp: Date.now() });
  emitEvent({ type: 'paused', timestamp: Date.now() });
}

export function resume() {
  if (fs.existsSync(pauseFile())) {
    fs.unlinkSync(pauseFile());
    appendAudit({ type: 'resumed', timestamp: Date.now() });
    emitEvent({ type: 'resumed', timestamp: Date.now() });
  }
}

export function isPaused() {
  return fs.existsSync(pauseFile());
}

/**
 * How long the loop has been paused, in milliseconds.
 * Returns 0 if not paused or if the timestamp cannot be read.
 */
export function pauseAgeMs() {
  const pf = pauseFile();
  if (!fs.existsSync(pf)) return 0;
  try {
    const ts = parseInt(fs.readFileSync(pf, 'utf-8').trim(), 10);
    return Number.isFinite(ts) ? Date.now() - ts : 0;
  } catch { return 0; }
}

// ── Audit Log (Task 4.14) ─────────────────────────────────────────────────────

export function appendAudit(event) {
  try {
    fs.mkdirSync(resolve(config.hitlDir), { recursive: true });
    const line = JSON.stringify({ ...event, _ts: Date.now() }) + '\n';
    fs.appendFileSync(resolve(config.hitlAuditFile), line);
  } catch { /* non-critical */ }
}

// ── SSE Event Bus (Task 4.10 support) ────────────────────────────────────────
// In-process listeners registered by the web-ui server.
const _sseListeners = new Set();

export function addSseListener(fn) { _sseListeners.add(fn); }
export function removeSseListener(fn) { _sseListeners.delete(fn); }

export function emitEvent(event) {
  const payload = JSON.stringify(event);
  for (const fn of _sseListeners) {
    try { fn(payload); } catch { /* don't let one bad listener kill the bus */ }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const _SECRET_ARG_RE = /(^|_|-)(api[-_]?key|key|token|secret|password|passwd|authorization|auth|bearer)($|_|-)/i;

function _sanitizeArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const copy = { ...args };
  // Don't log potentially large content inline
  if (copy.content && String(copy.content).length > 200) {
    copy.content = `[${String(copy.content).length} chars]`;
  }
  // Defense-in-depth: never let a credential-shaped arg leak into the SSE stream
  // or .agent/*.jsonl audit. Redact values of key/token/secret-named fields.
  for (const k of Object.keys(copy)) {
    if (_SECRET_ARG_RE.test(k) && copy[k]) copy[k] = '[REDACTED]';
  }
  return copy;
}

// Exposed for tests — the audit/SSE arg sanitizer (redacts large content + secrets).
export const sanitizeArgsForAudit = _sanitizeArgs;

function _writeEpisodicHitlEvent({ type, id, tool, approved, reason }) {
  if (!config.palaceEnabled) return;
  try {
    // Dynamic import to avoid hard dependency when palace disabled
    import('../palace/session.js').then(({ getPalaceSession }) => {
      const sess = getPalaceSession();
      if (!sess) return;
      sess.store.insert({
        verbatim: `HITL ${type}: ${tool} → ${approved ? 'approved' : 'denied'} (${reason})`,
        domain: 'hitl',
        summary: `${type} id=${id} tool=${tool}`,
        note: reason,
        who: 'user',
        timestamp: Date.now() / 1000,
      });
    }).catch(() => { /* non-critical */ });
  } catch { /* non-critical */ }
}
