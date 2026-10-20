// src/agents/budget.js
// Phase 3 — Per-agent token budget enforcement.
// Ensures one runaway agent cannot consume the entire session's step allowance.

/**
 * Create a budget for a multi-agent session.
 * @param {{ total?: number, perRole?: Record<string, number> }} opts
 * @returns {Budget}
 */
export function createBudget(opts = {}) {
  const total    = opts.total ?? Infinity;
  const perRole  = opts.perRole ?? {};
  // Wave D-4: optional USD ceiling unifying step-budget with the cost tracker.
  // 0 (or unset) = unbounded, preserving the prior steps-only behavior.
  const maxDollars = opts.maxDollars && opts.maxDollars > 0 ? opts.maxDollars : 0;
  let   consumed = 0;
  let   dollarsConsumed = 0;
  const roleConsumed = {};

  return {
    /**
     * Check whether a role can take another step. Stops on either the step
     * budget OR the USD ceiling (Wave D-4).
     * @param {string} role
     * @param {number} usedSoFar  steps already used by this role this run
     * @returns {{ ok: boolean, reason?: string }}
     */
    canStep(role, usedSoFar) {
      if (maxDollars > 0 && dollarsConsumed >= maxDollars) {
        return { ok: false, reason: `Session cost ceiling reached ($${dollarsConsumed.toFixed(4)}/$${maxDollars.toFixed(2)})` };
      }
      if (consumed >= total) {
        return { ok: false, reason: `Session budget exhausted (${consumed}/${total} total steps used)` };
      }
      const roleLimit = perRole[role];
      if (roleLimit !== undefined && usedSoFar >= roleLimit) {
        return { ok: false, reason: `Role "${role}" budget exhausted (${usedSoFar}/${roleLimit} steps)` };
      }
      return { ok: true };
    },

    /**
     * Record that a role took one step.
     * @param {string} role
     */
    recordStep(role) {
      consumed++;
      roleConsumed[role] = (roleConsumed[role] ?? 0) + 1;
    },

    /**
     * Record USD spent by a role's run (Wave D-4). The conductor calls this with
     * each specialist's costUsd so the cost ceiling accumulates across agents
     * (each specialist's runLoop resets its own cost session).
     * @param {string} role
     * @param {number} dollars
     */
    recordCost(role, dollars) {
      dollarsConsumed += Number(dollars) || 0;
    },

    /** Return a snapshot of budget state for logging. */
    snapshot() {
      return { total, consumed, remaining: total - consumed, perRole, roleConsumed, maxDollars, dollarsConsumed };
    },
  };
}

/**
 * Default session budget based on agent roles in a pipeline.
 * Total = sum of per-role limits + 20% headroom.
 * @param {Record<string, number>} perRole  — { role: maxSteps }
 * @param {number} [maxDollars]  — optional USD ceiling (Wave D-4); 0 = unbounded
 * @returns {Budget}
 */
export function defaultBudget(perRole, maxDollars = 0) {
  const sum   = Object.values(perRole).reduce((a, b) => a + b, 0);
  const total = Math.ceil(sum * 1.2);
  return createBudget({ total, perRole, maxDollars });
}
