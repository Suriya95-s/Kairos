#!/usr/bin/env node
// demo.js — renders the redesigned Kairos cockpit (Aurora grade) with fake data,
// no TTY and no agent required. Showcases the real composeFrame() path across the
// layout presets, the docked approval interrupt, and mono mode.
//
//   node apps/tui/demo.js            # color
//   AGENT_TUI_MONO=1 node apps/tui/demo.js   # force the whole run mono
//   COLORTERM=truecolor node apps/tui/demo.js  # 24-bit Aurora

import { state, setState, addStep } from './src/state.js';
import { composeFrame } from './src/app.js';
import { C, setActiveTheme } from './src/render.js';

const W = Math.min(process.stdout.columns || 110, 110);
const H = 26;

setActiveTheme('aurora');

setState({
  showSplash: false, connected: true, connecting: false,
  episodeId: 'ep_demo_7f3a9c',
  task: 'Refactor authentication middleware to use JWT + refresh tokens',
  status: 'running', step: 14, stage: 'implement', model: 'claude-opus-4-8', costUsd: 0.187,
  totalTokens: 42300,
  agentPipeline: [
    { role: 'orchestrator', status: 'done' },
    { role: 'implementer',  status: 'running' },
    { role: 'verifier',     status: 'idle' },
  ],
  focusChain: [
    { text: 'scope the auth module', state: 'done' },
    { text: 'write jwt helper', state: 'done' },
    { text: 'fix refresh flow', state: 'current' },
    { text: 'verify tests', state: 'pending' },
    { text: 'commit', state: 'pending' },
  ],
  stepLatenciesMs: [820, 1100, 950, 2300, 1450, 880, 3100, 720, 1650, 2900, 1200, 870, 4200, 1050],
  costHistory: [0.02, 0.05, 0.08, 0.10, 0.12, 0.14, 0.16, 0.187],
  pendingApprovals: [], _spinFrame: 2,
  skills: [
    { name: 'write_file', grade: 'A' }, { name: 'run_tests', grade: 'B' }, { name: 'read_file', grade: 'A' },
  ],
  palaceEvents: [
    { tool: 'read_file', step: 10, who: 'kairos' }, { tool: 'write_file', step: 12, who: 'kairos' },
    { tool: 'run_tests', step: 13, who: 'kairos' }, { tool: 'edit_function', step: 14, who: 'kairos' },
  ],
});

const fakeSteps = [
  { step: 14, tool: 'edit', arg: 'src/auth/jwt.js', thought: 'Fix the token expiry check in the refresh flow', result: '+ async function refreshToken(t){\n+   return verify(t, SECRET)\n- old slug\n  18/20 passing', error: false, latencyMs: 1200, startMs: Date.now() - 1200 },
  { step: 13, tool: 'bash', arg: 'npm test src/auth', thought: 'Verify JWT impl', result: '18/20 ✓ — 2 failures in refresh_token.test.js', error: false, latencyMs: 5400 },
  { step: 12, tool: 'write', arg: 'src/auth/jwt.js', thought: 'Create JWT helper', result: 'Wrote 94 lines', error: false, latencyMs: 320 },
  { step: 11, tool: 'grep', arg: 'verifyToken', thought: 'Find callers', result: '8 references in 4 files', error: false, latencyMs: 110 },
  { step: 10, tool: 'read', arg: 'src/auth/middleware.js', thought: 'Understand existing shape', result: '247 lines', error: false, latencyMs: 200 },
];
for (const s of fakeSteps) addStep(s);
state.steps = fakeSteps;

function show(label, hint) {
  process.stdout.write(`\n${C.bold}${C.iris}  ◆ ${label}${C.reset}   ${C.ink4}${hint || ''}${C.reset}\n`);
  process.stdout.write(`${C.rule}${'─'.repeat(W)}${C.reset}\n`);
  process.stdout.write(composeFrame(W, H).join('\n') + '\n');
}

setState({ view: 'live', layoutPreset: 'split' });
show('LIVE · Split preset', 'classic 3-col — [L] cycles layouts');

setState({ layoutPreset: 'focus' });
show('LIVE · Focus preset', 'thin rail + wide output + ambient vitals ribbon');

setState({ layoutPreset: 'wide' });
show('LIVE · Wide preset', 'output-only + status spine, for long diffs');

setState({ layoutPreset: 'split', pendingApprovals: [{
  id: 'req_8f2a1c', tool: 'git_push', args: { remote: 'origin', branch: 'feat/jwt-auth' },
  reason: 'Push the JWT refactor branch to origin — triggers CI', timestamp: Date.now() - 45000, timeoutMs: 600000,
}], hitlCursor: 0 });
show('APPROVAL INTERRUPT', 'docks into the top band on EVERY view — escalates by glyph + weight');

setState({ pendingApprovals: [] });
process.env.AGENT_TUI_MONO = '1';
show('MONO mode (NO_COLOR)', 'zero color — state survives on glyph + caps + position');
delete process.env.AGENT_TUI_MONO;

process.stdout.write(`\n${C.ink3}  Run it live:  ${C.reset}${C.ink2}node apps/tui/index.js --port 5180${C.reset}\n`);
process.stdout.write(`${C.ink3}  Themes/density: Settings (,) → Theme / Density · Layout: [L] · Help: [?]${C.reset}\n\n`);
