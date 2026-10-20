#!/usr/bin/env node
// scripts/mock-llm.mjs
// Minimal mock OpenAI-compatible server for tracing the agent loop end-to-end.
// Returns a fixed script of tool actions. Each POST to /v1/chat/completions
// pops the next scripted response from the queue.
//
// Usage:  node scripts/mock-llm.mjs [port]

import http from 'node:http';

const PORT = parseInt(process.argv[2] || '3099', 10);

// ── Scripted response queue ────────────────────────────────────────────────
// Each entry is what the "LLM" returns for one call.
// Calls arrive in order:
//   Step 1 → think       (reason about the task)
//   Step 2 → list_dir    (explore workspace)
//   Step 3 → update_plan (lay out a plan)
//   Step 4 → write_file  (create the deliverable)
//   Step 5 → finish      (signal completion)
//   Step 6 → verification call → return verified:true JSON

const SCRIPT = [
  // ── Step 1: think ──────────────────────────────────────────────────────
  JSON.stringify({
    thought: 'I need to understand the task. The user wants a hello-world.txt file. I should plan the work, then create the file, then finish.',
    tool: 'think',
    args: {
      content: 'Task: Create hello-world.txt with "Hello, World!". Steps: (1) update plan, (2) write the file, (3) finish.'
    }
  }),

  // ── Step 2: list_dir — explore workspace first ─────────────────────────
  JSON.stringify({
    thought: 'Let me see what is already in the workspace before writing anything.',
    tool: 'list_dir',
    args: { path: '.' }
  }),

  // ── Step 3: update_plan — create a structured plan ─────────────────────
  JSON.stringify({
    thought: 'Workspace explored. Now I will lay out a plan so the loop can track progress.',
    tool: 'update_plan',
    args: {
      content: `# Plan

### Phase 1: Create File
- [ ] Write hello-world.txt with content "Hello, World!"

### Phase 2: Verify & Finish
- [ ] Confirm file exists and finish
`
    }
  }),

  // ── Step 4: write_file — do the actual work ────────────────────────────
  JSON.stringify({
    thought: 'Plan is recorded. Now I will create the hello-world.txt file.',
    tool: 'write_file',
    args: {
      path: 'hello-world.txt',
      content: 'Hello, World!\n'
    }
  }),

  // ── Step 5: finish — signal completion ────────────────────────────────
  JSON.stringify({
    thought: 'File written successfully. I will now call finish with a clear summary.',
    tool: 'finish',
    args: {
      summary: 'Created hello-world.txt containing "Hello, World!" in the workspace root.'
    }
  }),

  // ── Verification call (6th call) ──────────────────────────────────────
  // The loop makes a second chatCompletion call to verify the finish.
  JSON.stringify({
    verified: true,
    reason: 'The agent wrote hello-world.txt with the correct content and the plan phases were completed.'
  }),
];

let callCount = 0;

// ── HTTP Server ────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const idx = callCount++;
    const content = SCRIPT[idx] ?? JSON.stringify({
      thought: 'All scripted responses used.',
      tool: 'finish',
      args: { summary: 'Scripted sequence exhausted.' }
    });

    // Pretty-print what the mock received (messages array is large, just log call # and model)
    let model = '?';
    try { model = JSON.parse(body).model; } catch {}
    console.error(`[mock] call #${idx + 1}  model=${model}  → returning scripted response`);

    const openAIResponse = {
      id: `mock-${idx + 1}`,
      object: 'chat.completion',
      model: model || 'mock',
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 500, completion_tokens: 80, total_tokens: 580 },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(openAIResponse));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[mock] LLM server listening on http://127.0.0.1:${PORT}`);
  console.error(`[mock] Scripted ${SCRIPT.length} responses — will loop on last after that`);
});
