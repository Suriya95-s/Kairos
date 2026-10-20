// advanced-agent-loop/src/skills.js
// Skill system supporting:
//   1. Legacy executable markdown skills in .agent/skills/*.md
//   2. Standard SKILL.md directory skills installed by skills.sh in project skill dirs

import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import vm from 'node:vm';
import logger from './logger.js';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import config from './config.js';
import { getWorkspace } from './state.js';

const nodeRequire = createRequire(import.meta.url);

// Skill code (model-authored, possibly influenced by untrusted task input) must
// NOT inherit the agent's secrets. Any skill can reach a shell via execSync, so
// passing the raw process.env would hand it AGENT_API_KEY / OPENAI_API_KEY / etc.
// Strip credential-like vars and the agent's own AGENT_* config; keep what a
// normal CLI needs to function (PATH, HOME, locale, TMPDIR, TERM).
const SECRET_KEY_RE = /(API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|_KEY$|SESSION)/i;
const SECRET_PREFIX_RE = /^(AGENT_|OPENAI_|ANTHROPIC_|AWS_|GCP_|GOOGLE_|AZURE_|HF_|HUGGINGFACE_|GITHUB_|GH_|NPM_|SLACK_)/i;
function scrubbedEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_PREFIX_RE.test(k) || SECRET_KEY_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// ── Skill trust tiers (Wave B) ───────────────────────────────────────────────
// A skill declares a trust tier (default `semi-trusted`). The tier decides both
// which environment the skill's child/vm/command process receives and which
// capabilities it is handed:
//   trusted       — full process.env. For skills you wrote and audited.
//   semi-trusted  — scrubbedEnv() (secrets stripped). The default; unchanged A0
//                   behavior for model-authored skills.
//   sandboxed     — minimalEnv() only, AND no shell access (execSync withheld).
//                   For skills running untrusted-influenced input.
const VALID_TRUST_TIERS = new Set(['trusted', 'semi-trusted', 'sandboxed']);
const MINIMAL_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'TZ', 'SHELL', 'USER'];

function minimalEnv() {
  const out = {};
  for (const k of MINIMAL_ENV_KEYS) {
    if (process.env[k] != null) out[k] = process.env[k];
  }
  return out;
}

/** Resolve the environment object handed to a skill of the given trust tier. */
export function envForTier(tier) {
  if (tier === 'trusted') return { ...process.env };
  if (tier === 'sandboxed') return minimalEnv();
  return scrubbedEnv(); // semi-trusted (default)
}

/**
 * Read a skill's declared trust tier from its markdown. Supports a `## Trust`
 * section or an inline `Trust: <tier>` / `trust: <tier>` line. Unknown or
 * missing values fall back to the safe default, `semi-trusted`.
 */
export function parseTrustTier(content) {
  const text = String(content || '');
  let m = text.match(/^\s*##\s+Trust\s*\n\s*([a-z-]+)/im);
  if (!m) m = text.match(/^[ \t]*trust:[ \t]*([a-z-]+)[ \t]*$/im);
  const tier = m ? m[1].toLowerCase() : 'semi-trusted';
  return VALID_TRUST_TIERS.has(tier) ? tier : 'semi-trusted';
}

/** @type {Map<string, any>} */
const loadedToolSkills = new Map();
/** @type {Map<string, any>} */
const loadedReferenceSkills = new Map();

const DEFAULT_PROJECT_SKILL_DIRS = [
  'skills',
  '.agents/skills',
  config.skillsDir,
  '.claude/skills',
];

function sanitizeSkillSlug(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9_/-]+/g, '_');
}

function tokenize(text) {
  return [...new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^\w./:-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && token.length <= 32)
  )];
}

function scoreSkillRelevance(skill, text) {
  const haystackTokens = new Set(tokenize(text));
  if (haystackTokens.size === 0) return 0;
  const skillTokens = tokenize([
    skill.name,
    skill.description,
    skill.tags?.join(' '),
    skill.sourceHint || '',
  ].join(' '));
  let hits = 0;
  for (const token of skillTokens) {
    if (haystackTokens.has(token)) hits++;
  }
  return hits / Math.max(1, Math.min(skillTokens.length, 12));
}

function parseFrontmatter(content) {
  const match = String(content || '').match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { metadata: {}, body: String(content || '') };

  const metadata = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    metadata[key.trim()] = value.trim().replace(/^["']|["']$/g, '');
  }
  return {
    metadata,
    body: String(content || '').slice(match[0].length),
  };
}

function getProjectSkillDirs() {
  const envDirs = String(process.env.AGENT_SKILL_DIRS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const relativeDirs = [...new Set([...DEFAULT_PROJECT_SKILL_DIRS, ...envDirs])];
  return relativeDirs.map((relPath) => path.join(getWorkspace(), relPath));
}

function classifySkillSource(filePath) {
  const relative = path.relative(getWorkspace(), filePath).replace(/\\/g, '/');
  if (relative.startsWith('skills/')) return 'repo-skill';
  if (relative.startsWith('.agents/skills/')) return 'skills.sh-project';
  if (relative.startsWith('.agent/skills/')) return 'agent-created';
  if (relative.startsWith('.claude/skills/')) return 'claude-project';
  return 'reference';
}

function walkSkillFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name === 'SKILL.md')) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function parseParameters(content) {
  const paramSection = content.match(/##\s+Parameters\s*\n([\s\S]*?)(?=\n##|\n$)/);
  if (!paramSection) return { type: 'object', properties: {}, required: [] };

  const properties = {};
  const required = [];
  for (const line of paramSection[1].split('\n')) {
    const match = line.match(/^[-*]\s+(\w+):\s*(\w+)\s*[—–-]\s*(.+)/);
    if (!match) continue;
    const [, paramName, paramType, paramDesc] = match;
    properties[paramName] = {
      type: paramType.toLowerCase() === 'number' ? 'number'
        : paramType.toLowerCase() === 'boolean' ? 'boolean'
        : 'string',
      description: paramDesc.trim(),
    };
    if (line.toLowerCase().includes('(required)')) {
      required.push(paramName);
    }
  }

  return { type: 'object', properties, required };
}

// ── Skill execution isolation ───────────────────────────────────────────────
// Skill code is model-authored (and may be influenced by untrusted task input),
// so it runs in a SEPARATE OS process via `node -e`. This protects the agent's
// main process from process.exit(), runaway loops (killed by the child timeout),
// uncaught exceptions, and OOM in skill code.
//
// SECURITY NOTE: node:vm is NOT a hard security boundary — code inside the
// context can still reach the host realm (e.g. `this.constructor.constructor`)
// and from there `process`/`require`/`child_process`. Running in a child process
// contains the blast radius to that throwaway process (it shares the same
// filesystem/credentials as the agent), but does not make hostile skill code
// safe. Treat installed skills as semi-trusted code, gated by skills-lock.json.
//
// The in-process vm path (`_runInVm`) is a LAST-RESORT fallback for environments
// where spawning a child fails (e.g. some sandboxed CI); it offers no
// crash/exit isolation, so the child path is strongly preferred.

const CHILD_RUNNER = `
(function () {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const { execSync } = require('node:child_process');

  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf-8')); }
  catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: 'bad payload: ' + e.message })); return; }

  const { code, args, workspace, skillName, allowExec } = payload;
  const ALLOWED = new Set(['path', 'url', 'querystring', 'crypto', 'util', 'string_decoder']);

  function safeResolve(rel) {
    const abs = path.resolve(workspace, rel);
    if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
      throw new Error('Path resolves outside workspace: ' + rel);
    }
    return abs;
  }

  const sandbox = {
    args,
    workspace,
    require(name) {
      if (!ALLOWED.has(name)) throw new Error('Module not allowed: ' + name);
      return require(name);
    },
    readFile: (rel) => { const a = safeResolve(rel); return fs.existsSync(a) ? fs.readFileSync(a, 'utf-8') : null; },
    writeFile: (rel, content) => { const a = safeResolve(rel); fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, content, 'utf-8'); },
    JSON,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    result: undefined,
  };

  // 'sandboxed' tier withholds shell access entirely (allowExec=false): execSync
  // is simply not present in the context, so any use throws a ReferenceError.
  if (allowExec) {
    sandbox.execSync = (cmd, opts = {}) => execSync(cmd, { cwd: workspace, encoding: 'utf-8', timeout: 30000, maxBuffer: 5*1024*1024, ...opts });
  }

  try {
    const ctx = vm.createContext(sandbox);
    const wrapped = '(function(){\\n' + code + '\\n})()';
    const result = vm.runInContext(wrapped, ctx, { timeout: 30000, displayErrors: true });
    process.stdout.write(JSON.stringify({ ok: true, result: String(result ?? ('Skill "' + skillName + '" executed successfully.')) }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
  }
})();
`;

function buildSkillHandler(code, skillName, trust = 'semi-trusted') {
  return (args) => {
    const workspace = getWorkspace();
    try {
      // Preferred path: real child process — gives crash/exit/timeout isolation.
      return _runInChildProcess({ code, args, workspace, skillName, trust });
    } catch (err) {
      // Child spawn unavailable (rare) — last-resort in-process vm.
      logger.warn(`[skills] child-process isolation unavailable for "${skillName}" (${err.message}); falling back to in-process vm`);
      return _runInVm(code, args, workspace, skillName, trust);
    }
  };
}

function _runInChildProcess({ code, args, workspace, skillName, trust = 'semi-trusted' }) {
  // 'sandboxed' tier gets neither secrets nor shell access.
  const allowExec = trust !== 'sandboxed';
  const input = JSON.stringify({ code, args, workspace, skillName, allowExec });
  // `node -e` reads the payload from stdin; the child runs with cwd=workspace so
  // we never mutate the parent process's cwd. A wall-clock timeout kills runaways.
  const out = execFileSync(process.execPath, ['-e', CHILD_RUNNER], {
    input,
    cwd: workspace,
    encoding: 'utf-8',
    timeout: 35000,
    maxBuffer: 5 * 1024 * 1024,
    // Tier-scoped env propagates to every execSync the skill runs in the child.
    env: envForTier(trust),
  });
  let parsed;
  try { parsed = JSON.parse(out); }
  catch { return `Skill "${skillName}" produced no parseable result.`; }
  return parsed.ok ? String(parsed.result) : `Skill "${skillName}" error: ${parsed.error}`;
}

function _runInVm(code, args, workspace, skillName, trust = 'semi-trusted') {
  try {
    const tierEnv = envForTier(trust);
    const allowExec = trust !== 'sandboxed';
    const ALLOWED = new Set(['path', 'url', 'querystring', 'crypto', 'util', 'string_decoder']);
    const restrictedRequire = (name) => {
      if (!ALLOWED.has(name)) throw new Error(`Module "${name}" is not allowed in skills.`);
      return nodeRequire(name);
    };
    const safeResolve = (relPath) => {
      const abs = path.resolve(workspace, relPath);
      if (abs !== workspace && !abs.startsWith(workspace + path.sep)) throw new Error(`Path resolves outside workspace.`);
      return abs;
    };
    const sandbox = {
      args,
      workspace,
      require: restrictedRequire,
      readFile: (rel) => { const a = safeResolve(rel); return fs.existsSync(a) ? fs.readFileSync(a, 'utf-8') : null; },
      writeFile: (rel, content) => { const a = safeResolve(rel); fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, content, 'utf-8'); },
      JSON,
      console: { log: () => {}, warn: () => {}, error: () => {} },
      result: undefined,
    };
    // 'sandboxed' tier withholds execSync entirely; others get a tier-scoped env.
    if (allowExec) {
      sandbox.execSync = (cmd, opts = {}) => execSync(cmd, { cwd: workspace, encoding: 'utf-8', timeout: 30000, maxBuffer: 5*1024*1024, ...opts, env: { ...tierEnv, ...(opts.env || {}) } });
    }
    const context = vm.createContext(sandbox);
    const wrapped = `(function(){\n${code}\n})()`;
    // No process.chdir here: it mutates global cwd and would race with the main
    // loop. The sandbox's execSync/readFile/writeFile already scope to `workspace`.
    const result = vm.runInContext(wrapped, context, { timeout: 30000, displayErrors: true });
    return String(result ?? `Skill "${skillName}" executed successfully.`);
  } catch (err) {
    return `Skill "${skillName}" error: ${err.message}`;
  }
}

// ── Task 6.4: skills-lock.json validation ────────────────────────────────────

/**
 * Validate installed skills against skills-lock.json hashes.
 * Logs a warning for any skill whose content hash has changed.
 * @returns {{ valid: string[], tampered: string[] }}
 */
export function validateSkillLock() {
  const lockPath = path.resolve(getWorkspace(), 'skills-lock.json');
  if (!fs.existsSync(lockPath)) return { valid: [], tampered: [] };
  let lock;
  try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); }
  catch { return { valid: [], tampered: [] }; }

  const skillDirs = getProjectSkillDirs();
  const valid = [];
  const tampered = [];

  for (const [name, entry] of Object.entries(lock.skills || {})) {
    const expectedHash = entry.computedHash;
    if (!expectedHash) continue;

    // Find the skill file across all skill dirs
    let skillContent = null;
    for (const dir of skillDirs) {
      const p1 = path.join(dir, name, 'SKILL.md');
      const p2 = path.join(dir, `${name}.md`);
      if (fs.existsSync(p1)) { skillContent = fs.readFileSync(p1, 'utf-8'); break; }
      if (fs.existsSync(p2)) { skillContent = fs.readFileSync(p2, 'utf-8'); break; }
    }

    if (!skillContent) continue; // skill not installed — skip

    const actualHash = createHash('sha256').update(skillContent, 'utf-8').digest('hex');
    if (actualHash !== expectedHash) {
      process.stderr.write(`[skills] WARNING: skill "${name}" hash mismatch — expected ${expectedHash.slice(0,12)}… got ${actualHash.slice(0,12)}…\n`);
      tampered.push(name);
    } else {
      valid.push(name);
    }
  }

  return { valid, tampered };
}

function buildCommandHandler(cmdTemplate, skillName, trust = 'semi-trusted') {
  return (args) => {
    try {
      let cmd = cmdTemplate;
      for (const [key, value] of Object.entries(args || {})) {
        const str = String(value);
        // {{key}} values are interpolated raw into a shell string, so reject any
        // shell metacharacter that would let a parameter break out of its slot
        // and inject additional commands.
        if (/[;&|`$(){}<>\n\r\\"'*?~!#]/.test(str)) {
          return `Skill "${skillName}" command error: parameter "${key}" contains disallowed shell metacharacters.`;
        }
        cmd = cmd.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), str);
      }
      const output = execSync(cmd, {
        cwd: getWorkspace(),
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 5 * 1024 * 1024,
        env: envForTier(trust),
      });
      return output || 'Command executed successfully (no output).';
    } catch (err) {
      return `Skill "${skillName}" command error: ${err.message}\n${(err.stdout || '') + (err.stderr || '')}`;
    }
  };
}

function parseLegacyToolSkill(content, filePath) {
  const nameMatch = content.match(/^#\s+Skill:\s*(.+)/m);
  if (!nameMatch) return null;
  const name = sanitizeSkillSlug(nameMatch[1]);
  const descMatch = content.match(/##\s+Description\s*\n([\s\S]*?)(?=\n##|\n$)/);
  const description = descMatch ? descMatch[1].trim() : `Custom skill: ${name}`;
  const params = parseParameters(content);
  const trust = parseTrustTier(content);
  const implMatch = content.match(/##\s+Implementation\s*\n[\s\S]*?```(?:javascript|js)\s*\n([\s\S]*?)```/);
  const cmdMatch = content.match(/##\s+Command\s*\n[\s\S]*?```(?:bash|sh)?\s*\n([\s\S]*?)```/);
  const handler = implMatch
    ? buildSkillHandler(implMatch[1].trim(), name, trust)
    : cmdMatch
      ? buildCommandHandler(cmdMatch[1].trim(), name, trust)
      : (_args) => `Skill "${name}" loaded. Description: ${description}\nUse this knowledge to complete your task.`;

  return {
    kind: 'tool',
    name: `skill_${name}`,
    description,
    parameters: params,
    handler,
    trust,
    source: classifySkillSource(filePath),
    filePath,
    rawContent: content,
    sourceHint: path.basename(filePath),
  };
}

function parseStandardSkill(content, filePath) {
  const { metadata, body } = parseFrontmatter(content);
  const slug = sanitizeSkillSlug(
    metadata.name ||
    path.basename(path.dirname(filePath)) ||
    path.basename(filePath, '.md')
  );
  const description = metadata.description || metadata.summary || body.split('\n').find(Boolean) || slug;
  const tags = String(metadata.tags || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const supportingFiles = fs.readdirSync(path.dirname(filePath))
    .filter((entry) => entry !== path.basename(filePath))
    .slice(0, 8);

  return {
    kind: 'reference',
    name: slug,
    description: String(description).trim(),
    filePath,
    rawContent: content,
    body: body.trim(),
    tags,
    supportingFiles,
    source: classifySkillSource(filePath),
    sourceHint: path.relative(getWorkspace(), path.dirname(filePath)),
  };
}

function parseSkillFile(content, filePath) {
  if (/#\s+Skill:/m.test(content)) {
    return parseLegacyToolSkill(content, filePath);
  }
  if (path.basename(filePath).toLowerCase() === 'skill.md' || /^---\n[\s\S]*?\n---/m.test(content)) {
    return parseStandardSkill(content, filePath);
  }
  return null;
}

export function loadSkills() {
  loadedToolSkills.clear();
  loadedReferenceSkills.clear();

  const loaded = [];
  for (const rootDir of getProjectSkillDirs()) {
    if (!fs.existsSync(rootDir)) continue;
    fs.mkdirSync(rootDir, { recursive: true });
    const files = walkSkillFiles(rootDir);

    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const skill = parseSkillFile(content, filePath);
        if (!skill) continue;
        if (skill.kind === 'tool') {
          loadedToolSkills.set(skill.name, skill);
        } else {
          loadedReferenceSkills.set(skill.name, skill);
        }
        loaded.push(skill);
      } catch (err) {
        logger.error(`[skills] Failed to load ${filePath}: ${err.message}`);
      }
    }
  }

  return loaded;
}

export function createSkill({ name, description, parameters, implementation, type = 'javascript' }) {
  const safeName = sanitizeSkillSlug(name);
  const skillsDir = path.join(getWorkspace(), config.skillsDir);
  fs.mkdirSync(skillsDir, { recursive: true });

  const implSection = type === 'command'
    ? `## Command\n\`\`\`bash\n${implementation}\n\`\`\``
    : type === 'knowledge'
      ? `## Knowledge\n${implementation}`
      : `## Implementation\n\`\`\`javascript\n${implementation}\n\`\`\``;

  const content = `# Skill: ${safeName}

## Description
${description}

## Parameters
${parameters || '- (no parameters)'}

${implSection}

## Examples
_Created by agent during task execution._

---
_Created: ${new Date().toISOString()}_
`;

  const filePath = path.join(skillsDir, `${safeName}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  loadSkills();
  return `Skill "${safeName}" created at .agent/skills/${safeName}.md and loaded.`;
}

export function getSkillToolDefinitions() {
  const defs = [];
  for (const skill of loadedToolSkills.values()) {
    defs.push({
      type: 'function',
      function: {
        name: skill.name,
        description: `[SKILL] ${skill.description}`,
        parameters: skill.parameters,
      },
    });
  }
  return defs;
}

export function executeSkill(name, args) {
  const skill = loadedToolSkills.get(name);
  if (!skill) return { result: `Skill not found: ${name}`, error: true };
  try {
    return { result: String(skill.handler(args)), error: false };
  } catch (err) {
    return { result: `Skill error (${name}): ${err.message}`, error: true };
  }
}

export function isSkillTool(name) {
  return loadedToolSkills.has(name);
}

export function getSkillsSummary() {
  const toolCount = loadedToolSkills.size;
  const referenceCount = loadedReferenceSkills.size;
  if (toolCount === 0 && referenceCount === 0) return 'No custom skills loaded.';

  const lines = [];
  for (const skill of loadedToolSkills.values()) {
    lines.push(`- **${skill.name}**: ${skill.description.slice(0, 100)} [${skill.source}]`);
  }
  for (const skill of loadedReferenceSkills.values()) {
    lines.push(`- **${skill.name}**: ${skill.description.slice(0, 100)} [reference:${skill.source}]`);
  }
  return `${toolCount} executable skill(s), ${referenceCount} reference skill(s) loaded:\n${lines.join('\n')}`;
}

export function getRelevantSkillBlocks({ task = '', currentSubtask = '', recentActions = [], maxSkills = 3, maxChars = 5000 }) {
  const text = [task, currentSubtask, ...recentActions].filter(Boolean).join('\n');
  const ranked = [...loadedReferenceSkills.values()]
    .map((skill) => ({ skill, score: scoreSkillRelevance(skill, text) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSkills);

  const blocks = [];
  let totalChars = 0;

  for (const { skill, score } of ranked) {
    const supporting = skill.supportingFiles?.length
      ? `Supporting files: ${skill.supportingFiles.join(', ')}`
      : '';
    const block = [
      `## Skill: ${skill.name}`,
      `Source: ${skill.sourceHint || skill.filePath}`,
      `Relevance: ${score.toFixed(2)}`,
      skill.description,
      supporting,
      skill.body || '',
    ].filter(Boolean).join('\n');

    if (totalChars + block.length > maxChars) break;
    blocks.push(block);
    totalChars += block.length;
  }

  return blocks;
}
