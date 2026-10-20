const DOMAIN_RULES = {
  api: {
    patterns: [/\b(api|endpoint|route|rest|http|fetch|request|response)\b/gi],
    fileExts: ['.json'],
    commands: ['curl'],
  },
  frontend: {
    patterns: [/\b(frontend|ui|component|css|html|dom|browser|react|vite)\b/gi],
    fileExts: ['.html', '.css', '.tsx', '.jsx'],
    commands: [],
  },
  backend: {
    patterns: [/\b(server|backend|express|fastify|service|controller|middleware)\b/gi],
    fileExts: ['.js', '.ts', '.py', '.go'],
    commands: ['node'],
  },
  database: {
    patterns: [/\b(database|db|sql|schema|migration|table|query|postgres|sqlite|mysql)\b/gi],
    fileExts: ['.sql'],
    commands: [],
  },
  testing: {
    patterns: [/\b(test|spec|assert|smoke|verify|verification|jest|vitest|playwright|pytest)\b/gi],
    fileExts: [],
    commands: ['pytest', 'node', 'python3', 'python'],
  },
  commands: {
    patterns: [/\b(command|terminal|shell|cli|bash|powershell)\b/gi],
    fileExts: ['.sh', '.ps1'],
    commands: ['npm', 'node', 'python3', 'python', 'git'],
  },
  docs: {
    patterns: [/\b(readme|docs|documentation|design|architecture|spec)\b/gi],
    fileExts: ['.md'],
    commands: [],
  },
  plan: {
    patterns: [/\b(plan|phase|subtask|todo|milestone|roadmap)\b/gi],
    fileExts: [],
    commands: [],
  },
  user: {
    patterns: [/\b(user|preference|instruction|request)\b/gi],
    fileExts: [],
    commands: [],
  },
  code: {
    patterns: [/\b(code|function|class|module|import|export|refactor|bug|fix|package)\b/gi],
    fileExts: ['.js', '.ts', '.py', '.go', '.rs', '.java'],
    commands: ['node', 'python3', 'python'],
  },
};

function countMatches(text, patterns) {
  let total = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    total += matches ? matches.length : 0;
  }
  return total;
}

function countFileExtensionHits(text, fileExts) {
  if (!fileExts.length) return 0;
  const matches = text.match(/\.[A-Za-z0-9]+/g) || [];
  return matches.filter((item) => fileExts.includes(item.toLowerCase())).length;
}

function countCommandHits(recentActions, commands) {
  if (!commands.length) return 0;
  const joined = recentActions.join('\n').toLowerCase();
  return commands.reduce((count, command) => count + (joined.includes(command) ? 1 : 0), 0);
}

function normalizeScore(rawScore) {
  if (rawScore <= 0) return 0;
  return Number(Math.min(1, rawScore).toFixed(2));
}

export function detectDomains({ task = '', currentSubtask = '', stage = '', recentActions = [], recentResults = [] }) {
  const taskText = [task, currentSubtask].filter(Boolean).join('\n').toLowerCase();
  const recentText = [...recentActions, ...recentResults].join('\n').toLowerCase();
  const combined = [taskText, recentText].join('\n');
  const scores = {};

  for (const [domain, rule] of Object.entries(DOMAIN_RULES)) {
    const lexicalHits = countMatches(combined, rule.patterns);
    const extHits = countFileExtensionHits(combined, rule.fileExts);
    const commandHits = countCommandHits(recentActions, rule.commands);
    let rawScore = lexicalHits * 0.18 + extHits * 0.22 + commandHits * 0.18;

    if (stage === 'planning' && domain === 'plan') rawScore += 0.2;
    if (stage === 'verification' && (domain === 'testing' || domain === 'commands')) rawScore += 0.22;
    if (stage === 'finalization' && (domain === 'verification' || domain === 'docs')) rawScore += 0.16;
    if (stage === 'execution' && domain === 'code' && rawScore > 0) rawScore += 0.12;

    const score = normalizeScore(rawScore);
    if (score >= 0.18) {
      scores[domain] = score;
    }
  }

  if (Object.keys(scores).length === 0) {
    scores.project = 0.35;
  }

  return Object.fromEntries(
    Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
  );
}
