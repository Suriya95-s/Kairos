export function mapOntology({ entities = [], domains = {}, taxonomy = { terms: {} } }) {
  const tags = new Set();
  const lowerTerms = taxonomy?.terms || {};

  for (const entity of entities) {
    const normalized = String(entity).toLowerCase();
    const matches = lowerTerms[normalized];
    if (Array.isArray(matches)) {
      matches.forEach((tag) => tags.add(tag));
    }

    if (/\.[a-z0-9]+$/i.test(entity)) tags.add('File');
    if (/test|spec|smoke/i.test(entity)) tags.add('Test');
    if (/route|endpoint|api/i.test(entity)) tags.add('API');
    if (/schema|migration|sql|table/i.test(entity)) tags.add('Database');
    if (/plan|todo|phase/i.test(entity)) tags.add('Plan');
    if (/user/i.test(entity)) tags.add('UserPreference');
  }

  for (const domain of Object.keys(domains)) {
    if (domain === 'frontend') tags.add('Framework:Frontend');
    else if (domain === 'backend') tags.add('Framework:Backend');
    else if (domain === 'database') tags.add('Database');
    else if (domain === 'testing') tags.add('Test');
    else if (domain === 'api') tags.add('API');
    else if (domain === 'plan') tags.add('Plan');
    else if (domain === 'docs') tags.add('ProjectKnowledge');
    else if (domain === 'code') tags.add('CodeArtifact');
  }

  return [...tags];
}
