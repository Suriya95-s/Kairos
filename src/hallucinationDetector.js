// src/hallucinationDetector.js
// Heuristic detection of hallucinated tool results (Phase 0.3).
// A hallucination is when the LLM's action description contradicts ground-truth
// evidence from tool execution — e.g., claiming a command passed when exit code ≠ 0,
// or claiming a file exists when the filesystem has no record of it.
//
// These are cheap, fast checks run after every tool call. They never block execution —
// they annotate the trace with hallucination_detected: true so downstream learning
// and the compaction anchor can account for them.

/**
 * Check for exit-code mismatch: the LLM described success but the tool reported failure,
 * or vice versa.
 *
 * @param {string} actionDescription - The LLM's description of what it expected.
 * @param {string} toolResult - The actual tool output string.
 * @param {boolean} toolError - Whether the tool flagged an error.
 * @returns {{ detected: boolean, reason: string }}
 */
export function detectExitCodeMismatch(actionDescription, toolResult, toolError) {
  if (!toolError) return { detected: false, reason: '' };

  const desc = String(actionDescription || '').toLowerCase();
  const claimsSuccess =
    /\b(success|passed|works|working|fixed|completed|done|ok)\b/.test(desc) &&
    !/\b(fail|error|broken|crash|wrong)\b/.test(desc);

  if (claimsSuccess) {
    return {
      detected: true,
      reason: `Exit-code mismatch: LLM described success ("${desc.slice(0, 80)}") but tool returned an error`,
    };
  }
  return { detected: false, reason: '' };
}

/**
 * Check for missing-file hallucination: the LLM claimed to have created or written a file
 * but the file path does not appear in the tool result or workspace snapshot keys.
 *
 * @param {string} tool - Tool name.
 * @param {Object} args - Tool arguments.
 * @param {string} toolResult - Raw tool output.
 * @param {boolean} toolError - Whether the tool flagged an error.
 * @param {Object} workspaceSnapshot - Map of path → metadata at session start.
 * @returns {{ detected: boolean, reason: string }}
 */
export function detectMissingFileClaim(tool, args, toolResult, toolError, workspaceSnapshot) {
  if (toolError) return { detected: false, reason: '' };
  if (!['write_file', 'edit_file', 'patch'].includes(tool)) return { detected: false, reason: '' };

  const claimedPath = String(args?.path || '');
  if (!claimedPath) return { detected: false, reason: '' };

  // If the tool result contains an explicit error about the path, it's not really a hallucination —
  // it's a real failure. Only flag when the LLM thinks it succeeded but nothing changed.
  const resultLower = String(toolResult || '').toLowerCase();
  const resultIndicatesFailure =
    resultLower.includes('error') ||
    resultLower.includes('fail') ||
    resultLower.includes('no such file') ||
    resultLower.includes('permission denied');

  if (resultIndicatesFailure) return { detected: false, reason: '' };

  // If the workspace snapshot is available and the path is not in it, it should have been
  // created by this tool call. We can't verify post-write without re-reading the FS, so
  // we only flag if the tool returned empty output for a write operation (strong signal).
  const emptyResult = String(toolResult || '').trim().length < 5;
  if (emptyResult) {
    return {
      detected: true,
      reason: `Missing-file claim: ${tool} on "${claimedPath}" returned near-empty output — write may not have occurred`,
    };
  }

  return { detected: false, reason: '' };
}

/**
 * Check for self-contradicting action: the LLM re-ran a command it just ran with the
 * same arguments and got the same result, but described it as "trying something different".
 *
 * @param {string} tool - Tool name.
 * @param {Object} args - Tool arguments.
 * @param {string} previousCommand - The last command run (if tool is run_command).
 * @param {string} actionDescription - The LLM's description.
 * @returns {{ detected: boolean, reason: string }}
 */
export function detectRepeatedClaimAsDifferent(tool, args, previousCommand, actionDescription) {
  if (tool !== 'run_command') return { detected: false, reason: '' };

  const currentCommand = String(args?.command || '').trim();
  const prev = String(previousCommand || '').trim();
  if (!currentCommand || !prev || currentCommand !== prev) return { detected: false, reason: '' };

  const desc = String(actionDescription || '').toLowerCase();
  const claimsDifferent =
    /\b(different|alternative|another|new approach|instead|change|modified)\b/.test(desc);

  if (claimsDifferent) {
    return {
      detected: true,
      reason: `Repeated-command hallucination: LLM claimed a "different" approach but ran the identical command: "${currentCommand.slice(0, 80)}"`,
    };
  }
  return { detected: false, reason: '' };
}

/**
 * Run all hallucination checks and return a combined result.
 *
 * @param {Object} params
 * @param {string} params.tool
 * @param {Object} params.args
 * @param {string} params.toolResult
 * @param {boolean} params.toolError
 * @param {string} params.actionDescription
 * @param {string} params.previousCommand
 * @param {Object} params.workspaceSnapshot
 * @returns {{ hallucination_detected: boolean, reasons: string[] }}
 */
export function detectHallucination({
  tool,
  args,
  toolResult,
  toolError,
  actionDescription,
  previousCommand,
  workspaceSnapshot,
}) {
  const checks = [
    detectExitCodeMismatch(actionDescription, toolResult, toolError),
    detectMissingFileClaim(tool, args, toolResult, toolError, workspaceSnapshot),
    detectRepeatedClaimAsDifferent(tool, args, previousCommand, actionDescription),
  ];

  const triggered = checks.filter((c) => c.detected);
  return {
    hallucination_detected: triggered.length > 0,
    reasons: triggered.map((c) => c.reason),
  };
}
