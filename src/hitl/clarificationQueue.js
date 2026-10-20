// src/hitl/clarificationQueue.js
// Agent-asks-human clarification queue.
// Pending questions:  .agent/hitl/clarify/<id>.json
// Answers appear in context at the next step.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import config from '../config.js';
import { workspaceResolve } from '../runtime/workspacePath.js';
import { appendAudit, emitEvent } from './gateway.js';

// Resolves through the AgentContext when one is active (the daemon runs each
// mission inside its own), falling back to the config singleton for direct CLI
// calls. See src/runtime/workspacePath.js for why this indirection exists.
function resolve(rel) {
  return workspaceResolve(rel);
}

function ensureDir() {
  fs.mkdirSync(resolve(config.hitlClarifyDir), { recursive: true });
}

/**
 * Agent calls this to ask the human a question.
 * @param {string} question
 * @returns {string} requestId
 */
export function askClarification(question) {
  ensureDir();
  const id = randomUUID();
  const req = { id, question, status: 'pending', timestamp: Date.now() };
  fs.writeFileSync(
    resolve(path.join(config.hitlClarifyDir, `${id}.json`)),
    JSON.stringify(req, null, 2)
  );
  appendAudit({ type: 'clarification_asked', id, question: question.slice(0, 200) });
  emitEvent({ type: 'clarification_asked', id, question: question.slice(0, 200), timestamp: Date.now() });
  return id;
}

/**
 * Human calls this (via CLI) to answer a clarification.
 * @param {string} id
 * @param {string} answer
 */
export function answerClarification(id, answer) {
  ensureDir();
  const file = resolve(path.join(config.hitlClarifyDir, `${id}.json`));
  if (!fs.existsSync(file)) throw new Error(`No clarification request with id=${id}`);
  const req = JSON.parse(fs.readFileSync(file, 'utf-8'));
  req.answer = answer;
  req.status = 'answered';
  req.answeredAt = Date.now();
  fs.writeFileSync(file, JSON.stringify(req, null, 2));
  appendAudit({ type: 'clarification_answered', id, answer: answer.slice(0, 200) });
  emitEvent({ type: 'clarification_answered', id, answer: answer.slice(0, 200), timestamp: Date.now() });
}

/**
 * List all pending (unanswered) clarification requests.
 * @returns {Array<object>}
 */
export function getPendingClarifications() {
  ensureDir();
  const dir = resolve(config.hitlClarifyDir);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(r => r && r.status === 'pending');
}

/**
 * Consume all answered clarifications — returns them and removes from disk.
 * Called by loop.js to inject answers into context.
 * @returns {Array<{id, question, answer}>}
 */
export function consumeAnswers() {
  ensureDir();
  const dir = resolve(config.hitlClarifyDir);
  const answered = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const fp = path.join(dir, f);
      try { return { file: fp, data: JSON.parse(fs.readFileSync(fp, 'utf-8')) }; }
      catch { return null; }
    })
    .filter(r => r && r.data.status === 'answered');

  const results = [];
  for (const { file, data } of answered) {
    results.push({ id: data.id, question: data.question, answer: data.answer });
    fs.unlinkSync(file);
  }
  return results;
}
