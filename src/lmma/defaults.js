import config from '../config.js';

const BANKS = [
  'task',
  'plan',
  'code',
  'api',
  'frontend',
  'backend',
  'database',
  'testing',
  'commands',
  'docs',
  'learnings',
  'skills',
  'user',
  'project',
  'verification',
];

export function getLmmaBanks() {
  return [...BANKS];
}

export function getLmmaBankFileMap() {
  return Object.fromEntries(BANKS.map((bank) => [bank, `${config.lmmaBanksDir}/${bank}.jsonl`]));
}

export function getDefaultOntology() {
  return {
    classes: {
      Task: [],
      Subtask: [],
      File: [],
      Directory: [],
      CodeArtifact: [],
      Function: [],
      Class: [],
      Framework: [],
      API: [],
      Database: [],
      Command: [],
      Test: [],
      Bug: [],
      Fix: [],
      Plan: [],
      Learning: [],
      Skill: [],
      UserPreference: [],
      ProjectKnowledge: [],
      MemoryBank: getLmmaBanks(),
    },
    relations: {
      depends_on: ['Task', 'Task'],
      modifies: ['Task', 'File'],
      implements: ['CodeArtifact', 'Task'],
      tests: ['Test', 'CodeArtifact'],
      uses: ['Task', 'Framework'],
      blocks: ['Bug', 'Task'],
      fixes: ['Fix', 'Bug'],
      related_to: ['any', 'any'],
      belongs_to_bank: ['any', 'MemoryBank'],
    },
  };
}

export function getDefaultTaxonomy() {
  return {
    terms: {
      react: ['Framework', 'Frontend'],
      vite: ['Framework', 'Frontend'],
      express: ['Framework', 'Backend', 'API'],
      fastify: ['Framework', 'Backend', 'API'],
      postgres: ['Database'],
      sqlite: ['Database'],
      mysql: ['Database'],
      jest: ['Test'],
      vitest: ['Test'],
      playwright: ['Test'],
      api: ['API'],
      endpoint: ['API'],
      route: ['API'],
      schema: ['Database'],
      migration: ['Database'],
      test: ['Test'],
      smoke: ['Test', 'Verification'],
      command: ['Command'],
      plan: ['Plan'],
      memory: ['Learning', 'ProjectKnowledge'],
      skill: ['Skill'],
      user: ['UserPreference'],
      project: ['ProjectKnowledge'],
      readme: ['ProjectKnowledge', 'File'],
    },
  };
}

export function getDefaultRules() {
  return {
    stagePriorities: {
      intake: ['project', 'user', 'task', 'plan', 'docs'],
      discovery: ['project', 'learnings', 'code', 'docs'],
      planning: ['plan', 'project', 'docs', 'learnings', 'task'],
      execution: ['code', 'api', 'backend', 'frontend', 'database'],
      verification: ['testing', 'commands', 'verification', 'learnings'],
      finalization: ['learnings', 'project', 'docs', 'skills', 'verification'],
    },
    domainToBanks: {
      code: ['code', 'project'],
      api: ['api', 'backend', 'testing'],
      frontend: ['frontend', 'api', 'testing'],
      backend: ['backend', 'api', 'database'],
      database: ['database', 'backend', 'testing'],
      testing: ['testing', 'verification', 'commands'],
      docs: ['docs', 'project'],
      commands: ['commands', 'verification'],
      plan: ['plan', 'task'],
      user: ['user', 'project'],
    },
  };
}

export function getDefaultBankRegistry() {
  return {
    Task: 'task',
    Plan: 'plan',
    CodeArtifact: 'code',
    API: 'api',
    'Framework:Frontend': 'frontend',
    'Framework:Backend': 'backend',
    Database: 'database',
    Test: 'testing',
    Command: 'commands',
    Learning: 'learnings',
    Skill: 'skills',
    UserPreference: 'user',
    ProjectKnowledge: 'project',
    Verification: 'verification',
    File: 'code',
  };
}

export function getDefaultLayerMaps() {
  return {
    knowledge: ['ontology_tags', 'bank_summaries', 'memory_summaries'],
    state: ['route_path', 'primary_bank', 'bank_confidence', 'unresolved_gaps'],
    session: ['retrieval_hits', 'working_memory_packet', 'recent_route_traces'],
    guidance: ['route_focus_hint', 'route_correction_hint'],
  };
}

export function getDefaultCrossMapGraph() {
  return {
    code: ['testing', 'project', 'docs'],
    api: ['backend', 'frontend', 'testing'],
    frontend: ['api', 'testing', 'docs'],
    backend: ['api', 'database', 'testing'],
    database: ['backend', 'api', 'testing'],
    testing: ['verification', 'commands', 'code'],
    commands: ['verification', 'testing'],
    plan: ['task', 'project'],
    docs: ['project', 'code'],
    user: ['project'],
    project: ['code', 'docs', 'plan'],
    verification: ['testing', 'commands', 'project'],
  };
}

export function getDefaultActiveRoute() {
  return {
    step: 0,
    stage: '',
    task: '',
    domains: {},
    entities: [],
    intents: [],
    ontologyTags: [],
    primaryBank: 'project',
    jumpBanks: [],
    selectedBanks: ['project'],
    bankConfidence: {},
    routePath: ['project'],
    routeSummary: '',
    unresolvedGaps: [],
    retrievalHits: [],
    cacheHit: false,
    consecutiveBankSteps: 0,
    controller: { mode: 'hosted-llm', confidence: 0, fallbackReason: 'not_started' },
    updatedAt: '',
  };
}

export function getDefaultWorkingMemoryPacket() {
  return {
    step: 0,
    stage: '',
    summary: '',
    focusHint: '',
    routePath: [],
    banks: [],
    retrievedMemories: [],
    ontologyTags: [],
    entities: [],
    unresolvedGaps: [],
    cacheStatus: 'cold',
    recentRouteTraces: [],
    generatedAt: '',
  };
}

export function getDefaultRetrievalCache() {
  return {
    version: 2,
    entries: {},
  };
}

export function getDefaultImportanceMap() {
  return {
    version: 2,
    banks: {},
    memories: {},
    ontologyTags: {},
    routes: {},
    bankStats: {},
    // Learned utility: EMA of step-outcome success per bank/tag (0..1, 0.5 = neutral).
    // Drives the learned-importance adjustment in scoreImportance().
    utility: { banks: {}, tags: {} },
  };
}

export function getLmmaSeedFiles() {
  const bankFiles = Object.fromEntries(
    Object.values(getLmmaBankFileMap()).map((relPath) => [relPath, ''])
  );

  return {
    [config.lmmaOntologyFile]: getDefaultOntology(),
    [config.lmmaTaxonomyFile]: getDefaultTaxonomy(),
    [config.lmmaRulesFile]: getDefaultRules(),
    [config.lmmaBankRegistryFile]: getDefaultBankRegistry(),
    [config.lmmaLayerMapsFile]: getDefaultLayerMaps(),
    [config.lmmaCrossMapGraphFile]: getDefaultCrossMapGraph(),
    [config.lmmaRouteTracesFile]: '',
    [config.lmmaActiveRouteFile]: getDefaultActiveRoute(),
    [config.lmmaWorkingMemoryFile]: getDefaultWorkingMemoryPacket(),
    [config.lmmaRetrievalCacheFile]: getDefaultRetrievalCache(),
    [config.lmmaImportanceFile]: getDefaultImportanceMap(),
    ...bankFiles,
  };
}
