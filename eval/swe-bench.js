#!/usr/bin/env node
// eval/swe-bench.js
// SWE-bench Lite harness adapter. Runs the agent against a set of problem instances
// and reports resolve rate. Expects instances as JSONL with {instance_id, repo, issue_text, patch_path}.
// Usage: node eval/swe-bench.js <instances.jsonl> [--max <N>] [--workspace-dir <dir>]
// Task 6.11

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { runLoop } from '../src/loop.js';
import { getFlag, getIntFlag, positional } from './args.js';

const args = process.argv.slice(2);
const instancesFile = positional(args);
const maxInstances  = getIntFlag(args, '--max', 0, { min: 0 });
const workspaceBase = getFlag(args, '--workspace-dir', '/tmp/swe-bench-workspaces');

if (!instancesFile) {
  console.error('Usage: node eval/swe-bench.js <instances.jsonl> [--max <N>] [--workspace-dir <dir>]');
  process.exit(1);
}

const lines = fs.readFileSync(instancesFile, 'utf-8')
  .split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const instances = maxInstances > 0 ? lines.slice(0, maxInstances) : lines;

const results = [];

for (const inst of instances) {
  const ws = path.join(workspaceBase, inst.instance_id);
  fs.mkdirSync(ws, { recursive: true });

  // Clone or copy repo into workspace
  if (inst.repo_path && fs.existsSync(inst.repo_path)) {
    execSync(`cp -r "${inst.repo_path}/." "${ws}/"`, { stdio: 'ignore' });
  }

  let exitReason = 'error';
  let resolved   = false;

  try {
    const loopResult = await runLoop({
      task:      inst.issue_text || inst.task || `Fix issue: ${inst.instance_id}`,
      workspace: ws,
    });
    exitReason = loopResult.exitReason;

    // Check resolve: apply reference patch and run tests
    if (inst.patch_path && fs.existsSync(inst.patch_path)) {
      try {
        execSync(`patch -p1 < "${inst.patch_path}"`, { cwd: ws, stdio: 'ignore' });
        execSync('python -m pytest --tb=no -q 2>&1 | tail -1', { cwd: ws, stdio: 'ignore' });
        resolved = true;
      } catch { resolved = false; }
    }
  } catch (err) {
    exitReason = `exception: ${err.message}`;
  }

  const rec = { instance_id: inst.instance_id, exitReason, resolved };
  results.push(rec);
  console.error(`[swe-bench] ${inst.instance_id}: exitReason=${exitReason} resolved=${resolved}`);
}

const resolveRate = results.length > 0 ? results.filter(r => r.resolved).length / results.length : 0;
const summary = {
  total:       results.length,
  resolved:    results.filter(r => r.resolved).length,
  resolveRate: (resolveRate * 100).toFixed(1) + '%',
  results,
};

console.log(JSON.stringify(summary, null, 2));
