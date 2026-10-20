const FILE_RE = /\b[\w./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|py|rb|go|rs|java|css|html|sql|yaml|yml)\b/g;
const COMMAND_RE = /\b(?:npm|node|python3?|pytest|pnpm|yarn|git|cargo|go|deno)\b[^\n]{0,120}/gi;
const IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_/-]{2,}\b/g;
const INTENT_VOCAB = ['implement', 'fix', 'test', 'document', 'refactor', 'verify', 'read', 'write', 'plan'];

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'agent', 'build', 'calls', 'check', 'class', 'complete', 'current',
  'debug', 'exact', 'file', 'files', 'from', 'function', 'game', 'into', 'just', 'like', 'main',
  'make', 'must', 'need', 'next', 'only', 'package', 'print', 'project', 'python', 'return',
  'score', 'should', 'stage', 'step', 'task', 'that', 'their', 'them', 'there', 'these', 'this',
  'tool', 'tools', 'true', 'used', 'using', 'with', 'without', 'work', 'workspace',
]);

const INTENT_KEYWORDS = {
  implement: /\b(add|build|create|implement|integrate|wire)\b/i,
  fix: /\b(debug|fix|broken|error|bug|issue|fail|crash|repair)\b/i,
  test: /\b(test|pytest|jest|vitest|smoke|assert)\b/i,
  document: /\b(doc|readme|design|architecture|explain|spec)\b/i,
  refactor: /\b(refactor|reshape|cleanup|restructure)\b/i,
  verify: /\b(verify|verification|verified|verifying|validation|check|confirm)\b/i,
  read: /\b(read|inspect|review|open)\b/i,
  write: /\b(write|edit|patch|rewrite|modify)\b/i,
  plan: /\b(plan|phase|todo|next|milestone|roadmap)\b/i,
};

function normalizeEntity(entity) {
  return String(entity || '')
    .replace(/[`"'()[\]{}:,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsefulIdentifier(token) {
  const normalized = normalizeEntity(token).toLowerCase();
  if (!normalized || normalized.length < 3 || normalized.length > 32) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (STOP_WORDS.has(normalized)) return false;
  if (normalized.split(' ').length > 1) return false;
  return true;
}

function extractCommandEntities(text) {
  const rawCommands = [...new Set((text.match(COMMAND_RE) || []).map((item) => item.trim()))];
  const entities = [];

  for (const command of rawCommands) {
    const tokens = command
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .map(normalizeEntity)
      .filter(Boolean);

    if (tokens.length === 0) continue;
    entities.push(tokens[0]);

    const interesting = tokens.find((token) => /\.[A-Za-z0-9]+$/.test(token) || /^--?[A-Za-z]/.test(token));
    if (interesting) entities.push(interesting);
  }

  return entities;
}

function scoreEntity(entity, corpus) {
  const lowered = entity.toLowerCase();
  const escaped = lowered.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const frequency = (corpus.match(new RegExp(escaped, 'g')) || []).length;
  const pathBonus = /\//.test(entity) || /\.[A-Za-z0-9]+$/.test(entity) ? 2 : 0;
  const ontologyBonus = /(api|test|plan|readme|route|schema|config|server|client|controller|component|skill|memory)/i.test(entity) ? 1 : 0;
  return frequency * 2 + pathBonus + ontologyBonus;
}

function extractIdentifierEntities(text) {
  const identifiers = text.match(IDENTIFIER_RE) || [];
  const ranked = [];
  const seen = new Set();

  for (const identifier of identifiers) {
    const normalized = normalizeEntity(identifier);
    if (!isUsefulIdentifier(normalized)) continue;
    const lowered = normalized.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    ranked.push(normalized);
  }

  return ranked.slice(0, 24);
}

function buildSignalText(task, currentSubtask, recentActions, recentResults) {
  const boundedTask = String(task || '')
    .split(/\r?\n/)
    .slice(0, 20)
    .join('\n');
  const boundedSubtask = String(currentSubtask || '').split(/\r?\n/).slice(0, 25).join('\n');
  const boundedActions = recentActions
    .map((entry) => String(entry || '').split(/\r?\n/).slice(0, 2).join(' '))
    .join('\n');
  const boundedResults = recentResults
    .map((entry) => String(entry || '').split(/\r?\n/).slice(0, 6).join(' '))
    .join('\n');

  return [boundedTask, boundedSubtask, boundedActions, boundedResults].filter(Boolean).join('\n');
}

export function extractEntitiesAndIntents({ task = '', currentSubtask = '', recentActions = [], recentResults = [], taxonomy = null }) {
  const text = buildSignalText(task, currentSubtask, recentActions, recentResults);
  const fileEntities = [...new Set((text.match(FILE_RE) || []).map(normalizeEntity).filter(Boolean))];
  const commandEntities = extractCommandEntities(text);
  const identifierEntities = extractIdentifierEntities(text);
  const taxonomyTerms = taxonomy?.terms ? new Set(Object.keys(taxonomy.terms).map((term) => term.toLowerCase())) : new Set();

  const candidateEntities = [...new Set([
    ...fileEntities,
    ...commandEntities,
    ...identifierEntities,
  ])]
    .filter((entity) => {
      if (taxonomyTerms.size === 0) return true;
      const lowered = entity.toLowerCase();
      return taxonomyTerms.has(lowered) ||
        fileEntities.includes(entity) ||
        /\//.test(entity) ||
        /\.[A-Za-z0-9]+$/.test(entity);
    })
    .map((entity) => ({ entity, score: scoreEntity(entity, text.toLowerCase()) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.entity);

  const intents = Object.entries(INTENT_KEYWORDS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([intent]) => intent);

  return {
    entities: candidateEntities,
    intents: intents.filter((intent) => INTENT_VOCAB.includes(intent)).slice(0, 3),
  };
}
