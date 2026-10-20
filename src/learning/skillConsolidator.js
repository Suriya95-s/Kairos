// src/learning/skillConsolidator.js
// Detect near-duplicate agent-created skills and merge them.
// Similarity = Jaccard coefficient on tokenized name+body tokens.
// Task 5.2

import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { workspaceResolve } from '../runtime/workspacePath.js';

function resolve(rel) {
  return workspaceResolve(rel);
}

const MERGE_THRESHOLD = 0.55; // Jaccard ≥ 0.55 → merge candidates

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^\w]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 3)
  );
}

function jaccard(a, b) {
  const intersection = [...a].filter(t => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

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

function loadSkillFiles() {
  const dir = resolve(config.skillsDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const filePath = path.join(dir, f);
      const content = fs.readFileSync(filePath, 'utf-8');
      const meta = parseMeta(content);
      return { name: meta.name || path.basename(f, '.md'), filePath, content, meta };
    });
}

/**
 * Find all pairs of skills with Jaccard similarity above the merge threshold.
 * @returns {Array<{skillA, skillB, similarity}>}
 */
export function findMergeCandidates(threshold = MERGE_THRESHOLD) {
  const skills = loadSkillFiles();
  const candidates = [];
  for (let i = 0; i < skills.length; i++) {
    const ta = tokenize(skills[i].name + ' ' + skills[i].content);
    for (let j = i + 1; j < skills.length; j++) {
      const tb = tokenize(skills[j].name + ' ' + skills[j].content);
      const sim = jaccard(ta, tb);
      if (sim >= threshold) {
        candidates.push({ skillA: skills[i], skillB: skills[j], similarity: Number(sim.toFixed(3)) });
      }
    }
  }
  return candidates;
}

/**
 * Merge two near-duplicate skills into one.
 * The survivor keeps the name of whichever had the higher reuse_count (or skillA by default).
 * The merged body is a union of both bodies.
 */
function mergeSkills(skillA, skillB) {
  const reuseA = parseInt(skillA.meta.reuse_count || '0', 10);
  const reuseB = parseInt(skillB.meta.reuse_count || '0', 10);
  const primary = reuseA >= reuseB ? skillA : skillB;
  const secondary = primary === skillA ? skillB : skillA;

  // Extract body (strip frontmatter)
  const bodyA = skillA.content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const bodyB = skillB.content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

  const mergedMeta = {
    ...primary.meta,
    reuse_count: String(reuseA + reuseB),
    merged_from: secondary.name,
    merged_at: new Date().toISOString(),
  };
  const frontmatter = '---\n' +
    Object.entries(mergedMeta).map(([k, v]) => `${k}: ${v}`).join('\n') +
    '\n---\n';

  // Union body: keep primary body, append unique paragraphs from secondary
  const primaryParagraphs = new Set(bodyA.split(/\n\n+/).map(p => p.trim()).filter(Boolean));
  const additionalParagraphs = bodyB.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
    .filter(p => !primaryParagraphs.has(p));

  const mergedBody = bodyA +
    (additionalParagraphs.length > 0 ? '\n\n<!-- merged from: ' + secondary.name + ' -->\n\n' + additionalParagraphs.join('\n\n') : '');

  return { primary, secondary, mergedContent: frontmatter + mergedBody };
}

/**
 * Consolidate all near-duplicate agent-created skills.
 * @param {boolean} dryRun — if true, return plan without writing files
 * @returns {Array<{primary, secondary, similarity, merged}>}
 */
export function consolidate(dryRun = false) {
  const candidates = findMergeCandidates();
  const merged = [];
  const deleted = new Set();

  for (const { skillA, skillB, similarity } of candidates) {
    if (deleted.has(skillA.filePath) || deleted.has(skillB.filePath)) continue;

    const { primary, secondary, mergedContent } = mergeSkills(skillA, skillB);

    if (!dryRun) {
      fs.writeFileSync(primary.filePath, mergedContent);
      fs.unlinkSync(secondary.filePath);
    }

    deleted.add(secondary.filePath);
    merged.push({
      primary: primary.name,
      secondary: secondary.name,
      similarity,
      merged: !dryRun,
    });
  }

  return merged;
}
