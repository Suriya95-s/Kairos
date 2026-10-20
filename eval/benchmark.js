#!/usr/bin/env node
// eval/benchmark.js
// Step-efficiency benchmark: runs agent on a set of tasks and reports
// steps-to-completion, latency, and success rate.
// Usage: node eval/benchmark.js [tasks.json] [--workspace-dir <dir>] [--timeout-ms <ms>]
// Task 6.12

import fs from 'node:fs';
import path from 'node:path';
import { runLoop } from '../src/loop.js';
import { getFlag, getIntFlag, positional } from './args.js';

const args = process.argv.slice(2);
const tasksFile    = positional(args);
const workspaceBase = getFlag(args, '--workspace-dir', '/tmp/kairos-bench');
const timeoutMs    = getIntFlag(args, '--timeout-ms', 300000, { min: 1 });

// Default micro-benchmark tasks if no file given
const DEFAULT_TASKS = [
  { id: 'hello-file',     task: 'Create a file hello.txt containing "Hello, Kairos!"' },
  { id: 'sum-function',   task: 'Create sum.js that exports a function sum(a,b) returning a+b' },
  { id: 'fibonacci',      task: 'Create fib.js that exports fib(n) returning the nth Fibonacci number' },
];

let tasks;
if (tasksFile && fs.existsSync(tasksFile)) {
  tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
} else {
  tasks = DEFAULT_TASKS;
}

const results = [];

for (const t of tasks) {
  const ws = path.join(workspaceBase, t.id || `task-${Date.now()}`);
  fs.mkdirSync(ws, { recursive: true });

  const startMs = Date.now();
  let loopResult = null;
  let timedOut   = false;

  try {
    const timer = setTimeout(() => { timedOut = true; }, timeoutMs);
    loopResult = await runLoop({ task: t.task, workspace: ws });
    clearTimeout(timer);
  } catch (err) {
    loopResult = { exitReason: `exception: ${err.message}`, totalSteps: 0, avgStepLatencyMs: 0 };
  }

  const wallMs = Date.now() - startMs;
  const rec = {
    id:               t.id,
    success:          loopResult.exitReason === 'completed',
    timedOut,
    exitReason:       loopResult.exitReason,
    totalSteps:       loopResult.totalSteps,
    wallMs,
    avgStepLatencyMs: loopResult.avgStepLatencyMs || 0,
    p95StepLatencyMs: loopResult.p95StepLatencyMs || 0,
  };
  results.push(rec);
  console.error(`[bench] ${t.id}: steps=${rec.totalSteps} wall=${wallMs}ms success=${rec.success}`);
}

const n       = results.length;
const passed  = results.filter(r => r.success).length;
const avgSteps = n > 0 ? Math.round(results.reduce((s, r) => s + r.totalSteps, 0) / n) : 0;
const avgWall  = n > 0 ? Math.round(results.reduce((s, r) => s + r.wallMs, 0) / n) : 0;

const summary = {
  total:       n,
  passed,
  successRate: n > 0 ? (passed / n * 100).toFixed(1) + '%' : 'N/A',
  avgSteps,
  avgWallMs:   avgWall,
  results,
};

console.log(JSON.stringify(summary, null, 2));
