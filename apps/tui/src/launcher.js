// src/launcher.js — persistence for the launcher hub: recent tasks (per project)
// and recent workspaces (global). Plain JSON, no dependencies.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MAX_TASKS = 12;
const MAX_WORKSPACES = 10;

function taskHistoryPath(root) {
  return path.join(root || process.cwd(), '.agent', 'tui-history.json');
}
function workspacesPath() {
  return path.join(os.homedir(), '.kairos', 'recent-workspaces.json');
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}
function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* non-critical */ }
}

/** Recent tasks for a project root, newest first. */
export function loadTasks(root) {
  const data = readJson(taskHistoryPath(root), { tasks: [] });
  return Array.isArray(data.tasks) ? data.tasks : [];
}

/** Record a launched task (deduped, newest first, capped). */
export function recordTask(root, task, ts) {
  const text = String(task || '').trim();
  if (!text) return;
  const tasks = loadTasks(root).filter(t => t.task !== text);
  tasks.unshift({ task: text, ts: ts || '' });
  writeJson(taskHistoryPath(root), { tasks: tasks.slice(0, MAX_TASKS) });
}

/** Recent workspaces across projects, newest first. */
export function loadWorkspaces() {
  const data = readJson(workspacesPath(), []);
  return Array.isArray(data) ? data : [];
}

/** Record a workspace root as recently used (deduped, newest first, capped). */
export function recordWorkspace(root, ts) {
  const abs = path.resolve(root || process.cwd());
  const list = loadWorkspaces().filter(w => w.root !== abs);
  list.unshift({ root: abs, ts: ts || '' });
  writeJson(workspacesPath(), list.slice(0, MAX_WORKSPACES));
}
