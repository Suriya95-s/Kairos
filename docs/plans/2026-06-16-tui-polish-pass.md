# TUI Polish Pass Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with the executing-plans skill, or dispatch a fresh subagent (Agent tool) per task with review between tasks. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the Kairos TUI's day-to-day UX — surface per-step timing & trend in the Live view, make keys discoverable per-view, add curated color themes, and guide first-run setup — without new dependencies and without breaking the mono/reduced-motion accessibility floor.

**Architecture:** Build on existing primitives in `apps/tui/src`. Pure helpers (`sparkline`, `fmtDuration`, `wrapLine`, `accent`, `setActiveTheme`) go in `render.js` and are unit-tested offline. The Live view (`views/live.js`) surfaces data already in `state` (`stepLatenciesMs`, a new `costHistory`, and a new per-step `latencyMs`). Discoverability folds into the **existing** `renderHintsLine` in `components/commandBar.js` (view-aware) rather than a new file — the codebase already renders a hints line there; adding a second footer would duplicate it. Onboarding folds the setup checklist into the **existing** `renderSplash` in `app.js` (already gated by `state.showSplash`) rather than a new overlay. Theming is a single accent indirection in `render.js` (`let _theme`, `setActiveTheme`, `accent()`) so the blast radius is contained and mono always wins.

**Tech Stack:** Node.js ESM (Node ≥18), zero runtime deps, `node --test`. Test command: `node --test tests/<file>.test.js`. Full suite: `npm test`.

**Deviations from the spec (intentional, same intent, less code):**
- B (footer) is implemented by making the existing `renderHintsLine` view-aware + trimming duplicate per-panel trailer rows, **not** a new `components/footer.js`.
- D (onboarding) is implemented as a checklist block inside the existing `renderSplash`, **not** a new overlay.

**Sequencing:** A → B → D → C. Each task ends green; commit after each.

---

## Workstream A — Live view richness

### Task A1: `fmtDuration` + `sparkline` + `wrapLine` pure helpers in render.js

**Files:**
- Modify: `apps/tui/src/render.js` (add exports near the string helpers, ~line 84)
- Test: `tests/tui-live-richness.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/tui-live-richness.test.js`:

```js
// tests/tui-live-richness.test.js — Workstream A: surface timing/trend data in
// the Live view. Pure helpers (fmtDuration/sparkline/wrapLine) + colorizeOutput
// diff tint + per-step duration rendering. All offline, mono-asserted.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { fmtDuration, sparkline, wrapLine, stripAnsi } from '../apps/tui/src/render.js';

describe('fmtDuration', () => {
  test('sub-second renders as Nms', () => {
    assert.equal(fmtDuration(0), '0ms');
    assert.equal(fmtDuration(450), '450ms');
    assert.equal(fmtDuration(999), '999ms');
  });
  test('>= 1s renders as N.Ns', () => {
    assert.equal(fmtDuration(1000), '1.0s');
    assert.equal(fmtDuration(1234), '1.2s');
    assert.equal(fmtDuration(5400), '5.4s');
  });
  test('nullish / negative → empty string', () => {
    assert.equal(fmtDuration(null), '');
    assert.equal(fmtDuration(undefined), '');
    assert.equal(fmtDuration(-5), '');
  });
});

describe('sparkline', () => {
  test('empty input → empty string', () => {
    assert.equal(sparkline([], 8), '');
    assert.equal(sparkline(null, 8), '');
  });
  test('maps min→lowest glyph, max→highest glyph', () => {
    const s = sparkline([0, 100], 8);
    assert.equal(stripAnsi(s)[0], '▁');
    assert.equal(stripAnsi(s)[stripAnsi(s).length - 1], '█');
  });
  test('flat data (min==max) → mid-tier bar, no NaN', () => {
    const s = stripAnsi(sparkline([5, 5, 5], 8));
    assert.equal(s.length, 3);
    assert.ok(!s.includes('NaN'));
    assert.ok('▁▂▃▄▅▆▇█'.includes(s[0]));
  });
  test('keeps only the last `width` samples', () => {
    const s = stripAnsi(sparkline([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3));
    assert.equal(s.length, 3);
  });
});

describe('wrapLine', () => {
  test('short line returned as single element', () => {
    assert.deepEqual(wrapLine('hello', 10), ['hello']);
  });
  test('wraps on word boundaries', () => {
    assert.deepEqual(wrapLine('aaa bbb ccc', 7), ['aaa bbb', 'ccc']);
  });
  test('hard-breaks a token longer than width (never drops chars)', () => {
    const out = wrapLine('abcdefghij', 4);
    assert.deepEqual(out, ['abcd', 'efgh', 'ij']);
    assert.equal(out.join(''), 'abcdefghij');
  });
  test('empty string → single empty element', () => {
    assert.deepEqual(wrapLine('', 5), ['']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/tui-live-richness.test.js`
Expected: FAIL — `fmtDuration`/`sparkline`/`wrapLine` are not exported.

- [ ] **Step 3: Implement the helpers in render.js**

In `apps/tui/src/render.js`, after `export function hline(...)` (~line 84), add:

```js
// ── Timing / trend formatting (Workstream A) ──────────────────────────────────

/** Human duration: <1s → "450ms", else "1.2s". Nullish/negative → "". */
export function fmtDuration(ms) {
  if (ms == null || !(ms >= 0)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const SPARK_GLYPHS = '▁▂▃▄▅▆▇█';

/**
 * Unicode block sparkline scaled to the data's min..max over the last `width`
 * samples. Empty input → "". Flat data → a mid-tier bar (no divide-by-zero).
 * Color is left to the caller; the glyphs render fine in mono.
 * @param {number[]} nums @param {number} width
 */
export function sparkline(nums, width = 16) {
  if (!Array.isArray(nums) || nums.length === 0) return '';
  const data = nums.slice(-width);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min;
  const mid = SPARK_GLYPHS[Math.floor((SPARK_GLYPHS.length - 1) / 2)];
  return data.map((n) => {
    if (span === 0) return mid;
    const t = (n - min) / span;
    const idx = Math.min(SPARK_GLYPHS.length - 1, Math.round(t * (SPARK_GLYPHS.length - 1)));
    return SPARK_GLYPHS[idx];
  }).join('');
}

/**
 * Wrap `text` to `width` columns on word boundaries; tokens longer than `width`
 * are hard-broken so no characters are ever dropped. Empty string → [''].
 * @param {string} text @param {number} width @returns {string[]}
 */
export function wrapLine(text, width) {
  const s = String(text ?? '');
  if (s === '') return [''];
  if (width <= 0) return [s];
  const out = [];
  let line = '';
  for (const word of s.split(' ')) {
    let w = word;
    // Hard-break a single token that cannot fit on its own line.
    while (w.length > width) {
      if (line) { out.push(line); line = ''; }
      out.push(w.slice(0, width));
      w = w.slice(width);
    }
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length > width) { out.push(line); line = w; }
    else line = candidate;
  }
  if (line || out.length === 0) out.push(line);
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/tui-live-richness.test.js`
Expected: PASS (fmtDuration, sparkline, wrapLine describes green).

- [ ] **Step 5: node --check**

Run: `node --check apps/tui/src/render.js`
Expected: no output (valid).

- [ ] **Step 6: Commit**

```bash
git add apps/tui/src/render.js tests/tui-live-richness.test.js
git commit --no-gpg-sign -m "feat(tui): add fmtDuration/sparkline/wrapLine render primitives"
```

---

### Task A2: Persist per-step `latencyMs` and add `costHistory` state

**Files:**
- Modify: `apps/tui/src/app.js` (`tool_result` handler ~line 1866; `step` handler ~line 1851)
- Modify: `apps/tui/src/state.js` (add `costHistory`, ~line 62)

- [ ] **Step 1: Add `costHistory` to state**

In `apps/tui/src/state.js`, immediately after the `stepLatenciesMs: [],` line (~line 62), add:

```js
  costHistory: [],      // last 200 cumulative-cost samples (session-only), for the trend sparkline
```

- [ ] **Step 2: Persist latency onto the step in `tool_result`**

In `apps/tui/src/app.js`, in the `case 'tool_result':` block (~line 1866-1877), set `latencyMs` on the step. Change:

```js
      const s = state.steps[0];
      if (s) {
        const latency = Date.now() - (s.startMs || Date.now());
        s.result = ev.result || '';
        s.error  = !!ev.error;
        const lats = [...state.stepLatenciesMs, latency].slice(-200);
        setState({ stepLatenciesMs: lats });
```

to:

```js
      const s = state.steps[0];
      if (s) {
        const latency = Date.now() - (s.startMs || Date.now());
        s.result = ev.result || '';
        s.error  = !!ev.error;
        s.latencyMs = latency;            // surfaced in the STEPS panel (Workstream A)
        const lats = [...state.stepLatenciesMs, latency].slice(-200);
        setState({ stepLatenciesMs: lats });
```

- [ ] **Step 3: Sample cost on each `step` event**

In `apps/tui/src/app.js`, in the `case 'step':` block (~line 1851-1864), after the `addStep({...})` call and before `break;`, add a cost sample:

```js
      setState({ costHistory: [...state.costHistory, state.costUsd].slice(-200) });
      break;
```

(Place it right before the existing `break;` that closes `case 'step':`.)

- [ ] **Step 4: Reset `costHistory` on run start**

In `apps/tui/src/app.js`, in the run-start `setState({...})` that resets `stepLatenciesMs: [], steps: [],` (~line 1843), add `costHistory: [],` to the same object:

```js
        step: 0, costUsd: 0, totalTokens: 0,
        stepLatenciesMs: [], costHistory: [], steps: [],
```

- [ ] **Step 5: node --check**

Run: `node --check apps/tui/src/app.js && node --check apps/tui/src/state.js`
Expected: no output.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: all green (existing count, unchanged behavior).

- [ ] **Step 7: Commit**

```bash
git add apps/tui/src/app.js apps/tui/src/state.js
git commit --no-gpg-sign -m "feat(tui): persist per-step latencyMs and sample costHistory"
```

---

### Task A3: Render per-step duration + sparklines + output wrap/diff in live.js

**Files:**
- Modify: `apps/tui/src/views/live.js` (`buildStepRows`, `buildOutputRows`, `colorizeOutput`, `buildInfoRows`)
- Test: `tests/tui-live-richness.test.js` (extend)

- [ ] **Step 1: Add failing tests for live rendering**

Append to `tests/tui-live-richness.test.js`:

```js
import { state, setState } from '../apps/tui/src/state.js';
import { renderLive } from '../apps/tui/src/views/live.js';
import { colorizeOutput } from '../apps/tui/src/views/live.js';

describe('live view richness', () => {
  test('a completed step shows its duration token', () => {
    setState({
      steps: [{ step: 7, tool: 'edit', arg: 'app.js', result: 'ok', error: false, latencyMs: 1234 }],
      status: 'completed', pinnedIdx: null, stepsScroll: 0, outputScroll: 0,
      pendingApprovals: [], task: 't', stage: '', model: 'm',
      stepLatenciesMs: [1234], costHistory: [0.01], palaceEvents: [], skills: [],
    });
    const text = renderLive(120, 24).map(stripAnsi).join('\n');
    assert.match(text, /1\.2s/);
  });
  test('a slow step (>=5s) is flagged with ⚠', () => {
    setState({
      steps: [{ step: 8, tool: 'bash', arg: '', result: 'done', error: false, latencyMs: 5400 }],
      status: 'completed', pinnedIdx: null, stepsScroll: 0, outputScroll: 0,
      pendingApprovals: [], task: 't', stage: '', model: 'm',
      stepLatenciesMs: [5400], costHistory: [0.02], palaceEvents: [], skills: [],
    });
    const text = renderLive(120, 24).map(stripAnsi).join('\n');
    assert.match(text, /5\.4s/);
    assert.match(text, /⚠/);
  });
  test('INFO panel shows a LATENCY section', () => {
    setState({
      steps: [{ step: 1, tool: 'read', result: 'x', error: false, latencyMs: 300 }],
      status: 'running', pinnedIdx: null, stepsScroll: 0, outputScroll: 0,
      pendingApprovals: [], task: 't', stage: '', model: 'm',
      stepLatenciesMs: [300, 800, 1200], costHistory: [0.01, 0.02], palaceEvents: [], skills: [],
    });
    const text = renderLive(120, 24).map(stripAnsi).join('\n');
    assert.match(text, /LATENCY/);
  });
  test('colorizeOutput tints + / - diff lines', () => {
    assert.match(colorizeOutput('+ added line'), /\x1b\[32m/);  // green
    assert.match(colorizeOutput('- removed line'), /\x1b\[31m/); // red
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/tui-live-richness.test.js`
Expected: FAIL — `colorizeOutput` not exported / no duration token / no LATENCY section.

- [ ] **Step 3: Render the duration in `buildStepRows`**

In `apps/tui/src/views/live.js`, update the imports on line 4-6 to include `sparkline, fmtDuration`:

```js
import {
  threeColTop, threeColBot, threeColRow, colWidths,
  C, g, y, r, gr, vi, dim, bold, cell, clip, padEnd, reducedMotion,
  sparkline, fmtDuration,
} from '../render.js';
```

Then in `buildStepRows`, replace the row push (currently line ~87):

```js
    rows.push(`${bg} ${icon} ${gr(stepNum)}  ${toolStr}${rst}`);
```

with a version that appends the duration for completed steps:

```js
    let durTok = '';
    if (!isCurrent && step.latencyMs != null) {
      const slow = step.latencyMs >= 5000;
      durTok = '  ' + (slow ? y(fmtDuration(step.latencyMs) + ' ⚠') : gr(fmtDuration(step.latencyMs)));
    }
    rows.push(`${bg} ${icon} ${gr(stepNum)}  ${toolStr}${durTok}${rst}`);
```

- [ ] **Step 4: Add LATENCY + cost sparkline to `buildInfoRows`**

In `apps/tui/src/views/live.js`, in `buildInfoRows`, locate the `// MODEL` section (~line 202-205). Immediately after the MODEL `divider();` call, insert a LATENCY section and extend cost:

```js
  // LATENCY (trend)
  if (state.stepLatenciesMs.length) {
    section('LATENCY');
    const p95 = latencyP(0.95);
    const spark = sparkline(state.stepLatenciesMs, Math.max(3, w - 12));
    push(`${gr('p95')} ${y((p95 / 1000).toFixed(1) + 's')}  ${C.cyan}${spark}${C.reset}`);
    divider();
  }

  // COST (trend)
  if (state.costHistory && state.costHistory.length) {
    section('COST');
    const spark = sparkline(state.costHistory, Math.max(3, w - 12));
    push(`${C.green}$${state.costUsd.toFixed(3)}${C.reset}  ${C.cyan}${spark}${C.reset}`);
    divider();
  }
```

`latencyP` is already imported on line 7 (`import { state, avgLatency, latencyP } from '../state.js';`). If `avgLatency` is unused after this, leave it — do not churn the import.

- [ ] **Step 5: Wrap output lines + export & extend `colorizeOutput`**

In `apps/tui/src/views/live.js`, change `colorizeOutput` from a local `function` to an exported one and add diff rules at the top:

```js
export function colorizeOutput(line) {
  if (/^\+ /.test(line)) return C.green + line + C.reset;   // unified-diff add
  if (/^- /.test(line))  return C.red + line + C.reset;     // unified-diff remove
  if (/✓|passing|PASS/i.test(line)) return C.green + line + C.reset;
  if (/✗|failing|FAIL|error|Error/i.test(line)) return C.red + line + C.reset;
  if (/warning|warn/i.test(line)) return C.yellow + line + C.reset;
  if (/^\s*>/.test(line)) return C.grey + line + C.reset;
  return line;
}
```

Then in `buildOutputRows`, replace the truncating loop (currently ~line 143-146):

```js
  for (const line of visible) {
    const colored = colorizeOutput(line.slice(0, w - 1));
    rows.push(' ' + colored);
  }
```

with a wrapping version (import `wrapLine` — add it to the render import list from Step 3, making it `sparkline, fmtDuration, wrapLine`):

```js
  for (const line of visible) {
    for (const seg of wrapLine(line, w - 1)) {
      rows.push(' ' + colorizeOutput(seg));
      if (rows.length >= h) break;
    }
    if (rows.length >= h) break;
  }
```

- [ ] **Step 6: Run the richness test**

Run: `node --test tests/tui-live-richness.test.js`
Expected: PASS (all describes).

- [ ] **Step 7: Mono assertion + full suite**

Run: `AGENT_TUI_MONO=1 node --test tests/tui-live-richness.test.js && npm test`
Expected: richness file green under mono; full suite green.

- [ ] **Step 8: node --check + commit**

```bash
node --check apps/tui/src/views/live.js
git add apps/tui/src/views/live.js tests/tui-live-richness.test.js
git commit --no-gpg-sign -m "feat(tui): per-step durations, latency/cost sparklines, output wrap+diff tint"
```

---

## Workstream B — Discoverability

### Task B1: Make `renderHintsLine` view-aware and drop duplicate panel trailers

**Files:**
- Modify: `apps/tui/src/components/commandBar.js` (`renderHintsLine`)
- Modify: `apps/tui/src/views/live.js` (remove the duplicated `[↑↓] scroll …` trailer rows)
- Test: `tests/tui-footer.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/tui-footer.test.js`:

```js
// tests/tui-footer.test.js — Workstream B: the command-bar hints line is
// view-aware (shows keys for the active view) and always advertises [?] Help.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { renderCommandBar } from '../apps/tui/src/components/commandBar.js';
import { stripAnsi } from '../apps/tui/src/render.js';

function hints() {
  // last line of the command bar is the hints line
  const bar = renderCommandBar(120).map(stripAnsi);
  return bar[bar.length - 1];
}

describe('view-aware hints line', () => {
  beforeEach(() => {
    setState({ cmdInputActive: false, overlay: null, attachments: [],
      pendingApprovals: [], settingsOpen: false });
  });
  test('live view advertises pin + model keys', () => {
    setState({ view: 'live' });
    const h = hints();
    assert.match(h, /Enter/);
    assert.match(h, /pin/i);
    assert.match(h, /\[\?\] Help/);
  });
  test('memory view advertises temporal/rooms/search', () => {
    setState({ view: 'memory' });
    const h = hints();
    assert.match(h, /Temporal|temporal/);
    assert.match(h, /Search|search/);
    assert.match(h, /\[\?\] Help/);
  });
  test('metrics view advertises export', () => {
    setState({ view: 'metrics' });
    assert.match(hints(), /Export|export/);
    assert.match(hints(), /\[\?\] Help/);
  });
  test('hints line is exactly one row, width-padded', () => {
    setState({ view: 'live' });
    const bar = renderCommandBar(120);
    const last = bar[bar.length - 1];
    assert.equal(stripAnsi(last).length, 120);
  });
  test('mono mode → no SGR codes in the hints line', () => {
    process.env.AGENT_TUI_MONO = '1';
    setState({ view: 'live' });
    const raw = renderCommandBar(120);
    delete process.env.AGENT_TUI_MONO;
    const last = raw[raw.length - 1];
    assert.ok(!/\x1b\[/.test(last), 'expected no ANSI escapes under mono');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/tui-footer.test.js`
Expected: FAIL — live view hints lack "pin"; memory lacks temporal/search; metrics lacks export.

- [ ] **Step 3: Add per-view action hints in `renderHintsLine`**

In `apps/tui/src/components/commandBar.js`, in `renderHintsLine`, find the default (non-chat, non-cmd) block that builds `base` and `actions`. Replace the `const actions = [];` line and the lines up to (but not including) `actions.push(...[/])` with a view-aware set:

```js
  const actions = [];

  if (state.pendingApprovals.length > 0) {
    actions.push(`${C.bold}${C.green}[A]${C.reset} Approve`);
    actions.push(`${C.bold}${C.red}[D]${C.reset} Deny`);
  }

  // View-specific keys (Workstream B — discoverability without opening help).
  if (state.view === 'live') {
    actions.push(gr('[↑↓] steps'), gr('[Enter] pin'), gr('[M] model'));
  } else if (state.view === 'memory') {
    actions.push(gr('[T] Temporal'), gr('[R] Rooms'), gr('[/] Search'), gr('[Tab] panel'));
  } else if (state.view === 'metrics') {
    actions.push(gr('[E] Export'));
  } else if (state.view === 'council') {
    actions.push(gr('[M] lineup'));
  }

  actions.push(`${C.bold}${C.cyan}[/]${C.reset} Commands`);
  actions.push(gr('[?] Help'));
  actions.push(`${C.bold}${C.red}[Q]${C.reset} Quit`);
```

(Keep the existing `const base = [...]` tabs array above unchanged, and the final `const line = ' ' + [...base, '  ', ...actions].join('  '); return padEnd(line, W);` unchanged.)

- [ ] **Step 4: Remove the now-duplicated trailer rows in live.js**

In `apps/tui/src/views/live.js`, `buildStepRows` ends with (currently ~line 108-109):

```js
  rows.push('');
  rows.push(gr(`  [↑↓] scroll  [Enter] pin${state.pinnedIdx !== null ? '  [Esc] unpin' : ''}`));
```

Replace those two lines with a single dynamic-only hint (keep the unpin affordance which is stateful, drop the static scroll/pin now in the footer):

```js
  if (state.pinnedIdx !== null) {
    rows.push('');
    rows.push(gr('  [Esc] unpin'));
  }
```

And `buildOutputRows` ends with (currently ~line 156-157):

```js
  rows.push('');
  rows.push(gr('  [↑↓] scroll  [PgUp/Dn]  [End] live'));
```

Remove those two lines entirely (scroll keys now live in the footer; the dynamic `↓ scrolled up N lines — [End] to follow live` hint above already remains for the stateful case).

- [ ] **Step 5: Run footer test + full suite**

Run: `node --test tests/tui-footer.test.js && npm test`
Expected: footer green; full suite green (note: `tui-cockpit`/`tui-frame` may assert on hint text — if any fail, update those assertions to match the new view-aware hints, since the change is intentional).

- [ ] **Step 6: node --check + commit**

```bash
node --check apps/tui/src/components/commandBar.js && node --check apps/tui/src/views/live.js
git add apps/tui/src/components/commandBar.js apps/tui/src/views/live.js tests/tui-footer.test.js
git commit --no-gpg-sign -m "feat(tui): view-aware hints line; drop duplicated live-panel trailers"
```

---

### Task B2: Regroup the help overlay into aligned sections

**Files:**
- Modify: `apps/tui/src/app.js` (`renderHelpOverlay` ~line 847-894)

- [ ] **Step 1: Tidy the help content (content-only change)**

In `apps/tui/src/app.js`, `renderHelpOverlay`, reorganize the `lines` array so each section has a bold header followed by aligned `key  description` pairs. Replace the existing `const lines = [ ... ];` block with:

```js
  const pad = (k) => k.padEnd(10);
  const lines = [
    '',
    `  ${bold('GLOBAL')}`,
    `  ${g(pad('1–5'))} ${gr('Live · Memory · Metrics · Chat · Council')}`,
    `  ${g(pad(','))} ${gr('Settings')}   ${g(pad('?'))} ${gr('This help')}`,
    `  ${y(pad('Space/P'))} ${gr('Pause/Resume')}   ${g(pad('A'))} ${gr('Approve')}   ${r(pad('D'))} ${gr('Deny')}`,
    `  ${y(pad('S'))} ${gr('Steer')}   ${g(pad('/'))} ${gr('Commands')}   ${r(pad('Q'))} ${gr('Quit')}`,
    '',
    `  ${bold('LIVE')}  ${gr('(approvals appear here inline)')}`,
    `  ${g(pad('↑↓'))} ${gr('Scroll steps')}   ${g(pad('Enter'))} ${gr('Pin output')}   ${g(pad('Esc'))} ${gr('Unpin')}`,
    `  ${g(pad('PgUp/Dn'))} ${gr('Scroll output')}   ${g(pad('M'))} ${gr('Model picker')}   ${g(pad('←→'))} ${gr('Cycle approvals')}`,
    `  ${gr('Type a message + Enter to steer · drop a file to attach')}`,
    '',
    `  ${bold('MEMORY')}`,
    `  ${g(pad('T'))} ${gr('Temporal')}   ${g(pad('R'))} ${gr('Rooms')}   ${g(pad('/'))} ${gr('Search')}   ${g(pad('Tab'))} ${gr('Switch panel')}`,
    '',
    `  ${bold('METRICS')}`,
    `  ${g(pad('E'))} ${gr('Export to .agent/tui-export.json')}`,
    '',
    `  ${bold('COMMANDS')}  ${gr('(type / then Tab to complete)')}`,
    `  ${g('/model')} ${g('/steer')} ${g('/approve')} ${g('/deny')} ${g('/clarify')} ${g('/memory')}`,
    `  ${g('/chat')} ${g('/clearchat')} ${g('/pause')} ${g('/resume')} ${g('/clear')} ${g('/export')}`,
    `  ${g('/status')} ${g('/reconnect')} ${g('/quit')}`,
    '',
    `  ${gr('Accessibility: NO_COLOR / AGENT_TUI_MONO=1 · AGENT_TUI_NO_SPIN=1 · --no-tui (headless)')}`,
    `  ${gr('[any key] close help')}`,
    '',
  ];
```

(Leave the `OW`/`OH`/`sr`/`sc` math and the draw loop below it unchanged.)

- [ ] **Step 2: node --check + full suite**

Run: `node --check apps/tui/src/app.js && npm test`
Expected: green (help overlay is not asserted line-by-line; if a test checks specific help text, update it to the new wording).

- [ ] **Step 3: Commit**

```bash
git add apps/tui/src/app.js
git commit --no-gpg-sign -m "feat(tui): regroup help overlay into aligned sections"
```

---

## Workstream D — Onboarding (before C; additive)

### Task D1: Setup checklist block in the splash

**Files:**
- Modify: `apps/tui/src/app.js` (`renderSplash` ~line 101-148; add a `buildSetupChecklist` helper)
- Test: `tests/tui-onboarding.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/tui-onboarding.test.js`:

```js
// tests/tui-onboarding.test.js — Workstream D: the splash shows a setup checklist
// reflecting model/key readiness and the keys that fix each gap.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { state, setState } from '../apps/tui/src/state.js';
import { buildSetupChecklist } from '../apps/tui/src/app.js';
import { stripAnsi } from '../apps/tui/src/render.js';

describe('buildSetupChecklist', () => {
  beforeEach(() => setState({ modelSource: 'api', apiKey: '', serverUrl: '', model: '' }));

  test('shows ✗ for an unset model and key, with the fix keys', () => {
    setState({ model: '', apiKey: '' });
    const text = buildSetupChecklist().map(stripAnsi).join('\n');
    assert.match(text, /Model/);
    assert.match(text, /✗/);
    assert.match(text, /\[M\]/);
    assert.match(text, /\[,\]/);
  });
  test('shows ✓ for a set model', () => {
    setState({ model: 'gpt-4o', apiKey: 'sk-x' });
    const text = buildSetupChecklist().map(stripAnsi).join('\n');
    assert.match(text, /✓/);
    assert.match(text, /gpt-4o/);
  });
  test('Local mode checks the endpoint instead of the API key', () => {
    setState({ modelSource: 'local', serverUrl: 'http://localhost:11434/v1', model: 'llama3' });
    const text = buildSetupChecklist().map(stripAnsi).join('\n');
    assert.match(text, /Endpoint|endpoint/);
    assert.match(text, /localhost:11434/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/tui-onboarding.test.js`
Expected: FAIL — `buildSetupChecklist` is not exported.

- [ ] **Step 3: Implement `buildSetupChecklist` and call it from `renderSplash`**

In `apps/tui/src/app.js`, add an exported helper just above `function renderSplash(W, H) {` (~line 100):

```js
/**
 * Setup checklist lines for the splash (Workstream D). Reflects whether a model
 * and a credential/endpoint are configured, with the key that fixes each gap.
 * Exported for tests. Returns styled lines (centering is the caller's job).
 */
export function buildSetupChecklist() {
  const ok = (b) => (b ? g('✓') : r('✗'));
  const apiMode = state.modelSource !== 'local';
  const hasModel = !!state.model;
  const credLabel = apiMode ? 'API key' : 'Endpoint';
  const credVal = apiMode ? state.apiKey : state.serverUrl;
  const hasCred = !!credVal;
  const credShown = apiMode
    ? (hasCred ? 'set' : 'none')
    : (hasCred ? credVal : 'none');
  return [
    `  ${ok(hasModel)} ${bold('Model')}     ${gr('[M]')}  ${hasModel ? C.cyan + state.model + C.reset : gr('not set')}`,
    `  ${ok(hasCred)} ${bold(credLabel.padEnd(8))} ${gr('[,]')}  ${hasCred ? gr(credShown) : gr('none')}`,
    `  ${gr('•')} ${bold('Run a task')} ${gr('[r]')}  ${gr('or type a task + Enter')}`,
  ];
}
```

Then in `renderSplash`, after the status line is pushed (after the block that pushes `statusLine`, ~line 142) and before the connectivity diagnostic block, insert the checklist centered:

```js
  // Setup checklist (Workstream D) — guide first-run config.
  lines.push('');
  for (const cl of buildSetupChecklist()) {
    const clPad = Math.max(0, Math.floor((W - visLen(cl)) / 2));
    lines.push(' '.repeat(clPad) + cl);
  }
```

(`g`, `r`, `bold`, `gr`, `C`, `visLen` are already imported in app.js — verify with `node --check`; if `bold` or `r` is missing from the render import in app.js, add it.)

- [ ] **Step 4: Run onboarding test (mono too)**

Run: `node --test tests/tui-onboarding.test.js && AGENT_TUI_MONO=1 node --test tests/tui-onboarding.test.js`
Expected: PASS both.

- [ ] **Step 5: node --check + full suite**

Run: `node --check apps/tui/src/app.js && npm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/tui/src/app.js tests/tui-onboarding.test.js
git commit --no-gpg-sign -m "feat(tui): first-run setup checklist in the splash"
```

---

## Workstream C — Theme presets (render.js indirection; last)

### Task C1: Theme accent indirection in render.js

**Files:**
- Modify: `apps/tui/src/render.js` (add `_theme`, `THEMES`, `accent`, `setActiveTheme`; route border helpers through `accent()`)
- Test: `tests/tui-theme.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/tui-theme.test.js`:

```js
// tests/tui-theme.test.js — Workstream C: curated accent themes via a single
// indirection. Mono always wins (blanks color). Unknown names fall back to violet.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { accent, setActiveTheme, boxTop } from '../apps/tui/src/render.js';

afterEach(() => { setActiveTheme('violet'); delete process.env.AGENT_TUI_MONO; });

describe('theme accent', () => {
  test('violet (default) accent is the 256-color violet SGR', () => {
    setActiveTheme('violet');
    assert.equal(accent(), '\x1b[38;5;135m');
  });
  test('ocean and warm have distinct accents', () => {
    setActiveTheme('ocean');
    const ocean = accent();
    setActiveTheme('warm');
    const warm = accent();
    assert.notEqual(ocean, warm);
    assert.match(ocean, /\x1b\[38;5;/);
    assert.match(warm, /\x1b\[38;5;/);
  });
  test('unknown theme name falls back to violet', () => {
    setActiveTheme('bogus');
    assert.equal(accent(), '\x1b[38;5;135m');
  });
  test('mono mode blanks the accent regardless of theme', () => {
    setActiveTheme('ocean');
    process.env.AGENT_TUI_MONO = '1';
    assert.equal(accent(), '');
  });
  test('boxTop borders use the active accent', () => {
    setActiveTheme('warm');
    const top = boxTop(20);
    assert.ok(top.includes(accent()), 'box border should carry the active accent');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/tui-theme.test.js`
Expected: FAIL — `accent`/`setActiveTheme` not exported.

- [ ] **Step 3: Add the theme machinery to render.js**

In `apps/tui/src/render.js`, after the `C` Proxy definition (~line 37, before `export function paint`), add:

```js
// ── Theme accent (Workstream C) ───────────────────────────────────────────────
// A single indirection so curated themes recolor borders/titles without touching
// every view. Mono mode (the accessibility floor) always blanks the accent.
const THEMES = {
  violet: { accent: '\x1b[38;5;135m' },
  ocean:  { accent: '\x1b[38;5;39m'  },
  warm:   { accent: '\x1b[38;5;208m' },
};
let _theme = 'violet';

/** Set the active theme; unknown names fall back to violet. */
export function setActiveTheme(name) {
  _theme = THEMES[name] ? name : 'violet';
  return _theme;
}
export function activeTheme() { return _theme; }

/** Current theme's accent SGR, or '' in mono mode. */
export function accent() {
  if (monoMode()) return '';
  return (THEMES[_theme] || THEMES.violet).accent;
}
```

- [ ] **Step 4: Route the border helpers through `accent()`**

In `apps/tui/src/render.js`, replace every `C.violet` used **for box borders** with `accent()`. Specifically:

- `vb`: `function vb(s) { return accent() + s + C.reset; }`
- `boxTop`: replace the three `C.violet` occurrences with `accent()`.
- `boxBot`: `return accent() + T.bl + T.h.repeat(width - 2) + T.br + C.reset;`
- `dboxTop`: replace the three `C.violet` with `accent()`.
- `dboxBot`: replace `C.violet` with `accent()`.
- `threeColTop`/`threeColBot`/`twoColTop`/`twoColBot`/`titledHlineVi`: replace each border `C.violet` with `accent()`.

Leave the `vi()` color helper (`export const vi = s => paint(C.violet, s);`) and any semantic non-border `C.violet` in the views as-is for this task (handled where needed; not required for tests).

- [ ] **Step 5: Run theme test (+mono) + full suite**

Run: `node --test tests/tui-theme.test.js && AGENT_TUI_MONO=1 node --test tests/tui-theme.test.js && npm test`
Expected: theme green (incl. mono); full suite green (border color is not asserted by existing tests — they strip ANSI; if any compares raw violet bytes, update to `accent()`).

- [ ] **Step 6: node --check + commit**

```bash
node --check apps/tui/src/render.js
git add apps/tui/src/render.js tests/tui-theme.test.js
git commit --no-gpg-sign -m "feat(tui): curated accent themes via render.js indirection"
```

---

### Task C2: Theme state, Settings cycle row, and persistence

**Files:**
- Modify: `apps/tui/src/state.js` (add `theme: 'violet'`)
- Modify: `apps/tui/src/views/settings.js` (`getSettingsItems` — add Theme row)
- Modify: `apps/tui/src/app.js` (`beginSettingsEdit` cycle handler; `saveSettings`/`loadSettings`; call `setActiveTheme` on load)
- Test: `tests/tui-theme.test.js` (extend) / `tests/settings-flow.test.js` (extend)

- [ ] **Step 1: Add `theme` to state and apply on load**

In `apps/tui/src/state.js`, add near `view:` (~line 111) or the TUI-config group:

```js
  theme: 'violet',        // accent theme: 'violet' | 'ocean' | 'warm' (mono overrides)
```

- [ ] **Step 2: Add the Theme row to settings**

In `apps/tui/src/views/settings.js`, in `getSettingsItems()`, in the `── TUI ──` section (after the `port` push, ~line 71), add:

```js
  items.push({ key: 'theme', label: 'Theme', section: 'TUI', kind: 'cycle', value: state.theme || 'violet' });
```

- [ ] **Step 3: Cycle the theme in `beginSettingsEdit`**

In `apps/tui/src/app.js`, in `beginSettingsEdit`, the existing `if (item.kind === 'cycle') {...}` currently only handles `modelSource`. Make it dispatch on the key:

Find:

```js
    if (item.kind === 'cycle') { setState({ modelSource: state.modelSource === 'api' ? 'local' : 'api' }); saveSettings(); showToast(...); return; }
```

Replace with:

```js
    if (item.kind === 'cycle') {
      if (item.key === 'theme') {
        const order = ['violet', 'ocean', 'warm'];
        const next = order[(order.indexOf(state.theme || 'violet') + 1) % order.length];
        setState({ theme: next });
        setActiveTheme(next);
        resetFrameBuffer();
        saveSettings();
        showToast(`Theme: ${next}`, 'green');
        return;
      }
      setState({ modelSource: state.modelSource === 'api' ? 'local' : 'api' });
      saveSettings();
      showToast(`Source: ${state.modelSource === 'api' ? 'API' : 'Local'}`, 'green');
      return;
    }
```

(Confirm the exact current text of the cycle branch first — match it precisely. `setActiveTheme` and `resetFrameBuffer` are imported from `render.js`; add them to the app.js render import if absent.)

- [ ] **Step 4: Persist + restore `theme`**

In `apps/tui/src/app.js`, `saveSettings`: add `theme: state.theme,` to the serialized object.

In `loadSettings`: add a validated restore alongside the others (e.g. near the `modelSource` guard):

```js
    ...((data.theme === 'violet' || data.theme === 'ocean' || data.theme === 'warm') ? { theme: data.theme } : {}),
```

And after the `setState({...})` that applies loaded settings, apply the accent:

```js
  setActiveTheme(state.theme || 'violet');
```

- [ ] **Step 5: Extend the theme test for persistence/cycle**

Append to `tests/tui-theme.test.js`:

```js
import { state, setState } from '../apps/tui/src/state.js';
import { getSettingsItems } from '../apps/tui/src/views/settings.js';

describe('theme settings integration', () => {
  test('getSettingsItems includes a Theme cycle row', () => {
    setState({ theme: 'ocean' });
    const item = getSettingsItems().find((i) => i.key === 'theme');
    assert.ok(item, 'expected a theme settings item');
    assert.equal(item.kind, 'cycle');
    assert.equal(item.value, 'ocean');
    setState({ theme: 'violet' });
  });
});
```

- [ ] **Step 6: Run tests (+mono) + full suite**

Run: `node --test tests/tui-theme.test.js && node --test tests/settings-flow.test.js && npm test`
Expected: green.

- [ ] **Step 7: node --check + commit**

```bash
node --check apps/tui/src/app.js && node --check apps/tui/src/state.js && node --check apps/tui/src/views/settings.js
git add apps/tui/src/app.js apps/tui/src/state.js apps/tui/src/views/settings.js tests/tui-theme.test.js
git commit --no-gpg-sign -m "feat(tui): theme setting — cycle row, persistence, applied on load"
```

---

### Task C3: Consistent selection vocabulary + empty-state copy

**Files:**
- Modify: `apps/tui/src/views/live.js` (empty-state copy; selection bar in steps)

- [ ] **Step 1: Improve the Live empty state**

In `apps/tui/src/views/live.js`, `buildStepRows`, the no-steps branch (currently ~line 104-106):

```js
  if (!steps.length) {
    rows.push(gr('  Waiting for steps…'));
  }
```

Replace with idle-aware copy:

```js
  if (!steps.length) {
    rows.push('');
    rows.push(gr(state.status === 'running' ? '  Waiting for steps…' : '  No steps yet — press [r] to run'));
  }
```

- [ ] **Step 2: Selection bar uses the accent**

In `apps/tui/src/views/live.js`, the selected-step background currently uses `C.bgSel`. Prepend an accent bar marker for a consistent vocabulary. In `buildStepRows`, where `bg`/`rst` are set (~line 85-86), change the selected row prefix so the icon column shows a bar when selected. Update the row push from Task A3 to:

```js
    const selMark = isSelected ? accent() + '▌' + C.reset : ' ';
    rows.push(`${bg}${selMark}${icon} ${gr(stepNum)}  ${toolStr}${durTok}${rst}`);
```

And add `accent` to the render import in live.js (the import edited in A3 becomes `..., sparkline, fmtDuration, wrapLine, accent`).

Note: this changes the leading space; verify the column still aligns (the previous code had a leading space inside the backtick: `` `${bg} ${icon}...` ``). The `selMark` replaces that leading space — keep exactly one cell before `${icon}`.

- [ ] **Step 3: node --check + full suite**

Run: `node --check apps/tui/src/views/live.js && npm test`
Expected: green (if a Live snapshot test asserts `Waiting for steps…` unconditionally, update it to accept the idle copy).

- [ ] **Step 4: Commit**

```bash
git add apps/tui/src/views/live.js
git commit --no-gpg-sign -m "feat(tui): idle empty-state copy + accent selection bar in Live"
```

---

## Final: docs + suite count

### Task E1: Update TESTING.md totals

**Files:**
- Modify: `TESTING.md`

- [ ] **Step 1: Recount and update**

Run: `npm test 2>&1 | tail -5` to get the new `tests N / pass N` total.

Update the TUI row and Total in `TESTING.md` to the new number (added files: `tui-live-richness`, `tui-footer`, `tui-onboarding`, `tui-theme`). Add one line per new test file describing its coverage, matching the existing table format.

- [ ] **Step 2: Commit**

```bash
git add TESTING.md
git commit --no-gpg-sign -m "docs: update TESTING.md totals for TUI polish-pass suites"
```

---

## Self-review notes (for the implementer)

- **Accessibility is a hard gate.** After every workstream run the new test file under `AGENT_TUI_MONO=1`; no new render path may emit SGR codes in mono. Spinners are already gated by `reducedMotion()` — this pass adds no new animation.
- **GPG:** commits use `--no-gpg-sign` because the environment's pinentry times out. If the user's signing works, drop the flag.
- **Existing-test churn is expected** in B1/B2/C1 where assertions may pin old hint/help/border text. Update those assertions to the new intentional wording — do not weaken them to pass.
- **Imports:** several tasks add helpers to the `render.js` import list in `live.js`/`app.js`. Always finish a task with `node --check` on each modified file to catch a missing/duplicate import before running tests.
