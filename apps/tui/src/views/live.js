// src/views/live.js — three-column live view: steps | output | info

import {
  threeColTop, threeColBot, threeColRow, colWidths,
  boxTopN, boxBotN, boxRowN, bandLR,
  C, g, y, r, gr, vi, dim, bold, cell, clip, padEnd, reducedMotion,
  sparkline, fmtDuration, wrapLine, accent,
} from '../render.js';
import { state, avgLatency, latencyP } from '../state.js';

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const GRADE_COLOR = { A: C.green, B: C.green, C: C.yellow, D: C.grey };

// Live layout presets (redesign §6): cycle with [L]. Split = the classic 3-col
// triage grid; Focus = thin step rail + wide output + ambient vitals ribbon;
// Wide = output-only with a status spine, for long diffs/logs.
export function renderLive(W, H) {
  if (state.layoutPreset === 'focus') return renderFocus(W, H);
  if (state.layoutPreset === 'wide')  return renderWide(W, H);
  return renderSplit(W, H);
}

function renderSplit(W, H) {
  const lines = [];
  // Approvals dock into the global top band on every view (redesign §4); the Live
  // grid no longer renders its own inline band.
  const [lW, cW, rW] = colWidths(W);
  const contentH = Math.max(1, H - 2);

  lines.push(threeColTop(W, ['STEPS', 'OUTPUT', 'INFO']));
  const leftRows  = buildStepRows(lW - 1, contentH);
  const centerRows = buildOutputRows(cW - 1, contentH);
  const rightRows = buildInfoRows(rW - 1, contentH);
  for (let i = 0; i < contentH; i++) {
    lines.push(threeColRow(W, leftRows[i] || '', centerRows[i] || '', rightRows[i] || ''));
  }
  lines.push(threeColBot(W));
  return lines;
}

// ── Ambient vitals ribbon (redesign §6) — one row replacing the stacked INFO ───
function outputLabel() {
  const s = state.pinnedIdx !== null ? state.steps[state.pinnedIdx] : state.steps[0];
  if (!s) return `${C.ink4}—${C.reset}`;
  return `${C.ink3}step ${s.step} · ${s.tool}${state.pinnedIdx !== null ? '  ' + C.aqua + '[PINNED]' + C.reset : ''}${C.reset}`;
}

function buildVitalsRibbon(W, presetLabel) {
  const p95 = latencyP(0.95);
  const latSpark = sparkline(state.stepLatenciesMs, 5);
  const costSpark = sparkline(state.costHistory, 5);
  const dot = `${C.ink4} · ${C.reset}`;
  const left = ` ${C.aqua}◷${C.reset} ${C.ink2}${state.model || '—'}${C.reset}${dot}${C.ink2}${state.stage || '—'}${C.reset}`
    + `${dot}${C.ink3}p95 ${p95 > 0 ? (p95 / 1000).toFixed(1) + 's' : '—'} ${C.aqua}${latSpark}${C.reset}`
    + `  ${C.ink3}$${(state.costUsd || 0).toFixed(3)} ${C.amber}${costSpark}${C.reset}`
    + `  ${C.ink3}mem ${state.palaceEvents.length}${C.reset}`;
  const right = `${C.iris}◧ ${presetLabel}${C.reset}`;
  return bandLR(left, right, W);
}

// Thin one-line-per-step rail for Focus/Wide.
function buildRailRows(w, h) {
  const rows = [];
  const steps = state.steps;
  const start = Math.max(0, state.stepsScroll);
  const visible = steps.slice(start, start + Math.max(1, h - 1));
  for (const step of visible) {
    const isSelected = state.pinnedIdx !== null && steps.indexOf(step) === state.pinnedIdx;
    const isCurrent = step === steps[0] && state.status === 'running' && state.pinnedIdx === null;
    const icon = isCurrent ? y(reducedMotion() ? '▷' : SPIN[state._spinFrame % SPIN.length])
      : step.error ? r('✗') : g('✔');
    const selMark = isSelected ? accent() + '▌' + C.reset : ' ';
    const label = `${String(step.step).padStart(3)} ${step.tool}`;
    const colored = isCurrent ? y(label) : isSelected ? `${C.ink}${label}${C.reset}` : gr(label);
    rows.push(`${selMark}${icon} ${colored}`);
  }
  if (!steps.length) rows.push(gr('  no steps yet'));
  const shown = visible.length;
  if (start + shown < steps.length) rows.push(gr(`  +${steps.length - start - shown} more`));
  return rows.slice(0, h);
}

function renderFocus(W, H) {
  const lines = [];
  lines.push(buildVitalsRibbon(W, 'Focus'));
  const railW = Math.max(12, Math.min(18, Math.floor(W * 0.22)));
  const outW = W - railW - 3;                       // │ rail │ output │
  const contentH = Math.max(1, H - 4);              // ribbon + top + title + bottom

  lines.push(boxTopN([railW, outW], 'single'));
  lines.push(boxRowN([` ${C.ink3}steps${C.reset}`, ` ${C.bold}${C.iris}OUTPUT${C.reset}  ${outputLabel()}`], [railW, outW], 'single'));
  const rail = buildRailRows(railW - 1, contentH);
  const out  = buildOutputRows(outW - 1, contentH, false);
  for (let i = 0; i < contentH; i++) lines.push(boxRowN([rail[i] || '', out[i] || ''], [railW, outW], 'single'));
  lines.push(boxBotN([railW, outW], 'single'));
  return lines;
}

function renderWide(W, H) {
  const lines = [];
  lines.push(buildVitalsRibbon(W, 'Wide'));
  const spineW = 1;                                 // status spine: │S│ output │
  const outW = W - spineW - 3;
  const contentH = Math.max(1, H - 4);

  // Status spine glyph (state at a glance even with the rail hidden).
  const spineGlyph = state.status === 'running' ? y(reducedMotion() ? '▷' : SPIN[state._spinFrame % SPIN.length])
    : state.status === 'error' ? r('✗') : state.status === 'paused' ? y('‖')
    : state.status === 'completed' ? g('✓') : gr('·');

  lines.push(boxTopN([spineW, outW], 'single'));
  lines.push(boxRowN([spineGlyph, ` ${C.bold}${C.iris}OUTPUT${C.reset}  ${outputLabel()}`], [spineW, outW], 'single'));
  const out = buildOutputRows(outW - 1, contentH, false);
  for (let i = 0; i < contentH; i++) lines.push(boxRowN([i === 0 ? spineGlyph : ' ', out[i] || ''], [spineW, outW], 'single'));
  lines.push(boxBotN([spineW, outW], 'single'));
  return lines;
}

// ── Steps panel ───────────────────────────────────────────────────────────────

function buildStepRows(w, h) {
  const rows = [];
  const steps = state.steps;

  // Scrollable: stepsScroll=0 means show newest at top
  const start = Math.max(0, state.stepsScroll);
  const visible = steps.slice(start, start + Math.floor(h / 2));

  for (const step of visible) {
    const isSelected = state.pinnedIdx !== null && steps.indexOf(step) === state.pinnedIdx;
    const isCurrent  = step === steps[0] && state.status === 'running' && state.pinnedIdx === null;

    const icon = isCurrent
      ? y(reducedMotion() ? '▷' : SPIN[state._spinFrame % SPIN.length])  // amber spinner / static ▷
      : step.error ? r('✗')
      : g('✔');  // completed → jade (redesign §5)

    const stepNum = String(step.step).padStart(3, ' ');
    const toolStr = isCurrent ? y(step.tool) : step.error ? r(step.tool) : g(step.tool);
    const bg = isSelected ? C.bgSel : '';
    const rst = isSelected ? C.reset : '';

    let durTok = '';
    if (!isCurrent && step.latencyMs != null) {
      const slow = step.latencyMs >= 5000;
      durTok = '  ' + (slow ? y(fmtDuration(step.latencyMs) + ' ⚠') : gr(fmtDuration(step.latencyMs)));
    }
    const selMark = isSelected ? accent() + '▌' + C.reset : ' ';
    rows.push(`${bg}${selMark}${icon} ${gr(stepNum)}  ${toolStr}${durTok}${rst}`);

    // Sub-line: arg/thought (dropped in compact density)
    const sub = step.arg || step.thought || '';
    if (sub && state.density !== 'compact') {
      const subClipped = sub.slice(0, w - 6);
      rows.push(`${bg}       ${gr(subClipped)}${rst}`);
    }
  }

  // Scroll hint
  if (state.stepsScroll > 0) {
    rows.unshift(gr(`  ↑ ${state.stepsScroll} more above`));
  }
  if (start + Math.floor(h / 2) < steps.length) {
    rows.push(gr(`  ↓ ${steps.length - start - Math.floor(h / 2)} more below`));
  }
  if (!steps.length) {
    rows.push('');
    rows.push(gr(state.status === 'running' ? '  Waiting for steps…' : '  No steps yet — press [r] to run'));
  }

  if (state.pinnedIdx !== null) {
    rows.push('');
    rows.push(gr('  [Esc] unpin'));
  }

  return rows.slice(0, h);
}

// ── Output panel ──────────────────────────────────────────────────────────────

function buildOutputRows(w, h, showHeader = true) {
  const rows = [];
  let output = '';
  let stepLabel = '';

  if (state.pinnedIdx !== null && state.steps[state.pinnedIdx]) {
    const s = state.steps[state.pinnedIdx];
    output = s.result || '(no output)';
    stepLabel = `Step ${s.step}: ${s.tool}  ${C.aqua}[PINNED]${C.reset}`;
  } else if (state.steps.length > 0) {
    const s = state.steps[0];
    output = s.result || '';
    stepLabel = `Step ${s.step}: ${s.tool}`;
  }

  if (showHeader && stepLabel) {
    rows.push(gr(' > ') + stepLabel);
    rows.push('');
  }

  const outLines = output.split('\n');
  const start = Math.max(0, outLines.length - h + rows.length + state.outputScroll);
  const visible = outLines.slice(
    Math.max(0, start - state.outputScroll),
    Math.min(outLines.length, start - state.outputScroll + h - rows.length - 2)
  );

  for (const line of visible) {
    for (const seg of wrapLine(line, w - 1)) {
      rows.push(' ' + colorizeOutput(seg));
      if (rows.length >= h) break;
    }
    if (rows.length >= h) break;
  }

  if (state.outputScroll > 0) {
    rows.push(gr(`  ↓ scrolled up ${state.outputScroll} lines — [End] to follow live`));
  }

  if (!output && !state.steps.length) {
    rows.push(gr('  Output appears here when the agent runs.'));
  }

  return rows.slice(0, h);
}

export function colorizeOutput(line) {
  if (/^\+ /.test(line)) return C.green + line + C.reset;   // unified-diff add
  if (/^- /.test(line))  return C.red + line + C.reset;     // unified-diff remove
  if (/✓|passing|PASS/i.test(line)) return C.green + line + C.reset;
  if (/✗|failing|FAIL|error|Error/i.test(line)) return C.red + line + C.reset;
  if (/warning|warn/i.test(line)) return C.yellow + line + C.reset;
  if (/^\s*>/.test(line)) return C.grey + line + C.reset;
  return line;
}

// ── Info panel ────────────────────────────────────────────────────────────────

function buildInfoRows(w, h) {
  const rows = [];

  const push = (line) => rows.push(' ' + line);
  const section = (label) => {
    // ▸ marker in aqua, label in receding ink (redesign §5 — INFO is quieter).
    rows.push(C.aqua + ' ' + '▸' + C.reset + ' ' + C.ink3 + label + C.reset);
  };
  // Dividers are dropped in compact density to tighten the INFO column.
  const divider = () => { if (state.density === 'compact') return; rows.push(C.rule + ' ' + '─'.repeat(w - 2) + C.reset); };

  // TASK
  section('TASK');
  const taskWords = (state.task || 'No active task').split(' ');
  let taskLine = '';
  for (const word of taskWords) {
    if ((taskLine + word).length > w - 2) {
      push(gr(taskLine.trim()));
      taskLine = word + ' ';
    } else {
      taskLine += word + ' ';
    }
    if (rows.length > h - 5) break;
  }
  if (taskLine.trim()) push(gr(taskLine.trim()));
  divider();

  // STAGE
  section('STAGE');
  push(state.stage ? y(state.stage) : gr('—'));
  divider();

  // MODEL
  section('MODEL');
  push(state.model ? C.cyan + state.model + C.reset : gr('—'));
  divider();

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

  // SKILLS
  if (state.skills.length) {
    section('SKILLS');
    for (const sk of state.skills.slice(0, 5)) {
      const col = GRADE_COLOR[sk.grade] || C.grey;
      const grade = `${col}${sk.grade}${C.reset}`;
      push(`${sk.name.slice(0, w - 6)}  ${grade}`);
    }
    divider();
  }

  // PALACE
  section('MEMORY');
  push(`${C.green}${state.palaceEvents.length}${C.reset} events`);
  if (state.palaceEvents.length > 0) {
    push(gr(`last: step ${state.palaceEvents[0].step || '?'}`));
  }

  return rows.slice(0, h);
}
