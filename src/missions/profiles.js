// src/missions/profiles.js
// Mission profiles — Phase 2 of JARVIS_EVOLUTION_PLAN.md.
//
// WHY THIS EXISTS
// ---------------
// The loop's lifecycle was hardcoded to one shape: a six-stage build pipeline
// that ends by demanding a passing `_smoke_test.py`. That is exactly right for
// "build me a Snake game" and actively wrong for everything else — ask it to
// summarise a repo and `finish` is refused because no smoke test exists. An
// ambient assistant answers questions, runs errands and holds conversations far
// more often than it builds software, so the lifecycle has to be selectable.
//
// A profile bundles the four things that were previously constants:
//   1. which stages exist, in order (empty = no stage machine at all)
//   2. the per-stage tool allowlist and step-budget split
//   3. the per-stage guidance text
//   4. the finish gates — what "done" has to prove
//
// SERIALIZATION CONSTRAINT (important)
// -----------------------------------
// `stageState` is JSON-serialized into checkpoint.json every step. Profiles
// contain functions, so a profile must NEVER be embedded in stageState — only
// its `name` is stored, and consumers re-resolve via getProfile(). Anything
// added here that must survive a resume has to be reachable from the name.

// ── Shared building blocks ───────────────────────────────────────────────────

const STAGE_COMPLETE_TAG = 'stage_status: complete';

const BUILD_STAGES = ['intake', 'discovery', 'planning', 'execution', 'verification', 'finalization'];

const BUILD_BUDGET_RATIOS = {
  intake: 0.05,
  discovery: 0.10,
  planning: 0.10,
  execution: 0.55,
  verification: 0.10,
  finalization: 0.10,
};

const BUILD_TOOL_ALLOWLIST = {
  intake: ['read_file', 'list_dir', 'think', 'write_file', 'save_memory', 'finish'],
  discovery: ['read_file', 'list_dir', 'search_files', 'glob', 'run_command', 'think', 'write_file', 'finish'],
  planning: ['think', 'update_plan', 'todowrite', 'todoread', 'save_memory', 'write_file', 'read_file', 'list_dir', 'run_command', 'finish'],
  execution: null,   // null = no restriction
  verification: ['run_command', 'read_file', 'search_files', 'lsp', 'write_file', 'edit_file', 'think', 'finish'],
  finalization: ['write_file', 'edit_file', 'read_file', 'run_command', 'finish', 'think'],
};

/**
 * Build-profile guidance. Preserved verbatim from the pre-Phase-2 `stages.js`
 * so the build profile is a byte-for-byte behavioural match.
 */
function buildGuidance(stage, step, stageStep) {
  switch (stage) {
    case 'intake':
      return `STAGE: INTAKE (step ${stageStep}, global ${step}). Understand the task. Update .agent/task-contract.md and set "${STAGE_COMPLETE_TAG}" when done.`;
    case 'discovery':
      return `STAGE: DISCOVERY (step ${stageStep}, global ${step}). Ground the task in the repo. Update .agent/discovery-summary.md and set "${STAGE_COMPLETE_TAG}" when done.`;
    case 'planning':
      return `STAGE: PLANNING (step ${stageStep}, global ${step}). Create a concrete plan and .agent/execution-contract.md. Set "${STAGE_COMPLETE_TAG}" when ready for execution. Do NOT summarize prior work or restate the runtime anchor. If runtime status already shows missing workspace artifacts, stop rediscovery and start creating the missing files with concrete tool calls.`;
    case 'execution':
      return `STAGE: EXECUTION (step ${stageStep}, global ${step}). Implement per plan. Avoid task reinterpretation drift.`;
    case 'verification':
      return `STAGE: VERIFICATION (step ${stageStep}, global ${step}). Run checks, collect evidence, and set "${STAGE_COMPLETE_TAG}" in .agent/verification-summary.md.
IMPORTANT — Runtime Smoke Test: You MUST write a file called _smoke_test.py (or _smoke_test.js) in the workspace root and run it. Requirements:
  - Use PACKAGE imports (e.g. "from snake_game.snake import Snake"), NOT "cd package && from snake import..."
  - Instantiate key classes and call their methods
  - NO interactive features (no curses.wrapper, no input(), no GUI)
  - Print "SMOKE OK" at the end
  - Run from workspace root: python3 _smoke_test.py
If the smoke test crashes, read the traceback, fix the bug with edit_file, and re-run until "SMOKE OK" prints.
Only set stage_status: complete AFTER _smoke_test.py prints "SMOKE OK".`;
    case 'finalization':
      return `STAGE: FINALIZATION (step ${stageStep}, global ${step}). Ensure required outputs exist and are non-empty. If any runtime errors remain, fix them with edit_file before calling finish.`;
    default:
      return '';
  }
}

function researchGuidance(stage, step, stageStep) {
  switch (stage) {
    case 'discovery':
      return `STAGE: DISCOVERY (step ${stageStep}, global ${step}). Gather sources. Read what exists, search where needed, and record what you find in .agent/discovery-summary.md with "${STAGE_COMPLETE_TAG}" when you have enough to answer. Do NOT start writing the final answer yet.`;
    case 'execution':
      return `STAGE: EXECUTION (step ${stageStep}, global ${step}). Produce the written deliverable. Cite concrete evidence — file paths, command output, URLs — for every claim. If a claim has no source, say so explicitly rather than asserting it.`;
    case 'finalization':
      return `STAGE: FINALIZATION (step ${stageStep}, global ${step}). Confirm the deliverable exists, is non-empty, and answers the original question. Then finish with a summary of what you found and what remains uncertain.`;
    default:
      return '';
  }
}

function errandGuidance(stage, step, stageStep) {
  switch (stage) {
    case 'execution':
      return `STAGE: EXECUTION (step ${stageStep}, global ${step}). Carry out the requested actions. Take one action at a time and confirm each result before the next. Never claim an action succeeded without a tool result proving it.`;
    case 'finalization':
      return `STAGE: FINALIZATION (step ${stageStep}, global ${step}). Report exactly what was done: every action taken, its outcome, and anything you could NOT do. Do not report intent as outcome.`;
    default:
      return '';
  }
}

// ── Profiles ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} MissionProfile
 * @property {string}   name
 * @property {string}   description
 * @property {string[]} stages            ordered; empty = stage machine disabled
 * @property {Object}   budgetRatios      stage → fraction of maxSteps
 * @property {Object}   toolAllowlist     stage → string[] | null (null = all tools)
 * @property {Function} guidance          (stage, step, stageStep) => string
 * @property {Object}   gates             finish requirements (see below)
 * @property {boolean}  parseTaskContracts  parse locked targets/commands/outputs from task text
 */

/** @type {Record<string, MissionProfile>} */
export const PROFILES = {
  build: {
    name: 'build',
    description: 'Create or modify software. Full six-stage lifecycle, smoke-test gated.',
    stages: BUILD_STAGES,
    budgetRatios: BUILD_BUDGET_RATIOS,
    toolAllowlist: BUILD_TOOL_ALLOWLIST,
    guidance: buildGuidance,
    gates: {
      // Requires a command result containing "SMOKE OK" before finish.
      requireSmokeTest: true,
      // Requires at least one non-.agent/ file to have been created or edited.
      requireFileModifications: true,
      // Enforces parsed output contracts / required-command evidence.
      requireOutputContracts: true,
      // Runs the LLM sandbox verifier (diff + action log + spot checks) on finish.
      requireSandboxVerify: true,
    },
    parseTaskContracts: true,
  },

  research: {
    name: 'research',
    description: 'Investigate and produce a written answer. No smoke test; evidence-gated.',
    stages: ['discovery', 'execution', 'finalization'],
    budgetRatios: { discovery: 0.35, execution: 0.45, finalization: 0.20 },
    toolAllowlist: {
      discovery: ['read_file', 'list_dir', 'search_files', 'glob', 'webfetch', 'websearch', 'run_command', 'think', 'write_file', 'save_memory', 'search_memory', 'finish'],
      execution: ['write_file', 'edit_file', 'read_file', 'search_files', 'glob', 'webfetch', 'websearch', 'think', 'save_memory', 'update_plan', 'finish'],
      finalization: ['read_file', 'write_file', 'edit_file', 'think', 'finish'],
    },
    guidance: researchGuidance,
    gates: {
      // A research answer is not software; demanding a smoke test made these
      // tasks impossible to finish at all.
      requireSmokeTest: false,
      // Still requires a real artifact — the written answer — so the agent
      // cannot "finish" a research task having produced nothing.
      requireFileModifications: true,
      requireOutputContracts: true,
      requireSandboxVerify: true,
    },
    parseTaskContracts: true,
  },

  errand: {
    name: 'errand',
    description: 'Take real-world actions via tools. Gated on actuation receipts, not artifacts.',
    stages: ['execution', 'finalization'],
    budgetRatios: { execution: 0.75, finalization: 0.25 },
    toolAllowlist: {
      execution: null,   // errands need whatever tool the action requires, incl. MCP
      finalization: ['read_file', 'write_file', 'think', 'save_memory', 'finish'],
    },
    guidance: errandGuidance,
    gates: {
      requireSmokeTest: false,
      // An errand's outcome may be entirely external (an email sent, an event
      // created) with no file touched, so an artifact requirement would block
      // legitimately-complete work.
      requireFileModifications: false,
      requireOutputContracts: false,
      requireSandboxVerify: false,
      // Instead: every state-changing tool call must have produced a recorded,
      // successful result. Enforced by the receipts gate in the loop; the
      // ledger it reads is written by the existing command/file tracking.
      requireActuationReceipts: true,
    },
    parseTaskContracts: false,
  },

  converse: {
    name: 'converse',
    description: 'Answer or discuss directly. No stages, no gates — the reflex-tier lifecycle.',
    stages: [],            // stage machine disabled entirely
    budgetRatios: {},
    toolAllowlist: {},
    guidance: () => '',
    gates: {
      requireSmokeTest: false,
      requireFileModifications: false,
      requireOutputContracts: false,
      requireSandboxVerify: false,
    },
    parseTaskContracts: false,
  },
};

export const DEFAULT_PROFILE = 'build';

/**
 * Resolve a profile by name. Unknown names fall back to the default rather than
 * throwing: a bad `--profile` should not strand a run, and a checkpoint written
 * by a newer build must still resume on an older one.
 * @param {string} [name]
 * @returns {MissionProfile}
 */
export function getProfile(name) {
  return PROFILES[String(name || '').toLowerCase()] || PROFILES[DEFAULT_PROFILE];
}

/** @returns {string[]} known profile names */
export function profileNames() {
  return Object.keys(PROFILES);
}

/** True when `name` is a known profile. */
export function isProfile(name) {
  return Object.prototype.hasOwnProperty.call(PROFILES, String(name || '').toLowerCase());
}

// ── Heuristic selection ──────────────────────────────────────────────────────
//
// LLM-free and deterministic, in the same spirit as routing/router.js: scoring
// by weighted keyword match. This is a DEFAULT, not a decision — an explicit
// --profile / config value always wins, and the Phase 4 router will replace
// this with a proper classifier (keeping this as its fast path).

const SIGNALS = {
  build: [
    ['build ', 3], ['implement', 3], ['create a', 2], ['write a program', 3],
    ['refactor', 3], ['fix the bug', 3], ['fix bug', 3], ['add a feature', 3],
    ['unit test', 2], ['make it compile', 3], ['migrate', 2], ['optimize', 2],
    ['app', 1], ['api', 1], ['function', 1], ['class', 1], ['module', 1],
    ['script', 1], ['game', 1], ['website', 1], ['cli', 1], ['bug', 1],
  ],
  research: [
    ['research', 3], ['investigate', 3], ['compare', 3], ['summarize', 3],
    ['summarise', 3], ['analyze', 3], ['analyse', 3], ['explain', 2],
    ['what is', 2], ['how does', 2], ['why does', 2], ['find out', 2],
    ['review the', 2], ['audit', 2], ['document', 2], ['write a report', 3],
    ['pros and cons', 2], ['evaluate', 2], ['look into', 2],
    // Learned live: "I want you to study about ontology" scored 0 everywhere,
    // fell back to `build`, and the smoke-test gate then blocked its finish 52
    // times in a row — the loop burned a week's token quota proving a written
    // study can't print "SMOKE OK". Spoken phrasing favours these verbs.
    ['study', 3], ['learn about', 3], ['read about', 2], ['teach me', 3],
    ['tell me about', 2],
  ],
  errand: [
    ['send ', 3], ['email', 3], ['schedule', 3], ['book ', 3], ['remind me', 3],
    ['add to my calendar', 3], ['calendar', 2], ['message', 2], ['post ', 2],
    ['turn on', 3], ['turn off', 3], ['open the', 2], ['order ', 2],
    ['notify', 2], ['cancel', 2], ['reply to', 3],
    // Kept in step with src/router/classify.js ERRAND_SIGNALS. The two tables
    // drifting apart is a real failure mode: the router says "errand" and the
    // profile selector then runs it under `build`, which demands a smoke test
    // for setting a timer.
    ['set a timer', 4], ['set an alarm', 4], ['timer for', 3], ['alarm for', 3],
  ],
  converse: [
    ['what do you think', 3], ['your opinion', 3], ['let us discuss', 3],
    ['let\'s discuss', 3], ['brainstorm', 2], ['chat about', 3],
    ['talk about', 2], ['advise me', 2], ['help me decide', 2],
  ],
};

/**
 * Pick a profile for a task.
 *
 * @param {string} taskText
 * @param {{ explicit?: string }} [opts] explicit name (flag/config) — always wins
 * @returns {{ name: string, reason: string, scores: Record<string, number> }}
 */
export function selectProfile(taskText, { explicit } = {}) {
  if (explicit && isProfile(explicit)) {
    return { name: String(explicit).toLowerCase(), reason: 'explicit', scores: {} };
  }
  if (explicit) {
    return { name: DEFAULT_PROFILE, reason: `unknown_profile:${explicit}`, scores: {} };
  }

  const text = String(taskText || '').toLowerCase();
  if (!text.trim()) return { name: DEFAULT_PROFILE, reason: 'empty_task', scores: {} };

  // Leading-verb bonus. Task instructions almost always lead with their
  // imperative verb, so a signal at position 0 is far stronger evidence than the
  // same word buried mid-sentence. Without this, "analyze why the build is slow"
  // ties 3-3 — "analyze" (research) against "build" appearing as a NOUN — and
  // falls back to build, which is the wrong lifecycle for a question.
  const LEAD_BONUS = 4;
  const lead = text.replace(/^\s*(please|can you|could you|hey|now)\s+/i, '');

  const scores = {};
  for (const [profile, signals] of Object.entries(SIGNALS)) {
    scores[profile] = signals.reduce((sum, [pattern, weight]) => {
      if (!text.includes(pattern)) return sum;
      return sum + weight + (lead.startsWith(pattern) ? LEAD_BONUS : 0);
    }, 0);
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topName, topScore] = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? 0;

  // No signal at all, or a tie at the top: prefer `build`. It is the most
  // conservative choice — its gates are the strictest, so a misrouted task gets
  // blocked and corrected rather than finishing on weaker evidence than it
  // should have.
  if (topScore === 0) return { name: DEFAULT_PROFILE, reason: 'no_signal', scores };
  if (topScore === runnerUp) return { name: DEFAULT_PROFILE, reason: 'tie', scores };

  return { name: topName, reason: `heuristic:${topScore}`, scores };
}

export default { PROFILES, getProfile, selectProfile, profileNames, isProfile, DEFAULT_PROFILE };
