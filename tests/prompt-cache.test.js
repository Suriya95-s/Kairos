// tests/prompt-cache.test.js — the system prompt must be byte-stable across
// steps so the provider's prompt-prefix cache survives. Per-step routed tool
// schemas belong in the user message, not the system prompt.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWorkspace, initAgentDir } from '../src/state.js';
import { buildMessages } from '../src/context.js';
import { WorkingMemory } from '../src/memory.js';
import { TOOL_DEFINITIONS } from '../src/tools.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-')); setWorkspace(dir); initAgentDir(); });
afterEach(() => { if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); });

const byName = (n) => TOOL_DEFINITIONS.find((t) => t.function.name === n);
const sysOf = (m) => m.find((x) => x.role === 'system').content;
const usrOf = (m) => m.find((x) => x.role === 'user').content;

describe('prompt-prefix cache stability', () => {
  test('system prompt is byte-identical across steps with different routed tools', () => {
    const m1 = buildMessages({ step: 1, memory: new WorkingMemory(), workspace: dir, routedTools: [byName('read_file'), byName('write_file')].filter(Boolean) });
    const m2 = buildMessages({ step: 2, memory: new WorkingMemory(), workspace: dir, routedTools: [byName('run_command'), byName('finish')].filter(Boolean) });
    assert.equal(sysOf(m1), sysOf(m2), 'system prompt must not change when routed tools change');
  });

  test('system prompt carries no embedded tool JSON schema', () => {
    const m = buildMessages({ step: 1, memory: new WorkingMemory(), workspace: dir, routedTools: [byName('read_file')].filter(Boolean) });
    assert.ok(!sysOf(m).includes('"parameters"'), 'tool schemas must not live in the cached system prompt');
  });

  test('routed tool schemas appear in the per-step user message', () => {
    const m = buildMessages({ step: 1, memory: new WorkingMemory(), workspace: dir, routedTools: [byName('run_command')].filter(Boolean) });
    const u = usrOf(m);
    assert.ok(u.includes('Tools Available This Step'), 'user message must include the per-step tool section');
    assert.ok(u.includes('run_command') && u.includes('"parameters"'), 'routed schema must be in the user message');
  });
});
