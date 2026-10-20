// src/trust/tiers.js
// Capability tiers (D6 / 7.1): what a tool can cost you if it is wrong.
//
// The gate this replaces worked from a list of dangerous *patterns* — `rm -rf`,
// `DROP TABLE`, a set of tool names. Pattern lists have a structural problem:
// they are a denylist, so anything nobody thought of is allowed. That is
// survivable while every tool is local and reversible. It stops being
// survivable the moment the agent can send email.
//
// So classification is inverted. Every tool is assigned a tier *at
// registration*, an unknown tool is treated as dangerous rather than safe, and
// the policy file becomes overrides on top of tiers instead of the whole story.
//
//   T0  read-only, local            auto
//   T1  reversible local write      auto + audit
//   T2  reversible external effect  confirm; a standing approval may be granted
//   T3  irreversible or expensive   always confirm; NO standing approval, ever
//
// Two properties are load-bearing and are tested as such:
//
//   1. **Unknown ⇒ T2 at minimum.** A tool nobody classified is a tool nobody
//      thought about, and the safe reading of that is "external effect".
//   2. **T3 can never be auto-approved.** Not by policy, not by a standing
//      approval, not by an MCP server's own `autoApprove` flag. This is checked
//      at every layer that could otherwise say yes, because a single missed
//      path is the whole guarantee.

export const TIERS = Object.freeze(['T0', 'T1', 'T2', 'T3']);

export const TIER_MEANING = Object.freeze({
  T0: 'read-only, local',
  T1: 'reversible local write',
  T2: 'reversible external effect',
  T3: 'irreversible or expensive',
});

/** Above this, no standing approval may ever be granted. */
export const MAX_STANDING_TIER = 'T2';

/** Ordering helper: T0 < T1 < T2 < T3. */
export function tierRank(tier) {
  const i = TIERS.indexOf(tier);
  // An unrecognised tier ranks as the most dangerous, not the least. A typo in
  // a classification table must fail closed.
  return i === -1 ? TIERS.length : i;
}

export function atLeast(tier, floor) { return tierRank(tier) >= tierRank(floor); }
export function maxTier(a, b) { return tierRank(a) >= tierRank(b) ? a : b; }

// ── Built-in tools ──────────────────────────────────────────────────────────
// Every tool this repo ships. Adding a tool without adding it here makes it T2
// by the unknown-tool rule, which is inconvenient and safe — the right way
// round.

export const BUILTIN_TIERS = Object.freeze({
  // T0 — look, don't touch
  read_file: 'T0',
  list_dir: 'T0',
  glob: 'T0',
  search_files: 'T0',
  search_memory: 'T0',
  recall_by_domain: 'T0',
  recall_by_entity: 'T0',
  recall_temporal: 'T0',
  recall_chat_session: 'T0',
  recall_room: 'T0',
  think: 'T0',
  finish: 'T0',

  // T1 — writes inside the workspace, recoverable from git or a checkpoint
  write_file: 'T1',
  edit_file: 'T1',
  patch: 'T1',
  create_dir: 'T1',
  copy_path: 'T1',
  move_path: 'T1',
  save_memory: 'T1',
  update_memory: 'T1',
  create_skill: 'T1',

  // T2 — leaves the machine, or leaves the workspace
  webfetch: 'T2',
  fetch_url: 'T2',

  // T3 — cannot be taken back
  delete_path: 'T3',
  delete_file: 'T3',

  // Classified by its arguments — see classify().
  run_command: 'T1',
});

// ── Argument-sensitive escalation ───────────────────────────────────────────
// `run_command` is the whole shell. Its tier is a property of the command, not
// of the tool, and the default (T1) only holds for commands that do not match
// anything below.

const COMMAND_ESCALATIONS = Object.freeze([
  // T3 — irreversible
  { tier: 'T3', why: 'recursive delete', re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i },
  { tier: 'T3', why: 'recursive delete', re: /\brmdir\b|\bshred\b|\bwipefs\b|\bmkfs\b/i },
  { tier: 'T3', why: 'raw device write', re: /\bdd\s+if=|>\s*\/dev\/(sd|nvme|disk)/i },
  { tier: 'T3', why: 'drive format', re: /\bformat\s+[a-z]:/i },
  { tier: 'T3', why: 'destructive SQL', re: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i },
  { tier: 'T3', why: 'publishes a release', re: /\bnpm\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b/i },
  { tier: 'T3', why: 'rewrites shared history', re: /\bgit\s+push\b.*(--force|-f)\b|\bgit\s+push\s+--delete\b/i },
  { tier: 'T3', why: 'discards uncommitted work', re: /\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f/i },
  { tier: 'T3', why: 'spends money', re: /\b(purchase|checkout|pay|buy)\b.*\b(api|order)\b|\bstripe\b.*\bcharge\b/i },
  { tier: 'T3', why: 'terraform apply/destroy', re: /\bterraform\s+(apply|destroy)\b/i },
  { tier: 'T3', why: 'kubernetes delete', re: /\bkubectl\s+delete\b/i },

  // T2 — external, but recoverable
  { tier: 'T2', why: 'pushes to a remote', re: /\bgit\s+push\b/i },
  { tier: 'T2', why: 'sends mail', re: /\b(sendmail|mailx|mutt|msmtp)\b/i },
  { tier: 'T2', why: 'network request', re: /\b(curl|wget|http|https):?\b/i },
  { tier: 'T2', why: 'installs software', re: /\b(npm|pnpm|yarn|pip|pip3|apt|apt-get|brew|choco)\s+(install|add|i)\b/i },
  { tier: 'T2', why: 'deploys', re: /\b(deploy|ansible-playbook|helm\s+(install|upgrade))\b/i },
  { tier: 'T2', why: 'changes system state', re: /\b(systemctl|service|launchctl|schtasks)\b/i },
]);

// ── MCP tools ───────────────────────────────────────────────────────────────
// Third-party code, named by its server. Classification is by verb, because
// that is the only thing reliably present in an MCP tool name, and the default
// is deliberately high.

const MCP_VERB_TIERS = Object.freeze([
  { tier: 'T3', why: 'deletes', re: /(^|_)(delete|remove|destroy|purge|drop|wipe)(_|$)/i },
  { tier: 'T3', why: 'spends money', re: /(^|_)(purchase|buy|pay|charge|order|checkout|refund)(_|$)/i },
  { tier: 'T3', why: 'publishes irreversibly', re: /(^|_)(publish|broadcast|post_public|tweet|deploy)(_|$)/i },
  { tier: 'T3', why: 'mass communication', re: /(^|_)(send_all|mass_|bulk_)/i },

  { tier: 'T2', why: 'sends a message', re: /(^|_)(send|email|mail|message|notify|sms|call)(_|$)/i },
  { tier: 'T2', why: 'creates external state', re: /(^|_)(create|add|schedule|book|invite|update|edit|set|write|move)(_|$)/i },

  { tier: 'T0', why: 'reads', re: /(^|_)(get|list|read|search|find|query|fetch|show|describe)(_|$)/i },
]);

/**
 * The tier of a tool call.
 *
 * @param {string} tool
 * @param {object} [args]
 * @param {object} [opts]
 * @param {object} [opts.registry]  extra name → tier entries (MCP registration)
 * @returns {{tier: string, reason: string, source: string}}
 */
export function classify(tool, args = {}, { registry = null } = {}) {
  const name = String(tool || '');
  if (!name) return { tier: 'T3', reason: 'unnamed tool', source: 'default' };

  // An explicit registration always wins — that is what registration is for.
  if (registry && registry[name]) {
    return { tier: registry[name], reason: 'registered', source: 'registry' };
  }

  if (name.includes('__')) return classifyMcp(name);

  const base = BUILTIN_TIERS[name];

  if (name === 'run_command') {
    const cmd = String(args?.command ?? args?.cmd ?? '');
    for (const rule of COMMAND_ESCALATIONS) {
      if (rule.re.test(cmd)) {
        return { tier: rule.tier, reason: `${rule.why}: ${cmd.slice(0, 80)}`, source: 'command' };
      }
    }
    // A shell command nobody recognised is not obviously safe. T1 keeps normal
    // development (`npm test`, `ls`, `node script.js`) unblocked, which is the
    // deliberate trade — the escalation list above is what catches the rest,
    // and MCP/network reach is covered by its own tools.
    return { tier: 'T1', reason: 'shell command with no escalation match', source: 'command' };
  }

  if (base) return { tier: base, reason: TIER_MEANING[base], source: 'builtin' };

  // Rule 1: unknown means unconsidered, and unconsidered means gated.
  return {
    tier: 'T2',
    reason: `"${name}" is not classified — treated as an external effect until it is`,
    source: 'unknown',
  };
}

function classifyMcp(name) {
  // Match against the tool part, after the server prefix: a server called
  // `delete-me` must not make every one of its tools T3.
  const toolPart = name.split('__').slice(1).join('__') || name;
  for (const rule of MCP_VERB_TIERS) {
    if (rule.re.test(toolPart)) {
      return { tier: rule.tier, reason: `MCP tool ${rule.why}`, source: 'mcp-verb' };
    }
  }
  return { tier: 'T2', reason: 'MCP tool with an unrecognised verb', source: 'mcp-default' };
}

/**
 * May this tier ever be granted a standing approval?
 *
 * The single question every standing-approval path must ask. T3 is excluded by
 * design: "always allow" and "cannot be taken back" must never be true of the
 * same action.
 */
export function canGrantStanding(tier) {
  return !atLeast(tier, 'T3');
}

/**
 * Default gate for a tier, before policy or standing approvals are consulted.
 * @returns {{required: boolean, reason: string, audit: boolean}}
 */
export function tierGate(tier) {
  switch (tier) {
    case 'T0': return { required: false, audit: false, reason: 'read-only' };
    case 'T1': return { required: false, audit: true, reason: 'reversible local write' };
    case 'T2': return { required: true, audit: true, reason: 'external effect — confirm' };
    default:   return { required: true, audit: true, reason: 'irreversible — always confirm' };
  }
}

/**
 * Register tier classifications for tools discovered at runtime (MCP servers).
 *
 * A server may declare its own tiers, but only *upward*: a server cannot
 * declare its `delete_everything` tool to be T0. Trusting third-party code to
 * rate its own danger is exactly the hole this phase exists to close.
 */
export function buildRegistry(declarations = {}) {
  const out = {};
  for (const [name, declared] of Object.entries(declarations)) {
    const inferred = classify(name).tier;
    const wanted = TIERS.includes(declared) ? declared : inferred;
    out[name] = maxTier(inferred, wanted);
  }
  return out;
}
