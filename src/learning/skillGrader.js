// src/learning/skillGrader.js
// Rank agent-created skills by reuse count, success rate, and recency.
// Grades (A/B/C/D) stored in .agent/learning/skill-grades.json.
// Task 5.1

import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { workspaceResolve } from '../runtime/workspacePath.js';

function resolve(rel) {
  return workspaceResolve(rel);
}

function ensureDir() {
  fs.mkdirSync(resolve(config.learningDir), { recursive: true });
}

function gradesFile() {
  return resolve(path.join(config.learningDir, 'skill-grades.json'));
}

/** Parse minimal frontmatter from a skill .md file */
function parseMeta(content) {
  const match = String(content || '').match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return meta;
}

/**
 * Scan accepted-traces.jsonl to tally how many times each skill was invoked
 * and what fraction of those invocations had a successful outcome.
 */
function buildSkillUsageFromTraces() {
  const tracesFile = resolve(config.trainingAcceptedFile);
  if (!fs.existsSync(tracesFile)) return {};
  const usage = {};
  const lines = fs.readFileSync(tracesFile, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const trace = JSON.parse(line);
      const tool = trace.controller_action?.tool || trace.tool;
      if (!tool || tool !== 'create_skill') continue;
      // Skill name from args
      const name = trace.controller_action?.args?.name || trace.input_summary?.match(/name[=:"]+([a-z0-9_-]+)/i)?.[1];
      if (!name) continue;
      if (!usage[name]) usage[name] = { invocations: 0, successes: 0 };
      usage[name].invocations++;
      if (trace.tool_outcome === 'success') usage[name].successes++;
    } catch { /* skip malformed lines */ }
  }
  return usage;
}

/**
 * Compute a grade from score value.
 * @param {number} score 0–1
 * @returns {'A'|'B'|'C'|'D'}
 */
function scoreToGrade(score) {
  if (score >= 0.75) return 'A';
  if (score >= 0.50) return 'B';
  if (score >= 0.25) return 'C';
  return 'D';
}

/**
 * Grade a single skill by name, content, and usage stats.
 * @param {{name: string, filePath: string, content: string}} skill
 * @param {object} traceUsage — map from skill name → { invocations, successes }
 * @returns {{grade, score, reuse_count, success_rate, last_used, name}}
 */
export function gradeSkill(skill, traceUsage = {}) {
  const meta = parseMeta(skill.content);
  const usage = traceUsage[skill.name] || {};

  // Reuse score — capped at 10 uses for full score
  const reuseCount = parseInt(meta.reuse_count || usage.invocations || '0', 10);
  const reuseScore = Math.min(1, reuseCount / 10);

  // Success-rate score — only computed from trace data; default 0.5 (neutral) when unknown
  const successes = usage.successes || 0;
  const invocations = usage.invocations || 0;
  const successRate = invocations > 0 ? successes / invocations : 0.5;

  // Recency score — bonus if used in last 7 days
  const lastUsed = meta.last_used ? new Date(meta.last_used).getTime() : 0;
  const daysSinceUse = lastUsed ? (Date.now() - lastUsed) / 86400000 : 999;
  const recencyScore = daysSinceUse < 7 ? 1 : daysSinceUse < 30 ? 0.5 : 0;

  // Content richness — longer, more detailed skills score higher
  const lines = skill.content.split('\n').length;
  const richnessScore = Math.min(1, lines / 50);

  const score = Number((
    0.35 * reuseScore +
    0.30 * successRate +
    0.20 * richnessScore +
    0.15 * recencyScore
  ).toFixed(3));

  return {
    name: skill.name,
    grade: scoreToGrade(score),
    score,
    reuse_count: reuseCount,
    success_rate: Number(successRate.toFixed(3)),
    last_used: meta.last_used || null,
  };
}

/**
 * Grade all agent-created skills and persist the results.
 * @returns {Array<{name, grade, score, reuse_count, success_rate}>}
 */
export function gradeAllSkills() {
  ensureDir();
  const skillsDir = resolve(config.skillsDir);
  if (!fs.existsSync(skillsDir)) return [];

  const traceUsage = buildSkillUsageFromTraces();
  const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
  const grades = [];

  for (const file of files) {
    const filePath = path.join(skillsDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const meta = parseMeta(content);
    const name = meta.name || path.basename(file, '.md');
    grades.push(gradeSkill({ name, filePath, content }, traceUsage));
  }

  // Sort A→D
  grades.sort((a, b) => b.score - a.score);
  fs.writeFileSync(gradesFile(), JSON.stringify(grades, null, 2));
  return grades;
}

/**
 * Load previously computed grades (or empty array if not yet run).
 */
export function loadGrades() {
  const f = gradesFile();
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); }
  catch { return []; }
}
