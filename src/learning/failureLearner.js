// src/learning/failureLearner.js
// Track repeated failures and suggest new skills when a pattern appears 3+ times.
// State persisted in .agent/learning/failure-patterns.json
// Task 5.6

import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { workspaceResolve } from '../runtime/workspacePath.js';

function resolve(rel) {
  return workspaceResolve(rel);
}

function patternsFile() {
  return resolve(path.join(config.learningDir, 'failure-patterns.json'));
}

function loadPatterns() {
  const f = patternsFile();
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); }
  catch { return {}; }
}

function savePatterns(patterns) {
  fs.mkdirSync(resolve(config.learningDir), { recursive: true });
  fs.writeFileSync(patternsFile(), JSON.stringify(patterns, null, 2));
}

/**
 * Normalise a failure into a pattern key.
 * Two failures that differ only in file path or specific arguments should
 * produce the same key so they accumulate toward the threshold.
 */
function toPatternKey(tool, error) {
  const errNorm = String(error || '')
    .toLowerCase()
    .replace(/[/\\][^\s/\\]*/g, '<path>')   // strip file paths
    .replace(/\d+/g, '<n>')                  // strip numbers
    .slice(0, 120);
  return `${tool}::${errNorm}`;
}

const SUGGESTION_THRESHOLD = 3;

/**
 * Record a tool failure. Returns a skill suggestion if the pattern has crossed
 * the threshold, or null otherwise.
 * @param {string} tool
 * @param {object} args
 * @param {string} error — error message / tool output
 * @returns {{ pattern, count, suggestion } | null}
 */
export function recordFailure(tool, args, error) {
  const key = toPatternKey(tool, error);
  const patterns = loadPatterns();

  if (!patterns[key]) {
    patterns[key] = { tool, count: 0, lastError: '', firstSeen: Date.now(), suggestion: null };
  }

  patterns[key].count++;
  patterns[key].lastError = String(error || '').slice(0, 200);
  patterns[key].lastSeen = Date.now();

  // Generate suggestion at threshold
  if (patterns[key].count === SUGGESTION_THRESHOLD && !patterns[key].suggestion) {
    patterns[key].suggestion = _buildSuggestion(tool, error, patterns[key].count);
  }

  savePatterns(patterns);

  if (patterns[key].count >= SUGGESTION_THRESHOLD) {
    return {
      pattern: key,
      count: patterns[key].count,
      suggestion: patterns[key].suggestion,
    };
  }

  return null;
}

/**
 * List all patterns that have a skill suggestion ready.
 * @returns {Array<{pattern, count, suggestion}>}
 */
export function getSkillSuggestions() {
  const patterns = loadPatterns();
  return Object.entries(patterns)
    .filter(([, v]) => v.suggestion && v.count >= SUGGESTION_THRESHOLD)
    .map(([k, v]) => ({ pattern: k, count: v.count, suggestion: v.suggestion }));
}

/**
 * Clear all recorded failure patterns (e.g., after a skill has been created).
 * @param {string} [patternKey] — if provided, clear only this key; otherwise clear all
 */
export function clearPattern(patternKey) {
  const patterns = loadPatterns();
  if (patternKey) {
    delete patterns[patternKey];
  } else {
    Object.keys(patterns).forEach(k => delete patterns[k]);
  }
  savePatterns(patterns);
}

function _buildSuggestion(tool, error, count) {
  const errSlice = String(error || '').slice(0, 120);
  return [
    `This failure pattern has occurred ${count} times: \`${tool}\` → "${errSlice}"`,
    `Consider creating a skill to handle this case.`,
    `Suggested skill name: \`handle-${tool.replace(/_/g, '-')}-${_slugify(errSlice)}\``,
    ``,
    `Skill should:`,
    `1. Detect this error condition early`,
    `2. Apply a known fix or escalate with context`,
    `3. Record the result to prevent re-occurrence`,
  ].join('\n');
}

function _slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30).replace(/^-|-$/g, '');
}
