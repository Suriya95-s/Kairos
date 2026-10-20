function summarizeResult(result, maxChars = 220) {
  const text = String(result || '').replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? text.slice(0, maxChars) + '...' : text;
}

function guessFileBank(filePath = '') {
  const normalized = String(filePath || '').toLowerCase();
  if (!normalized) return '';
  if (normalized.endsWith('.md')) return 'docs';
  if (/\.(html|css|tsx|jsx)$/.test(normalized)) return 'frontend';
  if (normalized.endsWith('.sql')) return 'database';
  if (/test|spec|smoke/.test(normalized)) return 'testing';
  if (/\.(js|mjs|cjs|ts|py|go|rs|java)$/.test(normalized)) return 'code';
  return '';
}

function rankCandidateBank({ action, stage, activeRoute }) {
  const candidates = new Map();
  const add = (bank, score) => {
    if (!bank) return;
    candidates.set(bank, Math.max(score, candidates.get(bank) || 0));
  };

  const primary = activeRoute?.primaryBank || 'project';
  add(primary, 0.45);
  (activeRoute?.selectedBanks || []).forEach((bank, index) => add(bank, Math.max(0.16, 0.32 - index * 0.04)));

  if (action.tool === 'update_plan') add('plan', 0.98);
  if (action.tool === 'add_learning') add('learnings', 0.98);
  if (action.tool === 'create_skill') add('skills', 0.98);
  if (action.tool === 'finish') add('task', 0.9);

  const fileBank = guessFileBank(action.args?.path || '');
  add(fileBank, 0.84);

  if (action.tool === 'run_command') {
    const command = String(action.args?.command || '').toLowerCase();
    if (/test|pytest|vitest|jest|smoke/.test(command)) add('testing', 0.95);
    add('commands', 0.82);
  }

  if (stage === 'verification' || stage === 'finalization') add('verification', 0.72);
  if (stage === 'planning') add('plan', 0.7);

  const ontologyTags = activeRoute?.ontologyTags || [];
  if (ontologyTags.includes('Framework:Frontend')) add('frontend', 0.66);
  if (ontologyTags.includes('Framework:Backend')) add('backend', 0.66);
  if (ontologyTags.includes('Database')) add('database', 0.66);
  if (ontologyTags.includes('API')) add('api', 0.66);
  if (ontologyTags.includes('Test')) add('testing', 0.68);
  if (ontologyTags.includes('ProjectKnowledge')) add('project', 0.64);
  if (ontologyTags.includes('Skill')) add('skills', 0.7);
  if (ontologyTags.includes('Plan')) add('plan', 0.72);

  const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] || primary;
}

function buildRelatedFiles(action, activeRoute) {
  const files = new Set([
    ...(action.args?.path ? [action.args.path] : []),
    ...((activeRoute?.entities || []).filter((entity) => /\.[A-Za-z0-9]+$/.test(entity))),
  ]);
  return [...files].slice(0, 6);
}

export function buildMemoryWriteback({
  step,
  stage,
  action,
  toolResult,
  toolError,
  activeRoute,
  importance,
}) {
  const bank = rankCandidateBank({ action, stage, activeRoute });
  const memoryId = `mem-${String(step).padStart(5, '0')}-${action.tool}`;
  const type = toolError ? 'Learning' : 'ProjectKnowledge';
  const title = toolError
    ? `${action.tool} failed during ${stage}`
    : `${action.tool} advanced ${stage}`;

  const baseEntry = {
    memory_id: memoryId,
    type,
    title,
    summary: summarizeResult(toolResult, importance > 0.7 ? 320 : 180),
    entities: (activeRoute?.entities || []).slice(0, 8),
    ontology_tags: activeRoute?.ontologyTags || [],
    related_files: buildRelatedFiles(action, activeRoute),
    related_commands: action.tool === 'run_command' && action.args?.command ? [action.args.command] : [],
    source_step: step,
    importance,
    timestamp: new Date().toISOString(),
  };

  if (importance < 0.4) {
    return {
      bank,
      mode: 'aggregate_only',
      stats: {
        lowImportanceCount: 1,
        lastActionTool: action.tool,
        lastStage: stage,
      },
      entry: null,
    };
  }

  if (importance <= 0.7) {
    return {
      bank,
      mode: 'compact',
      stats: { compactCount: 1 },
      entry: {
        ...baseEntry,
        entities: baseEntry.entities.slice(0, 5),
        summary: summarizeResult(toolResult, 160),
      },
    };
  }

  return {
    bank,
    mode: 'full',
    stats: { fullCount: 1 },
    entry: {
      ...baseEntry,
      relations: activeRoute?.routePath || [],
      route_summary: activeRoute?.routeSummary || '',
      files: baseEntry.related_files,
      commands: baseEntry.related_commands,
    },
  };
}
