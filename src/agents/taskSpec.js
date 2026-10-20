// src/agents/taskSpec.js
// Phase 3 — Conductor mini-language: parse/format sub-task specifications.
// The conductor emits a YAML-ish spec that agentRunner uses to dispatch specialists.
//
// Format (within a ```taskspec block):
//   - role: scout
//     task: "Map the project structure and identify existing test files."
//     maxSteps: 10
//   - role: planner
//     task: "Create a structured plan.md for adding a REST API."
//     dependsOn: [scout]

/**
 * @typedef {{ role: string, task: string, maxSteps?: number, dependsOn?: string[] }} AgentAssignment
 */

/**
 * Parse a taskSpec from conductor output text.
 * Looks for a ```taskspec ... ``` block; falls back to YAML-ish list parsing.
 *
 * @param {string} text
 * @returns {AgentAssignment[]}
 */
export function parseTaskSpec(text) {
  // Extract ```taskspec block
  const blockMatch = text.match(/```(?:taskspec|yaml)\s*([\s\S]*?)```/i);
  const raw = blockMatch ? blockMatch[1] : text;

  const assignments = [];
  // Split on lines that start a new role entry: "- role:" or "role:"
  const entries = raw.split(/\n(?=\s*-?\s*role:)/i);

  for (const entry of entries) {
    const roleMatch   = entry.match(/role:\s*["']?(\w+)["']?/i);
    const taskMatch   = entry.match(/task:\s*["'](.+?)["']|task:\s*>?\s*\n?([\s\S]+?)(?=\n\w|\n-|$)/i);
    const stepsMatch  = entry.match(/maxSteps:\s*(\d+)/i);
    const depsMatch   = entry.match(/dependsOn:\s*\[([^\]]*)\]/i);

    if (!roleMatch) continue;

    const role = roleMatch[1].toLowerCase();
    const task = (taskMatch?.[1] || taskMatch?.[2] || '').trim().replace(/^["']|["']$/g, '');
    if (!task) continue;

    const maxSteps = stepsMatch ? parseInt(stepsMatch[1], 10) : undefined;
    const dependsOn = depsMatch
      ? depsMatch[1].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean)
      : [];

    assignments.push({ role, task, ...(maxSteps ? { maxSteps } : {}), ...(dependsOn.length ? { dependsOn } : {}) });
  }

  return assignments;
}

/**
 * Format an array of AgentAssignments into a taskspec block (for logging / conductor output).
 * @param {AgentAssignment[]} assignments
 * @returns {string}
 */
export function formatTaskSpec(assignments) {
  const lines = assignments.map(a => {
    const parts = [
      `- role: ${a.role}`,
      `  task: "${a.task.replace(/"/g, "'")}"`,
    ];
    if (a.maxSteps) parts.push(`  maxSteps: ${a.maxSteps}`);
    if (a.dependsOn?.length) parts.push(`  dependsOn: [${a.dependsOn.join(', ')}]`);
    return parts.join('\n');
  });
  return '```taskspec\n' + lines.join('\n') + '\n```';
}

/**
 * Build a default task decomposition for a task when the conductor doesn't emit a spec.
 * Uses the standard Scout → Planner → Coder → Reviewer → Archivist pipeline.
 * @param {string} task
 * @returns {AgentAssignment[]}
 */
export function defaultDecomposition(task) {
  return [
    { role: 'scout',    task: `Explore the workspace and map what already exists for: ${task.slice(0, 200)}` },
    { role: 'planner',  task: `Create a structured plan.md for: ${task.slice(0, 200)}`, dependsOn: ['scout'] },
    { role: 'coder',    task: `Implement the plan for: ${task.slice(0, 200)}`,          dependsOn: ['planner'] },
    { role: 'reviewer', task: `Verify the implementation for: ${task.slice(0, 200)}`,   dependsOn: ['coder'] },
    { role: 'archivist', task: `Finalize and archive results for: ${task.slice(0, 200)}`, dependsOn: ['reviewer'] },
  ];
}
